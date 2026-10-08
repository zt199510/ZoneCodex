import { useId, useLayoutEffect, useRef } from 'react'
import type { ImageDescriptor } from '../../../../shared/image-input'
import { Icon } from '../../components/ui/Icon'

function focusable(element: HTMLElement | undefined): boolean {
  return Boolean(
    element?.isConnected &&
    element.getClientRects().length &&
    !element.closest('[inert]') &&
    !element.matches(':disabled')
  )
}

export function ImagePreview({
  image,
  src,
  returnFocus,
  onClose
}: {
  image: ImageDescriptor
  src: string
  returnFocus?: HTMLElement
  onClose: () => void
}): React.JSX.Element {
  const labelId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const trustedSrc =
    src.startsWith('data:image/png;base64,') || src.startsWith('data:image/jpeg;base64,')
      ? src
      : undefined

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    element.showModal()
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const restore = active === document.body || (active !== null && element.contains(active))
      if (element.open) element.close()
      if (!restore) return
      const target = focusable(previous)
        ? previous
        : (document.getElementById('chat-input') ?? undefined)
      if (focusable(target)) target?.focus({ preventScroll: true })
    }
  }, [image.imageId, returnFocus])

  return (
    <dialog
      ref={dialog}
      className="image-preview-dialog"
      aria-labelledby={labelId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault()
          closeButton.current?.focus({ preventScroll: true })
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="image-preview-heading">
        <div>
          <strong id={labelId}>{image.name}</strong>
          <small>
            {image.width} × {image.height}
          </small>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="关闭图片预览"
          title="关闭图片预览（Escape）"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="image-preview-content">
        {trustedSrc ? <img src={trustedSrc} alt={image.name} /> : <p>图片预览不可用。</p>}
      </div>
    </dialog>
  )
}
