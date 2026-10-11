import type { AgentMode } from '../shared/agent'
import type { PermissionMode, ExecutionApprovalInput } from '../shared/execution'
import type { AgentUserInputAnswer, AgentUserInputRequest } from '../shared/agent-user-input'
import type { AgentCoreEvent } from '../main/agent/agent-core-contract'

export class CLIInputError extends Error {}
export class InteractionUnavailableError extends Error {}

export type AgentHostInput = {
  mode: AgentMode
  prompt: string
  cwd?: string
  workspace?: string
  permission?: PermissionMode
}

export type AgentHostOptions = {
  signal?: AbortSignal
  onEvent?: (event: AgentCoreEvent) => void
  approve?: (request: ExecutionApprovalInput, signal: AbortSignal) => Promise<boolean>
  answer?: (
    request: AgentUserInputRequest,
    signal: AbortSignal
  ) => Promise<AgentUserInputAnswer[] | null>
}

/** Public facts only. Protocol history and model configuration stay inside the host. */
export type AgentHostResult = {
  requestId: string
  conversationId: string
  task: {
    state: 'completed' | 'waiting_approval' | 'failed' | 'cancelled'
    result?: string
    error?: string
  }
  answer: string
  effects: { approved: boolean; started: boolean }
  toolResults: Array<{ callId: string; name: string; output: string }>
  elapsedMs: number
  exitCode: 0 | 1 | 2 | 3 | 130
}
