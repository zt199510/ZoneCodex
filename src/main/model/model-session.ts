import { AgentError } from '../errors'
import type { ModelProvider, ModelSession, ModelPurpose } from './model-contract'
import { fixedResponsesConfiguration, readModelConfiguration, type ModelConfiguration } from './model-configuration'
import { createResponsesSender } from './responses-provider'
import { offlineProvider } from './offline-provider'
import type { ModelStatus } from '../../shared/model'

/** Internal dependency injection for trusted hosts/tests only; no global registry. */
export function createProviderSession(provider: ModelProvider): ModelSession {
  const capabilities = Object.freeze({ ...provider.capabilities })
  const session: ModelSession = {
    providerId: provider.id,
    label: provider.label,
    capabilities,
    createSend(request) {
      const supported: Record<ModelPurpose, boolean> = {
        agent: true, summary: capabilities.summary, title: capabilities.title,
        'risk-review': capabilities.riskReview, 'git-generation': capabilities.gitGeneration
      }
      if (!supported[request.purpose]) throw new AgentError('当前模型 Provider 不支持此能力')
      const send = provider.createSender(Object.freeze({ ...request,
        tools: Object.freeze(structuredClone(capabilities.tools ? [...request.tools] : [])) }))
      return async (input, signal, options = {}) => {
        signal.throwIfAborted()
        const result = await send(input, signal, {
          ...options,
          onTextDelta: (delta) => { signal.throwIfAborted(); options.onTextDelta?.(delta) },
          onMessageEvent: (event) => { signal.throwIfAborted(); options.onMessageEvent?.(event) },
          onRetry: (event) => { signal.throwIfAborted(); options.onRetry?.(event) }
        })
        signal.throwIfAborted()
        return result
      }
    }
  }
  return Object.freeze(session)
}

export function createModelSession(configuration: ModelConfiguration = readModelConfiguration()): ModelSession {
  if (configuration.provider === 'offline') return createProviderSession(offlineProvider)
  // Capture credentials once in a closure; sessions expose only public metadata.
  const fixed = fixedResponsesConfiguration(configuration)
  return createProviderSession({ id: 'responses', label: 'Responses SSE',
    capabilities: { tools: true, images: true, summary: true, title: true,
      riskReview: true, gitGeneration: true, resume: true },
    createSender: (request) => createResponsesSender(request.tools, request.instructions, fixed)
  })
}

export function assertModelInput(session: ModelSession, images: boolean, resuming: boolean): void {
  if (images && !session.capabilities.images) throw new AgentError('当前为离线模式，不支持图片推理；原记录已保留')
  if (resuming && !session.capabilities.resume) throw new AgentError('当前为离线模式，不支持任务续接；原任务未完成，记录已保留')
}

export function getModelStatus(environment: NodeJS.ProcessEnv = process.env): ModelStatus {
  try {
    const session = createModelSession(readModelConfiguration(environment))
    return session.providerId === 'offline'
      ? { provider: 'offline', state: 'offline', label: session.label }
      : { provider: 'responses', state: 'ready', label: 'Responses SSE（配置就绪，连接未验证）' }
  } catch {
    return { provider: 'unconfigured', state: 'error', label: '模型配置无效，请检查环境变量后重启',
      errorCode: 'MODEL_CONFIGURATION_INVALID' }
  }
}
