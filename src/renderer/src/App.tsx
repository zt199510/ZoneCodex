import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { SidebarSearch } from './components/layout/SidebarSearch'
import { TitleBar } from './components/layout/TitleBar'
import { SidebarRail } from './components/layout/SidebarRail'
import { useSidebarLayout } from './components/layout/useSidebarLayout'
import {
  clampSidebarWidth,
  sidebarBreakpoint,
  sidebarDefaultWidth,
  sidebarMinWidth,
  sidebarMaxWidth
} from './components/layout/sidebar-layout'
import { ChatWorkspace } from './features/chat/ChatWorkspace'
import { useThreadSummaryPanel } from './features/chat/useThreadSummaryPanel'
import { useSourcesSidePanel } from './features/chat/useSourcesSidePanel'
import { ThreadSourcesSidePanel } from './features/chat/ThreadSourcesSidePanel'
import { threadSummarySources } from './features/chat/thread-summary-sources'
import type { OpenFileView } from './features/files/file-view-origin'
import { useConversation } from './features/conversation/useConversation'
import { useFileView } from './features/files/useFileView'
import { SettingsPage } from './features/settings/SettingsPage'

function App(): React.JSX.Element {
  const conversation = useConversation()
  const setConversationSearch = conversation.setSearch
  const {
    open: sidebarOpen,
    peeking: sidebarPeeking,
    present: sidebarPresent,
    expanded: sidebarExpanded,
    transitioning: sidebarTransitioning,
    setOpen: setSidebarOpen,
    enterPreview: enterSidebarPreview,
    leavePreview: leaveSidebarPreview,
    finishTransition: finishSidebarTransition
  } = useSidebarLayout()
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [sidebarWidthPreference, setSidebarWidthPreference] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('zonecodex.sidebar.width'))
      return saved >= sidebarMinWidth && saved <= sidebarMaxWidth ? saved : sidebarDefaultWidth
    } catch {
      return sidebarDefaultWidth
    }
  })
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const sidebarWidth = clampSidebarWidth(sidebarWidthPreference, viewportWidth)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarView, setSidebarView] = useState<'active' | 'archived'>('active')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const threadSummary = useThreadSummaryPanel(
    settingsOpen ? null : conversation.activeConversationId
  )
  const [settingsSaving, setSettingsSaving] = useState(false)
  const settingsSavingRef = useRef(false)
  const onSettingsSavingChange = useCallback((saving: boolean): void => {
    settingsSavingRef.current = saving
    setSettingsSaving(saving)
  }, [])
  const [settingsReturnFocus, setSettingsReturnFocus] = useState<HTMLElement>()
  const sources = useMemo(
    () => threadSummarySources(conversation.messages, conversation.toolRuns),
    [conversation.messages, conversation.toolRuns]
  )
  const sourcesContext = JSON.stringify([
    conversation.activeConversationId,
    conversation.workspace.runtime?.workspaceId ?? null,
    conversation.contextSelection?.snapshotId ?? null,
    conversation.contextSelection?.files.map((file) => file.path) ?? [],
    conversation.executionPermissions.state?.revision ?? null
  ])
  const sourcesPanel = useSourcesSidePanel(
    settingsOpen || !conversation.activeConversationId ? null : sourcesContext
  )
  const fileView = useFileView(conversation, false)
  const openFile = fileView.open
  const selectSourceTab = sourcesPanel.select
  const onOpenFile = useCallback<OpenFileView>(
    (reference, origin, trigger): void => {
      selectSourceTab('file')
      openFile(reference, origin, trigger)
    },
    [openFile, selectSourceTab]
  )
  const closeSources = sourcesPanel.close
  const showSources = sourcesPanel.show
  const closeSummaryOverlay = threadSummary.closeOverlay
  const onShowAllSources = useCallback(
    (trigger: HTMLButtonElement): void => {
      showSources(trigger)
      closeSummaryOverlay()
    },
    [showSources, closeSummaryOverlay]
  )
  const closeFile = fileView.close
  const fileStatus = fileView.state.status
  const onCloseSources = useCallback((): void => {
    closeSources(fileStatus === 'idle')
  }, [closeSources, fileStatus])
  const onCloseSourceFile = useCallback((): void => {
    closeFile(!sourcesPanel.open)
    if (sourcesPanel.open) selectSourceTab('sources')
  }, [closeFile, selectSourceTab, sourcesPanel.open])
  const changeSidebarWidth = (width: number): void => {
    setSidebarWidthPreference(clampSidebarWidth(width))
  }
  useEffect(() => {
    const resize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (sidebarResizing) return
    try {
      localStorage.setItem('zonecodex.sidebar.width', String(sidebarWidthPreference))
    } catch {
      // The sidebar can still resize when local storage is unavailable.
    }
  }, [sidebarWidthPreference, sidebarResizing])
  const openSettings = useCallback(
    (returnFocus?: HTMLElement): void => {
      if (settingsOpen) return
      if (document.querySelector('dialog[open], [popover]:popover-open')) return
      setSettingsReturnFocus(
        returnFocus ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
      )
      if (window.innerWidth < sidebarBreakpoint) setSidebarOpen(false)
      setSettingsOpen(true)
    },
    [setSidebarOpen, settingsOpen]
  )

  async function showChatAfter(navigate: () => Promise<boolean>): Promise<boolean> {
    if (settingsSavingRef.current) return false
    const accepted = await navigate()
    if (accepted) {
      setSettingsOpen(false)
      setSidebarView('active')
      if (window.innerWidth < sidebarBreakpoint) setSidebarOpen(false)
    }
    return accepted
  }

  useEffect(() => {
    return window.api.onAgentUserInputChange((request) => {
      if (request) {
        setSettingsOpen(false)
        setSearchOpen(false)
        setConversationSearch('')
      }
    })
  }, [setConversationSearch])

  useEffect(() => {
    if (!settingsOpen && !searchOpen) return
    // An approval or window-close dialog needs the chat surface that owns it.
    const showPendingDialog = (): void => {
      const dialog = document.querySelector<HTMLDialogElement>(
        'dialog[open]:not(.sidebar-search-dialog)'
      )
      if (!dialog) return
      setSettingsOpen(false)
      setSearchOpen(false)
      setConversationSearch('')
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
  }, [settingsOpen, searchOpen, setConversationSearch])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open], [popover]:popover-open')
      ) {
        const key = event.key.toLowerCase()
        if (key === 'b') {
          event.preventDefault()
          setSidebarOpen((previous) => !previous)
          return
        }
        if (key === 'k') {
          event.preventDefault()
          setSearchOpen(true)
          return
        }
        if (key === 'n') {
          event.preventDefault()
          document.querySelector<HTMLButtonElement>('.conversation-create')?.click()
          return
        }
      }
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
  }, [openSettings, setSidebarOpen, settingsOpen])

  return (
    <div
      className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}${sidebarExpanded ? ' sidebar-visible' : ''}${sidebarPeeking ? ' sidebar-peeking' : ''}${sidebarResizing ? ' sidebar-resizing' : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      onPointerDownCapture={(event) => {
        if (
          sidebarPeeking &&
          !(event.target as Element).closest(
            '#conversation-sidebar, .sidebar-collapsed-rail, .sidebar-popover'
          )
        ) {
          setSidebarOpen(false)
        }
      }}
    >
      <TitleBar />
      <SidebarRail
        open={sidebarOpen}
        peeking={sidebarPeeking}
        disabled={
          !conversation.canNavigate || settingsSaving || conversation.conversations.length >= 100
        }
        settingsOpen={settingsOpen}
        onToggle={() => setSidebarOpen((previous) => !previous)}
        onOpen={() => {
          if (settingsSavingRef.current) return
          setSettingsOpen(false)
          setSidebarOpen(true)
        }}
        onCreate={() => showChatAfter(conversation.create)}
        onSearch={() => setSearchOpen(true)}
        onOpenSettings={openSettings}
        onPreviewEnter={enterSidebarPreview}
        onPreviewLeave={leaveSidebarPreview}
      />
      <button
        className="sidebar-backdrop"
        aria-label="关闭侧栏"
        aria-hidden={!sidebarOpen}
        hidden={!sidebarPresent}
        disabled={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar
        conversations={conversation.conversations}
        visibleConversations={conversation.visibleConversations}
        activeConversationId={conversation.activeConversationId}
        disabled={!conversation.canNavigate || settingsSaving}
        hidden={!sidebarOpen && !sidebarPeeking}
        present={sidebarPresent}
        transitioning={sidebarTransitioning}
        onTransitionEnd={finishSidebarTransition}
        view={sidebarView}
        onViewChange={setSidebarView}
        settingsOpen={settingsOpen}
        width={sidebarWidth}
        onWidthChange={changeSidebarWidth}
        onResizingChange={setSidebarResizing}
        onCollapse={() => setSidebarOpen(false)}
        onExpand={() => setSidebarOpen(true)}
        peeking={sidebarPeeking}
        onPreviewEnter={enterSidebarPreview}
        onPreviewLeave={leaveSidebarPreview}
        onOpenSearch={() => setSearchOpen(true)}
        onSelectWorkspace={() => showChatAfter(conversation.workspace.select)}
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
      <SidebarSearch
        open={searchOpen}
        disabled={!conversation.canNavigate || settingsSaving}
        conversations={conversation.visibleConversations}
        search={conversation.search}
        onSearch={conversation.setSearch}
        onClose={() => {
          setSearchOpen(false)
          conversation.setSearch('')
        }}
        onSelect={(id) => showChatAfter(() => conversation.select(id))}
        onRestore={(id) => showChatAfter(() => conversation.restore(id))}
      />
      <div className="workspace-shell" hidden={settingsOpen} inert={settingsOpen}>
        <div
          className={`workspace-body${sourcesPanel.open || fileView.state.status !== 'idle' ? ' with-sources-view' : ''}`}
        >
          <ChatWorkspace
            conversation={conversation}
            onOpenFile={onOpenFile}
            summary={threadSummary}
            sources={sources}
            onShowAllSources={onShowAllSources}
          />
          <ThreadSourcesSidePanel
            key={sourcesContext}
            sources={sources}
            sourcesOpen={sourcesPanel.open}
            selected={sourcesPanel.selected}
            fileState={fileView.state}
            active={!settingsOpen}
            onSelect={sourcesPanel.select}
            onCloseSources={onCloseSources}
            onCloseFile={onCloseSourceFile}
            onOpenFile={onOpenFile}
          />
        </div>
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
