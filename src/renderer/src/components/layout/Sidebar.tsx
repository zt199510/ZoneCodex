import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import type { Conversation } from '../../../../shared/conversation-library'
import { ProfileMenu } from './ProfileMenu'
import { SidebarMenu } from './SidebarMenu'
import { SidebarIcon } from './SidebarIcon'
import { useSidebarSections } from './useSidebarSections'
import {
  clampSidebarWidth,
  sidebarDefaultWidth,
  sidebarMaxWidth,
  sidebarMinWidth
} from './sidebar-layout'

type SidebarProps = {
  conversations: Conversation[]
  visibleConversations: Conversation[]
  activeConversationId: string | null
  disabled: boolean
  hidden?: boolean
  present: boolean
  transitioning: boolean
  onTransitionEnd: () => void
  view: SidebarView
  onViewChange: (view: SidebarView) => void
  settingsOpen: boolean
  width: number
  onWidthChange: (width: number) => void
  onResizingChange: (resizing: boolean) => void
  onCollapse: () => void
  onExpand: () => void
  peeking: boolean
  onPreviewEnter: () => void
  onPreviewLeave: () => void
  onOpenSearch: () => void
  onCreate: () => Promise<boolean>
  onSelectWorkspace: () => Promise<boolean>
  onSelect: (id: string) => Promise<boolean>
  onRename: (id: string, title: string) => boolean
  onTogglePinned: (id: string) => boolean
  onArchive: (id: string) => void | Promise<unknown>
  onRestore: (id: string) => Promise<boolean>
  onOpenSettings: (returnFocus?: HTMLElement) => void
}

type SidebarView = 'active' | 'archived'

export function Sidebar({
  conversations,
  visibleConversations,
  activeConversationId,
  disabled,
  hidden = false,
  present,
  transitioning,
  onTransitionEnd,
  view,
  onViewChange: setView,
  settingsOpen,
  width,
  onWidthChange,
  onResizingChange,
  onCollapse,
  onExpand,
  peeking,
  onPreviewEnter,
  onPreviewLeave,
  onOpenSearch,
  onCreate,
  onSelectWorkspace,
  onSelect,
  onRename,
  onTogglePinned,
  onArchive,
  onRestore,
  onOpenSettings
}: SidebarProps): React.JSX.Element {
  const sectionId = useId()
  const { isCollapsed, toggleSection } = useSidebarSections()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const drag = useRef<{ x: number; width: number; moved: boolean } | null>(null)
  const candidates = visibleConversations.filter((item) =>
    view === 'active' ? !item.archived : item.archived
  )
  const pinned = candidates.filter((item) => item.pinned)
  const unpinned = candidates.filter((item) => !item.pinned)
  const projects = new Map<string, { label: string; items: Conversation[] }>()
  for (const item of unpinned) {
    if (!item.workspace) continue
    const root = item.workspace.root.toLowerCase()
    const project = projects.get(root) ?? { label: item.workspace.label, items: [] }
    project.items.push(item)
    projects.set(root, project)
  }
  const recent = unpinned
  const activeCount = conversations.filter((item) => !item.archived).length
  const archivedCount = conversations.length - activeCount

  function beginRename(item: Conversation): void {
    if (disabled) return
    setEditingId(item.id)
    setDraft(item.title)
    setEditError(null)
  }

  function cancelRename(): void {
    setEditingId(null)
    setEditError(null)
  }

  function commitRename(id: string): void {
    if (disabled) return
    if (!draft.trim() || draft.trim().length > 80) {
      setEditError('标题不能为空，且不能超过 80 个字符。')
      return
    }
    if (onRename(id, draft)) cancelRename()
    else setEditError('当前无法修改会话，请稍后重试。')
  }

  function renderConversation(item: Conversation, groupHidden = false): React.JSX.Element {
    return (
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
              disabled={disabled}
              aria-label="会话标题"
              aria-invalid={Boolean(editError)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDraft(event.currentTarget.value)
                setEditError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelRename()
                }
              }}
            />
            <button
              type="submit"
              className="icon-button"
              disabled={disabled}
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
              onClick={cancelRename}
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
              aria-current={!settingsOpen && item.id === activeConversationId ? 'page' : undefined}
              title={item.title}
              onClick={() => void onSelect(item.id)}
            >
              <span>{item.title}</span>
            </button>
            <SidebarMenu
              className="conversation-actions"
              label={`会话菜单：${item.title}`}
              disabled={disabled}
              hidden={hidden || groupHidden}
              items={[
                { label: '重命名会话', icon: 'edit', onSelect: () => beginRename(item) },
                {
                  label: item.pinned ? '取消置顶' : '置顶会话',
                  icon: 'pin',
                  onSelect: () => {
                    onTogglePinned(item.id)
                  }
                },
                item.archived
                  ? {
                      label: '恢复会话',
                      icon: 'restore',
                      onSelect: () => {
                        void onRestore(item.id).then((accepted) => {
                          if (accepted) setView('active')
                        })
                      }
                    }
                  : {
                      label: '归档会话',
                      icon: 'archive',
                      onSelect: () => {
                        void onArchive(item.id)
                      }
                    }
              ]}
            />
          </>
        )}
        {editingId === item.id && editError && (
          <p className="sidebar-caption edit-error" role="alert">
            {editError}
          </p>
        )}
      </div>
    )
  }

  function renderGroup(
    key: string,
    label: string,
    children: ReactNode,
    actions?: ReactNode
  ): React.JSX.Element {
    const collapsed = isCollapsed(key)
    const id = `${sectionId}-${key}`
    return (
      <section className="sidebar-group" aria-label={label}>
        <div className="sidebar-group-heading">
          <button
            type="button"
            className="sidebar-group-toggle"
            aria-label={`${collapsed ? '展开' : '折叠'}${label}`}
            aria-expanded={!collapsed}
            aria-controls={id}
            onClick={() => toggleSection(key)}
          >
            <span>{label}</span>
            <SidebarIcon name="chevronDown" size={12} />
          </button>
          {actions}
        </div>
        <div id={id} className="sidebar-group-content" hidden={collapsed}>
          {children}
        </div>
      </section>
    )
  }

  return (
    <aside
      id="conversation-sidebar"
      className="sidebar"
      aria-label="对话侧栏"
      hidden={!present}
      aria-hidden={hidden}
      inert={hidden || transitioning || undefined}
      onPointerEnter={onPreviewEnter}
      onPointerLeave={onPreviewLeave}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onPreviewLeave()
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'transform')
          onTransitionEnd()
      }}
    >
      <div className="sidebar-panel">
        <div className="sidebar-header">
          <div className="sidebar-toolbar">
            <span className="sidebar-heading">会话</span>
            <button
              id="sidebar-search-toggle"
              type="button"
              className="icon-button sidebar-header-search"
              aria-label="搜索会话"
              title="搜索会话 (Ctrl+K)"
              onClick={onOpenSearch}
            >
              <SidebarIcon name="search" />
            </button>
          </div>
          <nav className="sidebar-main-nav" aria-label="主要导航">
            <button
              type="button"
              className="sidebar-nav-button conversation-create"
              disabled={disabled || conversations.length >= 100}
              onClick={() => {
                void onCreate().then((accepted) => {
                  if (accepted) {
                    setView('active')
                    cancelRename()
                  }
                })
              }}
            >
              <SidebarIcon name="newChat" />
              <span>新建会话</span>
              <kbd>Ctrl+N</kbd>
            </button>
          </nav>
        </div>
        <nav className="conversation-nav" aria-label="对话导航">
          {pinned.length > 0 &&
            renderGroup(
              'pinned',
              '置顶',
              <div className="sidebar-conversation-list">
                {pinned.map((item) => renderConversation(item, isCollapsed('pinned')))}
              </div>
            )}
          {renderGroup(
            'projects',
            '项目',
            Array.from(projects, ([root, project], index) => {
              const projectKey = `project:${root}`
              const collapsed = isCollapsed(projectKey)
              const id = `${sectionId}-project-${index}`
              return (
                <div className="sidebar-project" key={root}>
                  <button
                    type="button"
                    className="sidebar-project-toggle"
                    title={root}
                    aria-label={`${collapsed ? '展开' : '折叠'}项目：${project.label}`}
                    aria-expanded={!collapsed}
                    aria-controls={id}
                    onClick={() => toggleSection(projectKey)}
                  >
                    <span className="sidebar-project-disclosure">
                      <SidebarIcon name={collapsed ? 'folder' : 'folderOpen'} />
                      <SidebarIcon name="chevronDown" />
                    </span>
                    <span>{project.label}</span>
                  </button>
                  <div id={id} className="sidebar-project-chats" hidden={collapsed}>
                    {project.items.map((item) =>
                      renderConversation(item, collapsed || isCollapsed('projects'))
                    )}
                  </div>
                </div>
              )
            }),
            <button
              type="button"
              className="icon-button sidebar-add-project"
              aria-label="选择工作区"
              disabled={disabled || !activeConversationId}
              title={activeConversationId ? '为当前会话选择工作区' : '请先新建会话'}
              onClick={() => void onSelectWorkspace()}
            >
              <Icon name="plus" size={14} />
            </button>
          )}
          {renderGroup(
            'recent',
            view === 'active' ? '最近会话' : '已归档',
            <>
              {view === 'archived' && (
                <button
                  type="button"
                  className="sidebar-back-to-chats"
                  onClick={() => setView('active')}
                >
                  <Icon name="chevron" size={12} style={{ transform: 'rotate(180deg)' }} />
                  返回活动会话
                </button>
              )}
              <div className="sidebar-conversation-list">
                {recent.map((item) => renderConversation(item, isCollapsed('recent')))}
              </div>
              {candidates.length === 0 && (
                <p className="sidebar-caption">
                  {view === 'active' ? '新建一个会话，开始聊天。' : '暂无归档会话。'}
                </p>
              )}
            </>,
            <SidebarMenu
              className="conversation-view-menu"
              label="会话列表选项"
              hidden={hidden}
              items={[
                {
                  label: `活动会话 (${activeCount})`,
                  icon: 'messageCircle',
                  onSelect: () => {
                    setView('active')
                    cancelRename()
                  }
                },
                {
                  label: `已归档 (${archivedCount})`,
                  icon: 'archive',
                  onSelect: () => {
                    setView('archived')
                    cancelRename()
                  }
                }
              ]}
            />
          )}
          {conversations.length >= 100 && (
            <p className="sidebar-caption">已达到 100 条会话上限。</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <ProfileMenu hidden={hidden} onOpenSettings={onOpenSettings} />
        </div>
      </div>
      <div
        className="sidebar-rail"
        role="separator"
        aria-label="调整侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={sidebarMinWidth}
        aria-valuemax={clampSidebarWidth(sidebarMaxWidth)}
        aria-valuenow={width}
        tabIndex={hidden ? -1 : 0}
        title="拖动调整宽度，双击恢复默认宽度"
        onDoubleClick={() => onWidthChange(clampSidebarWidth(sidebarDefaultWidth))}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          drag.current = { x: event.clientX, width, moved: false }
          onResizingChange(true)
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const delta = event.clientX - drag.current.x
          if (Math.abs(delta) > 3) drag.current.moved = true
          if (!drag.current.moved) return
          const nextWidth = drag.current.width + delta
          if (nextWidth < sidebarMinWidth / 2) {
            drag.current = null
            onResizingChange(false)
            event.currentTarget.releasePointerCapture(event.pointerId)
            onCollapse()
          } else {
            if (peeking) onExpand()
            onWidthChange(clampSidebarWidth(nextWidth))
          }
        }}
        onPointerUp={(event) => {
          drag.current = null
          onResizingChange(false)
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
          onResizingChange(false)
        }}
        onLostPointerCapture={() => {
          drag.current = null
          onResizingChange(false)
        }}
        onKeyDown={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            onWidthChange(
              clampSidebarWidth(
                event.key === 'Home'
                  ? sidebarMinWidth
                  : event.key === 'End'
                    ? sidebarMaxWidth
                    : width + (event.key === 'ArrowRight' ? 10 : -10)
              )
            )
          }
        }}
      />
    </aside>
  )
}
