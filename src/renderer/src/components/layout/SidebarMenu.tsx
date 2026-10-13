import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { useAnchoredPosition } from '../ui/useAnchoredPosition'
import type { AnchorMeasurement, AnchorPositionStyle } from '../ui/useAnchoredPosition'

type SidebarMenuProps = {
  label: string
  className?: string
  disabled?: boolean
  hidden?: boolean
  items: Array<{
    label: string
    icon: IconName
    onSelect: () => void
    disabled?: boolean
  }>
}

export function SidebarMenu({
  label,
  className,
  disabled = false,
  hidden = false,
  items
}: SidebarMenuProps): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(false)
  const focusLastOnOpen = useRef(false)
  const [open, setOpen] = useState(false)
  const getAnchor = useCallback(() => trigger.current, [])
  const getStyle = useCallback(
    ({ rect, viewportWidth, viewportHeight }: AnchorMeasurement): AnchorPositionStyle => {
      const margin = 12
      const gap = 6
      const width = Math.max(0, Math.min(192, viewportWidth - margin * 2))
      const maxHeight = Math.max(0, viewportHeight - margin * 2)
      const height = Math.min((panel.current?.scrollHeight ?? 0) + 2, maxHeight)
      const right = rect.right + gap
      const left = rect.left - width - gap
      const fitsRight = right + width <= viewportWidth - margin
      const fitsLeft = left >= margin
      const preferredLeft = fitsRight ? right : fitsLeft ? left : rect.left
      const preferredTop = fitsRight || fitsLeft ? rect.top : rect.bottom + gap
      const top = Math.max(margin, Math.min(preferredTop, viewportHeight - height - margin))
      return {
        width: `${width}px`,
        left: `${Math.max(margin, Math.min(preferredLeft, viewportWidth - width - margin))}px`,
        bottom: `${viewportHeight - top - height}px`,
        maxHeight: `${maxHeight}px`
      }
    },
    []
  )
  const position = useAnchoredPosition({ active: open, panelRef: panel, getAnchor, getStyle })
  const close = useCallback((restore: boolean): void => {
    if (!panel.current?.matches(':popover-open')) return
    restoreFocus.current = restore
    panel.current.hidePopover()
  }, [])

  function enabledItems(): HTMLButtonElement[] {
    return Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    )
  }

  function focusBoundary(last = false): void {
    const buttons = enabledItems()
    buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (hidden || disabled) close(false)
  }, [close, disabled, hidden])

  useLayoutEffect(() => {
    if (open) position()
  }, [open, position])

  return (
    <div
      className={`sidebar-menu${className ? ` ${className}` : ''}`}
      hidden={hidden}
      inert={hidden || undefined}
    >
      <button
        ref={trigger}
        type="button"
        className="sidebar-menu-trigger icon-button"
        disabled={disabled}
        popoverTarget={id}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={(event) => {
          event.stopPropagation()
          focusLastOnOpen.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && panel.current?.matches(':popover-open')) {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            event.stopPropagation()
            if (!panel.current?.matches(':popover-open')) {
              focusLastOnOpen.current = event.key === 'ArrowUp'
              panel.current?.showPopover()
            } else focusBoundary(event.key === 'ArrowUp')
          }
        }}
      >
        <Icon name="more" size={16} />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="sidebar-popover"
        role="menu"
        aria-label={label}
        onToggle={(event) => {
          const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open'
          setOpen(nextOpen)
          if (nextOpen) {
            if (hidden || disabled) {
              close(false)
              return
            }
            position()
            const focusLast = focusLastOnOpen.current
            focusLastOnOpen.current = false
            queueMicrotask(() => {
              if (panel.current?.matches(':popover-open')) focusBoundary(focusLast)
            })
          } else if (restoreFocus.current) {
            restoreFocus.current = false
            queueMicrotask(() => {
              if (
                trigger.current?.getClientRects().length &&
                !trigger.current.disabled &&
                !trigger.current.closest('[inert]')
              ) {
                trigger.current.focus({ preventScroll: true })
              }
            })
          }
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === 'Tab') {
            close(false)
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            const buttons = enabledItems()
            if (!buttons.length) return
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : event.key === 'ArrowDown'
                    ? (current + 1) % buttons.length
                    : (current < 0 ? buttons.length - 1 : current - 1 + buttons.length) %
                      buttons.length
            buttons[next].focus({ preventScroll: true })
          }
        }}
      >
        {items.map((item, index) => (
          <button
            key={index}
            type="button"
            className="sidebar-menu-item"
            role="menuitem"
            disabled={disabled || item.disabled}
            onClick={() => {
              close(false)
              item.onSelect()
            }}
          >
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
