import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import { Icon } from '../../components/ui/Icon'

export function ComposerAttachments({
  conversation: c,
  previewTriggerRef
}: {
  conversation: ConversationController
  previewTriggerRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selection = c.contextSelection
  const count = selection?.files.length ?? 0
  const busy = c.operation === 'selecting'
  const [practicePath, setPracticePath] = useState('')
  const [proposedText, setProposedText] = useState('')
  const activePracticePath = selection?.files.some((file) => file.path === practicePath)
    ? practicePath
    : (selection?.files[0]?.path ?? '')

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
        ref={(element) => {
          trigger.current = element
          previewTriggerRef.current = element
        }}
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
              <strong>{c.projectSelection ? '移除所有附件' : '清除会话文件'}</strong>
              <small>
                {count} 个文件{c.projectSelection ? '' : '仍可用于追问；清除后停止使用'}
              </small>
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
          <section className="change-preview-practice" aria-labelledby={`${id}-preview-title`}>
            <div className="change-preview-practice-heading">
              <Icon name="code" size={15} />
              <strong id={`${id}-preview-title`}>修改预览练习</strong>
            </div>
            {!selection ? (
              <p className="change-preview-practice-empty">先添加文本或代码文件。</p>
            ) : (
              <>
                <label>
                  文件别名
                  <select
                    value={activePracticePath}
                    disabled={!c.canEdit || busy || c.changePreview.state.status === 'loading'}
                    onChange={(event) => setPracticePath(event.target.value)}
                  >
                    {selection.files.map((file) => (
                      <option value={file.path} key={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  候选内容
                  <textarea
                    value={proposedText}
                    disabled={!c.canEdit || busy || c.changePreview.state.status === 'loading'}
                    rows={5}
                    spellCheck={false}
                    placeholder="输入修改后的完整文件内容"
                    onChange={(event) => setProposedText(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="change-preview-practice-submit"
                  disabled={
                    !c.canEdit ||
                    busy ||
                    !activePracticePath ||
                    c.changePreview.state.status === 'loading'
                  }
                  onClick={() => {
                    void (async () => {
                      const accepted = await c.changePreview.requestPreview(
                        activePracticePath,
                        proposedText
                      )
                      if (accepted) close()
                    })()
                  }}
                >
                  <Icon name="code" size={14} />
                  预览修改
                </button>
              </>
            )}
          </section>
        </details>
      </div>
    </div>
  )
}
