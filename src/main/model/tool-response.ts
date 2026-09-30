import { AgentError } from '../agent/tool-loop'
import type { SendResponse } from '../agent/tool-loop'
import { readResponseStreamResult, StreamError } from './sse'

export function createLiveResponse(tools: readonly unknown[], instructions: string): SendResponse {
  return async (input, signal, options = {}) => {
    const endpoint = process.env.MODEL_ENDPOINT
    const model = process.env.MODEL_NAME
    const apiKey = process.env.MODEL_API_KEY
    if (!endpoint || !model || !apiKey) throw new AgentError('请配置模型地址、名称和密钥后重启')
    try {
      const url = new URL(endpoint)
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
    } catch {
      throw new AgentError('模型地址必须是有效的 HTTPS 地址，且不能在 URL 中携带凭据')
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
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
      }),
      signal
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AgentError(`模型请求失败（HTTP ${response.status}），请检查权限、额度和协议支持`)
    }
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'text/event-stream' || !response.body) {
      await response.body?.cancel()
      throw new AgentError('服务未返回 SSE，请确认网关支持 Responses 流式接口')
    }
    try {
      return await readResponseStreamResult(response.body, options.onTextDelta)
    } catch (error) {
      if (error instanceof StreamError) throw new AgentError(error.message)
      throw error
    }
  }
}
