import { useState } from 'react'
import { Icon } from '../ui/Icon'
import type { Conversation } from '../../../../shared/conversation-library'

type SidebarProps = {
  conversations: Conversation[]
  visibleConversations: Conversation[]
  activeConversationId: string | null
  disabled: boolean
  search: string
  onSearch: (value: string) => void
  onCreate: () => void | Promise<unknown>
  onSelect: (id: string) => void | Promise<unknown>
  onRename: (id: string, title: string) => boolean
  onTogglePinned: (id: string) => boolean
  onArchive: (id: string) => void | Promise<unknown>
  onRestore: (id: string) => Promise<boolean>
}

type SidebarView = 'active' | 'archived'

function sortConversations(conversations: Conversation[]): Conversation[] {
  return conversations.slice().sort((left, right) => Number(right.pinned) - Number(left.pinned))
}

export function Sidebar({
  conversations,
  visibleConversations,
  activeConversationId,
  disabled,
  search,
  onSearch,
  onCreate,
  onSelect,
  onRename,
  onTogglePinned,
  onArchive,
  onRestore
}: SidebarProps): React.JSX.Element {
  const [view, setView] = useState<SidebarView>('active')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const candidates = visibleConversations.filter((item) =>
    view === 'active' ? !item.archived : item.archived
  )
  const listed = sortConversations(candidates)
  const activeCount = conversations.filter((item) => !item.archived).length
  const archivedCount = conversations.filter((item) => item.archived).length

  function beginRename(item: Conversation): void {
    if (disabled) return
    setEditingId(item.id)
    setDraft(item.title)
    setEditError(null)
  }

  function commitRename(id: string): void {
    if (onRename(id, draft)) {
      setEditingId(null)
      setEditError(null)
    } else {
      setEditError('标题不能为空，且不能超过 80 个字符。')
    }
  }

  return (
    <aside className="sidebar" aria-label="对话侧栏">
      <nav className="conversation-nav" aria-label="对话导航">
        <div className="section-label">
          <span className="sidebar-heading">会话</span>
          <span>{view === 'active' ? activeCount : archivedCount}</span>
        </div>
        <label className="conversation-search">
          <Icon name="search" size={15} />
          <span className="sr-only">搜索会话</span>
          <input
            id="conversation-search"
            value={search}
            maxLength={200}
            placeholder="搜索标题或消息"
            onChange={(event) => onSearch(event.currentTarget.value)}
          />
          {search && (
            <button
              type="button"
              className="icon-button search-clear"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => onSearch('')}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <div className="conversation-views" role="tablist" aria-label="会话视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'active'}
            className={view === 'active' ? 'view-tab selected' : 'view-tab'}
            onClick={() => setView('active')}
          >
            活动 <span>{activeCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'archived'}
            className={view === 'archived' ? 'view-tab selected' : 'view-tab'}
            onClick={() => setView('archived')}
          >
            已归档 <span>{archivedCount}</span>
          </button>
        </div>
        {view === 'active' && (
          <button
            type="button"
            className="conversation-create"
            disabled={disabled || conversations.length >= 100}
            onClick={() => {
              void onCreate()
            }}
          >
            新建会话
          </button>
        )}
        {listed.map((item) => (
          <div className="conversation-row" key={item.id}>
            {editingId === item.id ? (
              <form
                className="conversation-edit"
                onSubmit={(event) => {
                  event.preventDefault()
                  commitRename(item.id)
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  maxLength={80}
                  aria-label="会话标题"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setEditingId(null)
                      setEditError(null)
                    }
                  }}
                />
                <button
                  type="submit"
                  className="icon-button"
                  aria-label="保存标题"
                  title="保存标题"
                >
                  <Icon name="check" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="取消重命名"
                  title="取消重命名"
                  onClick={() => {
                    setEditingId(null)
                    setEditError(null)
                  }}
                >
                  <Icon name="close" size={15} />
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="conversation-item"
                  disabled={disabled || item.archived}
                  aria-current={item.id === activeConversationId ? 'page' : undefined}
                  title={item.title}
                  onClick={() => {
                    void onSelect(item.id)
                  }}
                >
                  <Icon name="chat" size={17} />
                  <span>{item.title}</span>
                  {item.pinned && <Icon name="pin" size={14} style={{ color: 'var(--accent)' }} />}
                  {item.id === activeConversationId && <span className="conversation-dot" />}
                </button>
                <div className="conversation-actions">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled}
                    aria-label={item.pinned ? '取消置顶' : '置顶会话'}
                    title={item.pinned ? '取消置顶' : '置顶会话'}
                    onClick={() => onTogglePinned(item.id)}
                  >
                    <Icon name="pin" size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled}
                    aria-label="重命名会话"
                    title="重命名会话"
                    onClick={() => beginRename(item)}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  {item.archived ? (
                    <button
                      type="button"
                      className="icon-button"
                      disabled={disabled}
                      aria-label="恢复会话"
                      title="恢复会话"
                      onClick={() => {
                        void onRestore(item.id).then((accepted) => {
                          if (accepted) setView('active')
                        })
                      }}
                    >
                      <Icon name="restore" size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      disabled={disabled}
                      aria-label="归档会话"
                      title="归档会话"
                      onClick={() => {
                        void onArchive(item.id)
                      }}
                    >
                      <Icon name="archive" size={14} />
                    </button>
                  )}
                </div>
              </>
            )}
            {editingId === item.id && editError && (
              <p className="sidebar-caption edit-error">{editError}</p>
            )}
          </div>
        ))}
        {listed.length === 0 && (
          <p className="sidebar-caption">
            {search
              ? '没有匹配的会话。'
              : view === 'active'
                ? '新建一个会话，开始聊天。'
                : '暂无归档会话。'}
          </p>
        )}
        {view === 'active' && conversations.length >= 100 && (
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
          <p>未发送草稿按会话暂存，刷新后清空；生成或保存期间请等待。</p>
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
