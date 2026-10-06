import type { ProjectSelection } from '../../../../shared/project'
import type { Operation } from '../conversation/useOperation'
import type { WorkspaceController } from './useWorkspace'
import type { PermissionsState } from '../../../../shared/execution'

const permissionModeTitles = {
  default: '请求批准',
  'auto-approve': '帮我批准',
  'full-access': '完全访问权限'
} as const

function currentTaskLabel(waitingApproval: boolean, operation: Operation): string {
  if (waitingApproval) return '等待批准'
  switch (operation) {
    case 'loading':
      return '加载中'
    case 'generating':
      return '运行中'
    case 'saving':
      return '保存中'
    case 'selecting':
      return '选择文件中'
    case 'committing':
      return '提交中'
    case 'idle':
      break
  }
  return '空闲'
}

export function WorkspaceStatus({
  selection,
  operation,
  waitingApproval,
  workspace,
  permissions
}: {
  selection: ProjectSelection | null
  operation: Operation
  waitingApproval: boolean
  workspace: WorkspaceController
  permissions: PermissionsState | null
}): React.JSX.Element {
  const task = currentTaskLabel(waitingApproval, operation)
  const saved = workspace.saved
  const label = workspace.runtime?.label ?? '默认目录'
  const instructionLabel =
    saved && !workspace.runtime
      ? `${saved.label}：需重新选择后读取 AGENTS.md`
      : workspace.instructionState === 'read'
        ? workspace.instruction?.truncated
          ? '已读取 AGENTS.md（内容已截断）'
          : '已读取 AGENTS.md'
        : workspace.instructionState === 'absent'
          ? '未找到 AGENTS.md'
          : workspace.instructionState === 'error'
            ? 'AGENTS.md 读取失败'
            : '未读取 AGENTS.md'
  return (
    <div className="workspace-status" role="status" aria-label="工作区状态">
      <span>
        工作区：<strong>{label}</strong>
      </span>
      <span>
        状态：<strong>{task}</strong>
      </span>
      <span>
        权限：{permissions ? permissionModeTitles[permissions.mode] : '加载中'}
        {selection && '，已附加文件'}
      </span>
      <span>{instructionLabel}</span>
      <span className="workspace-status-actions">
        <button
          type="button"
          className="quiet-button"
          disabled={
            !workspace.canSelect || !workspace.saved || workspace.selecting || operation !== 'idle'
          }
          onClick={() => void workspace.readInstruction()}
        >
          重新读取指令
        </button>
        <button
          type="button"
          className="quiet-button"
          disabled={!workspace.canSelect || workspace.selecting || operation !== 'idle'}
          onClick={() => void workspace.select()}
        >
          {saved ? '更换工作区' : '选择工作区'}
        </button>
        {saved && (
          <button
            type="button"
            className="quiet-button"
            disabled={!workspace.canSelect || workspace.selecting || operation !== 'idle'}
            onClick={() => void workspace.clear()}
          >
            清除工作区
          </button>
        )}
      </span>
      {workspace.error && <span className="workspace-status-error">{workspace.error}</span>}
    </div>
  )
}
