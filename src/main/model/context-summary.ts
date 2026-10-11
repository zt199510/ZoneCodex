import { contextSummaryInstructions } from '../agent/context-manager'
import { createLiveResponse, type ModelConfiguration, type SendResponse } from './response-client'

/** Explicit request-only adapter. It has no executor, title, approval or answer observer. */
export function createContextSummaryResponse(configuration: ModelConfiguration): SendResponse {
  const send = createLiveResponse([], contextSummaryInstructions, configuration)
  return (input, signal, options) => send(input, signal, { onRetry: options?.onRetry })
}
