import { useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { useChatWorkspace } from './useChatWorkspace'
import { CloseGuard } from '../conversation/CloseGuard'
import { ChangePreviewPanel } from '../review/ChangePreviewPanel'
import { CommandReviewPanel } from '../review/CommandReviewPanel'
import { CommitReceipt } from '../review/CommitReceipt'
import type { OpenFileView } from '../files/file-view-origin'
import { ImagePreview } from '../project/ImagePreview'
import type { ImageDescriptor } from '../../../../shared/image-input'
import { agentResumeSafetyNotice } from '../../../../shared/agent-resume'
import { ThreadSummaryPanel } from './ThreadSummaryPanel'
import type { ThreadSummaryController } from './useThreadSummaryPanel'
import type { ThreadSummarySource } from './thread-summary-sources'
import { ThreadSummaryIcon } from './ThreadSummaryIcon'

export function ChatWorkspace({
  conversation,
  onOpenFile,
  summary,
  sources,
  onShowAllSources
}: {
  conversation: ConversationController
  onOpenFile: OpenFileView
  summary: ThreadSummaryController
  sources: ThreadSummarySource[]
  onShowAllSources: (trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const {
    workspaceRef,
    triggerRef: summaryTriggerRef,
    enabled: summaryEnabled,
    visible: summaryVisible,
    mode: summaryMode,
    toggle: toggleSummary
  } = summary
  const {
    draft,
    setDraft,
    executionApprovalPending,
    setExecutionApprovalPending,
    composerRegionRef,
    scrollArea,
    previewTriggerRef,
    commandTriggerRef,
    onScroll,
    send,
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
  const { storage, messages } = conversation
  const errors = [storage.error, conversation.chatError, conversation.workspace.error].filter(
    Boolean
  )
  return (
    <main
      className="chat-workspace"
      id="conversation"
      aria-label="聊天"
      ref={workspaceRef}
      data-summary-mode={summaryVisible ? summaryMode : undefined}
    >
      <header className="thread-toolbar" aria-label="会话工具栏">
        <div className="thread-toolbar-drag" aria-hidden="true" />
        {summaryEnabled && (
          <button
            ref={summaryTriggerRef}
            type="button"
            className="thread-summary-toggle"
            aria-label={summaryMode === 'overlay' ? '切换摘要' : '切换顶置摘要'}
            title={summaryMode === 'overlay' ? '切换摘要' : '切换顶置摘要'}
            aria-pressed={summaryVisible}
            aria-expanded={summaryVisible}
            aria-controls="thread-summary-panel"
            onClick={toggleSummary}
          >
            <ThreadSummaryIcon />
          </button>
        )}
      </header>
      {conversation.resumableTask && (
        <div className="task-resume-bar" role="status">
          <span>
            此会话有可继续的任务。继续时会重新核对目录和当前权限。{agentResumeSafetyNotice}
          </span>
          <button
            type="button"
            disabled={!conversation.canSend}
            onClick={() => conversation.resumeTask()}
          >
            继续此任务
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="error-banner" role="alert">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
          {storage.paused && (
            <button
              type="button"
              className="quiet-button"
              disabled={!conversation.canEdit}
              onClick={() => void storage.save()}
            >
              重试保存
            </button>
          )}
        </div>
      )}
      <div className="chat-transcript">
        <div className="chat-scroll-area" ref={scrollArea} onScroll={onScroll}>
          {conversation.activeConversationId !== null && messages.length > 0 && (
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
              pendingPlanQuestion={conversation.pendingPlanQuestion}
              onRespondToPlanQuestion={conversation.respondToPlanQuestion}
              onCancelPlanQuestion={conversation.stop}
              planQuestionDisabled={!conversation.canRespondToPlanQuestion}
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
        <ThreadSummaryPanel
          key={conversation.activeConversationId}
          conversation={conversation}
          summary={summary}
          onOpenFile={onOpenFile}
          sources={sources}
          onShowAll={onShowAllSources}
        />
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
      <CloseGuard conversation={conversation} />
    </main>
  )
}
