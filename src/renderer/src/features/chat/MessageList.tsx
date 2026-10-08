import { useState } from 'react'
import { getMessageImages, type ChatMessage } from '../../../../shared/conversation'
import type { ToolRun } from '../../../../shared/agent-history'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { ChangeProposalStatus } from '../review/useConversationReview'
import type { ToolActivity } from './useChatRequest'
import type { FileViewOrigin, OpenFileReference, OpenFileView } from '../files/file-view-origin'
import { Icon } from '../../components/ui/Icon'
import { MarkdownContent, UserMessageContent } from './MarkdownContent'
import { MessageEditor } from './MessageEditor'
import { MessageActivity } from './MessageActivity'
import { MessageChangeProposalCard, MessageCommandProposalCard } from './MessageProposals'
import { ImageAttachment } from '../project/ImageAttachment'
import type { RuntimeImage } from '../project/useImageSelection'
import {
  appendImageTurnNotice,
  stripImageTurnNotice,
  type ImageDescriptor
} from '../../../../shared/image-input'

export function MessageList({
  messages,
  commandProposals = {},
  commandSnapshotId = null,
  onOpenCommand,
  toolActivity = {},
  toolRuns = [],
  changeProposals = {},
  changeProposalStatus = {},
  proposalOpenDisabled = false,
  onOpenProposal,
  onSendEditedMessage,
  editDisabled = false,
  editMaxLength = 2000,
  onCopyMessage,
  onRetryAssistant,
  canRetryAssistant,
  onOpenFile,
  messageImages = {},
  messageImageErrors = {},
  onPreviewImage
}: {
  messages: readonly ChatMessage[]
  commandProposals?: Readonly<Record<string, MessageCommandProposal>>
  commandSnapshotId?: string | null
  onOpenCommand?: (proposal: MessageCommandProposal, trigger: HTMLButtonElement) => void
  toolActivity?: ToolActivity
  toolRuns?: readonly ToolRun[]
  changeProposals?: Readonly<Record<string, MessageChangeProposal>>
  changeProposalStatus?: Readonly<Record<string, ChangeProposalStatus>>
  proposalOpenDisabled?: boolean
  onOpenProposal?: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
  onSendEditedMessage?: (messageId: string, content: string) => boolean | Promise<boolean>
  editDisabled?: boolean
  editMaxLength?: number
  onCopyMessage?: (message: ChatMessage) => Promise<boolean> | boolean
  onRetryAssistant?: (message: ChatMessage) => void
  canRetryAssistant?: (message: ChatMessage) => boolean
  onOpenFile?: OpenFileView
  messageImages?: Readonly<Record<string, readonly RuntimeImage[]>>
  messageImageErrors?: Readonly<Record<string, Readonly<Record<string, string>>>>
  onPreviewImage?: (image: ImageDescriptor, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const lastUserMessageId = [...messages].reverse().find((message) => message.role === 'user')?.id
  return (
    <ol className="message-list" aria-label="聊天记录">
      {messages.map((message) => {
        const descriptors = message.role === 'user' ? getMessageImages(message) : []
        const imageTurn = descriptors.length > 0
        const userContent = imageTurn ? stripImageTurnNotice(message.content) : message.content
        const images = message.role === 'user' ? (messageImages[message.id] ?? []) : []
        const imageErrors = messageImageErrors[message.id] ?? {}
        const unavailable = descriptors.some(
          (descriptor) => !images.some((view) => view.image.imageId === descriptor.imageId)
        )
        const imageNotice = unavailable
          ? Object.keys(imageErrors).length
            ? '图片组中有不可用图片，请重新添加后发送。'
            : '正在恢复图片组…'
          : undefined
        const entries = message.role === 'assistant' ? toolActivity[message.id] : undefined
        const command = message.role === 'assistant' ? commandProposals[message.id] : undefined
        const activity = entries?.length ? entries : undefined
        const run =
          message.role === 'assistant'
            ? toolRuns.find((item) => item.assistantId === message.id)
            : undefined
        const referenceRun =
          run ??
          (message.role === 'user'
            ? toolRuns.find((item) => item.userId === message.id)
            : undefined)
        const fileOrigin: FileViewOrigin = {
          messageId: message.id,
          scope: referenceRun?.scope,
          source: { kind: 'local' }
        }
        const attachments = referenceRun
          ? messages.find((item) => item.id === referenceRun.userId)?.attachments
          : message.attachments
        const onOpenMessageFile: OpenFileReference | undefined = onOpenFile
          ? (reference, trigger) => {
              const scope = referenceRun?.scope
              const snapshotAlias =
                scope?.kind === 'project' &&
                attachments?.some((attachment) => attachment.path === reference.path)
              onOpenFile(
                reference,
                snapshotAlias && scope?.kind === 'project'
                  ? {
                      ...fileOrigin,
                      source: { kind: 'snapshot', snapshotId: scope.snapshotId }
                    }
                  : fileOrigin,
                trigger
              )
            }
          : undefined
        const hasProcess =
          run?.items.some(
            (item) =>
              item.type === 'function_call' ||
              (item.type === 'message' && item.phase === 'commentary')
          ) ?? false
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
            {(activity ||
              hasProcess ||
              (message.role === 'assistant' && message.status === 'pending')) && (
              <MessageActivity
                messageId={message.id}
                entries={activity ?? []}
                items={run?.items ?? []}
                status={message.status}
                answerStarted={message.status === 'pending' && Boolean(message.content)}
                fileOrigin={fileOrigin}
                onOpenFile={onOpenFile}
                onOpenMessageFile={onOpenMessageFile}
              />
            )}
            {editingId === message.id && onSendEditedMessage ? (
              <MessageEditor
                initialValue={userContent}
                imageNotice={imageNotice}
                maxLength={
                  editMaxLength -
                  (imageTurn ? appendImageTurnNotice('', descriptors.length).length : 0)
                }
                disabled={editDisabled}
                onCancel={() => setEditingId(null)}
                onSend={(content) => onSendEditedMessage(message.id, content)}
              />
            ) : (
              <div
                className={`message-content${message.role === 'assistant' ? ' message-answer' : ''}`}
              >
                {descriptors.length > 0 && (
                  <div className="message-images" aria-label="本轮图片">
                    {descriptors.map((descriptor) => {
                      const view = images.find((item) => item.image.imageId === descriptor.imageId)
                      return (
                        <ImageAttachment
                          key={descriptor.imageId}
                          image={descriptor}
                          src={view?.thumbnailSrc}
                          notice={
                            view ? undefined : (imageErrors[descriptor.imageId] ?? '正在恢复图片…')
                          }
                          compact
                          onPreview={onPreviewImage}
                        />
                      )
                    })}
                  </div>
                )}
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
                    <MarkdownContent content={message.content} onOpenFile={onOpenMessageFile} />
                  ) : message.role === 'user' ? (
                    <UserMessageContent content={userContent} onOpenFile={onOpenMessageFile} />
                  ) : (
                    message.content
                  )
                ) : message.status === 'pending' ? (
                  message.role === 'assistant' ? null : (
                    '正在生成回复…'
                  )
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
              <MessageChangeProposalCard
                proposal={proposal}
                proposalStatus={proposalStatus}
                proposalOpenDisabled={proposalOpenDisabled}
                onOpenProposal={onOpenProposal}
              />
            )}
            {command && (
              <MessageCommandProposalCard
                command={command}
                commandSnapshotId={commandSnapshotId}
                proposalOpenDisabled={proposalOpenDisabled}
                onOpenCommand={onOpenCommand}
              />
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
