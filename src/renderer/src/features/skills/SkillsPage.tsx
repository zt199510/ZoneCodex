import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SkillDescriptor } from '../../../../shared/skills'
import { Icon } from '../../components/ui/Icon'
import type { SkillsController } from './useSkills'

function canFocus(element: HTMLElement | undefined): boolean {
  return Boolean(
    element?.isConnected &&
    element.getClientRects().length &&
    !element.closest('[inert]') &&
    !element.matches(':disabled')
  )
}

function SkillGraphic(): React.JSX.Element {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m11.6 3.7-3.8 5.4a.5.5 0 0 0 .4.8h7.6a.5.5 0 0 0 .4-.8l-3.8-5.4a.5.5 0 0 0-.8 0Z" />
      <circle cx="6.5" cy="16.8" r="3.5" />
      <rect x="14.25" y="13.55" width="6.5" height="6.5" rx="1.5" />
    </svg>
  )
}

function SkillDetailDialog({
  item,
  root,
  disabled,
  returnFocus,
  onClose,
  onUse
}: {
  item: SkillDescriptor
  root: string
  disabled: boolean
  returnFocus?: HTMLElement
  onClose: () => void
  onUse: (item: SkillDescriptor) => void
}): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const name = item.status === 'available' ? item.name : item.directoryName
  const location = root
    ? `${root}${/[\\/]$/.test(root) ? '' : '\\'}${item.directoryName}`
    : item.directoryName

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    element.showModal()
    closeButton.current?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const restore = active === document.body || (active !== null && element.contains(active))
      if (element.open) element.close()
      if (restore && canFocus(previous)) previous?.focus({ preventScroll: true })
    }
  }, [item.skillId, item.generation, returnFocus])

  function close(): void {
    if (dialog.current?.open) dialog.current.close()
    onClose()
  }

  return (
    <dialog
      ref={dialog}
      className="skill-detail-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <header className="skill-detail-heading">
        <span className="skill-icon skill-detail-icon">
          <SkillGraphic />
        </span>
        <div className="skill-detail-title">
          <h2 id={titleId}>{name}</h2>
          <span>{item.status === 'available' ? '技能' : '技能 · 不可用'}</span>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button skill-detail-close"
          aria-label="关闭技能详情"
          title="关闭技能详情（Escape）"
          onClick={close}
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="skill-detail-content">
        <p
          id={descriptionId}
          className={item.status === 'available' ? 'skill-description' : 'skills-error'}
        >
          {item.status === 'available' ? item.description : item.error}
        </p>
        <dl className="skill-detail-metadata">
          <dt>位置</dt>
          <dd>{location}</dd>
        </dl>
      </div>
      <footer className="skill-detail-footer">
        <button
          type="button"
          className="skill-use"
          disabled={disabled || item.status !== 'available'}
          onClick={() => {
            // 立即退出模态状态，让准备期间的会话导航保持可用。
            close()
            onUse(item)
          }}
        >
          使用此技能
        </button>
      </footer>
    </dialog>
  )
}

function SkillsLibrary({
  skills,
  disabled,
  onSelect,
  titleId,
  searchInput
}: {
  skills: SkillsController
  disabled: boolean
  onSelect: (item: SkillDescriptor) => Promise<boolean>
  titleId: string
  searchInput: RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  const installedId = useId()
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<{
    item: SkillDescriptor
    returnFocus: HTMLElement
  } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const mounted = useRef(false)
  const latest = useRef(skills)
  const blocked = disabled || skills.busy
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const items = skills.items.filter((item) =>
    [
      item.directoryName,
      ...(item.status === 'available' ? [item.name, item.description] : [item.error])
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
  )

  useLayoutEffect(() => {
    latest.current = skills
  }, [skills])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function select(item: SkillDescriptor): Promise<void> {
    setLocalError(null)
    try {
      await onSelect(item)
    } catch (cause) {
      if (
        mounted.current &&
        latest.current.items.some(
          (candidate) =>
            candidate.skillId === item.skillId && candidate.generation === item.generation
        )
      )
        setLocalError(cause instanceof Error ? cause.message : '技能准备失败，请重新选择。')
    }
  }

  return (
    <>
      <header className="skills-topbar">
        <div className="skills-toolbar">
          <button
            type="button"
            className="icon-button skills-refresh"
            disabled={blocked}
            aria-label="刷新技能"
            title="刷新技能"
            onClick={() => {
              setLocalError(null)
              void skills.refresh()
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10m16 4-3 3A7 7 0 0 1 5 12" />
            </svg>
          </button>
          <label className="skills-search">
            <Icon name="search" size={16} />
            <input
              ref={searchInput}
              type="search"
              value={query}
              aria-label="搜索技能"
              placeholder="搜索技能"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="quiet-button skills-open-directory"
            disabled={blocked}
            onClick={() => {
              setLocalError(null)
              void skills.openDirectory()
            }}
          >
            <Icon name="folder" size={16} />
            打开技能目录
          </button>
        </div>
      </header>
      <div className="skills-scroll">
        <div className="skills-content">
          <header className="skills-header">
            <div className="skills-introduction">
              <h1 id={titleId}>技能</h1>
              <p>用技能添加可重复使用的工作流程。</p>
            </div>
          </header>
          <section
            className="skills-installed"
            aria-labelledby={installedId}
            aria-busy={skills.busy}
          >
            <h2 id={installedId}>已安装</h2>
            {(skills.error || localError) && (
              <p className="skills-error" role="alert">
                {skills.error || localError}
              </p>
            )}
            {skills.busy && !skills.items.length ? (
              <p className="skills-empty" role="status">
                正在读取技能…
              </p>
            ) : !skills.items.length ? (
              <p className="skills-empty">暂无已安装技能。打开技能目录后，添加技能文件并刷新。</p>
            ) : !items.length ? (
              <p className="skills-empty" role="status">
                未找到匹配的技能。
              </p>
            ) : (
              <div className="skills-grid">
                {items.map((item) => {
                  const name = item.status === 'available' ? item.name : item.directoryName
                  const description = item.status === 'available' ? item.description : item.error
                  const selected = item.status === 'available' && skills.pending?.name === item.name
                  return (
                    <button
                      key={item.skillId}
                      type="button"
                      className={`skills-option${item.status === 'unavailable' ? ' skills-unavailable' : ''}`}
                      disabled={blocked}
                      aria-haspopup="dialog"
                      onClick={(event) => setDetail({ item, returnFocus: event.currentTarget })}
                    >
                      <span className="skill-icon">
                        <SkillGraphic />
                      </span>
                      <span className="skill-card-copy">
                        <strong>{name}</strong>
                        <small title={description}>{description}</small>
                      </span>
                      <span className="skill-card-accessory">
                        {item.status === 'unavailable' && <span>不可用</span>}
                        <Icon name={selected ? 'check' : 'chevron'} size={15} />
                        {selected && <span className="sr-only">已选择</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
      {detail && (
        <SkillDetailDialog
          item={detail.item}
          root={skills.root}
          disabled={blocked}
          returnFocus={detail.returnFocus}
          onClose={() => setDetail(null)}
          onUse={(item) => void select(item)}
        />
      )}
    </>
  )
}

export function SkillsPage({
  open,
  skills,
  disabled,
  returnFocus,
  onSelect
}: {
  open: boolean
  skills: SkillsController
  disabled: boolean
  returnFocus?: HTMLElement
  onSelect: (item: SkillDescriptor) => Promise<boolean>
}): React.JSX.Element {
  const titleId = useId()
  const page = useRef<HTMLElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const entered = useRef(false)
  const latest = useRef({ skills, disabled })

  useLayoutEffect(() => {
    latest.current = { skills, disabled }
  }, [skills, disabled])
  useEffect(() => {
    if (!open) {
      entered.current = false
      return
    }
    if (entered.current) return
    entered.current = true
    const state = latest.current
    // 只在主动进入时发现；保持页面打开不会因会话变化重新扫描。
    if (!state.skills.root && !state.skills.pending && !state.skills.busy && !state.disabled)
      void state.skills.refresh()
  }, [open])

  useLayoutEffect(() => {
    const element = page.current
    if (!open || !element) return
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    searchInput.current?.focus({ preventScroll: true })
    return () => {
      requestAnimationFrame(() => {
        if (!element.hidden || document.querySelector('dialog[open], [popover]:popover-open'))
          return
        const active = document.activeElement
        if (active !== document.body && active !== null && !element.contains(active)) return
        const target = canFocus(previous)
          ? previous
          : (document.getElementById('chat-input') ?? undefined)
        if (canFocus(target)) target?.focus({ preventScroll: true })
      })
    }
  }, [open, returnFocus])

  return (
    <main ref={page} className="skills-page" hidden={!open} inert={!open} aria-labelledby={titleId}>
      {open && (
        <SkillsLibrary
          skills={skills}
          disabled={disabled}
          onSelect={onSelect}
          titleId={titleId}
          searchInput={searchInput}
        />
      )}
    </main>
  )
}
