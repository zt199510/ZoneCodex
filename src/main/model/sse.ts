export class StreamError extends Error {}

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

export type ResponseStreamEvent = Record<string, unknown>

// 读取 Responses SSE，并在 response.completed 时返回服务端的完整响应对象。
// 工具调用轮次可能没有 output_text，因此这里不要求文字非空；调用方按自己的协议校验 output。
export async function readResponseStreamResult(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void = () => undefined,
  onEvent: (event: ResponseStreamEvent) => void = () => undefined
): Promise<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SseParser()
  let completed: Record<string, unknown> | null = null
  let outputTextLength = 0
  let totalEventSize = 0
  let responseSize = 0

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
      throw new StreamError('模型未完整完成回复，请重试。')
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
      const { value, done } = await reader.read()
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true })
      for (const data of parser.push(text)) {
        if (accept(data)) return completed!
      }
      if (done) throw new StreamError('连接已结束，但没有收到完成事件。')
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 已断开或已取消时允许清理失败 */
    }
    reader.releaseLock()
  }
}
