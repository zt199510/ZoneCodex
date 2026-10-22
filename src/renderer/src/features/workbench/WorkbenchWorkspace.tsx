import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ReactNode } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import type { OpenFileView } from '../files/file-view-origin'
import type { ThreadSummarySource } from '../chat/thread-summary-sources'
import { Icon, type IconName } from '../../components/ui/Icon'
import { EditorTab, type EditorHandle } from './EditorTab'
import { BrowserTab } from './BrowserTab'
import { FilesTab } from './FilesTab'
import { ChangesTab } from './ChangesTab'
import { TerminalPanel, type TerminalPanelHandle } from '../terminal/TerminalPanel'
import { registerPanelCloseParticipant } from './close-participants'
import {
  addPanelTab,
  closePanelTab,
  movePanelTab,
  reopenPanelTab,
  sanitizeRestoredPanel
} from './panel-model'
import { emptyPanelState } from '../../../../shared/workbench'
import type {
  PanelState,
  PanelTab,
  WorkbenchContext,
  EditorDraft
} from '../../../../shared/workbench'

export type WorkbenchHandle = {
  openFile: OpenFileView
  openSources: () => void
  openNew: (full?: boolean) => void
}
export type WorkbenchToolbarActions = {
  newTabVisible: boolean
  openNewTab: () => void
  openNewTabMenu: () => void
}
type Session = {
  state: PanelState
  context: WorkbenchContext
  contextKey: string
  loaded: boolean
  error?: string
}
type Prompt = { message: string; resolve: (choice: 'save' | 'discard' | 'cancel') => void }
const names = {
  new: '新标签页',
  files: '文件',
  sources: '来源',
  changes: '改动',
  terminal: '终端',
  browser: '浏览器',
  file: '文件'
}
const icons: Record<PanelTab['kind'], IconName> = {
  new: 'panel',
  files: 'folder',
  sources: 'book',
  changes: 'code',
  terminal: 'terminal',
  browser: 'search',
  file: 'file'
}
export const WorkbenchWorkspace = forwardRef<
  WorkbenchHandle,
  {
    conversation: ConversationController
    sources: ThreadSummarySource[]
    active: boolean
    children: (actions: WorkbenchToolbarActions) => ReactNode
  }
>(function WorkbenchWorkspace({ conversation, sources, active, children }, ref) {
  const id = conversation.activeConversationId
  const root = useRef<HTMLDivElement>(null)
  const [sessions, setSessions] = useState<Record<string, Session>>({})
  const latest = useRef(sessions)
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const fresh = useRef(new Set<string>())
  const pendingAdd = useRef<{
    kind: PanelTab['kind']
    extras?: { file?: Extract<PanelTab, { kind: 'file' }>['file']; url?: string }
    full?: boolean
  } | null>(null)
  const editors = useRef(new Map<string, EditorHandle>())
  const terminals = useRef(new Map<string, TerminalPanelHandle>())
  const [width, setWidth] = useState(0)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [addMenu, setAddMenu] = useState(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [notice, setNotice] = useState('')
  const [closing, setClosing] = useState(new Set<string>())
  const loading = useRef(new Set<string>())
  const saved = useRef(new Map<string, PanelState>())
  const activeRef = useRef({ id, active, conversation, width })
  useLayoutEffect(() => {
    latest.current = sessions
    activeRef.current = { id, active, conversation, width }
  }, [sessions, id, active, conversation, width])
  const update = useCallback(
    (conversationId: string, change: (state: PanelState) => PanelState): void => {
      const existing = latest.current[conversationId]
      if (!existing || !existing.loaded || existing.error) return
      try {
        const next = {
          ...latest.current,
          [conversationId]: { ...existing, state: change(existing.state) }
        }
        latest.current = next
        setSessions(next)
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : '标签操作失败')
      }
    },
    []
  )
  const workspaceId = conversation.workspace.runtime?.workspaceId
  const context = useMemo<WorkbenchContext | null>(
    () => (id ? { conversationId: id, ...(workspaceId ? { workspaceId } : {}) } : null),
    [id, workspaceId]
  )
  const contextKey = JSON.stringify([
    id,
    context?.workspaceId ?? null,
    conversation.executionPermissions.state?.revision ?? null
  ])
  useEffect(() => {
    if (!id || !context || loading.current.has(id)) return
    loading.current.add(id)
    const captured = { context, contextKey }
    void window.api
      .loadPanelState(id)
      .then((result) => {
        const state = result.ok ? sanitizeRestoredPanel(result.data) : emptyPanelState()
        saved.current.set(id, state)
        setSessions((previous) => ({
          ...previous,
          [id]: { state, ...captured, loaded: true, ...(result.ok ? {} : { error: result.error }) }
        }))
        if (state.selected !== 'chat')
          setVisited((previous) => new Set([...previous, state.selected]))
      })
      .catch((reason) => {
        setSessions((previous) => ({
          ...previous,
          [id]: { state: emptyPanelState(), ...captured, loaded: true, error: String(reason) }
        }))
      })
  }, [id, context, contextKey])
  useEffect(() => {
    if (!id || !context) return
    setSessions((previous) => {
      const session = previous[id]
      return !session || session.contextKey === contextKey
        ? previous
        : { ...previous, [id]: { ...session, context, contextKey } }
    })
  }, [id, context, contextKey, sessions[id ?? '']?.loaded])
  const persist = useCallback(async (): Promise<boolean> => {
    let success = true
    for (const [conversationId, session] of Object.entries(latest.current)) {
      if (!session.loaded || session.error || saved.current.get(conversationId) === session.state)
        continue
      try {
        const result = await window.api.savePanelState(conversationId, session.state)
        if (result.ok) saved.current.set(conversationId, session.state)
        else {
          setNotice(result.error)
          success = false
        }
      } catch (reason) {
        setNotice(String(reason))
        success = false
      }
    }
    return success
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => void persist(), 250)
    return () => clearTimeout(timer)
  }, [sessions, persist])
  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (prompt) {
      dialog.current?.showModal()
      dialog.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus()
    } else dialog.current?.close()
  }, [prompt])
  const ask = useCallback(
    (message: string): Promise<'save' | 'discard' | 'cancel'> =>
      new Promise((resolve) => {
        window.dispatchEvent(new Event('workbench:show'))
        setPrompt({ message, resolve })
      }),
    []
  )
  const finishClose = useCallback(
    (conversationId: string, tabId: string, history = true): void => {
      update(conversationId, (state) => closePanelTab(state, tabId, history))
      setClosing((previous) => {
        const next = new Set(previous)
        next.delete(tabId)
        return next
      })
      editors.current.delete(tabId)
      terminals.current.delete(tabId)
      fresh.current.delete(tabId)
    },
    [update]
  )
  const closeTab = useCallback(
    async (conversationId: string, tabId: string): Promise<boolean> => {
      const session = latest.current[conversationId]
      const tab = session?.state.tabs.find((item) => item.id === tabId)
      if (!tab) return true
      if (dialog.current?.open) return false
      if (session.state.drafts[tabId]) {
        const choice = await ask(`“${tab.title}”有未保存修改，是否保存？`)
        if (choice === 'cancel') return false
        if (choice === 'save' && !(await editors.current.get(tabId)?.save())) return false
      }
      const terminal = terminals.current.get(tabId)
      if (terminal) {
        setClosing((previous) => new Set([...previous, tabId]))
        const result = await terminal.close()
        if (!result)
          setClosing((previous) => {
            const next = new Set(previous)
            next.delete(tabId)
            return next
          })
        return result
      }
      if (tab.kind === 'browser') {
        try {
          await window.api.closeBrowserTab(conversationId, tabId)
        } catch (reason) {
          setNotice(String(reason))
          return false
        }
      }
      finishClose(conversationId, tabId)
      return true
    },
    [ask, finishClose]
  )
  const select = useCallback(
    (conversationId: string, tabId: string): void => {
      setVisited((previous) => new Set([...previous, tabId]))
      update(conversationId, (state) => ({ ...state, selected: tabId }))
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLButtonElement>(`[data-tab-id="${tabId}"]`)
          ?.focus({ preventScroll: true })
      )
      requestAnimationFrame(() =>
        root.current
          ?.querySelector(`[data-tab-id="${tabId}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      )
    },
    [update]
  )
  const add = useCallback(
    (
      kind: PanelTab['kind'],
      extras?: { file?: Extract<PanelTab, { kind: 'file' }>['file']; url?: string },
      full?: boolean,
      targetConversationId?: string
    ): void => {
      const conversationId = targetConversationId ?? activeRef.current.id
      if (targetConversationId && !latest.current[targetConversationId]?.loaded) return
      if (!conversationId || !latest.current[conversationId]?.loaded) {
        pendingAdd.current = { kind, extras, full }
        if (!conversationId)
          void activeRef.current.conversation.create().then((created) => {
            if (!created) {
              pendingAdd.current = null
              setNotice('新建会话未成功，请重试')
            }
          })
        return
      }
      const tabId = crypto.randomUUID()
      const tab = {
        id: tabId,
        kind,
        title:
          kind === 'file'
            ? (extras!.file!.reference.path.split(/[\\/]/).at(-1) ?? '文件')
            : names[kind],
        ...(kind === 'file' ? { file: extras!.file } : {}),
        ...(kind === 'browser' ? { url: extras?.url ?? 'about:blank' } : {})
      } as PanelTab
      fresh.current.add(tabId)
      setVisited((previous) => new Set([...previous, tabId]))
      update(conversationId, (state) => {
        const next = addPanelTab(
          state,
          tab,
          full ? 'full' : state.layout === 'chat' ? 'split' : state.layout
        )
        return next
      })
    },
    [update]
  )
  const openNewTab = useCallback((): void => add('new'), [add])
  const openNewTabMenu = useCallback((): void => setAddMenu(true), [])
  useImperativeHandle(
    ref,
    () => ({
      openFile: (reference, origin) =>
        add('file', { file: { reference, source: origin.source, messageId: origin.messageId } }),
      openSources: () => add('sources'),
      openNew: (full) => add('new', undefined, full)
    }),
    [add]
  )
  useEffect(() => {
    return registerPanelCloseParticipant(async (deletedId, committed) => {
      if (deletedId && committed) {
        const next = { ...latest.current }
        delete next[deletedId]
        latest.current = next
        setSessions(next)
        loading.current.delete(deletedId)
        saved.current.delete(deletedId)
        const result = await window.api.removePanelState(deletedId)
        if (!result.ok) {
          setNotice(result.error)
          return false
        }
        return true
      }
      if (deletedId && !latest.current[deletedId]) {
        const result = await window.api.loadPanelState(deletedId)
        if (!result.ok) {
          setNotice(result.error)
          return false
        }
        const restored = sanitizeRestoredPanel(result.data)
        const context = { conversationId: deletedId }
        const next = {
          ...latest.current,
          [deletedId]: {
            state: restored,
            context,
            contextKey: JSON.stringify([deletedId, null, null]),
            loaded: true
          }
        }
        latest.current = next
        setSessions(next)
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      }
      if (dialog.current?.open) return false
      const targetIds = deletedId ? [deletedId] : Object.keys(latest.current)
      const drafts = targetIds.flatMap((targetId) =>
        Object.keys(latest.current[targetId].state.drafts)
      )
      if (drafts.length) {
        const choice = await ask(
          `有 ${drafts.length} 个文件尚未保存，是否保存后${deletedId ? '删除会话' : '关闭窗口'}？`
        )
        if (choice === 'cancel') return false
        if (choice === 'save') {
          for (const tabId of drafts) if (!(await editors.current.get(tabId)?.save())) return false
        } else
          for (const conversationId of targetIds)
            update(conversationId, (state) => ({ ...state, drafts: {} }))
      }
      if (deletedId) {
        for (const tab of [...latest.current[deletedId].state.tabs]) {
          if (!(await closeTab(deletedId, tab.id))) return false
        }
      }
      return persist()
    })
  }, [ask, persist, update, closeTab])
  const actions = useRef({ add, closeTab, select, update })
  useLayoutEffect(() => {
    actions.current = { add, closeTab, select, update }
  })
  useEffect(() => {
    if (id && sessions[id]?.loaded && pendingAdd.current) {
      const pending = pendingAdd.current
      pendingAdd.current = null
      actions.current.add(pending.kind, pending.extras, pending.full)
    }
  }, [id, sessions])
  const shortcuts = useCallback((event: KeyboardEvent): void => {
    const owner = activeRef.current
    if (
      !owner.active ||
      !owner.id ||
      event.isComposing ||
      event.defaultPrevented ||
      document.querySelector('dialog[open], [popover]:popover-open')
    )
      return
    const state = latest.current[owner.id]?.state
    if (!state) return
    const layout = state.layout === 'split' && owner.width < 678 ? 'full' : state.layout
    const key = event.key.toLowerCase(),
      mod = event.ctrlKey || event.metaKey
    let handled = true
    if (mod && key === 't' && event.shiftKey) actions.current.update(owner.id, reopenPanelTab)
    else if (mod && key === 't' && !event.altKey) actions.current.add('browser')
    else if (mod && key === 'w' && event.altKey) {
      void (async () => {
        for (const tab of state.tabs)
          if (tab.id !== state.selected && !(await actions.current.closeTab(owner.id!, tab.id)))
            break
      })()
    } else if (
      mod &&
      (key === 'w' || key === 'f4') &&
      !event.shiftKey &&
      !event.altKey &&
      state.selected !== 'chat'
    )
      void actions.current.closeTab(owner.id, state.selected)
    else if (mod && (key === 'tab' || key === 'pageup' || key === 'pagedown')) {
      const tabs =
        layout === 'full'
          ? ['chat', ...state.tabs.map((tab) => tab.id)]
          : state.tabs.map((tab) => tab.id)
      if (tabs.length) {
        const index = tabs.indexOf(state.selected)
        const offset = event.shiftKey || key === 'pageup' ? -1 : 1
        actions.current.select(owner.id, tabs[(index + offset + tabs.length) % tabs.length])
      }
    } else if (event.altKey && /^[1-9]$/.test(key)) {
      const tabs =
        layout === 'full'
          ? ['chat', ...state.tabs.map((tab) => tab.id)]
          : state.tabs.map((tab) => tab.id)
      if (tabs.length)
        actions.current.select(
          owner.id,
          key === '9' ? tabs[tabs.length - 1] : (tabs[Number(key) - 1] ?? tabs[tabs.length - 1])
        )
    } else handled = false
    if (handled) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }, [])
  useEffect(() => {
    window.addEventListener('keydown', shortcuts, true)
    const dispose = window.api.onBrowserNewTab((event) => {
      actions.current.add('browser', { url: event.url }, undefined, event.conversationId)
    })
    const disposeKeys = window.api.onBrowserKey((event) =>
      shortcuts(new KeyboardEvent('keydown', { ...event, cancelable: true }))
    )
    const dismiss = (): void => {
      setMenu(null)
      setAddMenu(false)
    }
    window.addEventListener('pointerdown', dismiss)
    return () => {
      window.removeEventListener('keydown', shortcuts, true)
      window.removeEventListener('pointerdown', dismiss)
      dispose()
      disposeKeys()
    }
  }, [shortcuts])
  const state = id ? (sessions[id]?.state ?? emptyPanelState()) : emptyPanelState()
  const effectiveLayout = state.layout === 'split' && width < 678 ? 'full' : state.layout
  useEffect(() => {
    if (!active || effectiveLayout === 'chat') return
    const frame = requestAnimationFrame(() => {
      root.current
        ?.querySelector(`[data-tab-id="${state.selected}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [active, effectiveLayout, state.selected, width, state.width])
  const chatVisible = effectiveLayout !== 'full' || state.selected === 'chat'
  const panelVisible = effectiveLayout !== 'chat' && (!chatVisible || effectiveLayout === 'split')
  function showChat(): void {
    if (!id) return
    update(id, (previous) => {
      const tab = previous.tabs.find((item) => item.id === previous.selected)
      const next = tab?.kind === 'new' ? closePanelTab(previous, tab.id, false) : previous
      return {
        ...next,
        selected: 'chat',
        layout: effectiveLayout === 'full' ? next.layout : 'chat'
      }
    })
    requestAnimationFrame(() =>
      document.getElementById('chat-input')?.focus({ preventScroll: true })
    )
  }
  function resize(event: React.PointerEvent<HTMLDivElement>): void {
    if (!id || !root.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const element = event.currentTarget,
      right = root.current.getBoundingClientRect().right
    const move = (input: PointerEvent): void =>
      update(id, (previous) => ({
        ...previous,
        width: Math.max(320, Math.min(width - 358, right - input.clientX))
      }))
    const stop = (): void => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', stop)
      element.removeEventListener('pointercancel', stop)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', stop)
    element.addEventListener('pointercancel', stop)
  }
  function tabButton(
    tabId: string,
    title: string,
    kind: PanelTab['kind'] | 'chat'
  ): React.JSX.Element {
    const selected = state.selected === tabId
    return (
      <div
        className="panel-tab-container"
        key={tabId}
        draggable={kind !== 'chat'}
        onDragStart={(event) => event.dataTransfer.setData('application/zonecodex-tab', tabId)}
        onDragOver={(event) => {
          if (kind !== 'chat') event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (id)
            update(id, (previous) =>
              movePanelTab(previous, event.dataTransfer.getData('application/zonecodex-tab'), tabId)
            )
        }}
      >
        <button
          type="button"
          role="tab"
          id={`panel-tab-${tabId}`}
          data-tab-id={tabId}
          aria-selected={selected}
          aria-controls={kind === 'chat' ? 'panel-chat' : `panel-page-${tabId}`}
          tabIndex={selected ? 0 : -1}
          className="panel-tab"
          title={title}
          onClick={() => id && select(id, tabId)}
          onDoubleClick={() =>
            kind !== 'chat' &&
            id &&
            update(id, (previous) => ({
              ...previous,
              layout: effectiveLayout === 'split' ? 'full' : 'split'
            }))
          }
          onAuxClick={(event) => {
            if (event.button === 1 && kind !== 'chat' && id) {
              event.preventDefault()
              void closeTab(id, tabId)
            }
          }}
          onContextMenu={(event) => {
            if (kind === 'chat') return
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY, id: tabId })
          }}
          onKeyDown={(event) => {
            if (!id) return
            const order =
              effectiveLayout === 'full'
                ? ['chat', ...state.tabs.map((tab) => tab.id)]
                : state.tabs.map((tab) => tab.id)
            const index = order.indexOf(tabId)
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              select(
                id,
                event.key === 'Home'
                  ? order[0]
                  : event.key === 'End'
                    ? order[order.length - 1]
                    : order[
                        (index + (event.key === 'ArrowRight' ? 1 : -1) + order.length) %
                          order.length
                      ]
              )
            }
            if (event.key === 'Delete' && kind !== 'chat') {
              event.preventDefault()
              void closeTab(id, tabId)
            }
          }}
        >
          <Icon name={kind === 'chat' ? 'chat' : icons[kind]} size={15} />
          <span>{title}</span>
          {!!state.drafts[tabId] && (
            <span className="panel-dirty-dot" aria-label="未保存">
              ●
            </span>
          )}
        </button>
        {kind !== 'chat' && (
          <button
            type="button"
            className="panel-tab-close"
            aria-label={`关闭${title}`}
            disabled={closing.has(tabId)}
            onClick={() => id && void closeTab(id, tabId)}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
    )
  }
  const tabStrip = (
    <header className="panel-tabs-header">
      <div className="panel-tabs" role="tablist" aria-label="打开的标签页">
        {effectiveLayout === 'full' && tabButton('chat', '聊天', 'chat')}
        {state.tabs.map((tab) => tabButton(tab.id, tab.title, tab.kind))}
      </div>
      <div className="panel-tabs-actions">
        <button
          type="button"
          className="panel-icon-button"
          aria-label="新建标签页"
          onClick={() => add('new')}
          onContextMenu={(event) => {
            event.preventDefault()
            setAddMenu(true)
          }}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          type="button"
          className="panel-icon-button"
          aria-label={effectiveLayout === 'split' ? '完整视图' : '左右分屏'}
          onClick={() =>
            id &&
            update(id, (previous) => ({
              ...previous,
              layout: effectiveLayout === 'split' ? 'full' : 'split'
            }))
          }
        >
          <Icon name="panel" size={16} />
        </button>
        <button
          type="button"
          className="panel-icon-button"
          aria-label="隐藏工作面板"
          onClick={() =>
            id && update(id, (previous) => ({ ...previous, layout: 'chat', selected: 'chat' }))
          }
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </header>
  )
  return (
    <div className={`workbench-workspace layout-${effectiveLayout}`} ref={root}>
      {effectiveLayout === 'full' && tabStrip}
      <div className="workbench-body">
        <div id="panel-chat" className="panel-chat" hidden={!chatVisible} inert={!chatVisible}>
          {children({
            newTabVisible: effectiveLayout !== 'full',
            openNewTab,
            openNewTabMenu
          })}
        </div>
        {effectiveLayout === 'split' && (
          <div
            className="panel-splitter"
            role="separator"
            aria-label="调整工作面板宽度"
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={resize}
            onKeyDown={(event) => {
              if (id && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault()
                update(id, (previous) => ({
                  ...previous,
                  width: Math.max(
                    320,
                    Math.min(width - 358, previous.width + (event.key === 'ArrowLeft' ? 20 : -20))
                  )
                }))
              }
            }}
          />
        )}
        <aside
          className="workbench-panel"
          aria-label="工作面板"
          hidden={!panelVisible}
          inert={!panelVisible}
          style={
            effectiveLayout === 'split'
              ? { width: Math.max(320, Math.min(state.width, width - 358)) }
              : undefined
          }
        >
          {effectiveLayout === 'split' && tabStrip}
          <div className="panel-pages">
            {Object.entries(sessions).flatMap(([conversationId, session]) =>
              session.state.tabs
                .filter(
                  (tab) =>
                    visited.has(tab.id) ||
                    !!session.state.drafts[tab.id] ||
                    (conversationId === id && tab.id === state.selected)
                )
                .map((tab) => {
                  const shown =
                    conversationId === id && tab.id === state.selected && panelVisible && active
                  const onDraft = (draft: EditorDraft | null): void =>
                    update(conversationId, (previous) => {
                      const drafts = { ...previous.drafts }
                      if (draft) drafts[tab.id] = draft
                      else delete drafts[tab.id]
                      return { ...previous, drafts }
                    })
                  return (
                    <div
                      className="panel-page"
                      key={tab.id}
                      id={`panel-page-${tab.id}`}
                      role="tabpanel"
                      aria-labelledby={`panel-tab-${tab.id}`}
                      hidden={!shown}
                      inert={!shown}
                    >
                      {tab.kind === 'new' && (
                        <div className="panel-new-page">
                          <h2>工具</h2>
                          <div className="panel-tool-grid">
                            <button type="button" onClick={showChat}>
                              <Icon name="chat" />
                              <span>聊天</span>
                            </button>
                            {(['files', 'browser', 'changes', 'terminal'] as const).map((kind) => (
                              <button type="button" key={kind} onClick={() => add(kind)}>
                                <Icon name={icons[kind]} />
                                <span>{names[kind]}</span>
                                {kind === 'browser' && <kbd>Ctrl+T</kbd>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {tab.kind === 'files' && (
                        <FilesTab
                          context={session.context}
                          contextKey={session.contextKey}
                          active={shown}
                          onOpen={(path) =>
                            add('file', {
                              file: { reference: { path }, source: { kind: 'local' } }
                            })
                          }
                        />
                      )}
                      {tab.kind === 'sources' && (
                        <div className="panel-source-list">
                          {sources.length ? (
                            sources.map((source) => (
                              <button
                                type="button"
                                key={source.key}
                                onClick={() =>
                                  add('file', {
                                    file: {
                                      reference: source.reference,
                                      source: source.origin.source,
                                      messageId: source.origin.messageId
                                    }
                                  })
                                }
                              >
                                <Icon name="file" />
                                <span>
                                  <strong>{source.reference.path.split(/[\\/]/).at(-1)}</strong>
                                  <small>{source.reference.path}</small>
                                </span>
                              </button>
                            ))
                          ) : (
                            <p>当前会话还没有来源。</p>
                          )}
                        </div>
                      )}
                      {tab.kind === 'file' && (
                        <EditorTab
                          tab={tab}
                          context={session.context}
                          contextKey={session.contextKey}
                          active={shown}
                          draft={session.state.drafts[tab.id]}
                          onDraft={onDraft}
                          register={(handle) => {
                            if (handle) editors.current.set(tab.id, handle)
                            else editors.current.delete(tab.id)
                          }}
                        />
                      )}
                      {tab.kind === 'browser' && (
                        <BrowserTab
                          conversationId={conversationId}
                          tab={tab}
                          autoLoad={fresh.current.has(tab.id)}
                          onChange={(patch) =>
                            update(conversationId, (previous) => ({
                              ...previous,
                              tabs: previous.tabs.map((item) =>
                                item.id === tab.id ? ({ ...item, ...patch } as PanelTab) : item
                              )
                            }))
                          }
                        />
                      )}
                      {tab.kind === 'terminal' && (
                        <TerminalPanel
                          embedded
                          context={session.context}
                          autoStart={fresh.current.has(tab.id)}
                          visible={shown}
                          onClose={() => finishClose(conversationId, tab.id)}
                          ref={(handle) => {
                            if (handle) terminals.current.set(tab.id, handle)
                            else terminals.current.delete(tab.id)
                          }}
                        />
                      )}
                      {tab.kind === 'changes' && (
                        <ChangesTab
                          active={shown}
                          onClose={() => void closeTab(conversationId, tab.id)}
                        />
                      )}
                    </div>
                  )
                })
            )}
          </div>
        </aside>
      </div>
      {(notice || (id && sessions[id]?.error)) && (
        <div className="panel-notice" role="alert">
          <span>{notice || sessions[id!]?.error}</span>
          <button
            type="button"
            onClick={() => {
              setNotice('')
              void persist()
            }}
          >
            重试保存
          </button>
        </div>
      )}
      {menu && (
        <div
          className="panel-context-menu"
          role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 140)
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {(['关闭', '关闭其他标签页', '关闭右侧标签页'] as const).map((label, index) => (
            <button
              role="menuitem"
              type="button"
              key={label}
              onClick={() => {
                if (!id) return
                const chosen =
                  index === 0
                    ? [menu.id]
                    : index === 1
                      ? state.tabs.filter((tab) => tab.id !== menu.id).map((tab) => tab.id)
                      : state.tabs
                          .slice(state.tabs.findIndex((tab) => tab.id === menu.id) + 1)
                          .map((tab) => tab.id)
                setMenu(null)
                void (async () => {
                  for (const tabId of chosen) if (!(await closeTab(id, tabId))) break
                })()
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {addMenu && (
        <div
          className="panel-new-menu"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              add('new')
              setAddMenu(false)
            }}
          >
            新建标签页
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              add('new', undefined, true)
              setAddMenu(false)
            }}
          >
            以完整视图新建标签页
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!state.closed.length}
            onClick={() => {
              if (id) update(id, reopenPanelTab)
              setAddMenu(false)
            }}
          >
            重新打开已关闭标签页
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="confirm-dialog panel-save-dialog"
        onCancel={(event) => {
          event.preventDefault()
          prompt?.resolve('cancel')
          setPrompt(null)
        }}
      >
        <h2>未保存的文件</h2>
        <p>{prompt?.message}</p>
        <div className="dialog-actions">
          {(['cancel', 'discard', 'save'] as const).map((choice) => (
            <button
              key={choice}
              data-cancel={choice === 'cancel' || undefined}
              type="button"
              onClick={() => {
                prompt?.resolve(choice)
                setPrompt(null)
              }}
            >
              {choice === 'cancel' ? '取消' : choice === 'discard' ? '放弃修改' : '保存'}
            </button>
          ))}
        </div>
      </dialog>
    </div>
  )
})
