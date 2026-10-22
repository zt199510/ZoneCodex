import { contextSummaryInstructions } from '../agent/context-manager'
import type { ModelSession, SendResponse } from './model-contract'
import type { ModelConfiguration } from './model-configuration'
import { createModelSession } from './model-session'

export function createContextSummaryResponse(configuration: ModelSession | ModelConfiguration): SendResponse {
  const session = 'createSend' in configuration ? configuration : createModelSession(configuration)
  const send = session.createSend({ purpose: 'summary', tools: [], instructions: contextSummaryInstructions })
  return (input, signal, options) => send(input, signal, { onRetry: options?.onRetry })
}
