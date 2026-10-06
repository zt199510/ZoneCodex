import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ProjectSelection,
  type ToolScope,
  type Workspace
} from '../../../../shared/project'
import type { ExecutionInfo } from '../../../../shared/execution'

export function resolveAgentRequest(
  conversationId: string,
  workspace: Workspace | null,
  selection: ProjectSelection | null,
  execution?: ExecutionInfo
): { context: AgentRequestContext; scope: ToolScope } {
  const context: AgentRequestContext = {
    conversationId,
    ...(execution ? { execution } : {}),
    ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    ...(selection
      ? { attachment: { snapshotId: selection.snapshotId, allowUpload: true as const } }
      : {})
  }
  return { context, scope: toolScopeForAgentRequest(context) }
}
