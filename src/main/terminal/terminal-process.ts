import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { isTerminalId, parseTerminalResult } from '../../shared/terminal'
import type { TerminalSize } from '../../shared/terminal'
import type { TerminalHostRequest } from './terminal-host-contract'
import { terminalHostError } from './terminal-host-contract'

type Subscription = { dispose: () => void }
export type TerminalProcessExit = { exitCode: number; error?: string }
export type TerminalProcess = {
  ready: Promise<void>
  onData: (listener: (data: string) => void) => Subscription
  onExit: (listener: (event: TerminalProcessExit) => void) => Subscription
  write: (data: string) => Promise<void>
  resize: (cols: number, rows: number) => Promise<void>
  kill: () => Promise<void>
}
type Pending = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const START_TIMEOUT_MS = 8000
const COMMAND_TIMEOUT_MS = 5000
const HOST_CLOSE_TIMEOUT_MS = 12000

// Keep IDE injection out of the internal host without mutating the desktop environment.
export function terminalHostEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^(NODE_OPTIONS|VSCODE_INSPECTOR_OPTIONS|ELECTRON_RUN_AS_NODE|V8_INSPECTOR_(?:BRK_)?PORT)$/i.test(
          name
        )
    )
  )
}

export function createTerminalProcess(
  sessionId: string,
  shell: { program: string; args: string[] },
  cwd: string,
  size: TerminalSize
): TerminalProcess {
  const child = utilityProcess.fork(join(__dirname, 'terminal-host.js'), [], {
    execArgv: [],
    env: terminalHostEnvironment(process.env),
    cwd,
    stdio: 'pipe',
    serviceName: 'ZoneCodex Terminal'
  })
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: TerminalProcessExit) => void>()
  const pending = new Map<number, Pending>()
  let serial = 0
  let spawned = false
  const queued: TerminalHostRequest[] = []
  let ready = false
  let exited = false
  let closing: Promise<void> | undefined
  let cleanupExitCode: number | undefined
  let failure = ''
  let closeTimer: NodeJS.Timeout | undefined
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const started = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A very early host failure can precede the caller's await.
  void started.catch(() => undefined)

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  function terminate(error: string): void {
    if (exited) return
    failure ||= error
    clearTimeout(startTimer)
    rejectReady(new Error(failure))
    rejectPending(new Error(failure))
    try {
      child.kill()
    } catch (cause) {
      console.error('终端宿主终止失败：', terminalHostError(cause))
    }
    // Ownership stays live until the utility process actually emits exit.
  }
  const startTimer = setTimeout(
    () => terminate('终端启动超时，已请求结束独立宿主'),
    START_TIMEOUT_MS
  )
  child.once('spawn', () => {
    if (exited) return
    if (failure) {
      queued.length = 0
      terminate(failure)
      return
    }
    try {
      spawned = true
      child.postMessage({
        type: 'init',
        sessionId,
        ...shell,
        cwd,
        size
      } satisfies TerminalHostRequest)
      for (const message of queued.splice(0)) child.postMessage(message)
    } catch (error) {
      terminate(terminalHostError(error))
    }
  })
  let diagnosticBytes = 0
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (bytes: Buffer) => {
    if (diagnosticBytes >= 4096) return
    const text = bytes.subarray(0, 4096 - diagnosticBytes).toString('utf8')
    diagnosticBytes += bytes.length
    console.error('[终端宿主] ' + text.trim())
  })
  child.on('error', (_type, _location, detail) => {
    terminate('终端独立宿主异常：' + String(detail).slice(0, 180))
  })
  child.on('message', (value: unknown) => {
    if (exited || !value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    if (!isTerminalId(message.sessionId) || message.sessionId !== sessionId) return
    if (message.type === 'ready' && !ready && !failure) {
      ready = true
      clearTimeout(startTimer)
      resolveReady()
    } else if (
      message.type === 'data' &&
      typeof message.data === 'string' &&
      !closing &&
      !failure
    ) {
      for (const listener of dataListeners) listener(message.data)
    } else if (message.type === 'result' && Number.isSafeInteger(message.sequence)) {
      const request = pending.get(message.sequence as number)
      if (!request) return
      pending.delete(message.sequence as number)
      clearTimeout(request.timer)
      try {
        const result = parseTerminalResult(message.result)
        if (result.ok) request.resolve()
        else request.reject(new Error(result.error.slice(0, 300)))
      } catch (error) {
        request.reject(new Error(terminalHostError(error)))
      }
    } else if (message.type === 'exit' && Number.isInteger(message.exitCode)) {
      cleanupExitCode ??= message.exitCode as number
      // Receipt must precede helper exit; postMessage followed by process.exit can lose tail messages.
      try {
        child.postMessage({ type: 'retire', sessionId } satisfies TerminalHostRequest)
      } catch (error) {
        terminate(terminalHostError(error))
      }
    } else if (message.type === 'error' && typeof message.error === 'string') {
      failure ||= message.error.slice(0, 300)
      clearTimeout(startTimer)
      rejectReady(new Error(failure))
      rejectPending(new Error(failure))
      // The helper retains its PTY handle and performs public kill/exit cleanup.
      if (!closeTimer) closeTimer = setTimeout(() => terminate(failure), HOST_CLOSE_TIMEOUT_MS)
    }
  })
  child.once('exit', (code) => {
    if (exited) return
    exited = true
    clearTimeout(startTimer)
    clearTimeout(closeTimer)
    const error =
      failure ||
      (cleanupExitCode === undefined
        ? '终端宿主退出，PTY清理未确认'
        : code !== 0
          ? '终端宿主异常退出，退休确认未完成'
          : '')
    if (!error && cleanupExitCode !== undefined) resolveReady()
    else rejectReady(new Error(error || '终端已退出'))
    rejectPending(new Error(error || '终端已退出'))
    const event: TerminalProcessExit = {
      exitCode: cleanupExitCode ?? code,
      ...(error ? { error } : {})
    }
    for (const listener of exitListeners) listener(event)
    dataListeners.clear()
    exitListeners.clear()
  })

  function command(
    request:
      { type: 'write'; data: string } | { type: 'resize'; size: TerminalSize } | { type: 'close' }
  ): Promise<void> {
    if (exited) return Promise.reject(new Error('终端宿主已退出'))
    if (request.type !== 'close' && (!ready || closing || failure))
      return Promise.reject(new Error('终端尚未就绪或正在关闭'))
    if (pending.size >= 32 && request.type !== 'close')
      return Promise.reject(new Error('终端通信忙，请稍后重试'))
    const sequence = ++serial
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(sequence)
          reject(new Error('终端宿主通信超时'))
        },
        request.type === 'close' ? HOST_CLOSE_TIMEOUT_MS : COMMAND_TIMEOUT_MS
      )
      pending.set(sequence, { resolve, reject, timer })
      try {
        const message = { ...request, sessionId, sequence } satisfies TerminalHostRequest
        if (spawned) child.postMessage(message)
        else queued.push(message)
      } catch (error) {
        pending.delete(sequence)
        clearTimeout(timer)
        reject(new Error(terminalHostError(error)))
      }
    })
  }
  function subscribe<T>(listeners: Set<T>, listener: T): Subscription {
    listeners.add(listener)
    return { dispose: () => void listeners.delete(listener) }
  }
  return {
    ready: started,
    onData: (listener) => subscribe(dataListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
    write: (data) => command({ type: 'write', data }),
    resize: (cols, rows) => command({ type: 'resize', size: { cols, rows } }),
    kill: () => {
      if (exited) return Promise.resolve()
      if (closing) return closing
      closeTimer ??= setTimeout(
        () => terminate('终端关闭超时，PTY清理未确认，已请求结束独立宿主'),
        HOST_CLOSE_TIMEOUT_MS
      )
      const request = command({ type: 'close' })
      closing = request.catch((error: unknown) => {
        // Explicit native kill failure can be retried; a missing reply still has a host deadline.
        closing = undefined
        throw error
      })
      return closing
    }
  }
}
