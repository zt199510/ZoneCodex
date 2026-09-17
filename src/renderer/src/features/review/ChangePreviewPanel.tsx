import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ChangePreview } from '../../../../shared/change-preview'
import { Icon } from '../../components/ui/Icon'
import { buildDiff } from './diff'
import type { ChangePreviewState } from './useChangePreview'

type ChangePreviewPanelProps = {
  state: ChangePreviewState
  snapshotCreatedAt: string | null
  onDiscard: () => boolean
  returnFocusRef: RefObject<HTMLButtonElement | null>
}

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path
}

function formatSnapshotTime(value: string | null): string {
  if (!value) return '当前快照'
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)
}

function marker(kind: 'same' | 'remove' | 'add'): string {
  if (kind === 'remove') return '-'
  if (kind === 'add') return '+'
  return ''
}

function rowLabel(kind: 'same' | 'remove' | 'add'): string {
  if (kind === 'remove') return '删除'
  if (kind === 'add') return '新增'
  return '未变化'
}

function DiffRows({ preview }: { preview: ChangePreview }): React.JSX.Element {
  const rows = useMemo(
    () => buildDiff(preview.before, preview.after),
    [preview.after, preview.before]
  )

  if (rows.length === 0) {
    return <p className="change-preview-no-change">没有变化</p>
  }

  return (
    <div className="diff-table" role="table" aria-label={`${fileName(preview.path)} 的文本差异`}>
      <div className="diff-row diff-row-header" role="row">
        <span role="columnheader">旧</span>
        <span role="columnheader">新</span>
        <span role="columnheader">变化</span>
        <span role="columnheader">内容</span>
      </div>
      {rows.map((row, index) => (
        <div className={`diff-row diff-row-${row.kind}`} key={`${row.kind}-${index}`} role="row">
          <span className="diff-line-number" role="cell">
            {row.oldLine ?? ''}
          </span>
          <span className="diff-line-number" role="cell">
            {row.newLine ?? ''}
          </span>
          <span className="diff-marker" aria-label={rowLabel(row.kind)} role="cell">
            {marker(row.kind)}
          </span>
          <pre className="diff-source" role="cell">
            {row.text === '' ? '∅' : row.text}
          </pre>
        </div>
      ))}
    </div>
  )
}

export function ChangePreviewPanel({
  state,
  snapshotCreatedAt,
  onDiscard,
  returnFocusRef
}: ChangePreviewPanelProps): React.JSX.Element | null {
  const closeButton = useRef<HTMLButtonElement>(null)
  const [closedGeneration, setClosedGeneration] = useState<number | null>(null)
  const visible = state.status !== 'idle' && closedGeneration !== state.generation
  const generation = state.status === 'idle' ? null : state.generation
  const canDiscard = state.status !== 'loading'

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => closeButton.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [visible])

  useEffect(() => {
    if (!visible || generation === null) return
    function onWindowKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setClosedGeneration(generation)
      requestAnimationFrame(() => returnFocusRef.current?.focus())
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => window.removeEventListener('keydown', onWindowKeyDown, true)
  }, [generation, returnFocusRef, visible])

  if (!visible) return null

  const preview = state.status === 'ready' ? state.preview : null
  const path =
    preview?.path ?? (state.status === 'loading' || state.status === 'error' ? state.path : '')

  function focusReturnTarget(): void {
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  function close(): void {
    if (generation === null) return
    setClosedGeneration(generation)
    focusReturnTarget()
  }

  function discard(): void {
    if (!canDiscard || !onDiscard()) return
    setClosedGeneration(generation)
    focusReturnTarget()
  }

  return (
    <section
      className="change-preview-panel"
      aria-labelledby="change-preview-title"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <div className="change-preview-shell">
        <header className="change-preview-header">
          <div className="change-preview-heading">
            <Icon name="code" size={16} />
            <div>
              <h2 id="change-preview-title">{path ? fileName(path) : '修改预览'}</h2>
              {path && <p title={path}>{path}</p>}
            </div>
          </div>
          <div className="change-preview-meta">
            <span>快照 {formatSnapshotTime(snapshotCreatedAt)}</span>
            <span className="change-preview-readonly">仅预览，未写入文件</span>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            type="button"
            aria-label="关闭修改预览"
            title="关闭修改预览"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="change-preview-content">
          {state.status === 'loading' && <p className="change-preview-status">正在生成预览…</p>}
          {state.status === 'error' && (
            <p className="change-preview-status change-preview-error" role="alert">
              {state.error}
            </p>
          )}
          {preview && <DiffRows preview={preview} />}
        </div>

        <footer className="change-preview-footer">
          <button type="button" className="quiet-button" disabled={!canDiscard} onClick={discard}>
            <Icon name="trash" size={14} />
            丢弃建议
          </button>
        </footer>
      </div>
    </section>
  )
}
