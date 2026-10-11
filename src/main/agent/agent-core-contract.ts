import type {
  AgentMessageEvent,
  AgentContextEvent,
  AgentMode,
  AgentResult,
  AgentRetryEvent,
  AgentToolEvent
} from '../../shared/agent'
import type { ProtocolItem } from '../../shared/agent-history'
import type { ImageHistoryReference } from '../../shared/image-input'
import type { ToolScope } from '../../shared/project'
import type { TaskCheckpoint } from '../../shared/task-checkpoint'
import type { SendResponse } from '../model/response-client'
import type { ExecuteTool } from './tool-loop'

/** Data already verified by the host; scope describes tools, never grants access. */
export type AgentCoreInput = {
  requestId: string
  conversationId: string
  mode: AgentMode
  prompt: string
  history: ProtocolItem[]
  scope: ToolScope
  imageHistory?: ImageHistoryReference[]
  resume?: { taskId: string; previousUpdatedAt: string; summaryStatus: string }
  contextSummary?: TaskCheckpoint['summary']
}

export type AgentCoreEvent =
  | { type: 'resume'; requestId: string; taskId: string; summaryStatus: string }
  | { type: 'progress'; requestId: string; message: string }
  | { type: 'delta'; requestId: string; delta: string }
  | { type: 'tool'; event: AgentToolEvent }
  | { type: 'message'; event: AgentMessageEvent }
  | { type: 'retry'; event: AgentRetryEvent }
  | { type: 'context'; event: AgentContextEvent }

/** Trusted adapters report facts; these callbacks do not authorize an operation. */
export type AgentCoreObserver = {
  appendTrace: (message: string) => void
  progress: (message: string) => void
  actionApproved: (kind: string) => void
  effectStarted: () => void
}

export type AgentCoreDependencies = {
  signal: AbortSignal
  send: SendResponse
  /** No business tools or public answer stream; preparation fixes the same model config. */
  summarize?: SendResponse
  networkOverhead?: {
    instructionsCharacters: number
    toolSchemaCharacters: number
    imageCount: number
    imageBytes: number
  }
  createTools: (observer: AgentCoreObserver) => ExecuteTool
  assertCurrent: () => boolean
  onEvent?: (event: AgentCoreEvent) => void
  /** Optional host preparation start, on the same performance.now() clock. */
  startedAt?: number
  transportLabel?: string
  /** Awaited at safe raw boundaries, even when public delivery has been cancelled. */
  onRawCheckpoint?: (
    history: ProtocolItem[],
    summary?: TaskCheckpoint['summary'],
    completed?: boolean
  ) => Promise<void>
}

export type AgentCoreOutcome = {
  result: AgentResult
  task: {
    state: 'completed' | 'waiting_approval' | 'failed' | 'cancelled'
    result?: string
    error?: string
  }
  effects: { approved: boolean; started: boolean }
  elapsedMs: number
}
