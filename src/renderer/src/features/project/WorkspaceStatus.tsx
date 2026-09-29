import type { ProjectSelection } from '../../../../shared/project'
import type { Operation } from '../conversation/useOperation'

function currentTaskLabel(
  waitingApproval: boolean,
  operation: Operation
): string {
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
  waitingApproval
}: {
  selection: ProjectSelection | null
  operation: Operation
  waitingApproval: boolean
}): React.JSX.Element {
  const task = currentTaskLabel(waitingApproval, operation)
  return (
    <div className="workspace-status" role="status" aria-label="工作区状态">
      <span>
        项目上下文：<strong>{selection?.label ?? '未选择文件'}</strong>
      </span>
      <span>
        状态：<strong>{task}</strong>
      </span>
      <span>文件授权：{selection ? '已限定' : '未限定'}</span>
    </div>
  )
}
