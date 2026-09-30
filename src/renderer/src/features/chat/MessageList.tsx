import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { ChangeProposalStatus } from '../conversation/useConversation'
import type { ToolActivity } from './useChatRequest'
import { Icon } from '../../components/ui/Icon'
import { MarkdownContent } from './MarkdownContent'

function InlineMessageEditor({
  initialValue,
  maxLength,
  disabled,
  onCancel,
  onSend
}: {
  initialValue: string
  maxLength: number
  disabled: boolean
  onCancel: () => void
  onSend: (content: string) => boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    textarea.current?.focus()
    textarea.current?.setSelectionRange(initialValue.length, initialValue.length)
  }, [initialValue])

  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [value])

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!disabled && value.trim() && onSend(value)) onCancel()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <form className="message-inline-editor" onSubmit={submit}>
      <label className="sr-only" htmlFor="message-inline-input">
        编辑消息
      </label>
      <textarea
        id="message-inline-input"
        ref={textarea}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        rows={2}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="message-inline-controls">
        <button type="button" className="message-inline-cancel" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="message-inline-send" disabled={disabled || !value.trim()}>
          发送
        </button>
      </div>
    </form>
  )
}

const toolLabels: Record<string, string> = {
  get_current_time: '读取当前时间',
  search_project_text: '搜索项目文本',
  read_project_file: '读取项目文件',
  propose_file_change: '准备文件修改建议',
  propose_command: '准备命令提案',
  list_workspace_files: '列出工作区文件',
  search_workspace_text: '搜索工作区文本',
  read_workspace_file: '读取工作区文件',
  edit_workspace_file: '修改工作区文件',
  run_workspace_command: '运行工作区命令'
}

const workspaceResultLabels: Record<string, string> = {
  applied: '已修改工作区文件',
  completed: '工作区命令已完成',
  cancelled: '用户未批准工作区操作',
  conflict: '文件已变化，未修改',
  no_change: '文件没有变化',
  unsupported: '文件格式不支持修改',
  failed: '工作区命令执行失败',
  timed_out: '工作区命令已请求停止',
  uncertain: '文件修改结果未确认',
  error: '工作区操作失败'
}

function ToolActivity({
  messageId,
  entries
}: {
  messageId: string
  entries: readonly string[]
}): React.JSX.Element | null {
  const results = entries.flatMap((line, index) => {
    const match = /^工作区结果：(edit_workspace_file|run_workspace_command)：([a-z_]+)$/.exec(line)
    return match ? [{ name: match[1], status: match[2], index }] : []
  })
  const tools = entries.flatMap((line, index) => {
    const name = /^执行工具：([a-z_]+)(?:$|[；;])/.exec(line)?.[1]
    return name && name !== 'edit_workspace_file' && name !== 'run_workspace_command'
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
              name={status && status !== 'applied' && status !== 'completed' ? 'close' : 'check'}
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

export function MessageList({
  messages,
  commandProposals = {},
  commandSnapshotId = null,
  onOpenCommand,
  toolActivity = {},
  changeProposals = {},
  changeProposalStatus = {},
  proposalOpenDisabled = false,
  onOpenProposal,
  onSendEditedMessage,
  editDisabled = false,
  editMaxLength = 2000,
  onCopyMessage,
  onRetryAssistant,
  canRetryAssistant
}: {
  messages: readonly ChatMessage[]
  commandProposals?: Readonly<Record<string, MessageCommandProposal>>
  commandSnapshotId?: string | null
  onOpenCommand?: (proposal: MessageCommandProposal, trigger: HTMLButtonElement) => void
  toolActivity?: ToolActivity
  changeProposals?: Readonly<Record<string, MessageChangeProposal>>
  changeProposalStatus?: Readonly<Record<string, ChangeProposalStatus>>
  proposalOpenDisabled?: boolean
  onOpenProposal?: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
  onSendEditedMessage?: (messageId: string, content: string) => boolean
  editDisabled?: boolean
  editMaxLength?: number
  onCopyMessage?: (message: ChatMessage) => Promise<boolean> | boolean
  onRetryAssistant?: (message: ChatMessage) => void
  canRetryAssistant?: (message: ChatMessage) => boolean
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id
  return (
    <ol className="message-list" aria-label="聊天记录">
      {messages.map((message) => {
        const entries = message.role === 'assistant' ? toolActivity[message.id] : undefined
        const command = message.role === 'assistant' ? commandProposals[message.id] : undefined
        const activity = entries?.length ? entries : undefined
        const proposal = message.role === 'assistant' ? changeProposals[message.id] : undefined
        const proposalStatus =
          message.role === 'assistant' ? changeProposalStatus[message.id] : undefined
        return (
          <li
            className={`message message-${message.role}${editingId === message.id ? ' message-editing' : ''}`}
            key={message.id}
            aria-label={
              message.role === 'user'
                ? '你的消息'
                : message.role === 'assistant'
                  ? '助手回复'
                  : '系统消息'
            }
          >
            {message.role === 'system' && <div className="message-author">系统</div>}
            {activity && <ToolActivity messageId={message.id} entries={activity} />}
            {editingId === message.id && onSendEditedMessage ? (
              <InlineMessageEditor
                initialValue={message.content}
                maxLength={editMaxLength}
                disabled={editDisabled}
                onCancel={() => setEditingId(null)}
                onSend={(content) => onSendEditedMessage(message.id, content)}
              />
            ) : (
              <div
                className={`message-content${message.role === 'assistant' ? ' message-answer' : ''}`}
              >
                {message.role === 'user' &&
                  message.attachments &&
                  message.attachments.length > 0 && (
                    <ul className="message-attachments" aria-label="本轮附件">
                      {message.attachments.map((attachment) => {
                        const name = attachment.path.split('/').at(-1) ?? attachment.path
                        return (
                          <li
                            className="message-attachment"
                            key={`${message.id}-${attachment.path}`}
                          >
                            <span className="message-attachment-icon" aria-hidden="true">
                              <Icon name="file" size={14} />
                            </span>
                            <span className="message-attachment-copy">
                              <strong title={attachment.path}>{name}</strong>
                              <small title={attachment.path}>{attachment.path}</small>
                              <small>
                                {attachment.bytes} 字节 · {attachment.lines} 行
                              </small>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                {message.content ? (
                  message.role === 'assistant' ? (
                    <MarkdownContent content={message.content} />
                  ) : (
                    message.content
                  )
                ) : message.status === 'pending' ? (
                  '正在生成回复…'
                ) : message.status === 'failed' || message.status === 'cancelled' ? null : (
                  '未收到回复文字'
                )}
              </div>
            )}
            {message.status === 'pending' && message.role === 'assistant' && message.content && (
              <span className="message-note">
                正在生成
                <span className="typing-dot" />
              </span>
            )}
            {message.status === 'failed' && (
              <span className="message-note message-warning">本轮失败 · 不计入后续上下文</span>
            )}
            {message.status === 'cancelled' && (
              <span className="message-note">已停止 · 不计入后续上下文</span>
            )}
            {proposal && (
              <aside className="message-change-proposal" aria-label="修改建议">
                <div className="message-change-proposal-heading">
                  <Icon name="code" size={15} />
                  <div>
                    <strong>{proposal.path.split('/').at(-1) ?? proposal.path}</strong>
                    <span title={proposal.path}>{proposal.path}</span>
                  </div>
                </div>
                <div className="message-change-proposal-meta">
                  {proposalStatus === 'stale' ? '原快照已失效' : '修改建议 · 未写入'}
                </div>
                {proposalStatus === 'stale' ? (
                  <span className="message-change-proposal-action message-change-proposal-stale">
                    请重新提出修改要求
                  </span>
                ) : (
                  <button
                    className="message-change-proposal-action"
                    type="button"
                    disabled={proposalOpenDisabled || !onOpenProposal}
                    onClick={(event) => onOpenProposal?.(proposal, event.currentTarget)}
                  >
                    查看差异
                  </button>
                )}
              </aside>
            )}
            {command && (
              <aside className="message-command-proposal" aria-label="命令提案">
                <strong>命令提案：npm run typecheck</strong>
                <span>尚未执行</span>
                {command.snapshotId !== commandSnapshotId ? (
                  <span>历史提案，需重新生成</span>
                ) : (
                  <button
                    type="button"
                    disabled={proposalOpenDisabled || !onOpenCommand}
                    onClick={(event) => onOpenCommand?.(command, event.currentTarget)}
                  >
                    查看命令提案
                  </button>
                )}
              </aside>
            )}
            {(message.content ||
              (message.role === 'assistant' &&
                (message.status === 'cancelled' || message.status === 'failed'))) &&
              message.status !== 'pending' &&
              editingId !== message.id && (
                <div className="message-actions" aria-label="消息操作">
                  {message.role === 'user' &&
                    message.id === lastUserMessageId &&
                    onSendEditedMessage &&
                    !editDisabled && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => setEditingId(message.id)}
                        title="编辑消息"
                        aria-label="编辑消息"
                      >
                        <Icon name="edit" size={14} />
                      </button>
                    )}
                  {message.content && onCopyMessage && (
                    <button
                      type="button"
                      className="message-action"
                      onClick={() => {
                        void Promise.resolve(onCopyMessage(message)).then((copied) => {
                          if (copied) {
                            setCopiedId(message.id)
                            window.setTimeout(() => setCopiedId(null), 1400)
                          }
                        })
                      }}
                      title={copiedId === message.id ? '已复制' : '复制消息'}
                      aria-label={copiedId === message.id ? '已复制' : '复制消息'}
                    >
                      <Icon name={copiedId === message.id ? 'check' : 'copy'} size={14} />
                    </button>
                  )}
                  {message.role === 'assistant' &&
                    (message.status === 'cancelled' || message.status === 'failed') &&
                    onRetryAssistant &&
                    (!canRetryAssistant || canRetryAssistant(message)) && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => onRetryAssistant(message)}
                        title="重新生成回复"
                        aria-label="重新生成回复"
                      >
                        <Icon name="restore" size={14} />
                      </button>
                    )}
                </div>
              )}
          </li>
        )
      })}
    </ol>
  )
}
