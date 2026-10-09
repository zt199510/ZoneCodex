import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { AgentMode } from '../../../../shared/agent'
import { ComposerMode } from './ComposerMode'

export function MessageEditor({
  initialValue,
  initialMode,
  maxLength,
  disabled,
  onCancel,
  onSend,
  imageNotice
}: {
  initialValue: string
  initialMode: AgentMode
  maxLength: number
  disabled: boolean
  onCancel: () => void
  onSend: (content: string, mode: AgentMode) => boolean | Promise<boolean>
  imageNotice?: string
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [mode, setMode] = useState(initialMode)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const version = useRef(0)
  const pending = useRef(false)
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

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
    if (disabled || pending.current || !value.trim() || value.length > maxLength) return
    const submittedVersion = version.current
    const settle = (accepted: boolean): void => {
      pending.current = false
      if (!mounted.current) return
      setPreparing(false)
      if (accepted && version.current === submittedVersion) onCancel()
    }
    const accepted = onSend(value, mode)
    if (typeof accepted === 'boolean') settle(accepted)
    else {
      pending.current = true
      setPreparing(true)
      void accepted.then(settle, () => settle(false))
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!pending.current) onCancel()
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
        onChange={(event) => {
          version.current += 1
          setValue(event.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
      />
      {imageNotice && <p className="message-image-notice">{imageNotice}</p>}
      <div className="message-inline-controls">
        <ComposerMode
          mode={mode}
          onSelect={(next) => {
            if (disabled || pending.current) return false
            version.current += 1
            setMode(next)
            return true
          }}
          disabled={disabled || preparing}
        />
        <button
          type="button"
          className="message-inline-cancel"
          disabled={preparing}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="submit"
          className="message-inline-send"
          disabled={disabled || preparing || !value.trim() || value.length > maxLength}
        >
          发送
        </button>
      </div>
    </form>
  )
}
