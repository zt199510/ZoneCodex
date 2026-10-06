import { spawn } from 'node:child_process'

export type CommandOutput = {
  stdout: string
  stderr: string
  totalBytes: number
  truncated: boolean
}

export type CommandProcess = {
  /** Stop observation and request termination; this does not confirm process exit. */
  stop: () => void
}

type CommandProcessOptions = {
  program: string
  args: string[]
  cwd: string
  environment?: NodeJS.ProcessEnv
  timeoutMs: number
  outputLimit: number
  // The tool captures original bytes; the legacy IPC clips each decoded text chunk.
  outputMode: 'bytes' | 'text'
  beforeSpawn?: () => void
  signal?: AbortSignal
  access?: { check: () => boolean; intervalMs: number }
  onOutput?: (stream: 'stdout' | 'stderr', text: string, output: CommandOutput) => void
  onError: (error: Error, output: CommandOutput) => void
  onClose: (code: number | null, signal: NodeJS.Signals | null, output: CommandOutput) => void
  onTimeout: (process: CommandProcess, output: CommandOutput) => void
  onAbort?: (process: CommandProcess) => void
  onAccessLost?: (process: CommandProcess, output: CommandOutput) => void
}

/** Process mechanics only. Authorization, tasks and final receipts belong to each caller. */
export function startCommandProcess(options: CommandProcessOptions): CommandProcess {
  options.beforeSpawn?.()
  const child = spawn(options.program, options.args, {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    ...(options.environment ? { env: options.environment } : {}),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let truncated = false
  let finished = false
  let accessTimer: NodeJS.Timeout | undefined

  const captured = (): CommandOutput => ({
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    totalBytes: bytes,
    truncated
  })

  function dispose(): void {
    finished = true
    clearTimeout(timer)
    clearInterval(accessTimer)
    options.signal?.removeEventListener('abort', aborted)
  }

  const process: CommandProcess = {
    stop: () => {
      if (finished) return
      dispose()
      child.kill()
    }
  }
  function aborted(): void {
    if (!finished) options.onAbort?.(process)
  }

  function collect(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    if (finished || (options.outputMode === 'text' && truncated)) return
    const value =
      options.outputMode === 'text'
        ? Buffer.from(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk, 'utf8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
    const remaining = options.outputLimit - bytes
    const clipped = value.subarray(0, Math.max(0, remaining))
    if (remaining > 0) (stream === 'stdout' ? stdout : stderr).push(clipped)
    bytes += Math.min(remaining, value.length)
    if (value.length > remaining) truncated = true
    options.onOutput?.(stream, clipped.toString('utf8'), captured())
  }

  child.stdout?.on('data', (chunk: Buffer | string) => collect('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer | string) => collect('stderr', chunk))
  child.once('error', (error) => {
    if (finished) return
    dispose()
    options.onError(error, captured())
  })
  child.once('close', (code, signal) => {
    if (finished) return
    dispose()
    options.onClose(code, signal, captured())
  })
  const timer = setTimeout(() => {
    if (!finished) options.onTimeout(process, captured())
  }, options.timeoutMs)
  if (options.access) {
    accessTimer = setInterval(() => {
      if (!finished && !options.access?.check()) options.onAccessLost?.(process, captured())
    }, options.access.intervalMs)
  }
  options.signal?.addEventListener('abort', aborted, { once: true })
  if (options.signal?.aborted) aborted()
  return process
}
