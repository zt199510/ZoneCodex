import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { Icon } from '../../components/ui/Icon'
import { useAnchoredPosition } from '../../components/ui/useAnchoredPosition'
import type { AnchorMeasurement } from '../../components/ui/useAnchoredPosition'
import type { FileMentionsController } from './useFileMentions'

export function FileMentionMenu({
  mentions,
  textarea,
  id
}: {
  mentions: FileMentionsController
  textarea: RefObject<HTMLTextAreaElement | null>
  id: string
}): React.JSX.Element {
  const { open, close } = mentions
  const panel = useRef<HTMLDivElement>(null)
  const getAnchor = useCallback(
    () => textarea.current?.closest<HTMLElement>('.composer') ?? null,
    [textarea]
  )
  const position = useAnchoredPosition({
    active: mentions.open,
    panelRef: panel,
    getAnchor,
    getStyle: useCallback(
      ({ rect, viewportWidth, viewportHeight }: AnchorMeasurement) => ({
        width: `${Math.min(rect.width, viewportWidth - 24)}px`,
        left: `${Math.max(12, Math.min(rect.left, viewportWidth - rect.width - 12))}px`,
        bottom: `${viewportHeight - rect.top + 8}px`,
        maxHeight: `${Math.max(60, Math.min(320, rect.top - 48))}px`
      }),
      []
    )
  })
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return
    if (mentions.open) {
      if (!element.matches(':popover-open')) element.showPopover()
      position()
    } else if (element.matches(':popover-open')) element.hidePopover()
  }, [mentions.open, position])
  useLayoutEffect(() => {
    if (mentions.open)
      panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [mentions.open, mentions.activeIndex])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        event.target !== textarea.current
      )
        close()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open, close, textarea])
  return (
    <div
      ref={panel}
      id={id}
      popover="manual"
      className="file-mention-menu"
      role="listbox"
      aria-label="引用项目文件"
    >
      {!mentions.hasWorkspace ? (
        <button
          type="button"
          className="file-mention-option"
          role="option"
          aria-selected="true"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void mentions.selectWorkspace()}
        >
          <Icon name="folder" size={16} />
          <span>选择项目文件夹</span>
        </button>
      ) : (
        mentions.paths.map((path, index) => {
          const split = path.lastIndexOf('/')
          return (
            <button
              type="button"
              key={path}
              id={`${id}-${index}`}
              className="file-mention-option"
              role="option"
              aria-selected={index === mentions.activeIndex}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onPointerMove={() => mentions.setActiveIndex(index)}
              onClick={() => void mentions.choose(path)}
            >
              <Icon name="file" size={16} />
              <span>{path.slice(split + 1)}</span>
              {split >= 0 && <small>{path.slice(0, split)}</small>}
            </button>
          )
        })
      )}
      {mentions.hasWorkspace && (mentions.error || !mentions.paths.length) && (
        <p className="file-mention-status" role="status">
          {mentions.error ?? (mentions.loading ? '正在查找文件…' : '没有匹配的文件')}
        </p>
      )}
    </div>
  )
}
