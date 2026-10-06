import type { RefObject } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { ExecutionApproval } from '../execution/ExecutionApproval'
import { ComposerPermissions } from '../execution/ComposerPermissions'
import { ComposerAttachments } from '../project/ComposerAttachments'
import { AttachmentCards } from '../project/AttachmentCards'
import { ChatInput } from './ChatInput'

export function ChatComposer({
  conversation,
  draft,
  onChange,
  onSend,
  executionApprovalPending,
  onPendingChange,
  anchorRef
}: {
  conversation: ConversationController
  draft: string
  onChange: (value: string) => void
  onSend: (content: string) => boolean
  executionApprovalPending: boolean
  onPendingChange: (pending: boolean) => void
  anchorRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { storage, operation } = conversation
  return (
    <div className="composer-region" ref={anchorRef}>
      <ExecutionApproval anchorRef={anchorRef} onPendingChange={onPendingChange} />
      <ChatInput
        value={draft}
        onChange={onChange}
        onSend={onSend}
        onStop={() => {
          void conversation.stop()
        }}
        disabled={!conversation.canSend}
        isSending={operation === 'generating'}
        maxLength={2000}
        tools={
          <div className="composer-tools">
            <ComposerAttachments conversation={conversation} />
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
  )
}
