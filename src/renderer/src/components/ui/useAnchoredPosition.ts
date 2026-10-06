import { useCallback, useLayoutEffect } from 'react'
import type { RefObject } from 'react'

export type AnchorMeasurement = {
  anchor: HTMLElement
  rect: DOMRect
  viewportWidth: number
  viewportHeight: number
}

export type AnchorPositionStyle = Pick<
  CSSStyleDeclaration,
  'width' | 'left' | 'bottom' | 'maxHeight'
>

type AnchoredPositionOptions = {
  active: boolean
  panelRef: RefObject<HTMLElement | null>
  getAnchor: () => HTMLElement | null
  getStyle: (measurement: AnchorMeasurement) => AnchorPositionStyle
  getResizeTargets?: () => Array<Element | null | undefined>
}

/** Shares geometry and subscriptions; each popover or dialog owns its interaction semantics. */
export function useAnchoredPosition({
  active,
  panelRef,
  getAnchor,
  getStyle,
  getResizeTargets
}: AnchoredPositionOptions): () => void {
  const position = useCallback((): void => {
    const anchor = getAnchor()
    const panel = panelRef.current
    if (!anchor || !panel) return
    Object.assign(
      panel.style,
      getStyle({
        anchor,
        rect: anchor.getBoundingClientRect(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    )
  }, [getAnchor, getStyle, panelRef])

  useLayoutEffect(() => {
    if (!active) return
    position()
    const observer = new ResizeObserver(position)
    const targets = getResizeTargets ? getResizeTargets() : [getAnchor()]
    for (const target of targets) if (target) observer.observe(target)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [active, getAnchor, getResizeTargets, position])

  return position
}
