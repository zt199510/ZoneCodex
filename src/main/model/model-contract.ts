import type { ResponseRetryEvent } from './response-retry'

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
  originalIndices?: readonly number[]
}
export type SendResponse = (
  input: unknown[], signal: AbortSignal, options?: SendResponseOptions
) => Promise<unknown>

export type ModelPurpose = 'agent' | 'summary' | 'title' | 'risk-review' | 'git-generation'
export type ModelCapabilities = Readonly<{
  tools: boolean
  images: boolean
  summary: boolean
  title: boolean
  riskReview: boolean
  gitGeneration: boolean
  resume: boolean
}>
export type ModelRequest = Readonly<{
  purpose: ModelPurpose
  tools: readonly unknown[]
  instructions: string
}>
/** Trusted internal adapter. No module paths, factories or scripts cross IPC. */
export type ModelProvider = Readonly<{
  id: string
  label: string
  capabilities: ModelCapabilities
  createSender: (request: ModelRequest) => SendResponse
}>
export type ModelSession = Readonly<{
  providerId: string
  label: string
  capabilities: ModelCapabilities
  createSend: (request: ModelRequest) => SendResponse
}>
