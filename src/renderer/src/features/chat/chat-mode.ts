import type { AgentMode } from '../../../../shared/agent'
import type { AgentContext, ProjectSelection, ToolScope } from '../../../../shared/project'

export type ChatMode = 'chat' | 'tool-mock' | 'tool-live' | 'project-mock' | 'project-live'

export function isProjectChatMode(mode: ChatMode): boolean {
  return mode === 'project-mock' || mode === 'project-live'
}

type ToolRequestConfig = {
  agentMode: AgentMode
  scope: ToolScope
  context: AgentContext
}

export function resolveToolRequest(
  mode: ChatMode,
  conversationId: string,
  selection: ProjectSelection | null
): ToolRequestConfig | null {
  if (mode === 'tool-mock' || mode === 'tool-live') {
    return {
      agentMode: mode === 'tool-mock' ? 'mock' : 'live',
      scope: { kind: 'time' },
      context: { kind: 'time' }
    }
  }
  if (mode === 'project-mock' || mode === 'project-live') {
    if (!selection) return null
    return {
      agentMode: mode === 'project-mock' ? 'mock' : 'live',
      scope: { kind: 'project', snapshotId: selection.snapshotId },
      context: {
        kind: 'project',
        snapshotId: selection.snapshotId,
        conversationId,
        // Adding an attachment is the user's authorization; mock remains offline.
        allowUpload: mode === 'project-live'
      }
    }
  }
  return null
}

// Normal UI selects capabilities through attachments; only transport is a debug preference.
export type ChatEngine = 'live' | 'mock' | 'stream'

export function resolveChatMode(engine: ChatEngine, hasFiles: boolean): ChatMode {
  if (engine === 'stream') return 'chat'
  if (hasFiles) return engine === 'live' ? 'project-live' : 'project-mock'
  return engine === 'live' ? 'tool-live' : 'tool-mock'
}
