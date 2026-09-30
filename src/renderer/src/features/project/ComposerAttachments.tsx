import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'

export function ComposerAttachments({
  conversation: c
}: {
  conversation: ConversationController
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocusOnClose = useRef(false)
  const [open, setOpen] = useState(false)
  const selection = c.contextSelection
  const count = selection?.files.length ?? 0
  const busy = c.operation === 'selecting'

  useLayoutEffect(() => {
    if (!open) return
    function position(): void {
      if (!trigger.current || !panel.current) return
      const composer = trigger.current.closest('.composer')
      if (!composer) return
      const rect = composer.getBoundingClientRect()
      const width = Math.min(rect.width, window.innerWidth - 24)
      Object.assign(panel.current.style, {
        width: `${width}px`,
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        bottom: `${window.innerHeight - rect.top + 8}px`,
        maxHeight: `${Math.max(80, Math.min(320, rect.top - 52))}px`
      })
    }
    position()
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
  }, [open, count, c.chatError])

  function close(restoreFocus = true): void {
    // Native popover dismissal does not submit the surrounding composer form.
    // Restore focus only for dismissals initiated from inside the panel; an
    // outside click should leave focus on the element the user clicked.
    restoreFocusOnClose.current = restoreFocus
    panel.current?.hidePopover()
  }

  useEffect(() => {
    if (open) close(false)
  }, [c.activeConversationId])

  return (
    <div className="composer-attachments">
      <button
        ref={(element) => {
          trigger.current = element
        }}
        type="button"
        className="attachment-add"
        popoverTarget={id}
        aria-label="添加附件"
        aria-expanded={open}
        aria-controls={id}
        disabled={!c.canEdit}
        title="添加附件"
      >
        <span aria-hidden="true">＋</span>
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="attachment-popover"
        role="dialog"
        aria-label="附件"
        onToggle={(event) => {
          const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open'
          setOpen(nextOpen)
          if (!nextOpen && restoreFocusOnClose.current) {
            restoreFocusOnClose.current = false
            queueMicrotask(() => trigger.current?.focus({ preventScroll: true }))
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      >
        <div className="attachment-heading">
          <strong>添加</strong>
          <button
            type="button"
            className="icon-button"
            onClick={() => close()}
            aria-label="关闭附件菜单"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          className="attachment-picker"
          disabled={!c.canEdit || busy}
          onClick={() => {
            close()
            void c.selectProjectFiles()
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 7v9a3 3 0 0 0 6 0V5a4 4 0 0 0-8 0v12a5 5 0 0 0 10 0V7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            <strong>{busy ? '正在选择…' : '文件'}</strong>
            <small>直接多选文本或代码文件，最多 8 个</small>
          </span>
        </button>
        {count > 0 && (
          <button
            type="button"
            className="attachment-picker"
            disabled={!c.canEdit}
            onClick={() => {
              close()
              void c.revokeProjectFiles()
            }}
          >
            <span aria-hidden="true">×</span>
            <span>
              <strong>{c.projectSelection ? '移除所有附件' : '清除会话文件'}</strong>
              <small>
                {count} 个文件{c.projectSelection ? '' : '仍可用于追问；清除后停止使用'}
              </small>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
