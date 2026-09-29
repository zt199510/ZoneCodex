import type { AgentContext, ProjectSelection, ToolScope } from '../../../../shared/project'

export type ChatMode = 'tool-live' | 'project-live'

export function isProjectChatMode(mode: ChatMode): boolean {
  return mode === 'project-live'
}

type ToolRequestConfig = {
  scope: ToolScope
  context: AgentContext
}

export function resolveToolRequest(
  mode: ChatMode,
  conversationId: string,
  selection: ProjectSelection | null
): ToolRequestConfig | null {
  if (mode === 'tool-live') {
    return {
      scope: { kind: 'time' },
      context: { kind: 'time' }
    }
  }
  if (mode === 'project-live') {
    if (!selection) return null
    return {
      scope: { kind: 'project', snapshotId: selection.snapshotId },
      context: {
        kind: 'project',
        snapshotId: selection.snapshotId,
        conversationId,
        allowUpload: true
      }
    }
  }
  return null
}

export function resolveChatMode(hasFiles: boolean): ChatMode {
  return hasFiles ? 'project-live' : 'tool-live'
}
