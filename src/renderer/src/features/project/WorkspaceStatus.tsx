import type { ProjectSelection } from '../../../../shared/project'
import type { Operation } from '../conversation/useOperation'
import type { TaskRecord } from '../../../../shared/task'

function taskLabel(status: TaskRecord['status']): string {
  switch (status) {
    case 'created':
      return '已创建'
    case 'running':
      return '运行中'
    case 'waiting_approval':
      return '等待批准'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已取消'
    case 'failed':
      return '失败'
    case 'timed_out':
      return '已超时'
    case 'interrupted':
      return '已中断'
  }
}

function taskTime(task: TaskRecord): string {
  const value = task.finishedAt ?? task.startedAt ?? task.createdAt
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function taskSummary(task: TaskRecord | undefined): string {
  if (!task) return '无'
  const summary = task.error ?? task.result
  if (!summary) return '无'
  return summary.length > 100 ? `${summary.slice(0, 100)}…` : summary
}

function currentTaskLabel(
  task: TaskRecord | undefined,
  waitingApproval: boolean,
  operation: Operation
): string {
  switch (task?.status) {
    case 'created':
    case 'running':
      return '运行中'
    case 'waiting_approval':
      return '等待批准'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已取消'
    case 'failed':
      return '失败'
    case 'timed_out':
      return '已超时'
    case 'interrupted':
      return '已中断'
    default:
      return waitingApproval || operation === 'generating' || operation === 'committing'
        ? waitingApproval
          ? '等待批准'
          : '运行中'
        : '空闲'
  }
}

export function WorkspaceStatus({
  selection,
  operation,
  waitingApproval,
  tasks,
  canRetryTask,
  onRetryTask
}: {
  selection: ProjectSelection | null
  operation: Operation
  waitingApproval: boolean
  tasks: readonly TaskRecord[]
  canRetryTask?: (taskId: string) => boolean
  onRetryTask?: (taskId: string) => boolean
}): React.JSX.Element {
  const latest = tasks[tasks.length - 1]
  const recentTasks = tasks.slice(-3).reverse()
  const task = currentTaskLabel(latest, waitingApproval, operation)
  return (
    <div className="workspace-status" role="status" aria-label="工作区状态">
      <span>工作区：{selection?.label ?? '未选择工作区'}</span>
      <span>AGENTS.md：{selection ? '未读取' : '未发现'}</span>
      <span>任务：{task}</span>
      <span
        aria-label="最近任务历史"
        title={recentTasks.map((item) => `${taskLabel(item.status)} ${taskTime(item)}`).join('；')}
      >
        历史：
        {recentTasks.length === 0 ? (
          '无'
        ) : (
          <>
            {recentTasks.map((item, index) => (
              <span key={item.taskId}>
                {index > 0 ? ' · ' : ''}
                {taskLabel(item.status)} {taskTime(item)}
                {canRetryTask?.(item.taskId) && onRetryTask && (
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      onRetryTask(item.taskId)
                    }}
                  >
                    重新发起
                  </button>
                )}
              </span>
            ))}
          </>
        )}
      </span>
      <span title={taskSummary(latest)}>结果：{taskSummary(latest)}</span>
      <span>权限：{selection ? '已限定' : '未限定'}</span>
    </div>
  )
}
