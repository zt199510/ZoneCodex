import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ProjectSelection,
  type ToolScope,
  type Workspace
} from '../../../../shared/project'
import type { ExecutionInfo } from '../../../../shared/execution'
import { parseAgentMode, type AgentContextEvent, type AgentMode } from '../../../../shared/agent'

export function isContextActivity(line: string): boolean {
  return /^上下文(?:占用|原记录|额外负载|整理)：/.test(line)
}

/** These display-only rows stay in the request hook; they never enter saved ToolRun.trace. */
export function contextActivityEntries(
  event: AgentContextEvent,
  previous: readonly string[]
): string[] {
  const next = previous.filter(
    (line) =>
      !/^上下文(?:占用|原记录|额外负载)：/.test(line) &&
      (event.phase === 'measured' || !line.startsWith('上下文整理：'))
  )
  const reasons: Record<AgentContextEvent['reason'], string> = {
    idle: '容量正常',
    near_limit: '接近容量',
    summary_ready: '候选摘要已验证',
    no_eligible_groups: '没有可整理的完整组',
    invalid_summary: '摘要格式或来源无效',
    no_reduction: '未减少工作上下文',
    summary_transport_failed: '摘要请求失败',
    chunk_limit: '分块次数已达上限',
    summary_limit: '摘要次数已达上限',
    working_limit: '工作上下文超过容量',
    source_material_limit: '摘要材料超过容量',
    summary_retry: '摘要请求正在重试'
  }
  if (event.phase !== 'measured') {
    const phase =
      event.phase === 'compacting'
        ? '正在整理'
        : event.phase === 'compacted'
          ? `整理完成 · ${event.beforeCharacters} → ${event.afterCharacters} 字符`
          : event.phase === 'failed'
            ? '整理失败'
            : '容量阻塞'
    next.push(`上下文整理：${phase} · ${reasons[event.reason]}`)
  }
  next.push(
    `上下文占用：${event.workingCharacters}/${event.limitCharacters} 字符 · ${event.workingItems} 项${event.workingCharacters >= event.triggerCharacters ? ' · 接近容量' : ''}`,
    `上下文原记录：历史 ${event.rawHistoryItems} 项/${event.rawHistoryCharacters} 字符；当轮 ${event.rawTurnItems}/${event.rawTurnLimitItems} 项、${event.rawTurnCharacters} 字符`,
    `上下文额外负载：指令 ${event.instructionsCharacters} 字符 · 工具定义 ${event.toolSchemaCharacters} 字符 · 图片 ${event.imageCount} 张/${event.imageBytes} 字节（另计）`
  )
  return next.slice(-30)
}

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
