import { Icon } from '../ui/Icon'
import { useWindowControls } from './useWindowControls'

export function TitleBar({
  sidebarOpen,
  showSidebarToggle = true,
  onToggleSidebar,
  terminalOpen,
  terminalDisabled,
  onToggleTerminal
}: {
  sidebarOpen: boolean
  showSidebarToggle?: boolean
  onToggleSidebar: () => void
  terminalOpen: boolean
  terminalDisabled: boolean
  onToggleTerminal: () => void
}): React.JSX.Element {
  const label = sidebarOpen ? '收起侧栏' : '展开侧栏'
  const controls = useWindowControls()
  return (
    <header className="title-bar" aria-label="窗口标题栏">
      {showSidebarToggle && (
        <button
          className="icon-button"
          onClick={onToggleSidebar}
          aria-label={label}
          title={label}
          aria-expanded={sidebarOpen}
        >
          <Icon name="panel" />
        </button>
      )}
      <button
        id="terminal-panel-toggle"
        type="button"
        className="quiet-button title-terminal-toggle"
        aria-label={terminalOpen ? '关闭终端' : '打开终端'}
        title={terminalOpen ? '关闭终端' : '打开终端'}
        aria-controls="terminal-panel"
        aria-expanded={terminalOpen}
        disabled={terminalDisabled}
        onClick={onToggleTerminal}
      >
        <Icon name="terminal" size={15} />
        终端
      </button>
      {controls.error && (
        <span className="window-error" role="status">
          {controls.error}
        </span>
      )}
      <div className="window-controls" aria-label="窗口操作">
        <button
          className="window-control"
          aria-label="最小化"
          title="最小化"
          onClick={() => {
            void controls.run('minimize')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6.5h10" />
          </svg>
        </button>
        <button
          className="window-control"
          aria-label={controls.maximized ? '还原窗口' : '最大化'}
          title={controls.maximized ? '还原窗口' : '最大化'}
          onClick={() => {
            void controls.run('toggle-maximize')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {controls.maximized ? (
              <path d="M3.5 3.5V1.5h7v7h-2m-7-5h7v7h-7Z" />
            ) : (
              <path d="M1.5 1.5h9v9h-9Z" />
            )}
          </svg>
        </button>
        <button
          className="window-control window-close"
          aria-label="关闭窗口"
          title="关闭窗口"
          onClick={() => {
            void controls.run('close')
          }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m1.5 1.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
    </header>
  )
}
