import { Icon } from '../../components/ui/Icon'

const toolLabels: Record<string, string> = {
  get_current_time: '读取当前时间',
  search_project_text: '搜索项目文本',
  read_project_file: '读取项目文件',
  propose_file_change: '准备文件修改建议',
  propose_command: '准备命令提案',
  list_workspace_files: '列出文件',
  search_workspace_text: '搜索文本',
  read_workspace_file: '读取文件',
  create_workspace_file: '新建文件',
  edit_workspace_file: '修改文件',
  run_workspace_command: '运行命令'
}

const workspaceResultLabels: Record<string, string> = {
  created: '已新建文件',
  applied: '已修改文件',
  completed: '命令已完成',
  cancelled: '操作已取消',
  conflict: '文件已变化，未修改',
  no_change: '文件没有变化',
  unsupported: '文件格式不支持修改',
  failed: '命令执行失败',
  timed_out: '命令已请求停止',
  uncertain: '文件修改结果未确认',
  error: '本地操作失败'
}

export function MessageActivity({
  messageId,
  entries
}: {
  messageId: string
  entries: readonly string[]
}): React.JSX.Element | null {
  const results = entries.flatMap((line, index) => {
    const match =
      /^(?:工作区|本地)结果：(create_workspace_file|edit_workspace_file|run_workspace_command)：([a-z_]+)$/.exec(
        line
      )
    return match ? [{ name: match[1], status: match[2], index }] : []
  })
  const tools = entries.flatMap((line, index) => {
    const name = /^执行工具：([a-z_]+)(?:$|[；;])/.exec(line)?.[1]
    return name &&
      name !== 'create_workspace_file' &&
      name !== 'edit_workspace_file' &&
      name !== 'run_workspace_command'
      ? [{ name, status: null, index }]
      : []
  })
  if (tools.length === 0 && results.length === 0) return null
  return (
    <ul className="message-tool-activity" aria-label="工具活动">
      {[...tools, ...results]
        .sort((left, right) => left.index - right.index)
        .map(({ name, status, index }) => (
          <li key={`${messageId}-tool-${index}`}>
            <Icon
              name={
                status && status !== 'created' && status !== 'applied' && status !== 'completed'
                  ? 'close'
                  : 'check'
              }
              size={13}
            />
            <span>
              {status ? (workspaceResultLabels[status] ?? status) : (toolLabels[name] ?? name)}
            </span>
          </li>
        ))}
    </ul>
  )
}
