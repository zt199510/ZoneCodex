import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { ProtocolItem } from '../../../../shared/agent-history'
import { commandTemplate } from '../../../../shared/command-proposal'
import { parseFileReference } from '../../../../shared/file-view'
import {
  parseAgentUserInputArguments,
  parseAgentUserInputResult
} from '../../../../shared/agent-user-input'
import { Icon, type IconName } from '../../components/ui/Icon'
import type { FileViewOrigin, OpenFileReference, OpenFileView } from '../files/file-view-origin'
import { MarkdownContent } from './MarkdownContent'

const toolLabels: Record<string, string> = {
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
  { kind: 'commentary'; text: string; id: number } | { kind: 'tools'; calls: ToolCall[] }
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
function displayCommand(program: string, args: readonly string[]): string {
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
function toolTarget(
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
function restoreCollapsedDetailsFocus(details: HTMLDetailsElement | null): void {
  const summary = details?.querySelector<HTMLElement>(':scope > summary')
  const active = details?.ownerDocument.activeElement
  if (
    details &&
    summary &&
    active &&
    active !== details &&
    details.contains(active) &&
    !summary.contains(active)
  )
    summary.focus({ preventScroll: true })
}
function toolIcon(name: string): IconName {
  if (name === 'run_workspace_command' || name === 'propose_command') return 'terminal'
  if (name.includes('search')) return 'search'
  if (name === 'read_project_file' || name === 'read_workspace_file') return 'book'
  if (name === 'apply_workspace_patch' || name === 'propose_file_change') return 'edit'
  if (name.includes('file')) return 'file'
  return 'code'
}
const fileTools = new Set([
  'read_project_file',
  'read_workspace_file',
  'create_workspace_file',
  'apply_workspace_patch',
  'propose_file_change'
])
function formatElapsed(milliseconds: number, pending = false): string {
  if (!pending && milliseconds < 1000) return '不到1秒'
  const seconds = Math.max(
    0,
    pending ? Math.floor(milliseconds / 1000) : Math.round(milliseconds / 1000)
  )
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours}小时` : ''}${hours || minutes ? `${minutes}分钟` : ''}${seconds % 60}秒`
}
function toolState(call: ToolCall, status: ChatMessage['status']): string {
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
function groupSummary(
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
function ToolGroup({
  calls,
  status,
  fileOrigin,
  onOpenFile
}: {
  calls: ToolCall[]
  status: ChatMessage['status']
  fileOrigin?: FileViewOrigin
  onOpenFile?: OpenFileView
}): React.JSX.Element {
  const details = useRef<HTMLDetailsElement>(null)
  const single = calls.length === 1
  const promoted = useRef(!single)
  const interacted = useRef(false)
  const [expanded, setExpanded] = useState(single)
  const summary = groupSummary(calls, status)
  useLayoutEffect(() => {
    if (promoted.current || single) return
    promoted.current = true
    const active = details.current?.ownerDocument.activeElement
    const childFocused =
      active && details.current?.querySelector('.message-tool-group-items')?.contains(active)
    if (!interacted.current && !childFocused) setExpanded(false)
  }, [single])
  const rememberChildInteraction = (event: React.SyntheticEvent<HTMLDetailsElement>): void => {
    if (
      event.target instanceof Node &&
      event.currentTarget.querySelector('.message-tool-group-items')?.contains(event.target)
    )
      interacted.current = true
  }
  return (
    <details
      className={`message-tool-group${single ? ' is-single' : ''}`}
      ref={details}
      open={single || expanded}
      onClickCapture={rememberChildInteraction}
      onFocusCapture={rememberChildInteraction}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return
        if (!event.currentTarget.open) restoreCollapsedDetailsFocus(event.currentTarget)
        if (!single) setExpanded(event.currentTarget.open)
      }}
    >
      <summary className="message-tool-group-summary">
        <span className={`message-tool-icon${summary.running ? ' is-running' : ''}`}>
          <Icon name={summary.icon} size={15} />
        </span>
        <span className="message-tool-summary-text">{summary.label}</span>
        <span className="message-tool-chevron">
          <Icon name="chevron" size={12} />
        </span>
      </summary>
      <div className="message-tool-group-items">
        {calls.map((call) => (
          <ToolItem
            key={call.id}
            call={call}
            status={status}
            fileOrigin={fileOrigin}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </details>
  )
}
function ToolItem({
  call,
  status,
  fileOrigin,
  onOpenFile
}: {
  call: ToolCall
  status: ChatMessage['status']
  fileOrigin?: FileViewOrigin
  onOpenFile?: OpenFileView
}): React.JSX.Element {
  const args = readObject(call.arguments)
  const result = readObject(call.output)
  const questions = call.name === 'request_user_input' ? parseAgentUserInputArguments(args) : null
  const confirmed = questions ? parseAgentUserInputResult(result, questions.questions) : null
  const command = call.name === 'run_workspace_command'
  const state = toolState(call, status)
  const requested = toolLabels[call.name] ?? call.name
  const completedLabel = confirmed
    ? '已收到计划回答'
    : call.name === 'read_project_file' || call.name === 'read_workspace_file'
      ? '已读取'
      : call.name === 'apply_workspace_patch' && result?.status === 'applied'
        ? '编辑了'
        : call.name === 'create_workspace_file' && result?.status === 'created'
          ? '新建了'
          : result?.status === 'completed'
            ? command
              ? '运行了命令'
              : requested
            : (resultLabels[String(result?.status)] ?? requested)
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
              : completedLabel
  const program = typeof args?.program === 'string' ? args.program : null
  const argv =
    Array.isArray(args?.args) && args.args.every((arg) => typeof arg === 'string')
      ? (args.args as string[])
      : []
  const cwd =
    typeof result?.cwd === 'string' ? result.cwd : typeof args?.cwd === 'string' ? args.cwd : null
  const error = typeof result?.error === 'string' ? result.error : null
  const hasCommandOutput = command && result && ('stdout' in result || 'stderr' in result)
  const target = toolTarget(call.name, args, result)
  const snapshotFile = call.name === 'read_project_file' || call.name === 'propose_file_change'
  const existingWriteTarget =
    (call.name === 'create_workspace_file' && result?.status === 'created') ||
    (call.name === 'apply_workspace_patch' &&
      (result?.status === 'applied' || result?.status === 'no_change'))
  const readableTarget =
    state !== 'failed' &&
    state !== 'cancelled' &&
    (call.name === 'read_project_file' ||
      call.name === 'read_workspace_file' ||
      call.name === 'propose_file_change' ||
      existingWriteTarget)
  const reference = target && readableTarget ? parseFileReference({ path: target.title }) : null
  const origin: FileViewOrigin | undefined = fileOrigin
    ? snapshotFile
      ? fileOrigin.scope?.kind === 'project'
        ? {
            ...fileOrigin,
            source: { kind: 'snapshot', snapshotId: fileOrigin.scope.snapshotId }
          }
        : undefined
      : { ...fileOrigin, source: { kind: 'local' } }
    : undefined
  return (
    <details
      className="message-tool-item"
      data-tool-name={call.name}
      data-state={state}
      onToggle={(event) => {
        if (!event.currentTarget.open) restoreCollapsedDetailsFocus(event.currentTarget)
      }}
    >
      <summary
        className="message-tool-summary"
        title={target ? `${label} · ${target.title}` : undefined}
      >
        <span className={`message-tool-icon${state === 'running' ? ' is-running' : ''}`}>
          <Icon name={toolIcon(call.name)} size={15} />
        </span>
        <span className="message-tool-summary-text">
          <span>{label}</span>
          {target &&
            (fileTools.has(call.name) ? (
              <>
                {' '}
                {reference && origin && onOpenFile ? (
                  <button
                    type="button"
                    className="message-tool-file-reference"
                    title={target.title}
                    aria-label={`查看文件 ${target.text}`}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      onOpenFile(reference, origin, event.currentTarget)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
                    }}
                    onKeyUp={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
                    }}
                  >
                    {target.text}
                  </button>
                ) : (
                  <span className="message-tool-file-reference" title={target.title}>
                    {target.text}
                  </span>
                )}
              </>
            ) : (
              ` · ${target.text}`
            ))}
        </span>
        <span className="message-tool-chevron">
          <Icon name="chevron" size={12} />
        </span>
      </summary>
      <div className="message-tool-details">
        {questions ? (
          <dl className="plan-question-history">
            {questions.questions.map((question) => (
              <div key={question.id}>
                <dt>{question.question}</dt>
                <dd>
                  {confirmed?.answers.find((answer) => answer.id === question.id)?.answer ??
                    '尚未回答'}
                </dd>
              </div>
            ))}
          </dl>
        ) : command && program ? (
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
        ) : !questions &&
          call.output !== undefined &&
          (!command || !result || state === 'uncertain') ? (
          <div className="message-tool-field">
            <span>结果</span>
            <pre>{result ? JSON.stringify(result, null, 2) : call.output}</pre>
          </div>
        ) : null}
        {error && <p className="message-tool-error">{error}</p>}
        {call.output === undefined && (
          <p className="message-tool-note">
            {state === 'running'
              ? questions
                ? '等待你回答计划问题。'
                : '正在处理此调用，结果尚未返回。'
              : questions
                ? '本轮已结束，问题未回答。'
                : '此调用未返回结果，请核对实际执行情况。'}
          </p>
        )}
      </div>
    </details>
  )
}
function ResponseRetryNotice({
  retry,
  delaySeconds,
  interrupted
}: {
  retry: number
  delaySeconds: number
  interrupted: boolean
}): React.JSX.Element {
  const [remaining, setRemaining] = useState(Math.ceil(delaySeconds))
  useEffect(() => {
    const deadline = performance.now() + delaySeconds * 1000
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
      setRemaining(next)
      if (next === 0) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [delaySeconds])
  return (
    <div className="message-response-retry" role="status" aria-live="polite">
      <span>
        正在重试 {retry}/5 ·{' '}
        {remaining > 0 ? `等待 ${remaining} 秒` : `等待回复（间隔 ${delaySeconds} 秒）`}
      </span>
      {interrupted && <span>本次回复中断，正在重试</span>}
    </div>
  )
}

export function MessageActivity({
  messageId,
  entries,
  items = [],
  status = 'complete',
  answerStarted = false,
  fileOrigin,
  onOpenFile,
  onOpenMessageFile
}: {
  messageId: string
  entries: readonly string[]
  items?: readonly ProtocolItem[]
  status?: ChatMessage['status']
  answerStarted?: boolean
  fileOrigin?: FileViewOrigin
  onOpenFile?: OpenFileView
  onOpenMessageFile?: OpenFileReference
}): React.JSX.Element | null {
  const overview = useRef<HTMLDetailsElement>(null)
  const [runningElapsed, setRunningElapsed] = useState(0)
  const finalSeen = useRef(answerStarted || status === 'complete')
  const [expanded, setExpanded] = useState(!answerStarted && status !== 'complete')
  useEffect(() => {
    if (status !== 'pending') return
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      setRunningElapsed(Math.max(0, performance.now() - startedAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])
  useLayoutEffect(() => {
    if (!finalSeen.current && (answerStarted || status === 'complete')) {
      finalSeen.current = true
      restoreCollapsedDetailsFocus(overview.current)
      setExpanded(false)
    }
  }, [answerStarted, status])
  const blocks = activityBlocks(items)
  const timing = [...entries].reverse().find((line) => /^用时：\d+毫秒$/.test(line))
  const parsedElapsed = timing ? Number(timing.slice(3, -2)) : null
  const elapsed = Number.isSafeInteger(parsedElapsed) ? parsedElapsed : null
  const timingLabel =
    status === 'pending'
      ? `正在处理 · ${formatElapsed(runningElapsed, true)}`
      : elapsed !== null
        ? `用时 ${formatElapsed(elapsed)}`
        : '处理过程'
  const retryEntry =
    status === 'pending'
      ? [...entries]
          .reverse()
          .find((line) => /^正在重试 [1-5]\/5 · 等待 \d+(?:\.\d+)? 秒$/.test(line))
      : undefined
  const retry = retryEntry
    ? /^正在重试 ([1-5])\/5 · 等待 (\d+(?:\.\d+)?) 秒$/.exec(retryEntry)
    : null
  const retryNotice = retry ? (
    <ResponseRetryNotice
      key={retryEntry}
      retry={Number(retry[1])}
      delaySeconds={Number(retry[2])}
      interrupted={Boolean(answerStarted)}
    />
  ) : null
  if (blocks.length)
    return (
      <section className="message-tool-run" aria-label="本轮处理过程">
        {retryNotice}
        <details
          className="message-tool-overview"
          ref={overview}
          open={expanded}
          onToggle={(event) => {
            if (event.target !== event.currentTarget) return
            if (!event.currentTarget.open) restoreCollapsedDetailsFocus(event.currentTarget)
            setExpanded(event.currentTarget.open)
          }}
        >
          <summary className="message-tool-overview-summary">
            <span>{timingLabel}</span>
            <Icon name="chevron" size={12} />
          </summary>
          <div className="message-tool-timeline">
            {blocks.map((block) =>
              block.kind === 'commentary' ? (
                <div
                  className="message-tool-commentary"
                  key={`${messageId}-commentary-${block.id}`}
                >
                  <MarkdownContent content={block.text} onOpenFile={onOpenMessageFile} />
                </div>
              ) : (
                <ToolGroup
                  key={block.calls[0].id}
                  calls={block.calls}
                  status={status}
                  fileOrigin={fileOrigin}
                  onOpenFile={onOpenFile}
                />
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
      !['create_workspace_file', 'apply_workspace_patch', 'run_workspace_command'].includes(name)
      ? [{ name, label: toolLabels[name] ?? name, index }]
      : []
  })
  if (!legacy.length && status !== 'pending' && elapsed === null) return null
  return (
    <section className="message-tool-run" aria-label="本轮处理过程">
      {retryNotice}
      {(status === 'pending' || elapsed !== null) && (
        <div className="message-tool-overview-summary message-response-timing">{timingLabel}</div>
      )}
      {legacy.length > 0 && (
        <ul className="message-tool-activity" aria-label="工具活动">
          {legacy.map((item) => (
            <li key={`${messageId}-legacy-${item.index}`}>
              <Icon name={toolIcon(item.name)} size={14} />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
