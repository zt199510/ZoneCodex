import type { Writable } from 'node:stream'
import type { AgentCoreEvent } from '../main/agent/agent-core-contract'
import {
  isAgentId,
  parseAgentMessageEvent,
  parseAgentRetryEvent,
  parseAgentToolEvent,
  parseResponseMessageId
} from '../shared/agent'
import type { OutputMode } from './arguments'

export type CLIResult = {
  requestId: string
  conversationId: string
  task: {
    state: 'completed' | 'waiting_approval' | 'failed' | 'cancelled'
    result?: string
    error?: string
  }
  answer: string
  effects: { approved: boolean; started: boolean }
  toolResults: Array<{ callId: string; name: string; output: string }>
  elapsedMs: number
  exitCode: number
}

export class CLIOutputError extends Error {
  constructor(message = '输出通道关闭、写入失败或超过有界队列预算') {
    super(message)
  }
}

const MAX_PENDING_BYTES = 4 * 1024 * 1024
// After task cancellation, allow a healthy output stream to deliver its final
// record, but never keep the cancelled process alive for a blocked consumer.
const CANCELLED_FLUSH_GRACE_MS = 250
export function terminalText(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join('')
}

/** Every record is rebuilt from an explicit allowlist, never a spread protocol object. */
export function projectEvent(event: AgentCoreEvent): Record<string, unknown> {
  if (event.type === 'progress') {
    if (
      !isAgentId(event.requestId) ||
      typeof event.message !== 'string' ||
      event.message.length > 500
    )
      throw new CLIOutputError()
    return { type: 'progress', requestId: event.requestId, message: event.message }
  }
  if (event.type === 'delta') {
    if (
      !isAgentId(event.requestId) ||
      typeof event.delta !== 'string' ||
      event.delta.length > 100000
    )
      throw new CLIOutputError()
    return { type: 'delta', requestId: event.requestId, delta: event.delta }
  }
  if (event.type === 'message') {
    const value = parseAgentMessageEvent({
      requestId: event.event.requestId,
      messageId: event.event.messageId,
      phase: event.event.phase,
      text: event.event.text
    })
    if (!value) throw new CLIOutputError()
    return { type: 'message', ...value }
  }
  if (event.type === 'retry') {
    const value = parseAgentRetryEvent({
      requestId: event.event.requestId,
      round: event.event.round,
      retry: event.event.retry,
      maxRetries: event.event.maxRetries,
      delayMs: event.event.delayMs,
      reason: event.event.reason,
      ...(event.event.status !== undefined ? { status: event.event.status } : {})
    })
    if (!value) throw new CLIOutputError()
    return { type: 'retry', ...value }
  }
  if (event.type === 'tool') {
    const common = {
      requestId: event.event.requestId,
      callId: event.event.callId,
      name: event.event.name,
      phase: event.event.phase
    }
    const value = parseAgentToolEvent(
      event.event.phase === 'start'
        ? {
            ...common,
            arguments: event.event.arguments,
            ...(event.event.commentary !== undefined ? { commentary: event.event.commentary } : {})
          }
        : { ...common, output: event.event.output, durationMs: event.event.durationMs }
    )
    if (!value) throw new CLIOutputError()
    return { type: 'tool', ...value }
  }
  throw new CLIOutputError()
}

export function projectResult(result: CLIResult): Record<string, unknown> {
  if (
    !isAgentId(result.requestId) ||
    !isAgentId(result.conversationId) ||
    !['completed', 'waiting_approval', 'failed', 'cancelled'].includes(result.task.state) ||
    typeof result.answer !== 'string' ||
    result.answer.length > 16000 ||
    (result.task.result !== undefined &&
      (typeof result.task.result !== 'string' || result.task.result.length > 16000)) ||
    (result.task.error !== undefined &&
      (typeof result.task.error !== 'string' || result.task.error.length > 16000)) ||
    typeof result.effects.approved !== 'boolean' ||
    typeof result.effects.started !== 'boolean' ||
    !Array.isArray(result.toolResults) ||
    result.toolResults.length > 160 ||
    !Number.isSafeInteger(result.elapsedMs) ||
    result.elapsedMs < 0 ||
    ![0, 1, 2, 3, 130].includes(result.exitCode)
  )
    throw new CLIOutputError()
  const toolResults = result.toolResults.map((item) => {
    const checked = parseAgentToolEvent({
      requestId: result.requestId,
      callId: item.callId,
      name: item.name,
      phase: 'finish',
      output: item.output,
      durationMs: 0
    })
    if (!checked || checked.phase !== 'finish') throw new CLIOutputError()
    return { callId: checked.callId, name: checked.name, output: checked.output }
  })
  return {
    type: 'result',
    requestId: result.requestId,
    conversationId: result.conversationId,
    task: {
      state: result.task.state,
      ...(result.task.result !== undefined ? { result: result.task.result } : {}),
      ...(result.task.error !== undefined ? { error: result.task.error } : {})
    },
    answer: result.answer,
    effects: { approved: result.effects.approved, started: result.effects.started },
    toolResults,
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode
  }
}

/** Writes one record at a time and waits for the stream callback before the next. */
export class CLIOutput {
  private tail: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private ended = false
  private failure: CLIOutputError | null = null
  private requestId: string | null = null
  private openMessage: string | null = null
  private messages = new Map<string, string>()
  private deliveredToolResults = new Set<string>()
  private activeWrite: { stream: Writable; abandon: () => void } | null = null
  private readonly streamError = (): void => this.fail()
  private readonly streamClose = (): void => this.fail()

  constructor(
    private readonly mode: OutputMode,
    private readonly stdout: Writable,
    private readonly stderr: Writable,
    private readonly onFailure: (error: CLIOutputError) => void
  ) {
    for (const stream of new Set([stdout, stderr])) {
      stream.on('error', this.streamError)
      stream.on('close', this.streamClose)
    }
  }

  private fail(): void {
    if (this.failure) return
    this.failure = new CLIOutputError()
    this.onFailure(this.failure)
  }

  private enqueue(stream: Writable, text: string): void {
    if (this.failure) throw this.failure
    const size = Buffer.byteLength(text)
    if (this.queuedBytes + size > MAX_PENDING_BYTES) {
      this.fail()
      throw this.failure
    }
    this.queuedBytes += size
    this.tail = this.tail
      .then(async () => {
        if (this.failure) return
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const cleanup = (): void => {
            stream.removeListener('error', error)
            stream.removeListener('close', close)
            this.activeWrite = null
          }
          const error = (): void => {
            if (settled) return
            settled = true
            cleanup()
            reject(new CLIOutputError())
          }
          const close = (): void => error()
          if (stream.destroyed || stream.writableEnded) {
            reject(new CLIOutputError())
            return
          }
          stream.once('error', error)
          stream.once('close', close)
          this.activeWrite = { stream, abandon: error }
          try {
            stream.write(text, (cause) => {
              if (settled) return
              settled = true
              cleanup()
              if (cause) reject(new CLIOutputError())
              else resolve()
            })
          } catch {
            error()
          }
        })
      })
      .catch(() => this.fail())
      .finally(() => {
        this.queuedBytes -= size
      })
  }

  private newline(): void {
    if (this.openMessage !== null) {
      this.enqueue(this.stderr, '\n')
      this.openMessage = null
    }
  }

  diagnostic(text: string): void {
    this.newline()
    this.enqueue(this.stderr, terminalText(text) + '\n')
  }

  help(text: string): void {
    this.enqueue(this.stdout, text)
  }

  event(event: AgentCoreEvent): void {
    if (this.ended) return
    const projected = projectEvent(event)
    const id = projected.requestId as string
    if (this.requestId !== null && id !== this.requestId) return
    this.requestId = id
    if (this.mode === 'jsonl') {
      this.enqueue(this.stdout, JSON.stringify(projected) + '\n')
      return
    }
    if (event.type === 'progress') this.diagnostic(`[进展] ${event.message}`)
    else if (event.type === 'retry') {
      for (const key of this.messages.keys())
        if (parseResponseMessageId(key)?.round === event.event.round) this.messages.delete(key)
      this.diagnostic(
        `[重试 第${event.event.round}轮 ${event.event.retry}/5] 前一尝试过程已退休；等待${event.event.delayMs}毫秒（${event.event.reason}）`
      )
    } else if (event.type === 'tool') {
      if (event.event.phase === 'finish') this.deliveredToolResults.add(event.event.callId)
      this.diagnostic(
        event.event.phase === 'start'
          ? `[工具 ${event.event.name}] 开始`
          : `[工具 ${event.event.name}] ${event.event.output}`
      )
    } else if (event.type === 'message' && event.event.phase === 'commentary') {
      const { messageId, text } = event.event
      const previous = this.messages.get(messageId) ?? ''
      if (text === previous) return
      const suffix = text.startsWith(previous) ? text.slice(previous.length) : text
      if (this.openMessage !== messageId) {
        this.newline()
        this.enqueue(this.stderr, `[过程 ${messageId}] `)
        this.openMessage = messageId
      }
      this.enqueue(this.stderr, terminalText(suffix))
      this.messages.set(messageId, text)
    }
    // Structured messages already carry the same text as deltas. Final stdout
    // is written only from the safe outcome, never assembled from attempts.
  }

  terminal(result: CLIResult): void {
    if (this.ended) return
    const projected = projectResult(result)
    if (this.requestId !== null && result.requestId !== this.requestId) throw new CLIOutputError()
    this.ended = true
    this.newline()
    if (this.mode === 'jsonl') this.enqueue(this.stdout, JSON.stringify(projected) + '\n')
    else {
      for (const item of result.toolResults)
        if (!this.deliveredToolResults.has(item.callId))
          this.diagnostic(`[工具 ${item.name}] ${item.output}`)
      if (result.answer) this.enqueue(this.stdout, terminalText(result.answer) + '\n')
      if (result.exitCode !== 0)
        this.diagnostic(result.task.error ?? `任务结束：${result.task.state}`)
    }
    this.messages.clear()
    this.deliveredToolResults.clear()
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (!signal) await this.tail
    else {
      let timer: ReturnType<typeof setTimeout> | undefined
      let stop = (): void => {}
      const cancelled = new Promise<void>((resolve) => {
        stop = () => {
          if (timer !== undefined) return
          timer = setTimeout(() => {
            this.fail()
            const blocked = this.activeWrite
            blocked?.abandon()
            blocked?.stream.destroy()
            resolve()
          }, CANCELLED_FLUSH_GRACE_MS)
        }
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      })
      try {
        await Promise.race([this.tail, cancelled])
      } finally {
        signal.removeEventListener('abort', stop)
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    if (this.failure) throw this.failure
  }

  dispose(): void {
    for (const stream of new Set([this.stdout, this.stderr])) {
      stream.removeListener('error', this.streamError)
      stream.removeListener('close', this.streamClose)
    }
  }
}
