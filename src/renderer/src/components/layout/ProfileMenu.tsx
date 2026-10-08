import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useAnchoredPosition } from '../ui/useAnchoredPosition'
import type { AnchorMeasurement, AnchorPositionStyle } from '../ui/useAnchoredPosition'

function menuStyle({
  rect,
  viewportWidth,
  viewportHeight
}: AnchorMeasurement): AnchorPositionStyle {
  const width = Math.min(220, viewportWidth - 24)
  return {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, viewportWidth - width - 12))}px`,
    bottom: `${viewportHeight - rect.top + 8}px`,
    maxHeight: `${Math.max(40, Math.min(220, rect.top - 20))}px`
  }
}

export function ProfileMenu({
  hidden,
  onOpenSettings
}: {
  hidden: boolean
  onOpenSettings: (returnFocus?: HTMLElement) => void
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const settingsItem = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const [open, setOpen] = useState(false)
  const getAnchor = useCallback(() => trigger.current, [])
  const position = useAnchoredPosition({
    active: open,
    panelRef: panel,
    getAnchor,
    getStyle: menuStyle
  })
  const close = useCallback((restore: boolean): void => {
    if (!panel.current?.matches(':popover-open')) return
    restoreFocus.current = restore
    panel.current.hidePopover()
  }, [])

  useLayoutEffect(() => {
    if (hidden) close(false)
  }, [close, hidden])

  useLayoutEffect(() => {
    if (!open) return
    position()
  }, [open, position])

  return (
    <div className="local-profile profile-menu">
      <button
        ref={trigger}
        type="button"
        className="profile-trigger"
        popoverTarget={id}
        aria-label="个人工作空间菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && panel.current?.matches(':popover-open')) {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!panel.current?.matches(':popover-open')) panel.current?.showPopover()
            else settingsItem.current?.focus({ preventScroll: true })
          }
        }}
      >
        <span className="profile-avatar">Z</span>
        <span className="profile-copy">
          <strong>个人工作空间</strong>
          <small>本地存储 · ZoneCodex</small>
        </span>
        <Icon name="chevron" size={12} style={{ transform: 'rotate(-90deg)' }} />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="profile-popover"
        role="menu"
        aria-label="个人工作空间"
        onToggle={(event) => {
          const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open'
          setOpen(nextOpen)
          if (nextOpen) {
            position()
            queueMicrotask(() => {
              if (panel.current?.matches(':popover-open'))
                settingsItem.current?.focus({ preventScroll: true })
            })
          } else if (restoreFocus.current) {
            restoreFocus.current = false
            queueMicrotask(() => {
              if (trigger.current?.getClientRects().length && !trigger.current.closest('[inert]'))
                trigger.current.focus({ preventScroll: true })
            })
          }
        }}
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
            settingsItem.current?.focus({ preventScroll: true })
          }
        }}
      >
        <button
          ref={settingsItem}
          type="button"
          className="profile-settings"
          role="menuitem"
          onClick={() => {
            // Hide synchronously so the settings shortcut guard sees a clear surface.
            close(false)
            onOpenSettings(trigger.current ?? undefined)
          }}
        >
          <Icon name="panel" size={16} />
          <span>设置</span>
          <kbd>Ctrl+,</kbd>
        </button>
      </div>
    </div>
  )
}
