import { Icon } from '../ui/Icon'
import type { Conversation } from '../../../../shared/conversation-library'

type SidebarProps = {
  conversations: Conversation[]
  activeConversationId: string | null
  disabled: boolean
  onCreate: () => void | Promise<unknown>
  onSelect: (id: string) => void | Promise<unknown>
}

export function Sidebar({
  conversations,
  activeConversationId,
  disabled,
  onCreate,
  onSelect
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar" aria-label="对话侧栏">
      <nav className="conversation-nav" aria-label="对话导航">
        <div className="section-label">
          对话 <span>{conversations.length}</span>
        </div>
        <button
          type="button"
          className="conversation-create"
          disabled={disabled || conversations.length >= 100}
          onClick={() => {
            onCreate()
          }}
        >
          新建会话
        </button>
        {conversations.map((item) => (
          <button
            type="button"
            className="conversation-item"
            key={item.id}
            disabled={disabled}
            aria-current={item.id === activeConversationId ? 'page' : undefined}
            title={item.title}
            onClick={() => {
              onSelect(item.id)
            }}
          >
            <Icon name="chat" size={17} />
            <span>{item.title}</span>
            {item.id === activeConversationId && <span className="conversation-dot" />}
          </button>
        ))}
        {conversations.length === 0 && <p className="sidebar-caption">新建一个会话，开始聊天。</p>}
        {conversations.length >= 100 && (
          <p className="sidebar-caption">已达到本课 100 条会话上限。</p>
        )}
      </nav>
      <div className="sidebar-footer">
        <details className="workspace-help">
          <summary>
            <Icon name="book" size={17} />
            使用说明
          </summary>
          <p>各会话独立保留消息，生成结束后自动保存。</p>
          <p>切换会清空未发送草稿；生成或保存期间请等待。</p>
        </details>
        <div className="local-profile">
          <span className="profile-avatar">Z</span>
          <div>
            <strong>个人工作空间</strong>
            <small>本地存储 · ZoneCodex</small>
          </div>
        </div>
      </div>
    </aside>
  )
}
