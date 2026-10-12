import { isAbsolute } from 'node:path'
import * as pty from 'node-pty'
import { isTerminalId, isTerminalSize } from '../../shared/terminal'
import type { TerminalResult } from '../../shared/terminal'
import { terminalHostError } from './terminal-host-contract'
import type { TerminalHostMessage, TerminalHostRequest } from './terminal-host-contract'

export type TerminalHostPort = {
  on: (event: 'message', listener: (event: { data: unknown }) => void) => unknown
  postMessage: (message: TerminalHostMessage) => void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequest(value: unknown): TerminalHostRequest | null {
  if (!record(value) || !isTerminalId(value.sessionId)) return null
  if (value.type === 'init') {
    if (
      typeof value.program !== 'string' ||
      !value.program ||
      value.program.length > 32768 ||
      value.program.includes('\0') ||
      !isAbsolute(value.program) ||
      typeof value.cwd !== 'string' ||
      !value.cwd ||
      value.cwd.length > 32768 ||
      value.cwd.includes('\0') ||
      !isAbsolute(value.cwd) ||
      !Array.isArray(value.args) ||
      value.args.length > 16 ||
      !value.args.every(
        (argument) =>
          typeof argument === 'string' && argument.length <= 1024 && !argument.includes('\0')
      ) ||
      !isTerminalSize(value.size)
    )
      return null
    return {
      type: 'init',
      sessionId: value.sessionId,
      program: value.program,
      args: [...value.args],
      cwd: value.cwd,
      size: { cols: value.size.cols, rows: value.size.rows }
    }
  }
  if (value.type === 'retire') return { type: 'retire', sessionId: value.sessionId }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return null
  const common = { sessionId: value.sessionId, sequence: value.sequence as number }
  if (value.type === 'write') {
    if (typeof value.data !== 'string' || value.data.length === 0 || value.data.length > 8192)
      return null
    return { type: 'write', ...common, data: value.data }
  }
  if (value.type === 'resize' && isTerminalSize(value.size))
    return { type: 'resize', ...common, size: { cols: value.size.cols, rows: value.size.rows } }
  if (value.type === 'close') return { type: 'close', ...common }
  return null
}

/** A utility process owns one PTY; the desktop thread never calls its native methods. */
export function installTerminalHost(
  parentPort: TerminalHostPort,
  dependencyPty: Pick<typeof pty, 'spawn'>,
  dependencyExit: (code: number) => void = (code) => {
    setImmediate(() => process.exit(code))
  }
): void {
  let sessionId: string | null = null
  let child: pty.IPty | null = null
  let exited = false
  let exitSubscribed = false
  let closing = false
  let finished = false
  let retirementTimer: NodeJS.Timeout | undefined
  let lastSequence = 0
  const subscriptions: pty.IDisposable[] = []
  const closeSequences = new Set<number>()

  function send(message: TerminalHostMessage): boolean {
    try {
      parentPort.postMessage(message)
      return true
    } catch (error) {
      console.error('终端宿主发送失败：', terminalHostError(error))
      return false
    }
  }

  function result(sequence: number, value: TerminalResult): void {
    if (sessionId) send({ type: 'result', sessionId, sequence, result: value })
  }

  function finish(code: number): void {
    if (finished) return
    finished = true
    clearTimeout(retirementTimer)
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.dispose()
      } catch (error) {
        console.error('终端宿主订阅释放失败：', terminalHostError(error))
      }
    }
    dependencyExit(code)
  }

  function keep(subscription: pty.IDisposable): void {
    // A very short shell can exit inside onExit registration itself.
    if (exited) subscription.dispose()
    else subscriptions.push(subscription)
  }

  function observeExit(): void {
    if (!child || exitSubscribed || exited) return
    const subscription = child.onExit(({ exitCode }) => {
      if (exited || !sessionId) return
      exited = true
      for (const sequence of closeSequences) result(sequence, { ok: true })
      closeSequences.clear()
      // Patched node-pty publishes onExit only after its owned cleanup completes.
      // Wait for main's receipt before ending this process so IPC tail messages cannot be lost.
      retirementTimer = setTimeout(() => finish(1), 5000)
      if (!send({ type: 'exit', sessionId, exitCode })) finish(1)
    })
    exitSubscribed = true
    keep(subscription)
  }

  function failClose(error: unknown): void {
    if (exited) return
    closing = false
    const message = terminalHostError(error)
    if (closeSequences.size) {
      for (const sequence of closeSequences) result(sequence, { ok: false, error: message })
      closeSequences.clear()
    } else if (sessionId) {
      send({ type: 'error', sessionId, error: message })
    }
  }

  function stop(sequence?: number): void {
    if (!child || exited) {
      if (sequence !== undefined) result(sequence, { ok: true })
      return
    }
    if (sequence !== undefined) {
      if (closeSequences.size >= 64) {
        result(sequence, { ok: false, error: '终端关闭请求过多，请等待后重试' })
        return
      }
      closeSequences.add(sequence)
    }
    if (closing) return
    closing = true
    let subscriptionError: unknown
    try {
      // A failed startup subscription keeps the child and retries on close.
      observeExit()
    } catch (error) {
      subscriptionError = error
    }
    try {
      if (!exited) child.kill()
    } catch (error) {
      failClose(error)
      return
    }
    if (subscriptionError) failClose(subscriptionError)
  }

  function initialize(request: Extract<TerminalHostRequest, { type: 'init' }>): void {
    if (sessionId) return
    sessionId = request.sessionId
    try {
      child = dependencyPty.spawn(request.program, request.args, {
        name: 'xterm-256color',
        cols: request.size.cols,
        rows: request.size.rows,
        cwd: request.cwd,
        env: process.env
      })
      observeExit()
      if (exited) return
      keep(
        child.onData((data) => {
          if (!exited && !closing && sessionId && !send({ type: 'data', sessionId, data })) stop()
        })
      )
      if (!exited && !send({ type: 'ready', sessionId })) stop()
    } catch (error) {
      if (exited) return
      send({ type: 'error', sessionId, error: terminalHostError(error) })
      // Never discard an owned PTY merely because attaching a listener failed.
      if (child) stop()
      else finish(1)
    }
  }

  parentPort.on('message', ({ data }) => {
    if (finished) return
    const request = parseRequest(data)
    if (!request) {
      if (record(data) && isTerminalId(data.sessionId) && data.sessionId === sessionId) {
        if (Number.isSafeInteger(data.sequence) && (data.sequence as number) >= 1)
          result(data.sequence as number, { ok: false, error: '终端宿主请求无效' })
        else send({ type: 'error', sessionId: data.sessionId, error: '终端宿主请求无效' })
      }
      return
    }
    if (request.type === 'init') {
      initialize(request)
      return
    }
    if (request.sessionId !== sessionId) return
    if (request.type === 'retire') {
      if (exited) finish(0)
      return
    }
    if (request.sequence <= lastSequence) {
      result(request.sequence, { ok: false, error: '终端宿主请求已失效' })
      return
    }
    lastSequence = request.sequence
    if (request.type === 'close') {
      stop(request.sequence)
      return
    }
    if (!child || exited || closing) {
      result(request.sequence, { ok: false, error: '终端已经关闭或正在关闭' })
      return
    }
    try {
      if (request.type === 'write') child.write(request.data)
      else child.resize(request.size.cols, request.size.rows)
      result(request.sequence, { ok: true })
    } catch (error) {
      result(request.sequence, { ok: false, error: terminalHostError(error) })
    }
  })
}

if (process.parentPort) installTerminalHost(process.parentPort, pty)
