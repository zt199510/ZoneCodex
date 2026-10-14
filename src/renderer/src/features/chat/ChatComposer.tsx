import type { RefObject } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { ExecutionApproval } from '../execution/ExecutionApproval'
import { ComposerPermissions } from '../execution/ComposerPermissions'
import { ComposerAttachments } from '../project/ComposerAttachments'
import { AttachmentCards } from '../project/AttachmentCards'
import { ImageAttachment } from '../project/ImageAttachment'
import { appendImageTurnNotice, type ImageDescriptor } from '../../../../shared/image-input'
import { ChatInput } from './ChatInput'
import { ComposerPlanIndicator } from './ComposerMode'
import { Icon } from '../../components/ui/Icon'

export function ChatComposer({
  conversation,
  newChat = false,
  draft,
  onChange,
  onSend,
  executionApprovalPending,
  onPendingChange,
  anchorRef,
  onPreviewImage
}: {
  conversation: ConversationController
  newChat?: boolean
  draft: string
  onChange: (value: string) => void
  onSend: (content: string) => boolean | Promise<boolean>
  executionApprovalPending: boolean
  onPendingChange: (pending: boolean) => void
  anchorRef: RefObject<HTMLDivElement | null>
  onPreviewImage?: (image: ImageDescriptor, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const { operation } = conversation
  const images = conversation.images
  const projectName = conversation.workspace.runtime?.label ?? conversation.workspace.saved?.label
  return (
    <div className="composer-region" ref={anchorRef}>
      <ExecutionApproval anchorRef={anchorRef} onPendingChange={onPendingChange} />
      {conversation.skills.pending && (
        <div className="pending-skill" role="status">
          <Icon name="book" size={15} />
          <span>
            <strong>{conversation.skills.pending.name}</strong>
            <small>下一条消息使用此技能</small>
          </span>
          <button
            type="button"
            className="pending-skill-remove icon-button"
            aria-label="移除待用技能"
            title="移除待用技能"
            disabled={
              operation !== 'idle' ||
              !conversation.canNavigate ||
              executionApprovalPending ||
              conversation.skills.busy ||
              Boolean(images?.busy)
            }
            onClick={() => void conversation.skills.remove()}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      <ChatInput
        value={draft}
        draftKey={conversation.activeConversationId}
        onChange={onChange}
        onSend={onSend}
        fileReferences={{
          contextKey: JSON.stringify([
            conversation.activeConversationId,
            conversation.workspace.runtime?.workspaceId
          ]),
          hasWorkspace: Boolean(conversation.workspace.runtime),
          search: conversation.searchReferenceFiles,
          add: conversation.addFileReference,
          selectWorkspace: conversation.selectReferenceWorkspace
        }}
        onStop={() => {
          void conversation.stop()
        }}
        disabled={!conversation.canSend || Boolean(images?.busy) || conversation.skills.busy}
        isSending={operation === 'generating'}
        stopping={conversation.stopping}
        maxLength={
          2000 -
          (images?.pending.length ? appendImageTurnNotice('', images.pending.length).length : 0)
        }
        placeholder={
          conversation.agentMode === 'plan'
            ? '描述任务，生成一份计划…'
            : newChat
              ? '随心输入'
              : conversation.messages.length
                ? '与 ZoneCodex 一起工作'
                : '描述你想完成的任务'
        }
        onPasteImages={
          images
            ? (files) => {
                void images.paste(files)
              }
            : undefined
        }
        onDropImages={
          images
            ? (files) => {
                void images.paste(files)
              }
            : undefined
        }
        onImageError={images?.setError}
        tools={
          <div className="composer-tools">
            <ComposerAttachments
              conversation={conversation}
              onSelectImage={
                images
                  ? () => {
                      void images.select()
                    }
                  : undefined
              }
              imageBusy={images?.busy}
              modeDisabled={
                operation !== 'idle' ||
                !conversation.canNavigate ||
                executionApprovalPending ||
                conversation.skills.busy ||
                Boolean(images?.busy)
              }
            />
            <ComposerPermissions
              permissions={conversation.executionPermissions}
              conversationId={conversation.activeConversationId}
              disabled={
                operation !== 'idle' ||
                !conversation.canNavigate ||
                executionApprovalPending ||
                conversation.skills.busy ||
                conversation.executionPermissions.loading ||
                !conversation.executionPermissions.state
              }
            />
            <ComposerPlanIndicator
              mode={conversation.agentMode}
              onSelect={conversation.setAgentMode}
              disabled={
                operation !== 'idle' ||
                !conversation.canNavigate ||
                executionApprovalPending ||
                conversation.skills.busy ||
                Boolean(images?.busy)
              }
            />
          </div>
        }
        attachments={
          <div className="composer-attachment-strip">
            <AttachmentCards
              selection={conversation.projectSelection}
              disabled={!conversation.canEdit}
              onRemove={conversation.removeFile}
            />
            {Boolean(images?.pending.length) && (
              <div className="composer-image" aria-label="待发送图片">
                {images?.pending.map((view) => (
                  <ImageAttachment
                    key={view.image.imageId}
                    image={view.image}
                    src={view.thumbnailSrc}
                    disabled={!conversation.canEdit || images.busy}
                    onPreview={onPreviewImage}
                    onRemove={() => {
                      void images.remove(view.image.imageId)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        }
      />
      {newChat && (
        <div className="new-chat-footer">
          <span className="new-chat-local">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="3" y="3.5" width="14" height="10" rx="2" stroke="currentColor" />
              <path d="M7 16.5h6M10 13.5v3" stroke="currentColor" strokeLinecap="round" />
            </svg>
            本地
          </span>
          <button
            type="button"
            className="new-chat-workspace"
            aria-label="选择项目"
            title={conversation.workspace.runtime?.root ?? conversation.workspace.saved?.root}
            disabled={
              !conversation.canNavigate || conversation.skills.busy || Boolean(images?.busy)
            }
            onClick={() => void conversation.selectReferenceWorkspace()}
          >
            <Icon name="folder" size={16} />
            <span>
              {conversation.workspace.selecting ? '正在选择…' : (projectName ?? '选择项目')}
            </span>
            <Icon name="chevron" size={12} style={{ transform: 'rotate(90deg)' }} />
          </button>
        </div>
      )}
    </div>
  )
}
