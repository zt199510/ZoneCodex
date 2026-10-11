import { AgentError } from '../errors'
import { readResponseStreamResult, StreamConnectionError, StreamError } from './sse'
import type { ResponseStreamEvent } from './sse'
import {
  isTransientConnectionError,
  RetryableResponseError,
  retryAfterMilliseconds,
  waitForResponseRetry,
  type ResponseRetryEvent
} from './response-retry'

export type ResponseMessageEvent = {
  attempt: number
  outputIndex: number
  phase: 'commentary' | 'final_answer'
  text: string
}

export type SendResponseOptions = {
  onTextDelta?: (delta: string) => void
  onMessageEvent?: (event: ResponseMessageEvent) => void
  onRetry?: (event: ResponseRetryEvent) => void
}
export type SendResponse = (
  input: unknown[],
  signal: AbortSignal,
  options?: SendResponseOptions
) => Promise<unknown>

export type ModelConfiguration = Readonly<{
  endpoint: string
  model: string
  apiKey: string
}>

function fixedModelConfiguration(configuration: ModelConfiguration): ModelConfiguration {
  const { endpoint, model, apiKey } = configuration
  if (
    typeof endpoint !== 'string' ||
    typeof model !== 'string' ||
    typeof apiKey !== 'string' ||
    !endpoint ||
    !model ||
    !apiKey
  )
    throw new AgentError('请配置模型地址、名称和密钥后重启')
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
  } catch {
    throw new AgentError('模型地址必须是有效的 HTTPS 地址，且不能在 URL 中携带凭据')
  }
  return Object.freeze({ endpoint, model, apiKey })
}

/** Called during trusted host preparation; importing this module reads no credentials. */
export function readModelConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): ModelConfiguration {
  return fixedModelConfiguration({
    endpoint: environment.MODEL_ENDPOINT ?? '',
    model: environment.MODEL_NAME ?? '',
    apiKey: environment.MODEL_API_KEY ?? ''
  })
}

type MessageState = {
  itemId?: string
  phase?: unknown
  verified: boolean
  parts: Map<number, string>
  emittedPhase?: ResponseMessageEvent['phase']
  emittedText?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Streaming snapshots are a public projection. The completed response remains
// untouched, including provider reasoning needed for the next model request.
function publicMessageObserver(
  emit: (event: ResponseMessageEvent) => void,
  attempt: number
): (event: ResponseStreamEvent) => void {
  const messages = new Map<number, MessageState>()
  const index = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 50
  const itemId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200
  const get = (outputIndex: number): MessageState => {
    let state = messages.get(outputIndex)
    if (!state) {
      state = { verified: false, parts: new Map() }
      messages.set(outputIndex, state)
    }
    return state
  }
  const identify = (state: MessageState, id: unknown): void => {
    if (id === undefined) return
    if (!itemId(id) || (state.itemId !== undefined && state.itemId !== id))
      throw new StreamError('文字事件与消息标识不一致。')
    state.itemId = id
  }
  const publish = (outputIndex: number): void => {
    const state = messages.get(outputIndex)
    if (!state?.verified || (state.phase !== 'commentary' && state.phase !== 'final_answer')) return
    const text = [...state.parts]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part)
      .join('\n')
    if (text.length > 16000) throw new StreamError('消息超过本轮显示长度上限。')
    if (state.emittedPhase !== undefined && state.emittedPhase !== state.phase)
      throw new StreamError('公开消息阶段不一致。')
    if (state.emittedPhase === state.phase && state.emittedText === text) return
    if (state.emittedText === undefined && !text) return
    state.emittedPhase = state.phase
    state.emittedText = text
    emit({ attempt, outputIndex, phase: state.phase, text })
  }
  const acceptItem = (
    outputIndex: number,
    item: unknown,
    replace: boolean,
    fallback?: ResponseMessageEvent['phase']
  ): void => {
    if (!record(item) || item.type !== 'message' || item.role !== 'assistant') return
    const state = get(outputIndex)
    identify(state, item.id)
    state.verified = true
    if (item.phase !== undefined) state.phase = item.phase
    else if (state.phase === undefined && fallback) state.phase = fallback
    if (Array.isArray(item.content)) {
      if (item.content.length > 160) throw new StreamError('消息内容项过多。')
      if (replace) state.parts.clear()
      for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
        const part = item.content[contentIndex]
        if (record(part) && part.type === 'output_text') {
          if (typeof part.text !== 'string') throw new StreamError('消息文字格式不正确。')
          if (replace || part.text || !state.parts.has(contentIndex))
            state.parts.set(contentIndex, part.text)
        }
      }
    }
    publish(outputIndex)
  }
  return (event): void => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      if (index(event.output_index))
        acceptItem(event.output_index, event.item, event.type === 'response.output_item.done')
      return
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const outputIndex = index(event.output_index)
        ? event.output_index
        : itemId(event.item_id)
          ? [...messages].find(([, state]) => state.itemId === event.item_id)?.[0]
          : undefined
      if (outputIndex === undefined) return
      if (
        typeof event.content_index !== 'number' ||
        !Number.isInteger(event.content_index) ||
        event.content_index < 0 ||
        event.content_index >= 160
      )
        throw new StreamError('文字事件的内容位置无效。')
      const text = event.type === 'response.output_text.delta' ? event.delta : event.text
      if (typeof text !== 'string') throw new StreamError('文字片段格式不正确。')
      const state = get(outputIndex)
      identify(state, event.item_id)
      state.parts.set(
        event.content_index,
        event.type === 'response.output_text.delta'
          ? (state.parts.get(event.content_index) ?? '') + text
          : text
      )
      // Even a message whose phase has not arrived must have a bounded buffer.
      if ([...state.parts.values()].reduce((size, part) => size + part.length, 0) > 16000)
        throw new StreamError('消息超过本轮显示长度上限。')
      publish(outputIndex)
      return
    }
    if (
      event.type === 'response.completed' &&
      record(event.response) &&
      event.response.status === 'completed' &&
      Array.isArray(event.response.output) &&
      event.response.output.length <= 50
    ) {
      const hasTool = event.response.output.some(
        (item) => record(item) && item.type === 'function_call'
      )
      for (let outputIndex = 0; outputIndex < event.response.output.length; outputIndex++) {
        acceptItem(
          outputIndex,
          event.response.output[outputIndex],
          true,
          hasTool ? 'commentary' : 'final_answer'
        )
      }
    }
  }
}

function httpErrorMessage(status: number): string {
  if (status >= 500) return `模型服务或网关暂时异常（HTTP ${status}），请稍后手动重试`
  if (status === 401 || status === 403)
    return `模型访问被拒绝（HTTP ${status}），请检查模型密钥及访问权限`
  if (status === 429) return '模型请求受限（HTTP 429），请稍后手动重试，或检查服务额度和请求频率'
  return `模型请求失败（HTTP ${status}），请检查模型地址、名称及接口配置`
}

export function createLiveResponse(
  tools: readonly unknown[],
  instructions: string,
  configuration?: ModelConfiguration
): SendResponse {
  const fixedConfiguration =
    configuration === undefined ? undefined : fixedModelConfiguration(configuration)
  return async (input, signal, options = {}) => {
    signal.throwIfAborted()
    // Existing desktop callers continue reading their environment for each send.
    const { endpoint, model, apiKey } = fixedConfiguration ?? readModelConfiguration()
    // Freeze the body once: a retry repeats only this model request, never
    // any completed local tool, and cannot observe later input mutation.
    const body = JSON.stringify({
      model,
      instructions,
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 4096
    })
    const request = {
      method: 'POST',
      redirect: 'error' as const,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`
      },
      body,
      signal
    }
    for (let attempt = 0; attempt <= 5; attempt++) {
      signal.throwIfAborted()
      try {
        let response: Response
        try {
          response = await fetch(endpoint, request)
        } catch (error) {
          signal.throwIfAborted()
          if (isTransientConnectionError(error))
            throw new RetryableResponseError('模型连接暂时中断，请稍后重试', 'connection')
          throw new AgentError('模型连接失败，请检查模型地址、网络及证书配置')
        }
        signal.throwIfAborted()
        if (!response.ok) {
          // Cleanup cannot mask a known HTTP failure or delay cancellation.
          void response.body?.cancel().catch(() => undefined)
          if ([429, 500, 502, 503, 504].includes(response.status))
            throw new RetryableResponseError(
              httpErrorMessage(response.status),
              'http',
              response.status,
              retryAfterMilliseconds(response.headers.get('retry-after'))
            )
          throw new AgentError(httpErrorMessage(response.status))
        }
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (mime !== 'text/event-stream' || !response.body) {
          void response.body?.cancel().catch(() => undefined)
          throw new AgentError('服务未返回 SSE，请确认网关支持 Responses 流式接口')
        }
        try {
          return await readResponseStreamResult(
            response.body,
            (delta) => {
              signal.throwIfAborted()
              options.onTextDelta?.(delta)
            },
            options.onMessageEvent
              ? publicMessageObserver((event) => {
                  signal.throwIfAborted()
                  options.onMessageEvent?.(event)
                }, attempt)
              : undefined,
            signal
          )
        } catch (error) {
          signal.throwIfAborted()
          if (error instanceof StreamConnectionError)
            throw new RetryableResponseError(error.message, 'stream')
          if (error instanceof StreamError) throw new AgentError(error.message)
          // Observer/protocol validation errors are not network failures.
          throw error
        }
      } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof RetryableResponseError)) throw error
        if (attempt === 5) throw new AgentError(`自动重试 5 次后仍未成功：${error.message}`)
        const retry = attempt + 1
        const delayMs = Math.max(1000 * 2 ** attempt, error.retryAfterMs)
        options.onRetry?.({
          retry,
          maxRetries: 5,
          delayMs,
          reason: error.reason,
          ...(error.status !== undefined ? { status: error.status } : {})
        })
        await waitForResponseRetry(delayMs, signal)
      }
    }
    throw new AgentError('模型请求未完成')
  }
}
