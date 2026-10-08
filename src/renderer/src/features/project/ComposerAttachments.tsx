import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { useAnchoredPosition } from '../../components/ui/useAnchoredPosition'
import type {
  AnchorMeasurement,
  AnchorPositionStyle
} from '../../components/ui/useAnchoredPosition'
import { maxImagesPerMessage } from '../../../../shared/image-input'

function attachmentMenuStyle({
  rect,
  viewportWidth,
  viewportHeight
}: AnchorMeasurement): AnchorPositionStyle {
  const width = Math.min(rect.width, viewportWidth - 24)
  return {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, viewportWidth - width - 12))}px`,
    bottom: `${viewportHeight - rect.top + 8}px`,
    maxHeight: `${Math.max(80, Math.min(320, rect.top - 52))}px`
  }
}

export function ComposerAttachments({
  conversation: c,
  onSelectImage,
  imageBusy = false
}: {
  conversation: ConversationController
  onSelectImage?: () => void
  imageBusy?: boolean
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocusOnClose = useRef(false)
  const [open, setOpen] = useState(false)
  const selection = c.contextSelection
  const count = selection?.files.length ?? 0
  const busy = c.operation === 'selecting'
  const canSelectImage = Boolean(onSelectImage) && c.canNavigate && c.canSend

  const getAnchor = useCallback(
    () => trigger.current?.closest<HTMLElement>('.composer') ?? null,
    []
  )
  const getResizeTargets = useCallback(() => {
    const composer = getAnchor()
    return [composer, composer?.parentElement?.parentElement]
  }, [getAnchor])
  const position = useAnchoredPosition({
    active: open,
    panelRef: panel,
    getAnchor,
    getStyle: attachmentMenuStyle,
    getResizeTargets
  })

  useLayoutEffect(() => {
    if (!open) return
    position()
  }, [open, count, c.chatError, position])

  const close = useCallback((restoreFocus = true): void => {
    // Native popover dismissal does not submit the surrounding composer form.
    // Restore focus only for dismissals initiated from inside the panel; an
    // outside click should leave focus on the element the user clicked.
    restoreFocusOnClose.current = restoreFocus
    panel.current?.hidePopover()
  }, [])

  useEffect(() => {
    close(false)
  }, [c.activeConversationId, close])

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
        disabled={!c.canEdit && !canSelectImage}
        title="添加附件"
      >
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3v18M3 12h18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
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
        {onSelectImage && (
          <button
            type="button"
            className="attachment-picker image-picker"
            disabled={!canSelectImage || busy || imageBusy}
            onClick={() => {
              close()
              onSelectImage()
            }}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect
                x="3"
                y="3"
                width="18"
                height="18"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="8" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m4 17 5-5 4 4 3-3 4 5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span>
              <strong>图片</strong>
              <small>PNG/JPEG，最多 {maxImagesPerMessage} 张；也可粘贴或拖入</small>
            </span>
          </button>
        )}
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
