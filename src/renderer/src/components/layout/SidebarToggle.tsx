import { SidebarIcon } from './SidebarIcon'

export function SidebarToggle({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const label = open ? '收起侧栏' : '展开侧栏'
  return (
    <button
      id="sidebar-toggle"
      type="button"
      className="icon-button sidebar-toggle"
      onClick={onToggle}
      aria-label={label}
      title={`${label} (Ctrl+B)`}
      aria-expanded={open}
      aria-controls="conversation-sidebar"
    >
      <span className="sidebar-toggle-logo">
        <SidebarIcon name="codex" size={24} />
      </span>
      <span className="sidebar-toggle-icon">
        <SidebarIcon name={open ? 'panel' : 'panelClosed'} size={20} />
      </span>
    </button>
  )
}
