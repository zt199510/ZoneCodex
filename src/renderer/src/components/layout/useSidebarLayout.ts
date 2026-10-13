import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetStateAction } from 'react'
import { sidebarBreakpoint } from './sidebar-layout'

function savedDesktopPreference(): boolean {
  try {
    return localStorage.getItem('zonecodex.sidebar.open') !== 'false'
  } catch {
    return true
  }
}

export function useSidebarLayout(): {
  open: boolean
  peeking: boolean
  present: boolean
  expanded: boolean
  transitioning: boolean
  setOpen: (value: SetStateAction<boolean>) => void
  enterPreview: () => void
  leavePreview: () => void
  finishTransition: () => void
} {
  const [initialPreference] = useState(savedDesktopPreference)
  const desktopPreference = useRef(initialPreference)
  const [open, updateOpen] = useState(
    () => window.innerWidth >= sidebarBreakpoint && initialPreference
  )
  const openRef = useRef(open)
  const [peeking, setPeeking] = useState(false)
  const peekingRef = useRef(false)
  const [present, setPresent] = useState(open)
  const presentRef = useRef(present)
  const [expanded, setExpanded] = useState(open)
  const [transitioning, setTransitioning] = useState(false)
  const shownRef = useRef(open)
  const pointerInside = useRef(false)
  const frame = useRef(0)
  const nextFrame = useRef(0)
  const fallback = useRef(0)
  const previewTimer = useRef(0)

  const cancelTransition = useCallback((): void => {
    cancelAnimationFrame(frame.current)
    cancelAnimationFrame(nextFrame.current)
    clearTimeout(fallback.current)
  }, [])

  const finishTransition = useCallback((): void => {
    cancelTransition()
    presentRef.current = shownRef.current
    setPresent(shownRef.current)
    setTransitioning(false)
  }, [cancelTransition])

  const showSidebar = useCallback(
    (next: boolean): void => {
      if (next === shownRef.current) return
      if (!next && document.activeElement?.closest('#conversation-sidebar, .sidebar-popover')) {
        document.getElementById('sidebar-toggle')?.focus({ preventScroll: true })
      }
      cancelTransition()
      shownRef.current = next
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setExpanded(next)
        finishTransition()
        return
      }
      setTransitioning(true)
      if (next && !presentRef.current) {
        presentRef.current = true
        setPresent(true)
        frame.current = requestAnimationFrame(() => {
          nextFrame.current = requestAnimationFrame(() => {
            setExpanded(true)
            fallback.current = window.setTimeout(finishTransition, 380)
          })
        })
      } else {
        setExpanded(next)
        fallback.current = window.setTimeout(finishTransition, 380)
      }
    },
    [cancelTransition, finishTransition]
  )

  const setOpen = useCallback(
    (value: SetStateAction<boolean>): void => {
      const next = typeof value === 'function' ? value(openRef.current) : value
      clearTimeout(previewTimer.current)
      if (window.innerWidth >= sidebarBreakpoint) {
        desktopPreference.current = next
        try {
          localStorage.setItem('zonecodex.sidebar.open', String(next))
        } catch {
          // Collapsing remains available when local storage is unavailable.
        }
      }
      openRef.current = next
      updateOpen(next)
      peekingRef.current = false
      setPeeking(false)
      showSidebar(next)
    },
    [showSidebar]
  )

  const enterPreview = useCallback((): void => {
    pointerInside.current = true
    clearTimeout(previewTimer.current)
    if (
      openRef.current ||
      peekingRef.current ||
      window.innerWidth < sidebarBreakpoint ||
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches
    )
      return
    previewTimer.current = window.setTimeout(() => {
      peekingRef.current = true
      setPeeking(true)
      showSidebar(true)
    }, 100)
  }, [showSidebar])

  const leavePreview = useCallback((): void => {
    pointerInside.current = false
    clearTimeout(previewTimer.current)
    if (!peekingRef.current) return
    previewTimer.current = window.setTimeout(() => {
      if (
        document.activeElement?.closest('#conversation-sidebar, .sidebar-popover') ||
        document.querySelector('.sidebar-popover:popover-open')
      )
        return
      peekingRef.current = false
      setPeeking(false)
      showSidebar(false)
    }, 100)
  }, [showSidebar])

  useEffect(() => {
    const desktop = window.matchMedia(`(min-width: ${sidebarBreakpoint}px)`)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changeViewport = (): void => setOpen(desktop.matches && desktopPreference.current)
    const changeMotion = (): void => {
      if (motion.matches) {
        setExpanded(shownRef.current)
        finishTransition()
      }
    }
    const checkPreview = (): void => {
      if (peekingRef.current && !pointerInside.current) leavePreview()
    }
    desktop.addEventListener('change', changeViewport)
    motion.addEventListener('change', changeMotion)
    window.addEventListener('toggle', checkPreview, true)
    window.addEventListener('focusin', checkPreview)
    return () => {
      desktop.removeEventListener('change', changeViewport)
      motion.removeEventListener('change', changeMotion)
      window.removeEventListener('toggle', checkPreview, true)
      window.removeEventListener('focusin', checkPreview)
      cancelTransition()
      clearTimeout(previewTimer.current)
    }
  }, [cancelTransition, finishTransition, leavePreview, setOpen])

  return {
    open,
    peeking,
    present,
    expanded,
    transitioning,
    setOpen,
    enterPreview,
    leavePreview,
    finishTransition
  }
}
