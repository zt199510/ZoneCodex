import { useLayoutEffect, useRef } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../components/ui/Icon'

type ChatInputProps = {
  value: string
  onChange: (value: string) => void
  onSend: (content: string) => boolean
  onStop: () => void
  disabled: boolean
  isSending: boolean
  maxLength: number
  tools: ReactNode
  attachments?: ReactNode
}

export function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  isSending,
  maxLength,
  tools,
  attachments
}: ChatInputProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [value])
  function submit(event: FormEvent): void {
    event.preventDefault()
    if (disabled || !value.trim()) return
    if (onSend(value)) onChange('')
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // 中文输入法正在确认候选词时，Enter 不能触发发送。
    if (
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
    <form className="composer" onSubmit={submit}>
      {attachments}
      <label className="sr-only" htmlFor="chat-input">
        发送消息
      </label>
      <textarea
        id="chat-input"
        ref={textarea}
        value={value}
        rows={2}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={isSending ? '正在回复，你可以随时停止…' : '有什么想一起探索的？'}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-toolbar">
        {tools}
        <div className="composer-submit">
          <span className="keyboard-hint">Shift + Enter 换行</span>
          {isSending ? (
            <button
              className="send-button"
              type="button"
              onClick={onStop}
              aria-label="停止生成"
              title="停止生成"
            >
              <Icon name="stop" size={17} />
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              disabled={disabled || !value.trim()}
              aria-label="发送消息"
              title="发送消息"
            >
              <Icon name="arrow" size={20} />
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
