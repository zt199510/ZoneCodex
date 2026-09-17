import type { ChatMessage } from '../../../../shared/conversation'
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

export function MessageList({
  messages,
  toolActivity = {},
  changeProposals = {},
  changeProposalStatus = {},
  proposalOpenDisabled = false,
  onOpenProposal
}: {
  messages: readonly ChatMessage[]
  toolActivity?: ToolActivity
  changeProposals?: Readonly<Record<string, MessageChangeProposal>>
  changeProposalStatus?: Readonly<Record<string, ChangeProposalStatus>>
  proposalOpenDisabled?: boolean
  onOpenProposal?: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  return (
    <ol className="message-list" aria-label="聊天记录">
      {messages.map((message) => {
        const entries = message.role === 'assistant' ? toolActivity[message.id] : undefined
        const activity = entries?.length ? entries : undefined
        const proposal = message.role === 'assistant' ? changeProposals[message.id] : undefined
        const proposalStatus =
          message.role === 'assistant' ? changeProposalStatus[message.id] : undefined
        return (
          <li className={`message message-${message.role}`} key={message.id}>
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
          </li>
        )
      })}
    </ol>
  )
}
