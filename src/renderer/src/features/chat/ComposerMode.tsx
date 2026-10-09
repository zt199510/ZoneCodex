import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { AgentMode } from '../../../../shared/agent'
import { Icon } from '../../components/ui/Icon'
import { useAnchoredPosition } from '../../components/ui/useAnchoredPosition'
import type {
  AnchorMeasurement,
  AnchorPositionStyle
} from '../../components/ui/useAnchoredPosition'

const modeOptions: { mode: AgentMode; title: string; description: string }[] = [
  { mode: 'execute', title: '执行', description: '根据请求实施，沿用所选授权方式。' },
  { mode: 'plan', title: '计划', description: '只读研究并给出方案，明确切换执行后再实施。' }
]

function modeMenuStyle({
  anchor,
  rect,
  viewportWidth,
  viewportHeight
}: AnchorMeasurement): AnchorPositionStyle {
  const container = anchor.closest('.composer, .message-inline-editor')?.getBoundingClientRect()
  const width = Math.min(300, container?.width ?? 300, viewportWidth - 24)
  return {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, viewportWidth - width - 12))}px`,
    bottom: `${viewportHeight - rect.top + 8}px`,
    maxHeight: `${Math.max(60, Math.min(280, rect.top - 20))}px`
  }
}

export function ComposerMode({
  mode,
  onSelect,
  disabled,
  conversationId
}: {
  mode: AgentMode
  onSelect: (mode: AgentMode) => boolean
  disabled: boolean
  conversationId?: string | null
}): React.JSX.Element {
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const disabledRef = useRef(disabled)
  const restoreFocusOnClose = useRef(false)
  const initialFocus = useRef<'selected' | 'first' | 'last'>('selected')
  const [open, setOpen] = useState(false)
  const title = mode === 'plan' ? '计划' : '执行'

  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  const close = useCallback((restoreFocus = true): void => {
    if (!panel.current?.matches(':popover-open')) return
    restoreFocusOnClose.current = restoreFocus
    panel.current.hidePopover()
  }, [])
  useEffect(() => {
    if (disabled) close(false)
  }, [close, disabled])
  useEffect(() => close(false), [close, conversationId])
  const getAnchor = useCallback(() => trigger.current, [])
  const getResizeTargets = useCallback(() => {
    const container = trigger.current?.closest('.composer, .message-inline-editor')
    return [container, container?.parentElement?.parentElement]
  }, [])
  const position = useAnchoredPosition({
    active: open,
    panelRef: panel,
    getAnchor,
    getStyle: modeMenuStyle,
    getResizeTargets
  })
  useLayoutEffect(() => {
    if (!open) return
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
  }, [open, position])
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
  return (
    <div className="composer-mode">
      <button
        ref={trigger}
        type="button"
        className="permissions-trigger agent-mode-trigger"
        data-mode={mode}
        popoverTarget={id}
        aria-label={`工作方式：${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        title={`工作方式：${title}`}
        onKeyDown={(event) => {
          if (disabledRef.current || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          initialFocus.current = event.key === 'ArrowDown' ? 'first' : 'last'
          panel.current?.showPopover()
        }}
      >
        <Icon name={mode === 'plan' ? 'book' : 'arrow'} size={15} />
        <span>{title}</span>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="permissions-popover agent-mode-popover"
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
          工作方式
        </p>
        {modeOptions.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="menuitemradio"
            className="permissions-option"
            data-mode={option.mode}
            aria-checked={mode === option.mode}
            tabIndex={mode === option.mode ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (disabledRef.current) return
              if (onSelect(option.mode)) close()
            }}
          >
            <Icon name={option.mode === 'plan' ? 'book' : 'arrow'} size={16} />
            <span className="permissions-option-copy">
              <strong>{option.title}</strong>
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
