import type { ChatMessage } from '../../../../shared/conversation'
import type { ProtocolItem } from '../../../../shared/agent-history'
import { commandTemplate } from '../../../../shared/command-proposal'
import {
  parseAgentUserInputArguments,
  parseAgentUserInputResult
} from '../../../../shared/agent-user-input'
import type { IconName } from '../../components/ui/Icon'

export const toolLabels: Record<string, string> = {
  request_user_input: '询问计划选择',
  get_current_time: '读取当前时间',
  search_project_text: '搜索项目文本',
  read_project_file: '读取项目文件',
  propose_file_change: '准备文件修改建议',
  propose_command: '准备命令提案',
  list_workspace_files: '列出文件',
  search_workspace_text: '搜索文本',
  read_workspace_file: '读取文件',
  create_workspace_file: '新建文件',
  apply_workspace_patch: '修改文件',
  run_workspace_command: '运行命令'
}
export const resultLabels: Record<string, string> = {
  created: '已新建文件',
  applied: '已修改文件',
  completed: '运行了命令',
  cancelled: '操作已取消',
  conflict: '文件已变化，未修改',
  no_change: '文件没有变化',
  unsupported: '文件格式不支持修改',
  failed: '命令执行失败',
  timed_out: '命令已超时',
  uncertain: '结果未确认',
  error: '本地操作失败',
  proposal_ready: '已准备建议'
}
export type ToolCall = { id: string; name: string; arguments: string; output?: string }
export type ActivityBlock =
  { kind: 'commentary'; text: string; id: number } | { kind: 'tools'; calls: ToolCall[] }
export function readObject(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
// Display only public commentary and actual calls/results. Internal call IDs
// remain keys; reasoning and encrypted fields never enter the message view.
export function activityBlocks(items: readonly ProtocolItem[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = []
  const calls = new Map<string, ToolCall>()
  items.forEach((item) => {
    if (item.type === 'message' && item.phase === 'commentary' && Array.isArray(item.content)) {
      const text = item.content
        .flatMap((part) =>
          part &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          part.type === 'output_text' &&
          typeof part.text === 'string'
            ? [part.text]
            : []
        )
        .join('\n')
      if (text) blocks.push({ kind: 'commentary', text, id: blocks.length })
    } else if (
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string'
    ) {
      const call: ToolCall = { id: item.call_id, name: item.name, arguments: item.arguments }
      calls.set(call.id, call)
      const previous = blocks.at(-1)
      if (previous?.kind === 'tools') previous.calls.push(call)
      else blocks.push({ kind: 'tools', calls: [call] })
    } else if (
      item.type === 'function_call_output' &&
      typeof item.call_id === 'string' &&
      typeof item.output === 'string'
    ) {
      const call = calls.get(item.call_id)
      if (call) call.output = item.output
    }
  })
  return blocks
}
export function displayCommand(program: string, args: readonly string[]): string {
  return [program, ...args]
    .map((argument) =>
      argument && !/[\s"]/u.test(argument)
        ? argument
        : `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
    )
    .join(' ')
}
function targetName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
export function toolTarget(
  name: string,
  args: Record<string, unknown> | null,
  result: Record<string, unknown> | null
): { text: string; title: string } | null {
  if (!args) return null
  if (name === 'run_workspace_command') {
    if (
      typeof args.program !== 'string' ||
      !args.program ||
      !Array.isArray(args.args) ||
      !args.args.every((arg) => typeof arg === 'string')
    )
      return null
    return {
      text: displayCommand(targetName(args.program), args.args),
      title: displayCommand(args.program, args.args)
    }
  }
  if (name === 'propose_command') {
    return args.template === commandTemplate.template
      ? { text: commandTemplate.display, title: commandTemplate.display }
      : null
  }
  if (name === 'get_current_time') {
    return args.timeZone === 'UTC' || args.timeZone === 'Asia/Hong_Kong'
      ? { text: args.timeZone, title: args.timeZone }
      : null
  }
  if (name === 'search_workspace_text' || name === 'search_project_text') {
    if (typeof args.query !== 'string' || !args.query) return null
    if (name === 'search_project_text') return { text: args.query, title: args.query }
    if (typeof args.path !== 'string') return null
    const text = `${args.query} · ${args.path === '' ? '默认目录' : args.path}`
    return { text, title: text }
  }
  if (name === 'list_workspace_files') {
    if (typeof args.path !== 'string') return null
    const text = args.path === '' ? '默认目录' : args.path
    return { text, title: text }
  }
  if (
    [
      'read_project_file',
      'read_workspace_file',
      'create_workspace_file',
      'apply_workspace_patch',
      'propose_file_change'
    ].includes(name) &&
    typeof args.path === 'string' &&
    args.path
  ) {
    const path =
      ['read_workspace_file', 'create_workspace_file', 'apply_workspace_patch'].includes(name) &&
      typeof result?.path === 'string' &&
      result.path
        ? result.path
        : args.path
    return { text: targetName(path), title: path }
  }
  return null
}
export function toolIcon(name: string): IconName {
  if (name === 'run_workspace_command' || name === 'propose_command') return 'terminal'
  if (name.includes('search')) return 'search'
  if (name === 'read_project_file' || name === 'read_workspace_file') return 'book'
  if (name === 'apply_workspace_patch' || name === 'propose_file_change') return 'edit'
  if (name.includes('file')) return 'file'
  return 'code'
}
export const fileTools = new Set([
  'read_project_file',
  'read_workspace_file',
  'create_workspace_file',
  'apply_workspace_patch',
  'propose_file_change'
])
export function formatElapsed(milliseconds: number, pending = false): string {
  if (!pending && milliseconds < 1000) return '不到1秒'
  const seconds = Math.max(
    0,
    pending ? Math.floor(milliseconds / 1000) : Math.round(milliseconds / 1000)
  )
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours}小时` : ''}${hours || minutes ? `${minutes}分钟` : ''}${seconds % 60}秒`
}
export function toolState(call: ToolCall, status: ChatMessage['status']): string {
  if (call.output === undefined)
    return status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'uncertain'
  const result = readObject(call.output)
  if (call.name === 'request_user_input') {
    const question = parseAgentUserInputArguments(readObject(call.arguments))
    return question && parseAgentUserInputResult(result, question.questions)
      ? 'completed'
      : 'uncertain'
  }
  if (call.name === 'run_workspace_command' && !result) return 'uncertain'
  if (result?.treeExited === false || result?.status === 'uncertain') return 'uncertain'
  if (result?.status === 'timed_out') return 'timed_out'
  if (result?.status === 'cancelled') return 'cancelled'
  if (
    result?.ok === false ||
    (typeof result?.error === 'string' && result.error) ||
    ['failed', 'error', 'unsupported', 'conflict'].includes(String(result?.status)) ||
    (typeof result?.exitCode === 'number' && result.exitCode !== 0)
  )
    return 'failed'
  if (call.name === 'run_workspace_command') {
    return result?.status === 'completed' && result.exitCode === 0 && result.treeExited === true
      ? 'completed'
      : 'uncertain'
  }
  if (
    result?.ok === true ||
    ['created', 'applied', 'no_change', 'proposal_ready'].includes(String(result?.status))
  )
    return 'completed'
  if (call.name === 'search_project_text' && Array.isArray(result?.matches)) return 'completed'
  if (
    call.name === 'read_project_file' &&
    typeof result?.path === 'string' &&
    typeof result.text === 'string'
  )
    return 'completed'
  return 'uncertain'
}
const toolCategories = [
  {
    names: ['read_project_file', 'read_workspace_file'],
    action: '读取文件',
    completed: '已读取文件',
    icon: 'book'
  },
  { names: ['apply_workspace_patch'], action: '编辑文件', completed: '编辑了文件', icon: 'edit' },
  { names: ['create_workspace_file'], action: '新建文件', completed: '新建了文件', icon: 'file' },
  {
    names: ['run_workspace_command'],
    action: '运行命令',
    completed: '运行了命令',
    icon: 'terminal'
  },
  {
    names: ['search_project_text', 'search_workspace_text'],
    action: '搜索文本',
    completed: '已搜索文本',
    icon: 'search'
  },
  { names: ['list_workspace_files'], action: '列出文件', completed: '已列出文件', icon: 'file' },
  {
    names: ['get_current_time'],
    action: '读取当前时间',
    completed: '已读取当前时间',
    icon: 'code'
  },
  {
    names: ['propose_file_change'],
    action: '准备文件修改建议',
    completed: '已准备文件修改建议',
    icon: 'edit'
  },
  {
    names: ['propose_command'],
    action: '准备命令提案',
    completed: '已准备命令提案',
    icon: 'terminal'
  }
] satisfies { names: string[]; action: string; completed: string; icon: IconName }[]
export function groupSummary(
  calls: readonly ToolCall[],
  status: ChatMessage['status']
): { label: string; icon: IconName; running: boolean } {
  const categories = [
    ...toolCategories,
    ...Array.from(new Set(calls.map((call) => call.name)))
      .filter((name) => !toolCategories.some((category) => category.names.includes(name)))
      .map((name) => ({
        names: [name],
        action: toolLabels[name] ?? name,
        completed: `${toolLabels[name] ?? name}已完成`,
        icon: toolIcon(name)
      }))
  ].filter((category) => calls.some((call) => category.names.includes(call.name)))
  const labels = categories.map((category) => {
    const categoryCalls = calls.filter((call) => category.names.includes(call.name))
    const states = new Set(categoryCalls.map((call) => toolState(call, status)))
    if (states.size === 1 && states.has('completed')) {
      if (
        category.names.includes('apply_workspace_patch') &&
        categoryCalls.every((call) => readObject(call.output)?.status === 'no_change')
      )
        return '文件没有变化'
      return category.completed
    }
    if (states.size === 1 && states.has('running')) return `正在${category.action}`
    const outcomes = [
      ['running', '处理中'],
      ['failed', '失败'],
      ['timed_out', '已超时'],
      ['cancelled', '已取消'],
      ['uncertain', '结果未确认']
    ]
      .filter(([state]) => states.has(state))
      .map(([, label]) => label)
    return `${category.action}（${outcomes.join('、')}）`
  })
  const icon = categories.find((category) => category.icon === 'edit')?.icon ?? categories[0].icon
  return {
    label: labels.join(''),
    icon,
    running: calls.some((call) => toolState(call, status) === 'running')
  }
}
