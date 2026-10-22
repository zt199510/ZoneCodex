import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { threadSummarySources } from './features/chat/thread-summary-sources'
import type { OpenFileView } from './features/files/file-view-origin'
import { useConversation } from './features/conversation/useConversation'
import { SettingsPage } from './features/settings/SettingsPage'
import { SkillsPage } from './features/skills/SkillsPage'
import { Icon } from './components/ui/Icon'
import type { SkillDescriptor } from '../../shared/skills'
import { WorkbenchWorkspace, type WorkbenchHandle } from './features/workbench/WorkbenchWorkspace'

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
  const [page, setPage] = useState<'chat' | 'settings' | 'skills'>('chat')
  const pageRef = useRef(page)
  const pageRevision = useRef(0)
  const conversationIdRef = useRef(conversation.activeConversationId)
  useLayoutEffect(() => {
    conversationIdRef.current = conversation.activeConversationId
  }, [conversation.activeConversationId])
  const showPage = useCallback((next: 'chat' | 'settings' | 'skills'): void => {
    pageRef.current = next
    pageRevision.current++
    setPage(next)
  }, [])
  const settingsOpen = page === 'settings'
  const skillsOpen = page === 'skills'
  const auxiliaryPageOpen = page !== 'chat'
  const threadSummary = useThreadSummaryPanel(
    auxiliaryPageOpen || (conversation.messages.length === 0 && !conversation.resumableTask)
      ? null
      : conversation.activeConversationId
  )
  const [settingsSaving, setSettingsSaving] = useState(false)
  const settingsSavingRef = useRef(false)
  const onSettingsSavingChange = useCallback((saving: boolean): void => {
    settingsSavingRef.current = saving
    setSettingsSaving(saving)
  }, [])
  const [settingsReturnFocus, setSettingsReturnFocus] = useState<HTMLElement>()
  const [skillsReturnFocus, setSkillsReturnFocus] = useState<HTMLElement>()
  const workbench = useRef<WorkbenchHandle>(null)
  const sources = useMemo(
    () => threadSummarySources(conversation.messages, conversation.toolRuns),
    [conversation.messages, conversation.toolRuns]
  )
  const onOpenFile = useCallback<OpenFileView>(
    (reference, origin, trigger): void => {
      workbench.current?.openFile(reference, origin, trigger)
    },
    []
  )
  const closeSummaryOverlay = threadSummary.closeOverlay
  const onShowAllSources = useCallback(
    (): void => {
      workbench.current?.openSources()
      closeSummaryOverlay()
    },
    [closeSummaryOverlay]
  )
  useEffect(() => {
    const reveal = (): void => showPage('chat')
    window.addEventListener('workbench:show', reveal)
    return () => window.removeEventListener('workbench:show', reveal)
  }, [showPage])
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
      showPage('settings')
    },
    [setSidebarOpen, settingsOpen, showPage]
  )

  const openSkills = (returnFocus?: HTMLElement): void => {
    if (skillsOpen || settingsSavingRef.current || !conversation.canNavigate) return
    if (document.querySelector('dialog[open], [popover]:popover-open')) return
    setSkillsReturnFocus(
      returnFocus ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    )
    if (window.innerWidth < sidebarBreakpoint) setSidebarOpen(false)
    showPage('skills')
  }

  const closeSkills = useCallback((): void => {
    showPage('chat')
    const revision = pageRevision.current
    requestAnimationFrame(() => {
      if (
        pageRef.current !== 'chat' ||
        pageRevision.current !== revision ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      const canRestore = (element: HTMLElement | undefined | null): boolean =>
        Boolean(
          element?.isConnected &&
          element.getClientRects().length &&
          !element.closest('[inert]') &&
          !element.matches(':disabled')
        )
      const target = canRestore(skillsReturnFocus)
        ? skillsReturnFocus
        : document.querySelector<HTMLButtonElement>('.rail-skills')
      if (canRestore(target)) target?.focus({ preventScroll: true })
      else document.getElementById('chat-input')?.focus({ preventScroll: true })
    })
  }, [showPage, skillsReturnFocus])

  const selectSkill = async (item: SkillDescriptor): Promise<boolean> => {
    if (pageRef.current !== 'skills') return false
    const revision = pageRevision.current
    const id = conversation.activeConversationId
    const accepted = await conversation.skills.select(item)
    if (
      accepted &&
      pageRef.current === 'skills' &&
      pageRevision.current === revision &&
      conversationIdRef.current === id &&
      !document.querySelector('dialog[open], [popover]:popover-open')
    ) {
      showPage('chat')
      requestAnimationFrame(() => {
        if (pageRef.current !== 'chat' || document.querySelector('dialog[open]')) return
        document.getElementById('chat-input')?.focus({ preventScroll: true })
      })
    }
    return accepted
  }

  async function showChatAfter(navigate: () => Promise<boolean>): Promise<boolean> {
    if (settingsSavingRef.current) return false
    const accepted = await navigate()
    if (accepted) {
      showPage('chat')
      setSidebarView('active')
      if (window.innerWidth < sidebarBreakpoint) setSidebarOpen(false)
    }
    return accepted
  }

  useEffect(() => {
    return window.api.onAgentUserInputChange((request) => {
      if (request) {
        showPage('chat')
        setSearchOpen(false)
        setConversationSearch('')
      }
    })
  }, [setConversationSearch, showPage])

  useEffect(() => {
    if (!auxiliaryPageOpen && !searchOpen) return
    // An approval or window-close dialog needs the chat surface that owns it.
    const showPendingDialog = (): void => {
      const dialog = document.querySelector<HTMLDialogElement>(
        'dialog[open]:not(.sidebar-search-dialog):not(.skill-detail-dialog)'
      )
      if (!dialog) return
      showPage('chat')
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
  }, [auxiliaryPageOpen, searchOpen, setConversationSearch, showPage])

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
        if (auxiliaryPageOpen) {
          event.preventDefault()
          if (skillsOpen) closeSkills()
          else showPage('chat')
        } else setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSettings, setSidebarOpen, auxiliaryPageOpen, skillsOpen, closeSkills, showPage])

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
        skillsOpen={skillsOpen}
        skillsDisabled={!conversation.canNavigate || settingsSaving}
        onToggle={() => setSidebarOpen((previous) => !previous)}
        onOpen={() => {
          if (settingsSavingRef.current) return
          showPage('chat')
          setSidebarOpen(true)
        }}
        onCreate={() => showChatAfter(conversation.create)}
        onSearch={() => setSearchOpen(true)}
        onOpenSettings={openSettings}
        onOpenSkills={openSkills}
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
        skillsOpen={skillsOpen}
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
        onOpenSkills={openSkills}
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
      <div className="workspace-shell" hidden={auxiliaryPageOpen} inert={auxiliaryPageOpen}>
        <WorkbenchWorkspace
          ref={workbench}
          conversation={conversation}
          sources={sources}
          active={!auxiliaryPageOpen}
        >
          {({ newTabVisible, openNewTab, openNewTabMenu }) => (
            <ChatWorkspace
              conversation={conversation}
              onOpenFile={onOpenFile}
              summary={threadSummary}
              sources={sources}
              onShowAllSources={onShowAllSources}
              toolbarActions={
                newTabVisible ? (
                  <button
                    type="button"
                    className="thread-toolbar-button panel-launcher"
                    aria-label="新建标签页"
                    title="新建标签页"
                    onClick={openNewTab}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      openNewTabMenu()
                    }}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                ) : undefined
              }
            />
          )}
        </WorkbenchWorkspace>
      </div>
      <SettingsPage
        open={settingsOpen}
        canChange={conversation.canChangeSettings}
        returnFocus={settingsReturnFocus}
        onSavingChange={onSettingsSavingChange}
        onClose={() => showPage('chat')}
      />
      <SkillsPage
        open={skillsOpen}
        skills={conversation.skills}
        disabled={!conversation.canNavigate || settingsSaving}
        returnFocus={skillsReturnFocus}
        onSelect={selectSkill}
      />
    </div>
  )
}

export default App
