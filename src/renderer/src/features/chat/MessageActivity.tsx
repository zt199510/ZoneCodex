import { useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { ProtocolItem } from '../../../../shared/agent-history'
import { Icon, type IconName } from '../../components/ui/Icon'
import { MarkdownContent } from './MarkdownContent'

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
const resultLabels: Record<string, string> = {
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
type ToolCall = { id: string; name: string; arguments: string; output?: string }
type ActivityBlock =
  { kind: 'commentary'; text: string; id: number } | { kind: 'tool'; call: ToolCall }
function readObject(text: string | undefined): Record<string, unknown> | null {
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
function activityBlocks(items: readonly ProtocolItem[]): ActivityBlock[] {
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
      blocks.push({ kind: 'tool', call })
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
function displayCommand(program: string, args: readonly string[]): string {
  return [program, ...args]
    .map((argument) =>
      argument && !/[\s"]/u.test(argument)
        ? argument
        : `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
    )
    .join(' ')
}
function toolIcon(name: string): IconName {
  if (name === 'run_workspace_command' || name === 'propose_command') return 'terminal'
  if (name.includes('search')) return 'search'
  if (name.includes('file')) return 'file'
  return 'code'
}
function toolState(call: ToolCall, status: ChatMessage['status']): string {
  if (call.output === undefined)
    return status === 'pending' ? 'running' : status === 'cancelled' ? 'cancelled' : 'uncertain'
  const result = readObject(call.output)
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
function ToolItem({
  call,
  status
}: {
  call: ToolCall
  status: ChatMessage['status']
}): React.JSX.Element {
  const args = readObject(call.arguments)
  const result = readObject(call.output)
  const command = call.name === 'run_workspace_command'
  const state = toolState(call, status)
  const requested = toolLabels[call.name] ?? call.name
  const label =
    state === 'running'
      ? requested
      : state === 'uncertain'
        ? `${requested} · 结果未确认`
        : state === 'failed'
          ? `${requested}失败`
          : state === 'cancelled'
            ? `${requested}已取消`
            : state === 'timed_out'
              ? '命令已超时'
              : (resultLabels[String(result?.status)] ?? (command ? '运行了命令' : requested))
  const program = typeof args?.program === 'string' ? args.program : null
  const argv =
    Array.isArray(args?.args) && args.args.every((arg) => typeof arg === 'string')
      ? (args.args as string[])
      : []
  const cwd =
    typeof result?.cwd === 'string' ? result.cwd : typeof args?.cwd === 'string' ? args.cwd : null
  const error = typeof result?.error === 'string' ? result.error : null
  const hasCommandOutput = command && result && ('stdout' in result || 'stderr' in result)
  return (
    <details className="message-tool-item" data-tool-name={call.name} data-state={state}>
      <summary className="message-tool-summary">
        <span className={`message-tool-icon${state === 'running' ? ' is-running' : ''}`}>
          <Icon name={toolIcon(call.name)} size={15} />
        </span>
        <span>{label}</span>
        <span className="message-tool-chevron">
          <Icon name="chevron" size={12} />
        </span>
      </summary>
      <div className="message-tool-details">
        {command && program ? (
          <>
            <div className="message-tool-field">
              <span>命令</span>
              <pre>{displayCommand(program, argv)}</pre>
            </div>
            <dl className="message-tool-meta">
              <div>
                <dt>工作目录</dt>
                <dd>{cwd ?? '默认工作目录'}</dd>
              </div>
              <div>
                <dt>权限请求</dt>
                <dd>
                  {args?.sandbox_permissions === 'require_escalated'
                    ? '扩大本次执行权限'
                    : '默认权限'}
                </dd>
              </div>
              {typeof result?.exitCode === 'number' && (
                <div>
                  <dt>退出码</dt>
                  <dd>{result.exitCode}</dd>
                </div>
              )}
              {typeof result?.treeExited === 'boolean' && (
                <div>
                  <dt>进程树</dt>
                  <dd>{result.treeExited ? '已确认退出' : '退出未确认'}</dd>
                </div>
              )}
            </dl>
          </>
        ) : (
          <div className="message-tool-field">
            <span>参数</span>
            <pre>{args ? JSON.stringify(args, null, 2) : call.arguments}</pre>
          </div>
        )}
        {hasCommandOutput ? (
          <>
            <div className="message-tool-field">
              <span>输出</span>
              <pre>
                {typeof result.stdout === 'string' && result.stdout
                  ? result.stdout
                  : '（无标准输出）'}
              </pre>
            </div>
            {typeof result.stderr === 'string' && result.stderr && (
              <div className="message-tool-field">
                <span>错误输出</span>
                <pre>{result.stderr}</pre>
              </div>
            )}
            {result.truncated === true && (
              <p className="message-tool-note">输出已达到捕获上限，部分内容未显示。</p>
            )}
          </>
        ) : call.output !== undefined && (!command || !result || state === 'uncertain') ? (
          <div className="message-tool-field">
            <span>结果</span>
            <pre>{result ? JSON.stringify(result, null, 2) : call.output}</pre>
          </div>
        ) : null}
        {error && <p className="message-tool-error">{error}</p>}
        {call.output === undefined && (
          <p className="message-tool-note">
            {state === 'running'
              ? '正在处理此调用，结果尚未返回。'
              : '此调用未返回结果，请核对实际执行情况。'}
          </p>
        )}
      </div>
    </details>
  )
}
export function MessageActivity({
  messageId,
  entries,
  items = [],
  status = 'complete',
  answerStarted = false
}: {
  messageId: string
  entries: readonly string[]
  items?: readonly ProtocolItem[]
  status?: ChatMessage['status']
  answerStarted?: boolean
}): React.JSX.Element | null {
  const finalSeen = useRef(answerStarted || status === 'complete')
  const [expanded, setExpanded] = useState(!answerStarted && status !== 'complete')
  useLayoutEffect(() => {
    if (!finalSeen.current && (answerStarted || status === 'complete')) {
      finalSeen.current = true
      setExpanded(false)
    }
  }, [answerStarted, status])
  const blocks = activityBlocks(items)
  const timing = [...entries].reverse().find((line) => /^用时：\d+毫秒$/.test(line))
  const elapsed = timing ? Number(timing.slice(3, -2)) : null
  if (blocks.length)
    return (
      <section className="message-tool-run" aria-label="本轮处理过程">
        <details
          className="message-tool-overview"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="message-tool-overview-summary">
            <span>
              {status === 'pending' && !answerStarted
                ? '正在处理'
                : elapsed !== null
                  ? `用时 ${elapsed < 1000 ? '不到1' : Math.round(elapsed / 1000)}秒`
                  : '处理过程'}
            </span>
            <Icon name="chevron" size={12} />
          </summary>
          <div className="message-tool-timeline">
            {blocks.map((block) =>
              block.kind === 'commentary' ? (
                <div
                  className="message-tool-commentary"
                  key={`${messageId}-commentary-${block.id}`}
                >
                  <MarkdownContent content={block.text} />
                </div>
              ) : (
                <ToolItem key={block.call.id} call={block.call} status={status} />
              )
            )}
          </div>
        </details>
      </section>
    )
  // Legacy labels have no saved arguments/output; do not invent details.
  const legacy = entries.flatMap((line, index) => {
    const result = /^(?:工作区|本地)结果：([a-z_]+)：([a-z_]+)$/.exec(line)
    if (result) return [{ name: result[1], label: resultLabels[result[2]] ?? result[2], index }]
    const name = /^执行工具：([a-z_]+)(?:$|[；;])/.exec(line)?.[1]
    return name &&
      !['create_workspace_file', 'edit_workspace_file', 'run_workspace_command'].includes(name)
      ? [{ name, label: toolLabels[name] ?? name, index }]
      : []
  })
  if (!legacy.length) return null
  return (
    <ul className="message-tool-activity" aria-label="工具活动">
      {legacy.map((item) => (
        <li key={`${messageId}-legacy-${item.index}`}>
          <Icon name={toolIcon(item.name)} size={14} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  )
}
