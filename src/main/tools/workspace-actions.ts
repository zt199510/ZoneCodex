import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { commitChange } from './change-commit'
import { prepareChange } from './change-preparation'
import { createProjectSnapshot } from './project-snapshot'
import type { ProjectExecutor } from './project-snapshot'

export type WorkspaceApprovalRequest = {
  kind: 'edit' | 'create' | 'command'
  path?: string
  program?: string
  args?: string[]
  before?: string
  after?: string
  cwd: string
}

export type WorkspaceApprove = (
  request: WorkspaceApprovalRequest,
  signal: AbortSignal
) => Promise<boolean>

export const workspaceActionTools = [
  {
    type: 'function',
    name: 'create_workspace_file',
    description:
      'Create one new UTF-8 text file in an existing workspace directory after showing its full content and obtaining user approval. Never overwrites an existing file or creates parent directories. Limited to 80 lines and 2000 characters.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 240 },
        content: { type: 'string', maxLength: 2000 }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'edit_workspace_file',
    description:
      'Replace one existing workspace text file with complete new content after showing the full before/after text and obtaining user approval. Limited to 80 lines and 2000 characters.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 240 },
        proposedText: { type: 'string', maxLength: 2000 },
        expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
      },
      required: ['path', 'proposedText', 'expectedSha256'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'run_workspace_command',
    description:
      'Run a program in the selected workspace after showing its complete program, arguments and working directory and obtaining user approval. No shell is used.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        program: { type: 'string', minLength: 1, maxLength: 500 },
        args: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20 }
      },
      required: ['program', 'args'],
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
const COMMAND_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL'
] as const

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of COMMAND_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') environment[key] = value
  }
  return environment
}

function result(status: string, details: Record<string, unknown> = {}): string {
  return JSON.stringify({ status, ...details })
}

function parseArguments(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > MAX_ARGUMENTS) return null
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
  if (typeof value !== 'string' || value.length > 2000 || value.split('\n').length > 80) {
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
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(current)) !== current) {
      throw new Error('父目录不是工作区内的普通目录，或包含符号链接/联接')
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
      current.ino !== original.ino ||
      (await realpath(original.path)) !== original.path
    ) {
      throw new Error('父目录已变化')
    }
  }
}

function validCommand(args: Record<string, unknown>): args is {
  program: string
  args: string[]
} {
  return (
    exactKeys(args, ['program', 'args']) &&
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
  const canonical = await realpath(root)
  const info = await lstat(canonical)
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== root) {
    throw new Error('工作区目录已变化')
  }
  if (!assertAccess()) throw new Error('工作区授权已失效')
  return canonical
}

async function runCommand(
  cwd: string,
  program: string,
  args: string[],
  signal: AbortSignal,
  assertAccess: () => boolean
): Promise<string> {
  signal.throwIfAborted()
  const hasAccess = (): boolean => {
    try {
      return assertAccess()
    } catch {
      return false
    }
  }
  if (!hasAccess()) return result('error', { error: '工作区授权已失效' })
  return new Promise<string>((resolveResult, rejectResult) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: commandEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolveResult(
        result('error', { error: error instanceof Error ? error.message : '命令启动失败' })
      )
      return
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let truncated = false
    let finished = false

    function collect(target: Buffer[], chunk: Buffer | string): void {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_OUTPUT_BYTES - bytes
      if (remaining > 0) target.push(value.subarray(0, remaining))
      bytes += Math.min(remaining, value.length)
      if (value.length > remaining) truncated = true
    }

    function capturedOutput(): { stdout: string; stderr: string; truncated: boolean } {
      return {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated
      }
    }

    function complete(output: string, aborted = false): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearInterval(accessTimer)
      signal.removeEventListener('abort', abort)
      if (aborted) rejectResult(signal.reason ?? new Error('命令已取消'))
      else resolveResult(output)
    }

    function abort(): void {
      child.kill()
      complete('', true)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => collect(stderr, chunk))
    child.once('error', (error) => {
      complete(result('error', { error: error.message.slice(0, 500), ...capturedOutput() }))
    })
    child.once('close', (code, closedSignal) => {
      if (!hasAccess()) {
        complete(result('error', { error: '工作区授权已失效', ...capturedOutput() }))
        return
      }
      complete(
        result(code === 0 ? 'completed' : 'failed', {
          exitCode: code,
          signal: closedSignal,
          ...capturedOutput()
        })
      )
    })
    const timer = setTimeout(() => {
      child.kill()
      complete(
        result('timed_out', {
          error: '命令执行超过 30 秒，已请求终止；进程是否退出未确认',
          ...capturedOutput()
        })
      )
    }, COMMAND_TIMEOUT_MS)
    const accessTimer = setInterval(() => {
      if (hasAccess()) return
      child.kill()
      complete(
        result('error', {
          error: '工作区授权已失效，已请求终止命令；进程是否退出未确认',
          ...capturedOutput()
        })
      )
    }, 250)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function createWorkspaceFile(
  root: string,
  path: string,
  content: string,
  signal: AbortSignal,
  assertAccess: () => boolean,
  approve: WorkspaceApprove
): Promise<string> {
  const cwd = await checkedRoot(root, assertAccess)
  const target = resolve(cwd, path)
  if (relative(cwd, target).split(sep).join('/') !== path) {
    return result('error', { error: '文件路径不在工作区内' })
  }
  const parents = await inspectParents(cwd, path)
  signal.throwIfAborted()
  if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
  const accepted = await approve({ kind: 'create', path, after: content, cwd }, signal)
  signal.throwIfAborted()
  if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
  if (!accepted) return result('cancelled', { path, error: '用户未批准创建文件' })

  await confirmParents(parents)
  signal.throwIfAborted()
  if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
  const bytes = Buffer.from(content, 'utf8')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // The exclusive flag prevents overwriting an existing target, including a symlink.
    handle = await open(target, 'wx+', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return result('conflict', { path, error: '目标文件已存在，本次未覆盖' })
    }
    return result('error', { path, error: error instanceof Error ? error.message : '文件创建失败' })
  }

  let failure: unknown = null
  try {
    signal.throwIfAborted()
    if (!assertAccess()) throw new Error('工作区授权已失效')
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      if (!assertAccess()) throw new Error('工作区授权已失效')
      const written = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('文件写入不完整')
      offset += written.bytesWritten
    }
    await handle.sync()
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== bytes.length) {
      throw new Error('创建后的文件状态不符合预期')
    }
    const readback = Buffer.alloc(bytes.length)
    offset = 0
    while (offset < readback.length) {
      const read = await handle.read(readback, offset, readback.length - offset, offset)
      if (read.bytesRead <= 0) throw new Error('无法完整复核新文件')
      offset += read.bytesRead
    }
    if (!readback.equals(bytes)) throw new Error('创建后的文件内容与批准内容不一致')
    await confirmParents(parents)
    const current = await lstat(target)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      (await realpath(target)) !== target
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
      path,
      error: failure instanceof Error ? failure.message : '创建后无法确认文件状态',
      message: '已尝试创建文件，可能留下空文件或部分内容；请检查目标路径后再决定是否重试'
    })
  }
  let accessValid = false
  try {
    accessValid = assertAccess()
  } catch {
    // A completed and verified create remains a create after access is revoked.
  }
  return result('created', { path, bytes: bytes.length, accessValid })
}

export function createWorkspaceActionExecutor(
  root: string,
  assertAccess: () => boolean,
  approve: WorkspaceApprove
): ProjectExecutor {
  return async (name, rawArguments, signal) => {
    signal.throwIfAborted()
    const args = parseArguments(rawArguments)
    if (!args) return result('error', { error: '工具参数无效或过长' })

    if (name === 'create_workspace_file') {
      if (
        !exactKeys(args, ['path', 'content']) ||
        !validRelativePath(args.path) ||
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
          approve
        )
      } catch (error) {
        signal.throwIfAborted()
        return result('error', { error: error instanceof Error ? error.message : '文件创建失败' })
      }
    }

    if (name === 'edit_workspace_file') {
      if (
        !exactKeys(args, ['path', 'proposedText', 'expectedSha256']) ||
        !validRelativePath(args.path) ||
        typeof args.proposedText !== 'string' ||
        args.proposedText.length > 2000 ||
        typeof args.expectedSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(args.expectedSha256)
      ) {
        return result('error', { error: '编辑参数无效' })
      }
      try {
        const cwd = await checkedRoot(root, assertAccess)
        const path = args.path
        const snapshot = await createProjectSnapshot(cwd, [resolve(cwd, path)], signal)
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        const baseline = snapshot.baselines?.get(path)
        if (
          !baseline ||
          createHash('sha256').update(baseline.originalBytes).digest('hex') !== args.expectedSha256
        ) {
          return result('conflict', { path, error: '文件内容已变化，请重新读取后再修改' })
        }
        const prepared = await prepareChange(snapshot, path, args.proposedText, signal)
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        if (prepared.status !== 'prepared')
          return result(prepared.status, { error: prepared.error })

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
        if (!accepted) return result('cancelled', { path, error: '用户未批准文件修改' })

        const outcome = await commitChange(
          snapshot,
          prepared,
          signal,
          assertAccess,
          () => undefined
        )
        let accessValid = false
        try {
          accessValid = assertAccess()
        } catch {
          // The commit outcome is authoritative even if access was revoked afterward.
        }
        return result(outcome.status, {
          path,
          message: outcome.message,
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
      try {
        const cwd = await checkedRoot(root, assertAccess)
        const before = await lstat(cwd)
        signal.throwIfAborted()
        if (!assertAccess() || !before.isDirectory() || before.isSymbolicLink()) {
          return result('error', { error: '工作区目录或授权已变化，未执行命令' })
        }
        const accepted = await approve(
          { kind: 'command', program: args.program, args: [...args.args], cwd },
          signal
        )
        signal.throwIfAborted()
        if (!assertAccess()) return result('error', { error: '工作区授权已失效' })
        if (!accepted) return result('cancelled', { error: '用户未批准命令执行' })
        await checkedRoot(root, assertAccess)
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
        return await runCommand(cwd, args.program, args.args, signal, assertAccess)
      } catch (error) {
        signal.throwIfAborted()
        return result('error', { error: error instanceof Error ? error.message : '命令执行失败' })
      }
    }

    return result('error', { error: '未知工作区工具' })
  }
}
