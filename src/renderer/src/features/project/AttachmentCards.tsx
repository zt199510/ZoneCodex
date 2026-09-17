import type { ProjectSelection } from '../../../../shared/project'

export function AttachmentCards({
  selection,
  disabled,
  onRemove
}: {
  selection: ProjectSelection | null
  disabled: boolean
  onRemove: (path: string) => Promise<boolean>
}): React.JSX.Element | null {
  if (!selection) return null
  return (
    <ul className="attachment-cards" aria-label="已选附件">
      {selection.files.map((file) => {
        const name = file.path.split('/').at(-1) ?? file.path
        const duplicate =
          selection.files.filter((item) => item.path.split('/').at(-1) === name).length > 1
        return (
          <li
            className="attachment-card"
            key={file.path}
            title={`${name} · ${file.bytes} 字节\n${file.path}`}
          >
            <div className="attachment-card-preview" aria-hidden="true">
              <svg width="23" height="28" viewBox="0 0 24 28" fill="none">
                <path
                  d="M5 2h9l5 5v17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path d="M14 2v6h5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              <span>{name.split('.').at(-1)?.toUpperCase()}</span>
            </div>
            <div className="attachment-card-name">
              <span>{name}</span>
              {duplicate && <small>{file.path.split('/')[0].slice(-8)}</small>}
            </div>
            <button
              className="attachment-remove"
              type="button"
              disabled={disabled}
              aria-label={`移除 ${file.path}`}
              title={`移除 ${name}`}
              onClick={() => {
                void onRemove(file.path)
              }}
            >
              ×
            </button>
          </li>
        )
      })}
    </ul>
  )
}
