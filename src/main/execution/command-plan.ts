import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync
} from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PermissionsState } from '../../shared/execution'
import { isAgentId } from '../../shared/agent'
import {
  inspectCommandHost,
  inspectWindowsCommandBackend,
  verifyCommandHost,
  verifyWindowsCommandBackend
} from './windows-command-backend'

export type CommandRequest = Readonly<{
  program: string
  args: readonly string[]
  cwd: string
  sandbox_permissions?: 'use_default' | 'require_escalated'
  justification?: string | null
}>
export type CommandOwner = Readonly<
  | { kind: 'desktop'; windowId: number; conversationId: string; requestId: string }
  | { kind: 'cli'; runId: string; conversationId: string; requestId: string }
>

type PlanContext = {
  owner: CommandOwner
  permissions: PermissionsState
  scopeId: string
  writableRoots: readonly string[]
  environment: 'tool' | 'legacy'
  assertCurrent: () => boolean
  /** Fixed application resource directory supplied by a trusted ordinary Node host. */
  runtimeRoot?: string
}
export type PreparedCommandExecution = Readonly<{
  command: CommandRequest
  permissions: Readonly<PermissionsState>
  sandboxAvailable: boolean
  reason: string
}>
export type CommandExecutionPlan = Readonly<{ command: CommandRequest; authorization: string }>
export type CommandAuthorize = (
  request: CommandRequest,
  signal: AbortSignal
) => Promise<CommandExecutionPlan | null>

const TOOL_ENV =
  /^(?:path|pathext|systemroot|windir|temp|tmp|home|userprofile|homedrive|homepath|lang|lc_all)$/i
const SECRET_ENV =
  /(?:^MODEL_|^OPENAI_|^CODEX_|^AZURE_OPENAI_|TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|NODE_OPTIONS|NODE_EXTRA_CA_CERTS)/i
const prepared = new WeakMap<PreparedCommandExecution, InternalPlan>()
const signed = new WeakMap<CommandExecutionPlan, InternalPlan>()
type Host = NonNullable<Awaited<ReturnType<typeof inspectCommandHost>>>
type Backend = NonNullable<Awaited<ReturnType<typeof inspectWindowsCommandBackend>>>
type InternalPlan = {
  context: PlanContext
  command: CommandRequest
  executable: string
  args: readonly string[]
  executableIdentity: string
  host: Host | null
  backend: Backend | null
  environment: Readonly<NodeJS.ProcessEnv>
  writableRoots: readonly string[]
  protectedPaths: readonly string[]
  temporaryRoot: string | null
  signal: AbortSignal
  sandbox: boolean
  cleanup: () => void
  directories: readonly Readonly<{ path: string; identity: string }>[]
  gitPointers: readonly Readonly<{ path: string; content: string }>[]
  protections: readonly Readonly<{ path: string; identity: string | null }>[]
}

function within(root: string, target: string): boolean {
  const offset = relative(root, target)
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}
function identity(file: string): string {
  const snapshot = (): string => {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024 * 1024)
      throw new Error('命令程序不是有效的普通文件')
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }
  const before = snapshot()
  const descriptor = openSync(file, 'r')
  try {
    const stat = fstatSync(descriptor)
    if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== before)
      throw new Error('命令程序已变化')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(256 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, stat.size - offset),
        offset
      )
      if (!count) throw new Error('命令程序已变化')
      hash.update(chunk.subarray(0, count))
      offset += count
    }
    const after = fstatSync(descriptor)
    if (
      `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== before ||
      snapshot() !== before
    )
      throw new Error('命令程序已变化')
    return `${before}:${hash.digest('hex')}`
  } finally {
    closeSync(descriptor)
  }
}
function commandEnvironment(kind: 'tool' | 'legacy'): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !SECRET_ENV.test(key) && (kind === 'legacy' || TOOL_ENV.test(key))
    )
  )
}
function directoryIdentity(path: string): string {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()
  )
    throw new Error('命令运行目录已变化')
  return `${stat.dev}:${stat.ino}`
}
function protectionIdentity(path: string): string | null {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (
    stat.isSymbolicLink() ||
    resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase() ||
    (!stat.isFile() && !stat.isDirectory())
  )
    throw new Error('命令受保护路径已变化')
  return `${stat.dev}:${stat.ino}:${stat.isDirectory() ? 'directory' : `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`}`
}
async function resolveProgram(
  program: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const search =
    isAbsolute(program) || /[\\/]/.test(program)
      ? [resolve(cwd, program)]
      : [cwd, ...(env.Path ?? env.PATH ?? '').split(delimiter)]
          .filter(Boolean)
          .map((root) => join(root, program))
  const extensions =
    process.platform === 'win32' && !/\.[^\\/]+$/.test(program)
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : ['']
  for (const candidate of search) {
    for (const extension of extensions) {
      const file = candidate + extension
      try {
        const stat = await lstat(file)
        if (stat.isFile() && !stat.isSymbolicLink()) return await realpath(file)
      } catch {
        /* Continue looking for this exact executable name. */
      }
    }
  }
  throw new Error(`找不到命令程序：${program}`)
}
async function protectedPaths(
  roots: readonly string[]
): Promise<{ paths: string[]; gitPointers: { path: string; content: string }[] }> {
  const paths = roots.flatMap((root) =>
    ['.git', '.agents', '.codex', '.aws'].map((name) => join(root, name))
  )
  const gitPointers: { path: string; content: string }[] = []
  for (const path of paths) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('命令受保护目录不能是链接')
  }
  for (const root of roots) {
    const git = join(root, '.git')
    try {
      const stat = await lstat(git)
      if (stat.isSymbolicLink()) throw new Error('工作区 .git 不能是链接')
      if (stat.isFile()) {
        if (stat.size > 4096) throw new Error('工作区 .git 指向文件无效')
        const text = await readFile(git, 'utf8')
        const match = /^gitdir:\s*([^\r\n]+)\s*$/i.exec(text.trim())
        if (!match) throw new Error('工作区 .git 指向文件无效')
        paths.push(await realpath(resolve(root, match[1])))
        gitPointers.push({ path: git, content: text })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { paths: [...new Set(paths)], gitPointers }
}

/** Preparation never grants permission. All launch material is copied before approval. */
export async function prepareCommandExecution(
  request: CommandRequest,
  context: PlanContext,
  signal: AbortSignal
): Promise<PreparedCommandExecution> {
  // Snapshot caller-owned material before any asynchronous operation.
  request = Object.freeze({
    program: request.program,
    args: Object.freeze([...request.args]),
    cwd: request.cwd,
    sandbox_permissions: request.sandbox_permissions,
    justification: request.justification
  })
  context = {
    ...context,
    owner: Object.freeze({ ...context.owner }),
    permissions: Object.freeze({ ...context.permissions }),
    writableRoots: Object.freeze([...context.writableRoots])
  }
  const current = (): void => {
    signal.throwIfAborted()
    if (!context.assertCurrent()) throw new Error('命令运行范围已失效')
  }
  current()
  if (
    !isAgentId(context.owner.conversationId) ||
    !isAgentId(context.owner.requestId) ||
    (context.owner.kind === 'desktop'
      ? !Number.isSafeInteger(context.owner.windowId) || context.owner.windowId <= 0
      : context.owner.kind !== 'cli' || !isAgentId(context.owner.runId)) ||
    (context.runtimeRoot !== undefined &&
      (typeof context.runtimeRoot !== 'string' || !isAbsolute(context.runtimeRoot)))
  )
    throw new Error('命令宿主来源或资源目录无效')
  if (context.owner.kind === 'cli' && process.platform !== 'win32')
    throw new Error('此脚本入口的命令执行只支持 Windows，本次未启动命令')
  if (
    !request.program ||
    request.program.includes('\0') ||
    request.args.some((arg) => arg.includes('\0')) ||
    !isAbsolute(request.cwd)
  ) {
    throw new Error('命令参数无效')
  }
  const cwd = await realpath(request.cwd)
  current()
  const roots = await Promise.all(context.writableRoots.map((root) => realpath(root)))
  const directories = [...new Set([cwd, ...roots])].map((path) =>
    Object.freeze({ path, identity: directoryIdentity(path) })
  )
  current()
  const environment = commandEnvironment(context.environment)
  let executable = await resolveProgram(request.program, cwd, environment)
  let args = [...request.args]
  // npm.cmd cannot be executed by CreateProcessW. Use npm's real Node entry point,
  // without constructing shell text or evaluating the command shim.
  if (process.platform === 'win32' && /(?:^|[\\/])npm(?:\.cmd)?$/i.test(executable)) {
    const npmEntry = join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const nodeEntry = join(dirname(executable), 'node.exe')
    if (!existsSync(npmEntry) || !existsSync(nodeEntry))
      throw new Error('npm 的真实 Node 入口不可用')
    executable = await realpath(nodeEntry)
    args = [await realpath(npmEntry), ...args]
  } else if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    throw new Error('批处理命令需要明确的程序入口，本次未拼接 Shell 执行')
  }
  current()
  const backend =
    context.permissions.mode === 'full-access'
      ? null
      : await inspectWindowsCommandBackend(context.runtimeRoot)
  const host = backend?.host ?? (await inspectCommandHost(context.runtimeRoot))
  current()
  if (process.platform === 'win32' && !host)
    throw new Error('Windows 命令监督器不可用或已变化，本次未启动命令')
  const sandbox =
    !!backend &&
    roots.some((root) => within(root, cwd)) &&
    request.sandbox_permissions !== 'require_escalated'
  const temporaryRoot = sandbox ? await mkdtemp(join(tmpdir(), 'zonecodex-command-')) : null
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    signal.removeEventListener('abort', cleanup)
    if (temporaryRoot)
      void rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
  signal.addEventListener('abort', cleanup, { once: true })
  if (temporaryRoot) environment.TEMP = environment.TMP = temporaryRoot
  let protectedEntries: { paths: string[]; gitPointers: { path: string; content: string }[] }
  try {
    protectedEntries = sandbox ? await protectedPaths(roots) : { paths: [], gitPointers: [] }
    // A workspace may contain the development checkout or an installed app.
    // Its commands must not replace the trusted host/manifest used by later plans.
    if (sandbox && backend) protectedEntries.paths.push(dirname(backend.host.path))
    current()
  } catch (error) {
    cleanup()
    throw error
  }
  const command = Object.freeze({
    program: request.program,
    cwd,
    args: Object.freeze([...request.args]),
    sandbox_permissions: request.sandbox_permissions,
    justification: request.justification
  })
  const result: PreparedCommandExecution = Object.freeze({
    command,
    permissions: Object.freeze({ ...context.permissions }),
    sandboxAvailable: sandbox,
    reason:
      request.sandbox_permissions === 'require_escalated'
        ? `此命令请求在当前受限环境之外运行。${request.justification ? ` ${request.justification}` : ''}`.slice(
            0,
            1000
          )
        : !roots.some((root) => within(root, cwd))
          ? '此命令的工作目录位于当前可写范围之外，将以本机权限运行。'
          : '当前 Windows 受限执行后端不可用，本次命令将以本机权限运行。'
  })
  try {
    const protections = Object.freeze(
      protectedEntries.paths.map((path) =>
        Object.freeze({ path, identity: protectionIdentity(path) })
      )
    )
    prepared.set(result, {
      context: {
        ...context,
        owner: Object.freeze({ ...context.owner }),
        permissions: result.permissions,
        writableRoots: Object.freeze(roots)
      },
      command,
      executable,
      args: Object.freeze(args),
      executableIdentity: identity(executable),
      host,
      backend,
      environment: Object.freeze(environment),
      writableRoots: Object.freeze(roots),
      // Missing default metadata paths remain snapshots, not explicit ACL targets.
      protectedPaths: Object.freeze(
        protections.filter((item) => item.identity !== null).map((item) => item.path)
      ),
      gitPointers: Object.freeze(protectedEntries.gitPointers.map((item) => Object.freeze(item))),
      protections,
      directories: Object.freeze(directories),
      temporaryRoot,
      signal,
      sandbox,
      cleanup
    })
  } catch (error) {
    cleanup()
    throw error
  }
  return result
}

/** Only main-process policy/approval owners can sign the prepared concrete command. */
export function authorizeCommandExecution(
  candidate: PreparedCommandExecution,
  authorization: 'sandbox' | 'full-access' | 'manual' | 'review'
): CommandExecutionPlan {
  const value = prepared.get(candidate)
  if (!value) throw new Error('命令准备已使用或无效')
  value.signal.throwIfAborted()
  if (!value.context.assertCurrent()) throw new Error('命令运行范围已失效')
  if (
    (authorization === 'sandbox') !== value.sandbox ||
    (authorization === 'full-access' && value.context.permissions.mode !== 'full-access')
  ) {
    throw new Error('命令批准与执行后端不一致')
  }
  prepared.delete(candidate)
  const plan = Object.freeze({ command: value.command, authorization })
  signed.set(plan, value)
  return plan
}

export type CommandLaunch = {
  program: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  supervised: boolean
  cleanup: () => void
}

/** Rejected or abandoned preparations never leave their private temporary directory. */
export function discardCommandExecution(
  value: PreparedCommandExecution | CommandExecutionPlan
): void {
  const internal =
    prepared.get(value as PreparedCommandExecution) ?? signed.get(value as CommandExecutionPlan)
  prepared.delete(value as PreparedCommandExecution)
  signed.delete(value as CommandExecutionPlan)
  internal?.cleanup()
}

/** One-time consumption, identity checks and scope checks precede every spawn attempt. */
export function claimCommandExecution(
  plan: CommandExecutionPlan,
  timeoutMs: number
): CommandLaunch {
  const value = signed.get(plan)
  if (!value) throw new Error('命令执行计划已使用或无效')
  signed.delete(plan)
  try {
    value.signal.throwIfAborted()
    if (!value.context.assertCurrent() || identity(value.executable) !== value.executableIdentity)
      throw new Error('命令来源或程序已变化')
    if (
      value.directories.some((item) => directoryIdentity(item.path) !== item.identity) ||
      value.gitPointers.some((item) => readFileSync(item.path, 'utf8') !== item.content) ||
      value.protections.some((item) => protectionIdentity(item.path) !== item.identity)
    )
      throw new Error('命令目录或 Git 指向已变化')
    if (value.host && !verifyCommandHost(value.host, value.context.runtimeRoot))
      throw new Error('命令监督器已变化')
    let program = value.executable
    let args = [...value.args]
    const environment = { ...value.environment }
    if (value.sandbox) {
      if (!value.backend || !verifyWindowsCommandBackend(value.backend, value.context.runtimeRoot))
        throw new Error('Windows 沙箱后端已变化')
      const entries = [
        { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
        ...[...value.writableRoots, value.temporaryRoot!].map((path) => ({
          path: { type: 'path', path },
          access: 'write'
        })),
        ...value.protectedPaths.map((path) => ({ path: { type: 'path', path }, access: 'read' }))
      ]
      const state = {
        permissionProfile: {
          type: 'managed',
          file_system: { type: 'restricted', entries },
          network: 'restricted'
        },
        codexLinuxSandboxExe: null,
        sandboxCwd: pathToFileURL(value.command.cwd).href,
        useLegacyLandlock: false
      }
      const set = Object.entries(value.environment)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`)
        .join(',')
      program = value.backend.cliPath
      args = [
        'sandbox',
        '-c',
        'windows.sandbox="elevated"',
        '-c',
        `shell_environment_policy={inherit="none",set={${set}}}`,
        '--sandbox-state-json',
        JSON.stringify(state),
        '--sandbox-state-disable-network',
        '--',
        value.executable,
        ...value.args
      ]
      environment.CODEX_HOME = value.backend.codexHome
    }
    const launch = value.host
      ? {
          program: value.host.path,
          args: [
            '--cwd',
            value.command.cwd,
            '--timeout-ms',
            String(timeoutMs),
            '--',
            program,
            ...args
          ],
          cwd: value.command.cwd,
          environment,
          supervised: true,
          cleanup: value.cleanup
        }
      : {
          program,
          args,
          cwd: value.command.cwd,
          environment,
          supervised: false,
          cleanup: value.cleanup
        }
    if (
      process.platform === 'win32' &&
      launch.args.reduce((length, arg) => length + arg.length * 2 + 3, launch.program.length) >
        30_000
    )
      throw new Error('命令超过 Windows 参数长度限制')
    value.signal.removeEventListener('abort', value.cleanup)
    return launch
  } catch (error) {
    value.cleanup()
    throw error
  }
}

export function commandScopeIdentity(cwd: string, state: PermissionsState): string {
  return createHash('sha256')
    .update(JSON.stringify({ cwd, ...state }))
    .digest('hex')
}
