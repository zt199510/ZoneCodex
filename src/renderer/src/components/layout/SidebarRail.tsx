import { SidebarIcon } from './SidebarIcon'
import { SidebarToggle } from './SidebarToggle'

export function SidebarRail({
  open,
  peeking,
  disabled,
  settingsOpen,
  onToggle,
  onOpen,
  onCreate,
  onSearch,
  onOpenSettings,
  onPreviewEnter,
  onPreviewLeave
}: {
  open: boolean
  peeking: boolean
  disabled: boolean
  settingsOpen: boolean
  onToggle: () => void
  onOpen: () => void
  onCreate: () => Promise<boolean>
  onSearch: () => void
  onOpenSettings: (returnFocus?: HTMLElement) => void
  onPreviewEnter: () => void
  onPreviewLeave: () => void
}): React.JSX.Element {
  return (
    <nav className="sidebar-collapsed-rail" aria-label="主要导航">
      <SidebarToggle open={open} onToggle={onToggle} />
      <div className="sidebar-rail-nav">
        <button
          type="button"
          className="icon-button conversation-create"
          aria-label="新建会话"
          title="新建会话 (Ctrl+N)"
          disabled={disabled}
          onClick={() => void onCreate()}
        >
          <SidebarIcon name="newChat" size={20} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="会话"
          title="会话"
          aria-controls="conversation-sidebar"
          aria-expanded={open || peeking}
          aria-current={!settingsOpen ? 'page' : undefined}
          onPointerEnter={onPreviewEnter}
          onPointerLeave={onPreviewLeave}
          onClick={onOpen}
        >
          <SidebarIcon name="home" size={20} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="搜索"
          title="搜索 (Ctrl+K)"
          onClick={onSearch}
        >
          <SidebarIcon name="search" size={20} />
        </button>
      </div>
      <div className="sidebar-rail-footer">
        <button
          type="button"
          className="icon-button sidebar-settings"
          aria-label="设置"
          title="设置 (Ctrl+,)"
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={(event) => onOpenSettings(event.currentTarget)}
        >
          <SidebarIcon name="settings" size={20} />
        </button>
      </div>
    </nav>
  )
}
