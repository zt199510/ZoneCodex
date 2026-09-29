import { useLayoutEffect, useRef, useState } from 'react'
import { ChatHeader } from '../../components/layout/ChatHeader'
import type { ConversationController } from '../conversation/useConversation'
import { ChatInput } from './ChatInput'
import { ClearConversationDialog } from './ClearConversationDialog'
import { EmptyState } from './EmptyState'
import { MessageList } from './MessageList'
import { CloseGuard } from '../conversation/CloseGuard'
import { ComposerAttachments } from '../project/ComposerAttachments'
import { AttachmentCards } from '../project/AttachmentCards'
import { ChangePreviewPanel } from '../review/ChangePreviewPanel'
import { CommandReviewPanel } from '../review/CommandReviewPanel'
import { WorkspaceStatus } from '../project/WorkspaceStatus'
import type { ChatMessage } from '../../../../shared/conversation'

export function ChatWorkspace({
  conversation
}: {
  conversation: ConversationController
}): React.JSX.Element {
  const [draft, setDraftState] = useState('')
  const drafts = useRef(new Map<string | null, string>())
  const currentDraft = useRef('')
  const currentConversationId = useRef<string | null>(conversation.activeConversationId)
  const [confirmClear, setConfirmClear] = useState(false)
  const scrollArea = useRef<HTMLDivElement>(null)
  const previewTriggerRef = useRef<HTMLButtonElement>(null)
  const commandTriggerRef = useRef<HTMLButtonElement>(null)
  const followBottom = useRef(true)
  const { storage, messages, operation } = conversation
  const errors = [storage.error, conversation.chatError].filter(Boolean)

  useLayoutEffect(() => {
    const nextConversationId = conversation.activeConversationId
    const previousConversationId = currentConversationId.current
    if (nextConversationId === previousConversationId) return
    drafts.current.set(previousConversationId, currentDraft.current)
    const nextDraft = drafts.current.get(nextConversationId) ?? ''
    currentConversationId.current = nextConversationId
    currentDraft.current = nextDraft
    followBottom.current = true
    setConfirmClear(false)
    setDraftState(nextDraft)
  }, [conversation.activeConversationId])

  function setDraft(value: string): void {
    currentDraft.current = value
    drafts.current.set(currentConversationId.current, value)
    setDraftState(value)
  }

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (area && followBottom.current) {
      area.scrollTop = area.scrollHeight
    }
  }, [messages, conversation.toolActivity])

  function send(content: string): boolean {
    const accepted = conversation.send(content)
    if (accepted) {
      setDraft('')
      followBottom.current = true
    }
    return accepted
  }
  function suggest(prompt: string): void {
    setDraft(prompt)
    document.getElementById('chat-input')?.focus()
  }
  async function copyMessage(message: ChatMessage): Promise<boolean> {
    if (!navigator.clipboard) return false
    try {
      await navigator.clipboard.writeText(message.content)
      return true
    } catch {
      return false
    }
  }
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
        onClear={() => setConfirmClear(true)}
      />
      <WorkspaceStatus
        selection={conversation.contextSelection}
        operation={operation}
        waitingApproval={conversation.commandReview.proposal !== null}
        workspace={conversation.workspace}
      />
      {errors.length > 0 && (
        <div className="error-banner" role="alert">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </div>
      )}
      <div
        className="chat-scroll-area"
        ref={scrollArea}
        onScroll={(event) => {
          const area = event.currentTarget
          followBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80
        }}
      >
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
            key={conversation.activeConversationId}
            commandProposals={conversation.commandProposals}
            commandSnapshotId={conversation.contextSelection?.snapshotId ?? null}
            onOpenCommand={(proposal, trigger) => {
              commandTriggerRef.current = trigger
              conversation.commandReview.open(proposal)
            }}
            messages={messages}
            toolActivity={conversation.toolActivity}
            changeProposals={conversation.changeProposals}
            changeProposalStatus={conversation.changeProposalStatus}
            proposalOpenDisabled={
              conversation.operation !== 'idle' ||
              conversation.changePreview.state.status === 'loading'
            }
            onOpenProposal={(proposal, trigger) => {
              previewTriggerRef.current = trigger
              void conversation.openProposal(proposal)
            }}
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
      {conversation.commit.receipt && (
        <section className="commit-receipt" role="status">
          <p>{conversation.commit.receipt.message}</p>
          {conversation.commit.receipt.recovery && (
            <p>
              备份：{conversation.commit.receipt.recovery.name}{' '}
              <button
                type="button"
                className="quiet-button"
                onClick={() => void conversation.commit.reveal()}
              >
                定位备份
              </button>
            </p>
          )}
          {conversation.commit.receipt.cleanupWarning && (
            <p>请检查同目录中的备份与临时文件；未执行自动回滚。</p>
          )}
          {conversation.commit.notice && <p>{conversation.commit.notice}</p>}
          <button type="button" className="quiet-button" onClick={conversation.commit.dismiss}>
            关闭结果
          </button>
        </section>
      )}
      <div className="composer-region">
        <ChatInput
          value={draft}
          onChange={setDraft}
          onSend={send}
          onStop={() => {
            void conversation.stop()
          }}
          disabled={!conversation.canSend}
          isSending={operation === 'generating'}
          maxLength={2000}
          tools={
            <ComposerAttachments
              conversation={conversation}
              previewTriggerRef={previewTriggerRef}
            />
          }
          attachments={
            <AttachmentCards
              selection={conversation.projectSelection}
              disabled={!conversation.canEdit}
              onRemove={conversation.removeFile}
            />
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
      <ClearConversationDialog
        open={confirmClear}
        disabled={!conversation.canEdit}
        onCancel={() => setConfirmClear(false)}
        onConfirm={async () => {
          if (await conversation.clear()) {
            setDraft('')
            followBottom.current = true
            setConfirmClear(false)
          }
        }}
      />
      <CloseGuard conversation={conversation} />
    </main>
  )
}
