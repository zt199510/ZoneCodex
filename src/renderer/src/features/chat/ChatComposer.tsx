import type { RefObject } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { ExecutionApproval } from '../execution/ExecutionApproval'
import { ComposerPermissions } from '../execution/ComposerPermissions'
import { ComposerAttachments } from '../project/ComposerAttachments'
import { AttachmentCards } from '../project/AttachmentCards'
import { ImageAttachment } from '../project/ImageAttachment'
import { appendImageTurnNotice, type ImageDescriptor } from '../../../../shared/image-input'
import { ChatInput } from './ChatInput'

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
  const { storage, operation } = conversation
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
        maxLength={
          2000 -
          (images?.pending.length ? appendImageTurnNotice('', images.pending.length).length : 0)
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
          </div>
        }
        attachments={
          <>
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
          </>
        }
      />
      <p className="composer-footnote">
        {storage.paused
          ? '自动保存已暂停，请重试保存后再关闭。'
          : storage.dirty
            ? '修改尚未保存，关闭前请等待保存完成。'
            : '回复可能存在疏漏，请核实重要信息。'}
      </p>
    </div>
  )
}
