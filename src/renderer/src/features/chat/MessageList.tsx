import type { ChatMessage } from '../../../../shared/conversation'
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
  toolActivity = {}
}: {
  messages: readonly ChatMessage[]
  toolActivity?: ToolActivity
}): React.JSX.Element {
  return (
    <ol className="message-list" aria-label="聊天记录">
      {messages.map((message) => {
        const activity = message.role === 'assistant' ? toolActivity[message.id] : undefined
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
          </li>
        )
      })}
    </ol>
  )
}
