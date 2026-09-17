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

export function ChatWorkspace({
  conversation
}: {
  conversation: ConversationController
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const scrollArea = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const { storage, messages, operation } = conversation
  const errors = [storage.error, conversation.chatError].filter(Boolean)

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (area && followBottom.current) {
      area.scrollTop = area.scrollHeight
    }
  }, [messages, conversation.toolActivity])

  function send(content: string): boolean {
    const accepted = conversation.send(content)
    if (accepted) followBottom.current = true
    return accepted
  }
  function suggest(prompt: string): void {
    setDraft(prompt)
    document.getElementById('chat-input')?.focus()
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
          <MessageList messages={messages} toolActivity={conversation.toolActivity} />
        )}
      </div>
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
          maxLength={conversation.engine === 'stream' ? 4000 : 2000}
          tools={<ComposerAttachments conversation={conversation} />}
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
