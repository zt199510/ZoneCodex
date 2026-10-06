import { useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'

export function MessageEditor({
  initialValue,
  maxLength,
  disabled,
  onCancel,
  onSend
}: {
  initialValue: string
  maxLength: number
  disabled: boolean
  onCancel: () => void
  onSend: (content: string) => boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    textarea.current?.focus()
    textarea.current?.setSelectionRange(initialValue.length, initialValue.length)
  }, [initialValue])

  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [value])

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!disabled && value.trim() && onSend(value)) onCancel()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return (
    <form className="message-inline-editor" onSubmit={submit}>
      <label className="sr-only" htmlFor="message-inline-input">
        编辑消息
      </label>
      <textarea
        id="message-inline-input"
        ref={textarea}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        rows={2}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="message-inline-controls">
        <button type="button" className="message-inline-cancel" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="message-inline-send" disabled={disabled || !value.trim()}>
          发送
        </button>
      </div>
    </form>
  )
}
