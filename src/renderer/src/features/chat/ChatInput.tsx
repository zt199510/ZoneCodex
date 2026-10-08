import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../components/ui/Icon'

type ChatInputProps = {
  value: string
  onChange: (value: string) => void
  onSend: (content: string) => boolean | Promise<boolean>
  onStop: () => void
  disabled: boolean
  isSending: boolean
  maxLength: number
  tools: ReactNode
  attachments?: ReactNode
  draftKey?: string | null
  onPasteImages?: (files: readonly File[]) => void
  onDropImages?: (files: readonly File[]) => void
  onImageError?: (error: string) => void
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
  attachments,
  draftKey,
  onPasteImages,
  onDropImages,
  onImageError
}: ChatInputProps): React.JSX.Element {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const wasSending = useRef(isSending)
  const mounted = useRef(true)
  const submitting = useRef(false)
  const [preparing, setPreparing] = useState(false)
  const dragContext = JSON.stringify([draftKey, disabled, isSending, preparing])
  const [dragState, setDragState] = useState({ context: dragContext, active: false })
  if (dragState.context !== dragContext) setDragState({ context: dragContext, active: false })
  const draggingImages = dragState.context === dragContext && dragState.active
  const dragDepth = useRef(0)
  const latestDraft = useRef({ value, key: draftKey, version: 0 })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useLayoutEffect(() => {
    const latest = latestDraft.current
    if (latest.value !== value || latest.key !== draftKey) latest.version += 1
    latest.value = value
    latest.key = draftKey
  }, [value, draftKey])
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [value])
  useLayoutEffect(() => {
    const element = textarea.current
    if (wasSending.current && !isSending && !disabled && element) {
      const active = element.ownerDocument.activeElement
      if (active === element.ownerDocument.body || (active && element.form?.contains(active)))
        element.focus({ preventScroll: true })
    }
    wasSending.current = isSending
  }, [disabled, isSending])
  useEffect(() => {
    dragDepth.current = 0
  }, [dragContext])
  function setDraggingImages(active: boolean): void {
    setDragState({ context: dragContext, active })
  }
  function submit(event: FormEvent): void {
    event.preventDefault()
    if (disabled || submitting.current || !value.trim() || value.length > maxLength) return
    const submitted = { ...latestDraft.current }
    const settle = (accepted: boolean): void => {
      submitting.current = false
      if (!mounted.current) return
      setPreparing(false)
      const latest = latestDraft.current
      if (
        accepted &&
        latest.version === submitted.version &&
        latest.key === submitted.key &&
        latest.value === submitted.value
      ) {
        latest.value = ''
        latest.version += 1
        onChange('')
      }
    }
    const accepted = onSend(value)
    if (typeof accepted === 'boolean') settle(accepted)
    else {
      submitting.current = true
      setPreparing(true)
      void accepted.then(settle, () => settle(false))
    }
  }
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    if (!onPasteImages) return
    const images = Array.from(event.clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    )
    if (!images.length) return
    event.preventDefault()
    if (disabled || isSending || submitting.current) {
      onImageError?.('请等待当前操作结束后再添加图片。')
      return
    }
    const files = images.map((item) => item.getAsFile())
    if (files.some((file) => !file)) {
      onImageError?.('无法读取粘贴图片，请重新添加。')
      return
    }
    onPasteImages(files as File[])
  }
  function hasFiles(event: DragEvent<HTMLFormElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files')
  }
  function onDragEnter(event: DragEvent<HTMLFormElement>): void {
    if (!onDropImages || !hasFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    if (!disabled && !isSending && !submitting.current) setDraggingImages(true)
  }
  function onDragOver(event: DragEvent<HTMLFormElement>): void {
    if (!onDropImages || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = disabled || isSending || submitting.current ? 'none' : 'copy'
  }
  function onDragLeave(event: DragEvent<HTMLFormElement>): void {
    if (!dragDepth.current) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (!dragDepth.current) setDraggingImages(false)
  }
  function onDrop(event: DragEvent<HTMLFormElement>): void {
    if (!onDropImages || !hasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDraggingImages(false)
    if (disabled || isSending || submitting.current) {
      onImageError?.('请等待当前操作结束后再添加图片。')
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (!files.length) {
      onImageError?.('无法读取拖入图片，请重新添加。')
      return
    }
    onDropImages(files)
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // 中文输入法正在确认候选词时，Enter 不能触发发送。
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !composing.current &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }
  return (
    <form
      className={`composer${draggingImages ? ' composer-image-drop' : ''}`}
      onSubmit={submit}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {attachments}
      {draggingImages && (
        <div className="composer-drop-hint" aria-live="polite">
          松开以添加 PNG/JPEG 图片
        </div>
      )}
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
        onChange={(event) => {
          latestDraft.current = {
            value: event.currentTarget.value,
            key: draftKey,
            version: latestDraft.current.version + 1
          }
          onChange(event.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
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
              disabled={disabled || preparing || !value.trim() || value.length > maxLength}
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
