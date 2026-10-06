import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { PermissionMode } from '../../../../shared/execution'
import type { ExecutionPermissionsController } from './useExecutionPermissions'

const permissionModeTitles: Record<PermissionMode, string> = {
  default: '请求批准',
  'auto-approve': '帮我批准',
  'full-access': '完全访问权限'
}

const options: Array<{ mode: PermissionMode; description: string }> = [
  { mode: 'default', description: '编辑外部文件和使用互联网时始终询问' },
  { mode: 'auto-approve', description: '仅对检测到的风险操作请求批准' },
  { mode: 'full-access', description: '可不受限制地访问互联网和你电脑上的任何文件' }
]

function PermissionIcon({ mode }: { mode: PermissionMode }): React.JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
      {mode === 'full-access' ? (
        <>
          <path d="m12 3 8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6l8-3Z" />
          <path d="M12 8v5m0 3h.01" />
        </>
      ) : mode === 'auto-approve' ? (
        <>
          <path d="M5 4h10l4 4v9l-4 3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
          <path d="m8 12 2 2 4-4" />
        </>
      ) : (
        <path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v5c0 4-2 7-6 7h-2c-2 0-3-1-4-3l-3-5a1.5 1.5 0 0 1 2-2l1 2Z" />
      )}
    </svg>
  )
}

export function ComposerPermissions({
  permissions,
  disabled,
  conversationId
}: {
  permissions: ExecutionPermissionsController
  disabled: boolean
  conversationId: string | null
}): React.JSX.Element {
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const disabledRef = useRef(disabled)
  const selectingRef = useRef(false)
  const restoreFocusOnClose = useRef(false)
  const restoreFocusAfterSelect = useRef(false)
  const initialFocus = useRef<'selected' | 'first' | 'last'>('selected')
  const [open, setOpen] = useState(false)
  const mode = permissions.state?.mode ?? 'default'

  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  const close = useCallback((restoreFocus = true): void => {
    if (!panel.current?.matches(':popover-open')) return
    restoreFocusOnClose.current = restoreFocus
    panel.current.hidePopover()
  }, [])

  const restoreSelectionFocus = useCallback((): void => {
    if (!restoreFocusAfterSelect.current || disabledRef.current) return
    restoreFocusAfterSelect.current = false
    if (document.activeElement === document.body || document.activeElement === trigger.current) {
      trigger.current?.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (disabled) close(false)
    else restoreSelectionFocus()
  }, [close, disabled, restoreSelectionFocus])

  useEffect(() => close(false), [close, conversationId])

  useLayoutEffect(() => {
    if (!open) return
    function position(): void {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const composer = trigger.current.closest('.composer')?.getBoundingClientRect()
      const width = Math.min(344, composer?.width ?? 344, window.innerWidth - 24)
      Object.assign(panel.current.style, {
        width: `${width}px`,
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        bottom: `${window.innerHeight - rect.top + 8}px`,
        maxHeight: `${Math.max(100, Math.min(360, rect.top - 20))}px`
      })
    }
    position()
    const items = panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    const focused =
      initialFocus.current === 'first'
        ? items?.[0]
        : initialFocus.current === 'last'
          ? items?.[items.length - 1]
          : panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    focused?.focus({ preventScroll: true })
    initialFocus.current = 'selected'
    const observer = new ResizeObserver(position)
    const composer = trigger.current?.closest('.composer')
    if (composer) observer.observe(composer)
    if (composer?.parentElement?.parentElement)
      observer.observe(composer.parentElement.parentElement)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  function navigate(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const items = Array.from(
      panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ??
        []
    )
    if (!items.length) return
    const current = items.findIndex((item) => item === document.activeElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus({ preventScroll: true })
  }

  async function select(next: PermissionMode): Promise<void> {
    if (disabledRef.current || selectingRef.current) return
    selectingRef.current = true
    restoreFocusAfterSelect.current = true
    close(false)
    try {
      await permissions.select(next)
    } finally {
      selectingRef.current = false
      restoreSelectionFocus()
    }
  }

  return (
    <div className="composer-permissions">
      <button
        ref={trigger}
        type="button"
        className="permissions-trigger"
        data-mode={mode}
        popoverTarget={id}
        aria-label={`权限：${permissionModeTitles[mode]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        title={permissionModeTitles[mode]}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          initialFocus.current = event.key === 'ArrowDown' ? 'first' : 'last'
          panel.current?.showPopover()
        }}
      >
        <PermissionIcon mode={mode} />
        <span>{permissionModeTitles[mode]}</span>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="permissions-popover"
        role="menu"
        aria-labelledby={titleId}
        onKeyDown={navigate}
        onToggle={(event) => {
          const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open'
          setOpen(nextOpen)
          if (!nextOpen && restoreFocusOnClose.current) {
            restoreFocusOnClose.current = false
            queueMicrotask(() => trigger.current?.focus({ preventScroll: true }))
          }
        }}
      >
        <p id={titleId} className="permissions-heading">
          应如何批准 ZoneCodex 操作？
        </p>
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="menuitemradio"
            className="permissions-option"
            data-mode={option.mode}
            aria-checked={mode === option.mode}
            tabIndex={mode === option.mode ? 0 : -1}
            disabled={disabled}
            onClick={() => void select(option.mode)}
          >
            <PermissionIcon mode={option.mode} />
            <span className="permissions-option-copy">
              <strong>{permissionModeTitles[option.mode]}</strong>
              <small>{option.description}</small>
            </span>
            <span className="permissions-check" aria-hidden="true">
              {mode === option.mode ? '✓' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
