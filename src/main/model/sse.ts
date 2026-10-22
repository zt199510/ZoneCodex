export class StreamError extends Error {}
export class StreamConnectionError extends StreamError {}

/// 解析 SSE 流事件的类
export class SseParser {
  private line = ''
  private data: string[] = []
  private skipLF = false
  private frameSize = 0

  push(text: string): string[] {
    const frames: string[] = []
    const endLine = (): void => {
      if (this.line === '') {
        if (this.data.length > 0) frames.push(this.data.join('\n'))
        this.data = []
        this.frameSize = 0
      } else if (this.line === 'data' || this.line.startsWith('data:')) {
        const value = this.line === 'data' ? '' : this.line.slice(5)
        this.data.push(value.startsWith(' ') ? value.slice(1) : value)
      }
      this.line = ''
    }

    for (const char of text) {
      if (this.skipLF) {
        this.skipLF = false
        if (char === '\n') continue
      }
      this.frameSize++
      if (this.frameSize > 1_000_000) throw new StreamError('单条流事件过大。')
      if (char === '\r') {
        endLine()
        this.skipLF = true
      } else if (char === '\n') {
        endLine()
      } else {
        this.line += char
      }
    }
    return frames
  }
}
/// 判断值是否为 Record<string, unknown> 类型的类型保护函数
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function streamFailureDetails(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : null
  const error = response && isRecord(response.error)
    ? response.error : isRecord(event.error) ? event.error : event
  const incomplete = response && isRecord(response.incomplete_details)
    ? response.incomplete_details : null
  // Only known protocol codes are public. Server messages may echo private input,
  // addresses or credentials and must never be copied into chat or checkpoints.
  const reasons: Record<string, string> = {
    insufficient_quota: '服务额度不足，请检查服务端账户额度',
    rate_limit_exceeded: '服务请求限流，请稍后重试',
    invalid_api_key: '服务端拒绝密钥，请检查模型配置后重启',
    model_not_found: '模型不存在或当前账户无权使用',
    context_length_exceeded: '请求超过服务端上下文限制',
    max_output_tokens: '达到服务端输出长度限制',
    content_filter: '服务端内容过滤中止了回复',
    invalid_request_error: '服务端拒绝了请求格式或参数',
    server_error: '模型服务内部错误，请稍后重试'
  }
  const code = incomplete?.reason ?? error.code ?? error.type
  const reason = typeof code === 'string' && Object.hasOwn(reasons, code) ? reasons[code] : ''
  return `模型未完整完成回复，请重试。服务事件：${event.type}${reason ? `；${reason}` : '；服务未提供可公开的具体原因'}`
}

export type ResponseStreamEvent = Record<string, unknown>

// 读取 Responses SSE，并在 response.completed 时返回服务端的完整响应对象。
// 工具调用轮次可能没有 output_text，因此这里不要求文字非空；调用方按自己的协议校验 output。
export async function readResponseStreamResult(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void = () => undefined,
  onEvent: (event: ResponseStreamEvent) => void = () => undefined,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted()
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SseParser()
  let completed: Record<string, unknown> | null = null
  let outputTextLength = 0
  let totalEventSize = 0
  let responseSize = 0
  let rejectAborted: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject
  })
  // Keep the rejection handled even when abort occurs between reads.
  void aborted.catch(() => undefined)
  const abort = (): void => {
    rejectAborted?.(signal?.reason)
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', abort, { once: true })

  function accept(data: string): boolean {
    totalEventSize += data.length
    if (totalEventSize > 1_000_000) throw new StreamError('模型响应过大。')
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new StreamError('流事件不是有效 JSON。')
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      throw new StreamError('流事件格式不正确。')
    }
    responseSize += data.length
    if (responseSize > 1_000_000) throw new StreamError('模型响应过大。')
    onEvent(parsed)
    if (parsed.type === 'response.output_text.delta') {
      if (typeof parsed.delta !== 'string') throw new StreamError('文字片段格式不正确。')
      outputTextLength += parsed.delta.length
      if (outputTextLength > 100_000) throw new StreamError('回复超过本课显示长度上限。')
      onDelta(parsed.delta)
    } else if (parsed.type === 'response.completed') {
      if (!isRecord(parsed.response) || parsed.response.status !== 'completed') {
        throw new StreamError('完成事件的状态不正确。')
      }
      if (JSON.stringify(parsed.response).length > 1_000_000) {
        throw new StreamError('模型响应过大。')
      }
      completed = parsed.response
      return true
    } else if (
      parsed.type === 'response.failed' ||
      parsed.type === 'response.incomplete' ||
      parsed.type === 'error'
    ) {
      throw new StreamError(streamFailureDetails(parsed))
    } else if (
      parsed.type === 'response.refusal.delta' ||
      parsed.type === 'response.refusal.done'
    ) {
      throw new StreamError('模型未提供本课要求的文字回答。')
    }
    return false
  }

  try {
    while (true) {
      signal?.throwIfAborted()
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), aborted])
      } catch (error) {
        signal?.throwIfAborted()
        throw new StreamConnectionError('模型回复连接中断，请稍后重试。', { cause: error })
      }
      signal?.throwIfAborted()
      const { value, done } = result
      let text: string
      try {
        text = done ? decoder.decode() : decoder.decode(value, { stream: true })
      } catch {
        if (done) throw new StreamConnectionError('连接已结束，但没有收到完成事件。')
        throw new StreamError('模型回复不是有效 UTF-8。')
      }
      for (const data of parser.push(text)) {
        if (accept(data)) return completed!
      }
      if (done) throw new StreamConnectionError('连接已结束，但没有收到完成事件。')
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    try {
      // Start cleanup without waiting for a transport-owned cancel promise:
      // a broken connection must not hold a completed or cancelled task open.
      void reader.cancel().catch(() => undefined)
    } catch {
      /* 已断开或已取消时允许清理失败 */
    }
    reader.releaseLock()
  }
}
