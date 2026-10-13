import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type ThreadSummaryDisplayMode = 'overlay' | 'shift' | 'gutter'

// Codex 26.1007.2314 uses the width of the conversation pane, after the sidebar
// and any file panel have taken their space. The pin preference survives resizing.
export function useThreadSummaryPanel(contextKey: string | null): {
  workspaceRef: React.RefObject<HTMLElement | null>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  panelRef: React.RefObject<HTMLElement | null>
  mode: ThreadSummaryDisplayMode
  visible: boolean
  enabled: boolean
  toggle: () => void
  closeOverlay: (returnFocus?: boolean) => void
} {
  const workspaceRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem('zonecodex.summary.pinned') !== 'false'
    } catch {
      return true
    }
  })
  const [overlayContext, setOverlayContext] = useState<string | null>(null)
  const enabled = contextKey !== null
  const mode: ThreadSummaryDisplayMode =
    width < 1096 ? 'overlay' : width < 1536 ? 'shift' : 'gutter'
  const visible = enabled && (mode === 'overlay' ? overlayContext === contextKey : pinned)

  useLayoutEffect(() => {
    const element = workspaceRef.current
    if (!element) return
    const measure = (): void => {
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('zonecodex.summary.pinned', String(pinned))
    } catch {
      // The panel remains usable without persistent browser storage.
    }
  }, [pinned])

  const closeOverlay = useCallback((returnFocus = false): void => {
    setOverlayContext(null)
    if (returnFocus) {
      requestAnimationFrame(() => {
        const trigger = triggerRef.current
        if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true })
      })
    }
  }, [])

  useLayoutEffect(() => {
    const panelHadFocus = panelRef.current?.contains(document.activeElement)
    closeOverlay(Boolean(panelHadFocus) && (!enabled || mode === 'overlay' || !pinned))
  }, [closeOverlay, contextKey, enabled, mode, pinned])

  const toggle = useCallback((): void => {
    if (!enabled) return
    if (mode === 'overlay') {
      setOverlayContext((previous) => (previous === contextKey ? null : contextKey))
    } else setPinned((previous) => !previous)
  }, [contextKey, enabled, mode])

  useLayoutEffect(() => {
    if (!visible || mode !== 'overlay') return
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({
        preventScroll: true
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [mode, visible])

  useEffect(() => {
    if (!visible || mode !== 'overlay') return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target))
        return
      closeOverlay()
      requestAnimationFrame(() => {
        if (panelRef.current?.contains(document.activeElement))
          triggerRef.current?.focus({ preventScroll: true })
      })
    }
    const onFocusIn = (event: FocusEvent): void => {
      if (!(event.target instanceof Element)) return
      if (
        panelRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target) ||
        event.target.closest(
          '.file-view-panel, .conversation-sources-side-panel, .change-preview-panel, .command-review-panel, dialog'
        )
      )
        return
      closeOverlay()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.activeElement?.closest(
          '.file-view-panel, .conversation-sources-side-panel, .change-preview-panel, .command-review-panel'
        ) ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeOverlay(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [closeOverlay, mode, visible])

  return { workspaceRef, triggerRef, panelRef, mode, visible, enabled, toggle, closeOverlay }
}

export type ThreadSummaryController = ReturnType<typeof useThreadSummaryPanel>
