import { Icon } from '../ui/Icon'

type ChatHeaderProps = {
  status: string
  needsAttention: boolean
  saving: boolean
  paused: boolean
  canEdit: boolean
  hasMessages: boolean
  onSave: () => void
  onClear: () => void
}

export function ChatHeader(props: ChatHeaderProps): React.JSX.Element {
  return (
    <header className="chat-header">
      <div className="header-heading">
        <h1>当前对话</h1>
      </div>
      <div className="header-actions">
        <span
          className={`save-status ${props.needsAttention ? 'needs-attention' : ''}`}
          role="status"
        >
          <span className="status-dot" />
          {props.status}
        </span>
        <button className="quiet-button" disabled={!props.canEdit} onClick={props.onSave}>
          {props.saving ? '保存中…' : props.paused ? '重试保存' : '立即保存'}
        </button>
        <span className="header-divider" />
        <button
          className="icon-button"
          disabled={!props.canEdit || !props.hasMessages}
          onClick={props.onClear}
          aria-label="清空对话"
          title="清空对话"
        >
          <Icon name="trash" size={17} />
        </button>
      </div>
    </header>
  )
}
