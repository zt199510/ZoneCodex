import { useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { parseFileReference } from '../../../../shared/file-view'
import {
  parseAgentUserInputArguments,
  parseAgentUserInputResult
} from '../../../../shared/agent-user-input'
import { Icon } from '../../components/ui/Icon'
import type { FileViewOrigin, OpenFileView } from '../files/file-view-origin'
import { restoreCollapsedDetailsFocus } from './message-activity-focus'
import {
  displayCommand,
  fileTools,
  groupSummary,
  readObject,
  resultLabels,
  toolIcon,
  toolLabels,
  toolState,
  toolTarget,
  type ToolCall
} from './message-activity-model'

export function ToolGroup({
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
