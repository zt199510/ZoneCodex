import type { ImageDescriptor } from '../../../../shared/image-input'

export function ImageAttachment({
  image,
  src,
  disabled = false,
  compact = false,
  onPreview,
  onRemove
}: {
  image: ImageDescriptor
  src?: string | null
  disabled?: boolean
  compact?: boolean
  onPreview?: (image: ImageDescriptor, trigger: HTMLButtonElement) => void
  onRemove?: () => void
}): React.JSX.Element {
  const trustedSrc =
    src?.startsWith('data:image/png;base64,') || src?.startsWith('data:image/jpeg;base64,')
      ? src
      : undefined
  return (
    <div className={`image-attachment${compact ? ' message-image-attachment' : ''}`}>
      <button
        type="button"
        className="image-attachment-preview"
        disabled={!trustedSrc || !onPreview}
        aria-label={`预览图片 ${image.name}`}
        title={`预览 ${image.name}`}
        onClick={(event) => onPreview?.(image, event.currentTarget)}
      >
        {trustedSrc ? (
          <img src={trustedSrc} alt={image.name} decoding="async" />
        ) : (
          <span className="image-attachment-placeholder">图片预览不可用</span>
        )}
      </button>
      <div className="image-attachment-copy">
        <strong title={image.name}>{image.name}</strong>
        <small>
          {image.width} × {image.height} ·{' '}
          {image.bytes >= 1024 * 1024
            ? `${(image.bytes / (1024 * 1024)).toFixed(1)} MiB`
            : `${Math.max(1, Math.ceil(image.bytes / 1024))} KiB`}
        </small>
      </div>
      {onRemove && (
        <button
          type="button"
          className="attachment-remove image-attachment-remove"
          disabled={disabled}
          aria-label={`移除图片 ${image.name}`}
          title={`移除 ${image.name}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </div>
  )
}
