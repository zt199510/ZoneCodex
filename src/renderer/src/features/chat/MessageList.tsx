import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { ChangeProposalStatus } from '../conversation/useConversation'
import type { ToolActivity } from './useChatRequest'
import { Icon } from '../../components/ui/Icon'
import { MarkdownContent } from './MarkdownContent'

const roleLabels: Record<ChatMessage['role'], string> = {
  user: '你',
  assistant: 'ZoneCodex',
  system: '系统'
}

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
  onRetryAssistant
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
          >
            <div className="message-author">
              {message.role === 'assistant' && (
                <span className="assistant-avatar">
                  <Icon name="code" size={15} />
                </span>
              )}
              <strong>{roleLabels[message.role]}</strong>
            </div>
            {activity && (
              <details
                open={message.status === 'pending'}
                style={{ marginBottom: 8, overflowWrap: 'anywhere' }}
              >
                <summary>处理记录</summary>
                <ol>
                  {activity.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ol>
              </details>
            )}
            {editingId === message.id && onSendEditedMessage ? (
              <InlineMessageEditor
                initialValue={message.content}
                maxLength={editMaxLength}
                disabled={editDisabled}
                onCancel={() => setEditingId(null)}
                onSend={(content) => onSendEditedMessage(message.id, content)}
              />
            ) : (
              <div className="message-content">
                {message.content ? (
                  message.role === 'assistant' ? (
                    <MarkdownContent content={message.content} />
                  ) : (
                    message.content
                  )
                ) : message.status === 'pending' ? (
                  activity ? (
                    '正在处理请求…'
                  ) : (
                    '正在思考…'
                  )
                ) : (
                  '未收到回复文字'
                )}
              </div>
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
                  >
                    <Icon name="edit" size={13} />
                    编辑
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
                    title="复制消息"
                  >
                    <Icon name="copy" size={13} />
                    {copiedId === message.id ? '已复制' : '复制'}
                  </button>
                )}
                {message.role === 'assistant' &&
                  (message.status === 'cancelled' || message.status === 'failed') &&
                  onRetryAssistant && (
                    <button
                      type="button"
                      className="message-action"
                      onClick={() => onRetryAssistant(message)}
                      title="重新生成回复"
                    >
                      重新生成
                    </button>
                  )}
              </div>
            )}
            {message.status === 'pending' && message.role === 'assistant' && (
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
          </li>
        )
      })}
    </ol>
  )
}
