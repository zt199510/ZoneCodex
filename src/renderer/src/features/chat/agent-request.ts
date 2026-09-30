import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ProjectSelection,
  type ToolScope,
  type Workspace
} from '../../../../shared/project'

export function resolveAgentRequest(
  conversationId: string,
  workspace: Workspace | null,
  selection: ProjectSelection | null
): { context: AgentRequestContext; scope: ToolScope } {
  const context: AgentRequestContext = {
    conversationId,
    ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    ...(selection
      ? { attachment: { snapshotId: selection.snapshotId, allowUpload: true as const } }
      : {})
  }
  return { context, scope: toolScopeForAgentRequest(context) }
}
