import { useEffect, useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatWorkspace } from './features/chat/ChatWorkspace'
import { useConversation } from './features/conversation/useConversation'
import { useFileView } from './features/files/useFileView'
import { FileViewPanel } from './features/files/FileViewPanel'

function App(): React.JSX.Element {
  const conversation = useConversation()
  const fileView = useFileView(conversation)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)

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
      <div className={`workspace-body${fileView.state.status !== 'idle' ? ' with-file-view' : ''}`}>
        <ChatWorkspace conversation={conversation} onOpenFile={fileView.open} />
        <FileViewPanel state={fileView.state} onClose={fileView.close} />
      </div>
    </div>
  )
}

export default App
