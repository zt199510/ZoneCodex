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

export function ChatComposer({
  conversation,
  draft,
  onChange,
  onSend,
  executionApprovalPending,
  onPendingChange,
  anchorRef,
  onPreviewImage
}: {
  conversation: ConversationController
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
  return (
    <div className="composer-region" ref={anchorRef}>
      <ExecutionApproval anchorRef={anchorRef} onPendingChange={onPendingChange} />
      <ChatInput
        value={draft}
        draftKey={conversation.activeConversationId}
        onChange={onChange}
        onSend={onSend}
        onStop={() => {
          void conversation.stop()
        }}
        disabled={!conversation.canSend || Boolean(images?.busy)}
        isSending={operation === 'generating'}
        stopping={conversation.stopping}
        maxLength={
          2000 -
          (images?.pending.length ? appendImageTurnNotice('', images.pending.length).length : 0)
        }
        placeholder={
          conversation.agentMode === 'plan'
            ? '描述任务，生成一份计划…'
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
    </div>
  )
}
