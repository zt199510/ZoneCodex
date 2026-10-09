import {
  startCommandProcess,
  type CommandOutput,
  type CommandProcess
} from '../execution/command-runner'
import {
  discardCommandExecution,
  type CommandAuthorize,
  type CommandExecutionPlan
} from '../execution/command-plan'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, sep, win32 } from 'node:path'
import { commitChange } from './change-commit'
import { prepareChange } from './change-preparation'
import { createProjectSnapshot } from './project-snapshot'
import { applyWorkspacePatch } from './workspace-patch'
import type { ProjectExecutor } from './project-file-tools'
import { canonicalLocalPath, insideLocalPath, localPathParts, sameLocalPath } from './local-path'

export type WorkspaceActionOptions = {
  isPathAllowed?: (target: string) => boolean
  onEffect?: () => void
  authorizeCommand?: CommandAuthorize
}

export type WorkspaceApprovalRequest =
  | { kind: 'edit'; path: string; before: string; after: string; cwd: string }
  | { kind: 'create'; path: string; after: string; cwd: string }
  | { kind: 'command'; program: string; args: string[]; cwd: string }

export type WorkspaceApprove = (
  request: WorkspaceApprovalRequest,
  signal: AbortSignal
) => Promise<boolean>

export const workspaceActionTools = [
  {
    type: 'function',
    name: 'create_workspace_file',
    description:
      'Create one new UTF-8 text file in an existing local directory under the current runtime permission and approval policy. The path may be relative to the default working directory or absolute. Never overwrites an existing file or creates parent directories. Limited to 80 lines and 2000 characters.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        content: { type: 'string', maxLength: 2000 }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'apply_workspace_patch',
    description:
      'Apply exact context patches to one existing UTF-8 text file fully read in this request. Send path, the raw-byte sha256 from that read, and patch text: *** Begin Patch, *** Update File: <same path>, one or more bare @@ hunk headers with space-prefixed context, - old lines and + new lines, then *** End Patch (each on its own line). Optional *** End of File anchors the final hunk at the end. Use exact unique old context, never line numbers or @@ descriptions. Do not include line-number prefixes or BOM. The main process preserves BOM, LF/CRLF and the original trailing-newline count. No add/delete/move or multi-file patches. Source and candidate remain limited to 80 lines and 2000 characters. Subject to the current permission and approval policy.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        patch: { type: 'string', minLength: 1, maxLength: 6000 },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
      },
      required: ['path', 'patch', 'expectedSha256'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'run_workspace_command',
    description:
      'Run a program through the verified runtime command backend. cwd may be relative to the default working directory or absolute; use null for the default. Use sandbox_permissions use_default or null for the current restricted policy. Only when the user task requires access outside that policy, request require_escalated and give a concrete justification. A denied or failed run is never automatically retried outside the sandbox. No untrusted shell text is constructed.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', minLength: 1, maxLength: 500 },
        args: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20 },
        cwd: { type: ['string', 'null'], maxLength: 512 },
        sandbox_permissions: {
          type: ['string', 'null'],
          enum: ['use_default', 'require_escalated', null]
        },
        justification: { type: ['string', 'null'], maxLength: 1000 }
      },
      required: ['program', 'args', 'cwd', 'sandbox_permissions', 'justification'],
      additionalProperties: false
    }
  }
] as const

const MAX_ARGUMENTS = 4096
// JSON escaping can expand command output before the Agent's 12,000-character limit.
const MAX_OUTPUT_BYTES = 1800
const COMMAND_TIMEOUT_MS = 30_000
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  '.ssh',
  '.aws',
  'vendor',
  'target'
])
const SKIPPED_FILES =
  /(^\.(?:env(?:\.|$)|npmrc$|pypirc$|netrc$)|(?:^|[._-])(?:secret|credential|password|private[-_.]?key)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$)/i
function result(status: string, details: Record<string, unknown> = {}): string {
  return JSON.stringify({ status, ...details })
}

function parseArguments(raw: string, limit = MAX_ARGUMENTS): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > limit) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function validRelativePath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const parts = path.split('/')
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes(':') &&
    !hasControlCharacters(path) &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
        !SKIPPED_DIRECTORIES.has(part.toLowerCase()) &&
        !SKIPPED_FILES.test(part)
    )
  )
}

function validNewText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000 || value.split(/\r\n|\r|\n/).length > 80) {
    return false
  }
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && code !== 9 && code !== 10 && code !== 13
    })
  ) {
    return false
  }
  const bytes = Buffer.from(value, 'utf8')
  return (
    bytes.length <= 32768 &&
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === value
  )
}

type DirectoryIdentity = { path: string; dev: number; ino: number }

async function inspectParents(root: string, path: string): Promise<DirectoryIdentity[]> {
  const parts = path.split('/')
  parts.pop()
  let current = root
  const identities: DirectoryIdentity[] = []
  for (const part of ['', ...parts]) {
    if (part) current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('父目录不是普通目录，或包含符号链接/联接')
    }
    identities.push({ path: current, dev: info.dev, ino: info.ino })
  }
  return identities
}

async function confirmParents(identities: readonly DirectoryIdentity[]): Promise<void> {
  for (const original of identities) {
    const current = await lstat(original.path)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== original.dev ||
      current.ino !== original.ino
    ) {
      throw new Error('父目录已变化')
    }
  }
  const last = identities.at(-1)
  if (last && !sameLocalPath(await realpath(last.path), last.path)) {
    throw new Error('父目录的实际路径已变化')
  }
}

function validCommand(args: Record<string, unknown>): args is {
  program: string
  args: string[]
  cwd?: string | null
  sandbox_permissions?: 'use_default' | 'require_escalated' | null
  justification?: string | null
} {
  return (
    Object.hasOwn(args, 'program') &&
    Object.hasOwn(args, 'args') &&
    Object.keys(args).every((key) =>
      ['program', 'args', 'cwd', 'sandbox_permissions', 'justification'].includes(key)
    ) &&
    (args.cwd === undefined ||
      args.cwd === null ||
      (typeof args.cwd === 'string' &&
        args.cwd.length <= 512 &&
        !hasControlCharacters(args.cwd))) &&
    (args.sandbox_permissions === undefined ||
      args.sandbox_permissions === null ||
      args.sandbox_permissions === 'use_default' ||
      args.sandbox_permissions === 'require_escalated') &&
    (args.justification === undefined ||
      args.justification === null ||
      (typeof args.justification === 'string' &&
        args.justification.trim().length > 0 &&
        args.justification.length <= 1000 &&
        !hasControlCharacters(args.justification))) &&
    (args.sandbox_permissions !== 'require_escalated' ||
      (typeof args.justification === 'string' && args.justification.trim().length > 0)) &&
    typeof args.program === 'string' &&
    !!args.program.trim() &&
    args.program.length <= 500 &&
    !hasControlCharacters(args.program) &&
    Array.isArray(args.args) &&
    args.args.length <= 20 &&
    args.args.every(
      (item) => typeof item === 'string' && item.length <= 500 && !item.includes('\0')
    )
  )
}

async function checkedRoot(root: string, assertAccess: () => boolean): Promise<string> {
  if (!assertAccess()) throw new Error('工作区授权已失效')
  const canonical = await canonicalLocalPath(root, '', true)
  const info = await lstat(canonical)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('运行目录已变化')
  }
  if (!assertAccess()) throw new Error('工作区授权已失效')
  return canonical
}

async function runCommand(
  plan: CommandExecutionPlan,
  cwd: string,
  signal: AbortSignal,
  assertAccess: () => boolean,
  onEffect?: () => void
): Promise<string> {
  signal.throwIfAborted()
  const hasAccess = (): boolean => {
    try {
      return assertAccess()
    } catch {
      return false
    }
  }
  if (!hasAccess()) {
    discardCommandExecution(plan)
    return result('error', { error: '工作区授权已失效' })
  }
  const capturedOutput = (output: CommandOutput): Record<string, unknown> => ({
    cwd,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated
  })
  return new Promise<string>((resolveResult, rejectResult) => {
    let stopping = false
    let settled = false
    const complete = (value: string): void => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    const failed = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectResult(error)
    }
    const stop = (process: CommandProcess, finish: (treeExited: boolean) => void): void => {
      if (stopping || settled) return
      stopping = true
      void process.stop().then(
        (outcome) => finish(outcome.treeExited),
        () => finish(false)
      )
    }
    try {
      startCommandProcess({
        plan,
        outputLimit: MAX_OUTPUT_BYTES,
        outputMode: 'bytes',
        timeoutMs: COMMAND_TIMEOUT_MS,
        beforeSpawn: () => {
          signal.throwIfAborted()
          if (!hasAccess()) throw new Error('运行权限已失效')
          onEffect?.()
        },
        signal,
        access: { check: hasAccess, intervalMs: 250 },
        onError: (error, output, outcome) => {
          if (stopping) return
          complete(
            result('error', {
              error: [
                error.message,
                outcome.treeExited ? null : '进程树是否退出未确认，请核对本地结果'
              ]
                .filter(Boolean)
                .join('；')
                .slice(0, 500),
              treeExited: outcome.treeExited,
              ...capturedOutput(output)
            })
          )
        },
        onClose: (code, closedSignal, output, outcome) => {
          if (stopping) return
          if (!outcome.treeExited) {
            complete(
              result('uncertain', {
                error: '命令已经结束，但无法确认全部子进程退出；请核对结果后再决定是否重新请求',
                treeExited: false,
                ...capturedOutput(output)
              })
            )
            return
          }
          if (!hasAccess()) {
            complete(result('error', { error: '工作区授权已失效', ...capturedOutput(output) }))
            return
          }
          complete(
            result(code === 0 ? 'completed' : 'failed', {
              exitCode: code,
              signal: closedSignal,
              treeExited: true,
              ...capturedOutput(output)
            })
          )
        },
        onTimeout: (process, output) => {
          stop(process, (treeExited) =>
            complete(
              result('timed_out', {
                error: treeExited
                  ? '命令执行超过 30 秒，已确认受控进程退出'
                  : '命令执行超过 30 秒，已请求终止；进程树是否退出未确认',
                treeExited,
                ...capturedOutput(output)
              })
            )
          )
        },
        onAccessLost: (process, output) => {
          stop(process, (treeExited) =>
            complete(
              result('error', {
                error: treeExited
                  ? '工作区授权已失效，已确认受控进程退出'
                  : '工作区授权已失效，已请求终止命令；进程树是否退出未确认',
                treeExited,
                ...capturedOutput(output)
              })
            )
          )
        },
        onAbort: (process) => {
          stop(process, (treeExited) =>
            failed(
              treeExited
                ? (signal.reason ?? new Error('命令已取消'))
                : new Error('命令已取消并请求终止；进程树是否退出未确认，请核对本地结果')
            )
          )
        }
      })
    } catch (error) {
      complete(
        result('error', {
          cwd,
          error: error instanceof Error ? error.message : '命令启动失败'
        })
      )
    }
  })
}

async function createWorkspaceFile(
  root: string,
  path: string,
  content: string,
  signal: AbortSignal,
  assertAccess: () => boolean,
  approve: WorkspaceApprove,
  options: WorkspaceActionOptions
): Promise<string> {
  const cwd = await checkedRoot(root, assertAccess)
  const target = await canonicalLocalPath(cwd, path)
  const allowed = (): boolean =>
    assertAccess() &&
    (options.isPathAllowed ? options.isPathAllowed(target) : insideLocalPath(cwd, target))
  if (!allowed()) return result('error', { error: '文件路径超出允许范围' })
  if (
    options.isPathAllowed &&
    localPathParts(target).some(
      (part) => SKIPPED_DIRECTORIES.has(part.toLowerCase()) || SKIPPED_FILES.test(part)
    )
  ) {
    return result('error', { error: '文件路径不在允许的文件范围内' })
  }
  const displayPath = options.isPathAllowed ? target : path
  const parents = await inspectParents(
    parse(target).root,
    relative(parse(target).root, target).split(sep).join('/')
  )
  signal.throwIfAborted()
  if (!allowed()) return result('error', { error: '运行权限已失效' })
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing)
    return result('conflict', { path: displayPath, error: '目标文件已存在，本次未覆盖' })
  const accepted = await approve({ kind: 'create', path: displayPath, after: content, cwd }, signal)
  signal.throwIfAborted()
  if (!allowed()) return result('error', { error: '运行权限已失效' })
  if (!accepted) return result('cancelled', { path: displayPath, error: '当前策略未允许创建文件' })

  await confirmParents(parents)
  signal.throwIfAborted()
  if (!allowed()) return result('error', { error: '运行权限已失效' })
  const bytes = Buffer.from(content, 'utf8')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // The exclusive flag prevents overwriting an existing target, including a symlink.
    options.onEffect?.()
    handle = await open(target, 'wx+', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return result('conflict', { path: displayPath, error: '目标文件已存在，本次未覆盖' })
    }
    return result('error', {
      path: displayPath,
      error: error instanceof Error ? error.message : '文件创建失败'
    })
  }

  let failure: unknown = null
  try {
    const checkContinue = (): void => {
      signal.throwIfAborted()
      if (!allowed()) throw new Error('运行权限已失效')
    }
    checkContinue()
    let offset = 0
    while (offset < bytes.length) {
      checkContinue()
      const written = await handle.write(bytes, offset, bytes.length - offset, offset)
      checkContinue()
      if (written.bytesWritten <= 0) throw new Error('文件写入不完整')
      offset += written.bytesWritten
    }
    await handle.sync()
    checkContinue()
    const opened = await handle.stat()
    checkContinue()
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== bytes.length) {
      throw new Error('创建后的文件状态不符合预期')
    }
    const readback = Buffer.alloc(bytes.length)
    offset = 0
    while (offset < readback.length) {
      checkContinue()
      const read = await handle.read(readback, offset, readback.length - offset, offset)
      checkContinue()
      if (read.bytesRead <= 0) throw new Error('无法完整复核新文件')
      offset += read.bytesRead
    }
    if (!readback.equals(bytes)) throw new Error('创建后的文件内容与批准内容不一致')
    await confirmParents(parents)
    checkContinue()
    const current = await lstat(target)
    checkContinue()
    const resolvedTarget = await realpath(target)
    checkContinue()
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      !sameLocalPath(resolvedTarget, target)
    ) {
      throw new Error('创建后的文件路径已变化')
    }
  } catch (error) {
    failure = error
  }
  try {
    await handle.close()
  } catch (error) {
    failure ??= error
  }
  if (failure) {
    return result('uncertain', {
      path: displayPath,
      error: failure instanceof Error ? failure.message : '创建后无法确认文件状态',
      message: '已尝试创建文件，可能留下空文件或部分内容；请检查目标路径后再决定是否重试'
    })
  }
  let accessValid = false
  try {
    accessValid = allowed()
  } catch {
    // A completed and verified create remains a create after access is revoked.
  }
  return result('created', { path: displayPath, bytes: bytes.length, accessValid })
}

export function createWorkspaceActionExecutor(
  root: string,
  assertAccess: () => boolean,
  approve: WorkspaceApprove,
  options: WorkspaceActionOptions = {}
): ProjectExecutor {
  function validFilePath(path: unknown): path is string {
    return options.isPathAllowed
      ? typeof path === 'string' && path.length > 0 && path.length <= 512
      : validRelativePath(path)
  }

  async function checkedTarget(cwd: string, input: string, allowRoot = false): Promise<string> {
    const target = await canonicalLocalPath(cwd, input, allowRoot)
    if (
      !assertAccess() ||
      (options.isPathAllowed ? !options.isPathAllowed(target) : !insideLocalPath(cwd, target))
    ) {
      throw new Error('目标路径或运行权限已失效')
    }
    if (
      !allowRoot &&
      options.isPathAllowed &&
      localPathParts(target).some(
        (part) => SKIPPED_DIRECTORIES.has(part.toLowerCase()) || SKIPPED_FILES.test(part)
      )
    ) {
      throw new Error('文件路径不在允许的文件范围内')
    }
    return target
  }

  return async (name, rawArguments, signal) => {
    signal.throwIfAborted()
    const args = parseArguments(
      rawArguments,
      name === 'apply_workspace_patch' ? 12000 : MAX_ARGUMENTS
    )
    if (!args) return result('error', { error: '工具参数无效或过长' })

    if (name === 'create_workspace_file') {
      if (
        !exactKeys(args, ['path', 'content']) ||
        !validFilePath(args.path) ||
        !validNewText(args.content)
      ) {
        return result('error', { error: '创建文件参数无效' })
      }
      try {
        return await createWorkspaceFile(
          root,
          args.path,
          args.content,
          signal,
          assertAccess,
          approve,
          options
        )
      } catch (error) {
        signal.throwIfAborted()
        return result('error', { error: error instanceof Error ? error.message : '文件创建失败' })
      }
    }

    if (name === 'apply_workspace_patch') {
      if (
        !exactKeys(args, ['path', 'patch', 'expectedSha256']) ||
        !validFilePath(args.path) ||
        typeof args.patch !== 'string' ||
        args.patch.length > 6000 ||
        typeof args.expectedSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(args.expectedSha256)
      ) {
        return result('error', { error: '补丁参数无效' })
      }
      try {
        const cwd = await checkedRoot(root, assertAccess)
        const target = await checkedTarget(cwd, args.path)
        const path = options.isPathAllowed ? target : args.path
        const alias = basename(target)
        const parents = await inspectParents(
          parse(target).root,
          relative(parse(target).root, target).split(sep).join('/')
        )
        const snapshot = await createProjectSnapshot(dirname(target), [target], signal)
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        const baseline = snapshot.baselines?.get(alias)
        if (
          !baseline ||
          !sameLocalPath(baseline.absolutePath, target) ||
          createHash('sha256').update(baseline.originalBytes).digest('hex') !== args.expectedSha256
        ) {
          return result('conflict', { path, error: '文件内容已变化，请重新读取后再修改' })
        }
        if (baseline.newline === 'unsupported')
          return result('unsupported', { path, error: '暂不修改混合换行或孤立 CR 文件' })
        const originalText = snapshot.files.get(alias)?.join('\n')
        if (originalText === undefined) return result('error', { path, error: '缺少原文基线' })
        const candidate = applyWorkspacePatch(originalText, args.patch, args.path)
        if (candidate.status !== 'candidate')
          return result('error', { path, error: candidate.error })
        const prepared = await prepareChange(snapshot, alias, candidate.text, signal)
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        if (prepared.status !== 'prepared')
          return result(prepared.status, { path, error: prepared.error, hunks: candidate.hunks })

        const accepted = await approve(
          {
            kind: 'edit',
            path,
            before: Buffer.from(prepared.baseline.originalBytes).toString('utf8'),
            after: Buffer.from(prepared.candidateBytes).toString('utf8'),
            cwd
          },
          signal
        )
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        if (!accepted) return result('cancelled', { path, error: '当前策略未允许文件修改' })

        await confirmParents(parents)
        await checkedTarget(cwd, target)
        signal.throwIfAborted()
        const canReplace = (): boolean =>
          assertAccess() &&
          (options.isPathAllowed ? options.isPathAllowed(target) : insideLocalPath(cwd, target))

        const outcome = await commitChange(snapshot, prepared, signal, canReplace, (phase) => {
          if (phase === 'staging') options.onEffect?.()
        })
        let accessValid = false
        try {
          accessValid = canReplace()
        } catch {
          // The commit outcome is authoritative even if access was revoked afterward.
        }
        return result(outcome.status, {
          path,
          hunks: candidate.hunks,
          ...(outcome.status === 'applied'
            ? { sha256: createHash('sha256').update(prepared.candidateBytes).digest('hex') }
            : {}),
          message: outcome.status === 'applied' ? '文件修改已提交并复核' : outcome.message,
          ...(outcome.recovery ? { recoveryPath: outcome.recovery.path } : {}),
          cleanupWarning: outcome.cleanupWarning,
          accessValid
        })
      } catch (error) {
        signal.throwIfAborted()
        return result('error', { error: error instanceof Error ? error.message : '文件修改失败' })
      }
    }

    if (name === 'run_workspace_command') {
      if (!validCommand(args)) return result('error', { error: '命令参数无效' })
      let plan: CommandExecutionPlan | null = null
      try {
        const defaultCwd = await checkedRoot(root, assertAccess)
        const cwd = await checkedTarget(defaultCwd, args.cwd ?? '', true)
        const before = await lstat(cwd)
        signal.throwIfAborted()
        if (!assertAccess() || !before.isDirectory() || before.isSymbolicLink()) {
          return result('error', { error: '工作区目录或授权已变化，未执行命令' })
        }
        if (!options.authorizeCommand) {
          return result('error', { error: '命令执行后端未接通，本次未启动' })
        }
        plan = await options.authorizeCommand(
          {
            program: args.program,
            args: [...args.args],
            cwd,
            sandbox_permissions: args.sandbox_permissions ?? 'use_default',
            justification: args.justification ?? null
          },
          signal
        )
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        if (!plan) return result('cancelled', { cwd, error: '当前策略未允许命令执行' })
        await checkedRoot(root, assertAccess)
        await checkedTarget(defaultCwd, cwd, true)
        const after = await lstat(cwd)
        signal.throwIfAborted()
        if (
          !assertAccess() ||
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          before.dev !== after.dev ||
          before.ino !== after.ino
        ) {
          return result('error', { error: '工作区目录或授权已变化，未执行命令' })
        }
        return await runCommand(
          plan,
          cwd,
          signal,
          () =>
            assertAccess() &&
            (options.isPathAllowed ? options.isPathAllowed(cwd) : insideLocalPath(defaultCwd, cwd)),
          options.onEffect
        )
      } catch (error) {
        if (signal.aborted) throw error
        return result('error', { error: error instanceof Error ? error.message : '命令执行失败' })
      } finally {
        if (plan) discardCommandExecution(plan)
      }
    }

    return result('error', { error: '未知工作区工具' })
  }
}
