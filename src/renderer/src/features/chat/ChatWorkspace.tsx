import { useState } from 'react'
import { ChatHeader } from '../../components/layout/ChatHeader'
import type { ConversationController } from '../conversation/useConversation'
import { ClearConversationDialog } from './ClearConversationDialog'
import { EmptyState } from './EmptyState'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { useChatWorkspace } from './useChatWorkspace'
import { CloseGuard } from '../conversation/CloseGuard'
import { ChangePreviewPanel } from '../review/ChangePreviewPanel'
import { CommandReviewPanel } from '../review/CommandReviewPanel'
import { CommitReceipt } from '../review/CommitReceipt'
import { WorkspaceStatus } from '../project/WorkspaceStatus'
import type { OpenFileView } from '../files/file-view-origin'
import { ImagePreview } from '../project/ImagePreview'
import type { ImageDescriptor } from '../../../../shared/image-input'

export function ChatWorkspace({
  conversation,
  onOpenFile
}: {
  conversation: ConversationController
  onOpenFile: OpenFileView
}): React.JSX.Element {
  const {
    draft,
    setDraft,
    confirmClear,
    requestClear,
    cancelClear,
    clear,
    executionApprovalPending,
    setExecutionApprovalPending,
    composerRegionRef,
    scrollArea,
    previewTriggerRef,
    commandTriggerRef,
    onScroll,
    send,
    suggest,
    copyMessage,
    openProposal,
    openCommand
  } = useChatWorkspace(conversation)
  const [imagePreview, setImagePreview] = useState<{
    conversationId: string | null
    imageId: string
    trigger: HTMLButtonElement
  } | null>(null)
  const previewImage =
    imagePreview?.conversationId === conversation.activeConversationId
      ? conversation.images?.getImage(imagePreview.imageId)
      : null
  const openImage = (image: ImageDescriptor, trigger: HTMLButtonElement): void => {
    if (!conversation.images?.isAvailable(image.imageId)) {
      conversation.images?.setError('图片已失效，请重新添加。')
      return
    }
    setImagePreview({
      conversationId: conversation.activeConversationId,
      imageId: image.imageId,
      trigger
    })
  }
  const { storage, messages, operation } = conversation
  const errors = [storage.error, conversation.chatError].filter(Boolean)
  return (
    <main className="chat-workspace" id="conversation">
      <ChatHeader
        status={storage.status}
        needsAttention={storage.dirty || !!storage.error}
        saving={operation === 'saving'}
        paused={storage.paused}
        canEdit={conversation.canEdit}
        hasMessages={messages.length > 0}
        onSave={() => {
          void storage.save()
        }}
        onClear={requestClear}
      />
      <WorkspaceStatus
        selection={conversation.contextSelection}
        operation={operation}
        waitingApproval={executionApprovalPending || conversation.commandReview.proposal !== null}
        workspace={conversation.workspace}
        permissions={conversation.executionPermissions.state}
      />
      {errors.length > 0 && (
        <div className="error-banner" role="alert">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </div>
      )}
      <div className="chat-scroll-area" ref={scrollArea} onScroll={onScroll}>
        {conversation.activeConversationId === null ? (
          <div className="empty-state">
            <p>还没有会话，先新建一个。</p>
            <button
              type="button"
              disabled={!conversation.canNavigate}
              onClick={() => {
                conversation.create()
              }}
            >
              新建会话
            </button>
          </div>
        ) : messages.length === 0 ? (
          <EmptyState disabled={!conversation.canSend} onSuggestion={suggest} />
        ) : (
          <MessageList
            onOpenFile={onOpenFile}
            messageImages={conversation.images?.messages}
            messageImageErrors={conversation.images?.messageErrors}
            onPreviewImage={openImage}
            key={conversation.activeConversationId}
            commandProposals={conversation.commandProposals}
            commandSnapshotId={conversation.contextSelection?.snapshotId ?? null}
            onOpenCommand={openCommand}
            messages={messages}
            toolActivity={conversation.toolActivity}
            toolRuns={conversation.toolRuns}
            changeProposals={conversation.changeProposals}
            changeProposalStatus={conversation.changeProposalStatus}
            proposalOpenDisabled={
              conversation.operation !== 'idle' ||
              conversation.changePreview.state.status === 'loading'
            }
            onOpenProposal={openProposal}
            onSendEditedMessage={conversation.editAndSend}
            editDisabled={!conversation.canSend}
            editMaxLength={2000}
            onCopyMessage={copyMessage}
            onRetryAssistant={(message) => {
              conversation.retryMessage(message.id)
            }}
            canRetryAssistant={(message) => conversation.canRetryMessage(message.id)}
          />
        )}
      </div>
      <ChangePreviewPanel
        commit={conversation.commit}
        preparation={conversation.preparation}
        state={conversation.changePreview.state}
        snapshotCreatedAt={conversation.contextSelection?.createdAt ?? null}
        onClose={conversation.closePreview}
        onDiscard={conversation.discardProposal}
        returnFocusRef={previewTriggerRef}
      />
      {conversation.commandReview.proposal && (
        <CommandReviewPanel
          proposal={conversation.commandReview.proposal}
          onClose={conversation.commandReview.close}
          returnFocusRef={commandTriggerRef}
        />
      )}
      <CommitReceipt commit={conversation.commit} />
      <ChatComposer
        conversation={conversation}
        draft={draft}
        onChange={setDraft}
        onSend={send}
        executionApprovalPending={executionApprovalPending}
        onPendingChange={setExecutionApprovalPending}
        anchorRef={composerRegionRef}
        onPreviewImage={openImage}
      />
      {previewImage && imagePreview && (
        <ImagePreview
          key={previewImage.image.imageId}
          image={previewImage.image}
          src={previewImage.src}
          returnFocus={imagePreview.trigger}
          onClose={() => setImagePreview(null)}
        />
      )}
      <ClearConversationDialog
        open={confirmClear}
        disabled={!conversation.canEdit}
        onCancel={cancelClear}
        onConfirm={clear}
      />
      <CloseGuard conversation={conversation} />
    </main>
  )
}
