import { useEffect, useRef } from 'react'

export function ClearConversationDialog({
  open,
  disabled,
  onCancel,
  onConfirm
}: {
  open: boolean
  disabled: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      cancel.current?.focus()
    } else dialog.current?.close()
  }, [open])
  return (
    <dialog
      className="confirm-dialog"
      ref={dialog}
      aria-labelledby="clear-title"
      onCancel={onCancel}
    >
      <h2 id="clear-title">清空当前对话？</h2>
      <p>消息将被清空，并自动保存为空对话。此操作无法撤销。</p>
      <div className="dialog-actions">
        <button className="quiet-button" ref={cancel} onClick={onCancel}>
          保留对话
        </button>
        <button className="danger-button" disabled={disabled} onClick={() => void onConfirm()}>
          确认清空
        </button>
      </div>
    </dialog>
  )
}
