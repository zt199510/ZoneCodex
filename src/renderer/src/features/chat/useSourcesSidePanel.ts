import { useCallback, useLayoutEffect, useRef, useState } from 'react'

type SourcesPanelState = { contextKey: string; selected: 'sources' | 'file' }

export function useSourcesSidePanel(contextKey: string | null): {
  open: boolean
  selected: 'sources' | 'file'
  show: (trigger: HTMLButtonElement) => void
  select: (tab: 'sources' | 'file') => void
  close: (returnFocus?: boolean) => void
} {
  const [state, setState] = useState<SourcesPanelState | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const previousContext = useRef(contextKey)
  const open = contextKey !== null && state?.contextKey === contextKey
  if (state && state.contextKey !== contextKey) setState(null)

  useLayoutEffect(() => {
    if (previousContext.current === contextKey) return
    previousContext.current = contextKey
    const hadFocus =
      document.activeElement === document.body ||
      document.activeElement?.closest('.conversation-sources-side-panel')
    trigger.current = null
    const composer = document.getElementById('chat-input')
    if (hadFocus && composer?.getClientRects().length && !composer.closest('[inert]'))
      composer.focus({ preventScroll: true })
  }, [contextKey])

  const show = useCallback(
    (element: HTMLButtonElement): void => {
      if (!contextKey) return
      trigger.current = element
      setState({ contextKey, selected: 'sources' })
    },
    [contextKey]
  )

  const select = useCallback((selected: 'sources' | 'file'): void => {
    setState((previous) => (previous ? { ...previous, selected } : previous))
  }, [])

  const close = useCallback(
    (returnFocus = true): void => {
      setState(null)
      if (!returnFocus) return
      const returnTrigger = trigger.current
      // Let the conversation width observer restore the summary before choosing its focus target.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (previousContext.current !== contextKey) return
          const targets = [
            returnTrigger,
            document.querySelector<HTMLElement>('.thread-summary-toggle'),
            document.getElementById('chat-input')
          ]
          targets
            .find(
              (element) =>
                element?.isConnected &&
                element.getClientRects().length > 0 &&
                !element.closest('[inert]') &&
                !element.matches(':disabled')
            )
            ?.focus({ preventScroll: true })
        })
      })
    },
    [contextKey]
  )

  return { open, selected: open ? state.selected : 'sources', show, select, close }
}
