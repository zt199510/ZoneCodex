import { useEffect, useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatWorkspace } from './features/chat/ChatWorkspace'
import { useConversation } from './features/conversation/useConversation'
// import { TerminalPanel } from './features/terminal/TerminalPanel'

function App(): React.JSX.Element {
  const conversation = useConversation()
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)
  // const [terminalOpen, setTerminalOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open], [popover]:popover-open')
      )
        setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((previous) => !previous)}
      />
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭侧栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {sidebarOpen && (
        <Sidebar
          conversations={conversation.conversations}
          visibleConversations={conversation.visibleConversations}
          activeConversationId={conversation.activeConversationId}
          disabled={!conversation.canNavigate}
          search={conversation.search}
          onSearch={conversation.setSearch}
          onCreate={conversation.create}
          onSelect={conversation.select}
          onRename={conversation.rename}
          onTogglePinned={conversation.togglePinned}
          onArchive={conversation.archive}
          onRestore={conversation.restore}
        />
      )}
      <div className="workspace-body">
        <ChatWorkspace
          conversation={conversation}
        />
        {/* {terminalOpen ? (
          <TerminalPanel onClose={() => setTerminalOpen(false)} />
        ) : (
          <div className="terminal-launcher">
            <button type="button" onClick={() => setTerminalOpen(true)}>
              打开本地终端
            </button>
          </div>
        )} */}
      </div>
    </div>
  )
}

export default App
