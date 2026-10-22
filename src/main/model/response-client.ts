// Compatibility facade; configuration and transport stay in the main process.
export type { SendResponse, SendResponseOptions, ResponseMessageEvent } from './model-contract'
export type { ModelConfiguration } from './model-configuration'
export { readModelConfiguration } from './model-configuration'
import type { SendResponse } from './model-contract'
import type { ModelConfiguration } from './model-configuration'
import { createModelSession } from './model-session'

export function createLiveResponse(tools: readonly unknown[], instructions: string, configuration?: ModelConfiguration): SendResponse {
  const fixed = configuration ? createModelSession(configuration) : undefined
  return (input, signal, options) => {
    const session = fixed ?? createModelSession()
    return session.createSend({ purpose: 'agent', tools, instructions })(input, signal, options)
  }
}
