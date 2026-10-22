import { AgentError } from '../errors'

export type ResponsesConfiguration = Readonly<{
  provider?: 'responses'
  endpoint: string
  model: string
  apiKey: string
}>
export type ModelConfiguration = ResponsesConfiguration | Readonly<{ provider: 'offline' }>

export function fixedResponsesConfiguration(value: ResponsesConfiguration): ResponsesConfiguration {
  const { endpoint, model, apiKey } = value
  if (typeof endpoint !== 'string' || typeof model !== 'string' || typeof apiKey !== 'string' ||
      !endpoint.trim() || !model.trim() || !apiKey.trim())
    throw new AgentError('模型配置不完整，请配置模型地址、名称和密钥后重启')
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
  } catch {
    throw new AgentError('模型地址必须是有效的 HTTPS 地址，且不能在 URL 中携带凭据')
  }
  return Object.freeze({ endpoint, model, apiKey })
}

/** Explicit offline selection deliberately never reads the three remote fields. */
export function readModelConfiguration(environment: NodeJS.ProcessEnv = process.env): ModelConfiguration {
  const provider = environment.MODEL_PROVIDER?.trim()
  if (provider === 'offline') return Object.freeze({ provider: 'offline' })
  if (provider && provider !== 'responses') throw new AgentError('不支持的模型 Provider，请使用 offline 或 responses')
  const endpoint = environment.MODEL_ENDPOINT ?? ''
  const model = environment.MODEL_NAME ?? ''
  const apiKey = environment.MODEL_API_KEY ?? ''
  if (!provider && !endpoint.trim() && !model.trim() && !apiKey.trim())
    return Object.freeze({ provider: 'offline' })
  return fixedResponsesConfiguration({ endpoint, model, apiKey })
}
