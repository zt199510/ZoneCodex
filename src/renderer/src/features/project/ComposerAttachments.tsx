import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'

export function ComposerAttachments({
  conversation: c
}: {
  conversation: ConversationController
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selection = c.projectSelection
  const count = selection?.files.length ?? 0
  const busy = c.operation === 'selecting'

  useLayoutEffect(() => {
    if (!open) return
    function position(): void {
      if (!trigger.current || !panel.current) return
      const composer = trigger.current.closest('.composer')
      if (!composer) return
      const rect = composer.getBoundingClientRect()
      const width = Math.min(rect.width, window.innerWidth - 24)
      Object.assign(panel.current.style, {
        width: `${width}px`,
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        bottom: `${window.innerHeight - rect.top + 8}px`,
        maxHeight: `${Math.max(80, Math.min(320, rect.top - 52))}px`
      })
    }
    position()
    const observer = new ResizeObserver(position)
    const composer = trigger.current?.closest('.composer')
    if (composer) observer.observe(composer)
    if (composer?.parentElement?.parentElement)
      observer.observe(composer.parentElement.parentElement)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open, count, c.chatError])

  function close(): void {
    panel.current?.hidePopover()
  }

  return (
    <div className="composer-attachments">
      <button
        ref={trigger}
        type="button"
        className="attachment-add"
        popoverTarget={id}
        aria-label="添加附件"
        aria-expanded={open}
        aria-controls={id}
        disabled={!c.canEdit}
        title="添加附件"
      >
        <span aria-hidden="true">＋</span>
      </button>
      {c.engine !== 'live' && (
        <span className="debug-badge">{c.engine === 'mock' ? '离线模拟' : '流式调试'}</span>
      )}
      <div
        ref={panel}
        id={id}
        popover="auto"
        className="attachment-popover"
        role="dialog"
        aria-label="附件与调试设置"
        onToggle={(event) => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.stopPropagation()
        }}
      >
        <div className="attachment-heading">
          <strong>添加</strong>
          <button type="button" className="icon-button" onClick={close} aria-label="关闭附件菜单">
            ×
          </button>
        </div>
        <button
          type="button"
          className="attachment-picker"
          disabled={!c.canEdit || busy}
          onClick={() => {
            close()
            void c.selectProjectFiles()
          }}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M9 7v9a3 3 0 0 0 6 0V5a4 4 0 0 0-8 0v12a5 5 0 0 0 10 0V7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            <strong>{busy ? '正在选择…' : '文件'}</strong>
            <small>直接多选文本或代码文件，最多 8 个</small>
          </span>
        </button>
        {count > 0 && (
          <button
            type="button"
            className="attachment-picker"
            disabled={!c.canEdit}
            onClick={() => {
              close()
              void c.revokeProjectFiles()
            }}
          >
            <span aria-hidden="true">×</span>
            <span>
              <strong>移除所有附件</strong>
              <small>{count} 个文件</small>
            </span>
          </button>
        )}
        <details className="composer-debug">
          <summary>开发调试</summary>
          <label>
            响应来源
            <select
              aria-label="调试响应来源"
              value={c.engine}
              disabled={!c.canEdit}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'live' || value === 'mock' || value === 'stream')
                  void c.setEngine(value)
              }}
            >
              <option value="live">真实模型（默认）</option>
              <option value="mock">离线模拟</option>
              <option value="stream">纯文本流式调试</option>
            </select>
          </label>
          <p>
            模拟模式固定查询时间或搜索
            greet，不理解任意问题。流式调试不使用附件，切换时会清除当前附件授权。
          </p>
        </details>
      </div>
    </div>
  )
}
