import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Conversation } from '../../../../shared/conversation-library'
import { Icon } from '../ui/Icon'

type SidebarSearchProps = {
  open: boolean
  disabled: boolean
  conversations: Conversation[]
  search: string
  onSearch: (value: string) => void
  onClose: () => void
  onSelect: (id: string) => Promise<boolean>
  onRestore: (id: string) => Promise<boolean>
}

function canFocus(element: HTMLElement | undefined): boolean {
  return Boolean(
    element?.isConnected &&
    element.getClientRects().length &&
    !element.closest('[inert]') &&
    !element.matches(':disabled')
  )
}

function messagePreview(conversation: Conversation, search: string): string {
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const matching = normalizedSearch
    ? conversation.messages.find((message) =>
        message.content.toLocaleLowerCase().includes(normalizedSearch)
      )
    : undefined
  const latest = conversation.messages
    .slice()
    .reverse()
    .find((message) => message.content.trim())
  return (matching?.content ?? latest?.content ?? '暂无消息').replace(/\s+/gu, ' ').trim()
}

export function SidebarSearch({
  open,
  disabled,
  conversations,
  search,
  onSearch,
  onClose,
  onSelect,
  onRestore
}: SidebarSearchProps): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    generation.current += 1
    if (!open) {
      if (element.open) element.close()
      return
    }
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (!element.open) element.showModal()
    input.current?.focus({ preventScroll: true })
    input.current?.select()
    return () => {
      generation.current += 1
      const active = document.activeElement
      const restore = active === document.body || (active !== null && element.contains(active))
      if (element.open) element.close()
      if (!restore) return
      requestAnimationFrame(() => {
        if (element.open || document.querySelector('dialog[open], [popover]:popover-open')) return
        const current = document.activeElement
        if (current !== document.body && current !== null && current !== previous) return
        if (canFocus(previous)) previous?.focus({ preventScroll: true })
      })
    }
  }, [open])

  async function selectResult(conversation: Conversation): Promise<void> {
    if (disabled || pending.current || !dialog.current?.open) return
    pending.current = true
    setBusy(true)
    setError(null)
    const submittedGeneration = generation.current
    try {
      const accepted = await (conversation.archived
        ? onRestore(conversation.id)
        : onSelect(conversation.id))
      if (
        accepted &&
        mounted.current &&
        generation.current === submittedGeneration &&
        dialog.current?.open
      ) {
        onClose()
      }
    } catch {
      if (mounted.current && generation.current === submittedGeneration) {
        setError('无法打开会话，请重试。')
      }
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  function resultButtons(): HTMLButtonElement[] {
    return Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>(
        '.sidebar-search-result:not(:disabled)'
      ) ?? []
    )
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = conversations[0]
      if (first) void selectResult(first)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const buttons = resultButtons()
      const target = buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'nearest' })
    }
  }

  function onResultKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const buttons = resultButtons()
    if (!buttons.length) return
    const current = buttons.indexOf(event.currentTarget)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : (current - 1 + buttons.length) % buttons.length
    buttons[next].focus({ preventScroll: true })
    buttons[next].scrollIntoView({ block: 'nearest' })
  }

  return (
    <dialog
      ref={dialog}
      className="sidebar-search-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="搜索会话"
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          onClose()
        }
      }}
    >
      <div className="sidebar-search-heading">
        <Icon name="search" size={18} />
        <label className="sr-only" htmlFor="conversation-search">
          搜索会话
        </label>
        <input
          ref={input}
          autoFocus
          id="conversation-search"
          value={search}
          maxLength={200}
          placeholder="搜索标题或消息"
          autoComplete="off"
          onChange={(event) => {
            setError(null)
            onSearch(event.currentTarget.value)
          }}
          onKeyDown={onInputKeyDown}
        />
        {search && (
          <button
            type="button"
            className="icon-button search-clear"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => {
              setError(null)
              onSearch('')
              input.current?.focus({ preventScroll: true })
            }}
          >
            <Icon name="close" size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon-button sidebar-search-close"
          aria-label="关闭搜索"
          title="关闭搜索"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="sidebar-search-results" role="group" aria-label="搜索结果" aria-busy={busy}>
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className="sidebar-search-result"
            title={conversation.title}
            disabled={disabled || busy}
            onClick={() => void selectResult(conversation)}
            onKeyDown={onResultKeyDown}
          >
            <Icon name={conversation.archived ? 'archive' : 'chat'} size={18} />
            <span className="sidebar-search-result-copy">
              <strong>{conversation.title}</strong>
              <small>{messagePreview(conversation, search)}</small>
            </span>
            {conversation.archived && <span className="sidebar-search-archived">已归档</span>}
          </button>
        ))}
        {conversations.length === 0 && (
          <p className="sidebar-search-empty">{search ? '没有匹配的会话。' : '暂无会话。'}</p>
        )}
      </div>
      {error && (
        <p className="sidebar-search-error" role="alert">
          {error}
        </p>
      )}
      <footer className="sidebar-search-footer">
        <span>
          <kbd>Esc</kbd> 关闭
        </span>
        <span>
          <kbd>Enter</kbd> 打开
        </span>
      </footer>
    </dialog>
  )
}
