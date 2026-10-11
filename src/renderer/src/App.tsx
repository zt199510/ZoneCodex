import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatWorkspace } from './features/chat/ChatWorkspace'
import { useConversation } from './features/conversation/useConversation'
import { useFileView } from './features/files/useFileView'
import { FileViewPanel } from './features/files/FileViewPanel'
import { SettingsPage } from './features/settings/SettingsPage'
import { TerminalPanel } from './features/terminal/TerminalPanel'
import type { TerminalPanelHandle } from './features/terminal/TerminalPanel'

function App(): React.JSX.Element {
  const conversation = useConversation()
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const terminalPanel = useRef<TerminalPanelHandle>(null)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const settingsSavingRef = useRef(false)
  const onSettingsSavingChange = useCallback((saving: boolean): void => {
    settingsSavingRef.current = saving
    setSettingsSaving(saving)
  }, [])
  const [settingsReturnFocus, setSettingsReturnFocus] = useState<HTMLElement>()
  const closeTerminalPanel = useCallback((): void => {
    setTerminalOpen(false)
    requestAnimationFrame(() => {
      if (document.querySelector('dialog[open], [popover]:popover-open')) return
      if (document.querySelector('.workspace-shell[hidden], .workspace-shell[inert]')) return
      if (document.activeElement && document.activeElement !== document.body) return
      document.getElementById('terminal-panel-toggle')?.focus({ preventScroll: true })
    })
  }, [])
  const fileView = useFileView(conversation, !settingsOpen)
  const openSettings = useCallback(
    (returnFocus?: HTMLElement): void => {
      if (settingsOpen) return
      if (document.querySelector('dialog[open], [popover]:popover-open')) return
      setSettingsReturnFocus(
        returnFocus ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
      )
      if (window.innerWidth <= 760) setSidebarOpen(false)
      setSettingsOpen(true)
    },
    [settingsOpen]
  )

  async function showChatAfter(navigate: () => Promise<boolean>): Promise<boolean> {
    if (settingsSavingRef.current) return false
    const accepted = await navigate()
    if (accepted) setSettingsOpen(false)
    return accepted
  }

  useEffect(() => {
    return window.api.onAgentUserInputChange((request) => {
      if (request) setSettingsOpen(false)
    })
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    // An approval or window-close dialog needs the chat surface that owns it.
    const showPendingDialog = (): void => {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')
      if (!dialog) return
      setSettingsOpen(false)
      requestAnimationFrame(() => {
        if (!dialog.isConnected || !dialog.open || dialog.contains(document.activeElement)) return
        const target = dialog.querySelector<HTMLElement>(
          '[autofocus], button:not(:disabled), input:not(:disabled), [tabindex="0"]'
        )
        ;(target ?? dialog).focus({ preventScroll: true })
      })
    }
    const observer = new MutationObserver(showPendingDialog)
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
    showPendingDialog()
    return () => observer.disconnect()
  }, [settingsOpen])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.isComposing &&
        !event.defaultPrevented &&
        (event.key === ',' || event.code === 'Comma') &&
        !document.querySelector('dialog[open], [popover]:popover-open')
      ) {
        event.preventDefault()
        openSettings()
        return
      }
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open], [popover]:popover-open')
      ) {
        if (settingsOpen) {
          event.preventDefault()
          setSettingsOpen(false)
        } else setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, settingsOpen])

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((previous) => !previous)}
        terminalOpen={terminalOpen}
        terminalDisabled={settingsOpen}
        onToggleTerminal={() => {
          if (settingsOpen || document.querySelector('dialog[open], [popover]:popover-open')) return
          if (terminalOpen) terminalPanel.current?.close()
          else setTerminalOpen(true)
        }}
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
          disabled={!conversation.canNavigate || settingsSaving}
          search={conversation.search}
          onSearch={conversation.setSearch}
          onCreate={() => showChatAfter(conversation.create)}
          onSelect={(id) => showChatAfter(() => conversation.select(id))}
          onRename={(id, title) => !settingsSavingRef.current && conversation.rename(id, title)}
          onTogglePinned={(id) => !settingsSavingRef.current && conversation.togglePinned(id)}
          onArchive={async (id) => {
            if (settingsSavingRef.current) return false
            return conversation.archive(id)
          }}
          onRestore={(id) => showChatAfter(() => conversation.restore(id))}
          onOpenSettings={openSettings}
        />
      )}
      <div className="workspace-shell" hidden={settingsOpen} inert={settingsOpen}>
        <div
          className={`workspace-body${fileView.state.status !== 'idle' ? ' with-file-view' : ''}`}
        >
          <ChatWorkspace conversation={conversation} onOpenFile={fileView.open} />
          <FileViewPanel state={fileView.state} onClose={fileView.close} />
        </div>
        {terminalOpen && (
          <TerminalPanel ref={terminalPanel} visible={!settingsOpen} onClose={closeTerminalPanel} />
        )}
      </div>
      <SettingsPage
        open={settingsOpen}
        canChange={conversation.canChangeSettings}
        returnFocus={settingsReturnFocus}
        onSavingChange={onSettingsSavingChange}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

export default App
