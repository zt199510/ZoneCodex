import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ProjectSelection,
  type ToolScope,
  type Workspace
} from '../../../../shared/project'
import type { ExecutionInfo } from '../../../../shared/execution'
import { parseAgentMode, type AgentMode } from '../../../../shared/agent'

export function resolveAgentRequest(
  conversationId: string,
  workspace: Workspace | null,
  selection: ProjectSelection | null,
  mode: AgentMode,
  execution?: ExecutionInfo
): { context: AgentRequestContext; scope: ToolScope } {
  if (!parseAgentMode(mode)) throw new Error('工作方式无效，请选择执行或计划。')
  const context: AgentRequestContext = {
    conversationId,
    mode,
    ...(execution ? { execution } : {}),
    ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
    ...(selection
      ? { attachment: { snapshotId: selection.snapshotId, allowUpload: true as const } }
      : {})
  }
  return { context, scope: toolScopeForAgentRequest(context) }
}
