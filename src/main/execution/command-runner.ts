import { spawn } from 'node:child_process'
import { claimCommandExecution, type CommandExecutionPlan } from './command-plan'

export type CommandOutput = {
  stdout: string
  stderr: string
  totalBytes: number
  truncated: boolean
}
export type CommandTermination = {
  treeExited: boolean
  stopped: boolean
  exitCode: number | null
}
export type CommandProcess = {
  /** Resolves after the host exits, or with an explicitly unconfirmed tree on deadline. */
  stop: () => Promise<CommandTermination>
}
type CommandProcessOptions = {
  plan: CommandExecutionPlan
  timeoutMs: number
  outputLimit: number
  outputMode: 'bytes' | 'text'
  beforeSpawn?: () => void
  signal?: AbortSignal
  access?: { check: () => boolean; intervalMs: number }
  onOutput?: (stream: 'stdout' | 'stderr', text: string, output: CommandOutput) => void
  onError: (error: Error, output: CommandOutput, outcome: CommandTermination) => void
  onClose: (
    code: number | null,
    signal: NodeJS.Signals | null,
    output: CommandOutput,
    outcome: CommandTermination
  ) => void
  onTimeout: (process: CommandProcess, output: CommandOutput) => void
  onAbort?: (process: CommandProcess) => void
  onAccessLost?: (process: CommandProcess, output: CommandOutput) => void
}
type TerminalFrame = CommandTermination & { error?: string }
const SHUTDOWN_DEADLINE = 10_000
const MAX_FRAME = 64 * 1024

/** Only a signed main-process plan can launch. The host wraps all untrusted child output. */
export function startCommandProcess(options: CommandProcessOptions): CommandProcess {
  const launch = claimCommandExecution(options.plan, options.timeoutMs)
  let child: ReturnType<typeof spawn>
  try {
    options.signal?.throwIfAborted()
    options.beforeSpawn?.()
    child = spawn(launch.program, launch.args, {
      cwd: launch.cwd,
      env: launch.environment,
      shell: false,
      windowsHide: true,
      stdio: [launch.supervised ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    launch.cleanup()
    throw error
  }
  const stdout: Buffer[] = [],
    stderr: Buffer[] = []
  let bytes = 0,
    truncated = false,
    finished = false,
    stopping = false
  let started = false,
    protocol = '',
    terminal: TerminalFrame | undefined
  let failure: Error | undefined
  let accessTimer: NodeJS.Timeout | undefined, shutdownTimer: NodeJS.Timeout | undefined
  let resolveExit!: (outcome: CommandTermination) => void
  const exited = new Promise<CommandTermination>((resolve) => {
    resolveExit = resolve
  })
  const captured = (): CommandOutput => ({
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    totalBytes: bytes,
    truncated
  })
  const controlsOff = (): void => {
    clearTimeout(timer)
    clearInterval(accessTimer)
    options.signal?.removeEventListener('abort', aborted)
  }
  const complete = (
    code: number | null,
    closedSignal: NodeJS.Signals | null,
    deadline = false
  ): void => {
    if (finished) return
    finished = true
    controlsOff()
    clearTimeout(shutdownTimer)
    const outcome: CommandTermination = {
      treeExited:
        !deadline && (!child.pid || (launch.supervised && !failure && !!terminal?.treeExited)),
      stopped: stopping || terminal?.stopped === true,
      exitCode: terminal?.exitCode ?? code
    }
    // A valid native error may still prove a zero-member Job. Protocol errors cannot.
    if (!deadline && launch.supervised && terminal?.error && !failure)
      outcome.treeExited = terminal.treeExited
    launch.cleanup()
    resolveExit(outcome)
    const error = failure ?? (terminal?.error ? new Error(terminal.error) : undefined)
    if (error) options.onError(error, captured(), outcome)
    else options.onClose(outcome.exitCode, closedSignal, captured(), outcome)
  }
  const control: CommandProcess = {
    stop: () => {
      if (finished || stopping) return exited
      stopping = true
      controlsOff()
      if (launch.supervised) child.stdin?.end('stop\n')
      else child.kill()
      shutdownTimer = setTimeout(() => {
        failure ??= new Error('已请求终止命令；进程树退出未确认')
        child.kill()
        child.stdout?.destroy()
        child.stderr?.destroy()
        complete(null, null, true)
      }, SHUTDOWN_DEADLINE)
      return exited
    }
  }
  function aborted(): void {
    if (finished || stopping) return
    options.onAbort?.(control)
    void control.stop()
  }
  function collect(stream: 'stdout' | 'stderr', raw: Buffer): void {
    if (finished || (options.outputMode === 'text' && truncated)) return
    const value = options.outputMode === 'text' ? Buffer.from(raw.toString('utf8'), 'utf8') : raw
    const remaining = Math.max(0, options.outputLimit - bytes)
    const clipped = value.subarray(0, remaining)
    if (clipped.length) (stream === 'stdout' ? stdout : stderr).push(clipped)
    bytes += clipped.length
    if (value.length > remaining) truncated = true
    options.onOutput?.(stream, clipped.toString('utf8'), captured())
  }
  function protocolFailure(): void {
    failure ??= new Error('命令监督器协议无效；执行结果需核对')
    void control.stop()
  }
  function frame(line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (!value || Array.isArray(value) || terminal) return protocolFailure()
      const keys = (expected: string[]): boolean =>
        Object.keys(value).length === expected.length && expected.every((key) => key in value)
      if (
        value.type === 'started' &&
        !started &&
        keys(['type', 'pid']) &&
        Number.isInteger(value.pid) &&
        Number(value.pid) > 0
      ) {
        started = true
      } else if (
        value.type === 'output' &&
        started &&
        keys(['type', 'stream', 'data']) &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.data === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
      ) {
        collect(value.stream, Buffer.from(value.data, 'base64'))
      } else if (
        value.type === 'closed' &&
        started &&
        keys(['type', 'exitCode', 'treeExited', 'stopped']) &&
        Number.isInteger(value.exitCode) &&
        typeof value.treeExited === 'boolean' &&
        typeof value.stopped === 'boolean'
      ) {
        terminal = {
          exitCode: Number(value.exitCode),
          treeExited: value.treeExited,
          stopped: value.stopped
        }
      } else if (
        value.type === 'error' &&
        keys(['type', 'message', 'treeExited']) &&
        typeof value.message === 'string' &&
        value.message.length <= 2000 &&
        typeof value.treeExited === 'boolean'
      ) {
        terminal = {
          error: value.message,
          exitCode: null,
          treeExited: value.treeExited,
          stopped: stopping
        }
      } else protocolFailure()
    } catch {
      protocolFailure()
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    if (finished) return
    if (!launch.supervised) return collect('stdout', chunk)
    protocol += chunk.toString('ascii')
    let newline: number
    while ((newline = protocol.indexOf('\n')) >= 0) {
      if (newline > MAX_FRAME) {
        protocol = ''
        protocolFailure()
        return
      }
      const line = protocol.slice(0, newline)
      protocol = protocol.slice(newline + 1)
      frame(line)
    }
    if (protocol.length > MAX_FRAME) {
      protocol = ''
      protocolFailure()
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    collect('stderr', chunk)
    if (launch.supervised) protocolFailure()
  })
  child.stdin?.on('error', () => {
    /* Host closure is confirmed by its close event below. */
  })
  child.once('error', (error) => {
    failure = error
  })
  child.once('close', (code, closedSignal) => {
    if (
      launch.supervised &&
      child.pid &&
      (!terminal || protocol.length || (!terminal.error && code !== 0))
    ) {
      failure ??= new Error('命令监督器意外结束；进程树退出未确认')
    }
    complete(code, closedSignal)
  })
  const timer = setTimeout(() => {
    if (finished || stopping) return
    options.onTimeout(control, captured())
    void control.stop()
  }, options.timeoutMs)
  if (options.access)
    accessTimer = setInterval(() => {
      if (finished || stopping) return
      let allowed = false
      try {
        allowed = options.access!.check()
      } catch {
        /* Revoked or unavailable means stop. */
      }
      if (!allowed) {
        options.onAccessLost?.(control, captured())
        void control.stop()
      }
    }, options.access.intervalMs)
  options.signal?.addEventListener('abort', aborted, { once: true })
  if (options.signal?.aborted) aborted()
  return control
}
