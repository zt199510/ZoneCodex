import { useLayoutEffect, useMemo, useRef } from 'react'
import type { GitChangeItem } from '../../../../shared/git-view'
import { Icon } from '../../components/ui/Icon'
import { gitDisplayRows, visibleGitText } from './git-presentation'
import type { GitViewState } from './useGitView'

const groups = [
  { value: 'staged', label: '已暂存', source: 'HEAD → index' },
  { value: 'unstaged', label: '未暂存', source: 'index → 工作树' },
  { value: 'untracked', label: '新文件', source: '没有 Git 基线' }
] as const
const changes = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  unmerged: '冲突',
  'type-changed': '类型变化',
  unknown: '不支持'
} as const
const baselines = {
  'head-index': '已暂存 · HEAD → index',
  'empty-index': '已暂存 · 空树 → index（无 HEAD）',
  'index-worktree': '未暂存 · index → 工作树',
  untracked: '新文件内容 · 没有 Git 基线'
} as const

export function GitViewPanel({
  state,
  cleanupError,
  directoryDisabled,
  onSelectDirectory,
  onRefresh,
  onReadItem,
  onClose
}: {
  state: GitViewState
  cleanupError: string
  directoryDisabled: boolean
  onSelectDirectory: () => Promise<void>
  onRefresh: () => Promise<void>
  onReadItem: (item: GitChangeItem) => Promise<void>
  onClose: () => void
}): React.JSX.Element | null {
  const closeButton = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () => (state.detail ? gitDisplayRows(state.detail.text, state.detail.format) : []),
    [state.detail]
  )
  useLayoutEffect(() => {
    if (state.open) closeButton.current?.focus({ preventScroll: true })
  }, [state.open])
  useLayoutEffect(() => {
    if (content.current) {
      content.current.scrollTop = 0
      content.current.scrollLeft = 0
    }
  }, [state.selectedItemId, state.detail])

  if (!state.open) return null
  return (
    <aside id="git-panel" className="git-view-panel" aria-label="Git 改动查看">
      <header className="git-view-header">
        <Icon name="code" size={16} />
        <strong>Git 改动</strong>
        <span>只读</span>
        <button
          ref={closeButton}
          id="git-panel-close"
          className="icon-button"
          type="button"
          aria-label="关闭 Git 查看"
          title="关闭 Git 查看（Escape）"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="git-view-actions">
        <button
          id="git-view-select"
          type="button"
          className="quiet-button"
          disabled={directoryDisabled || state.phase === 'selecting'}
          onClick={() => void onSelectDirectory()}
        >
          <Icon name="folder" size={14} />
          {state.view ? '换目录' : '选择目录'}
        </button>
        <button
          id="git-view-refresh"
          type="button"
          className="quiet-button"
          disabled={!state.view || state.phase === 'selecting'}
          onClick={() => void onRefresh()}
        >
          刷新
        </button>
      </div>
      {state.view && (
        <div className="git-view-scope">
          <span title={visibleGitText(state.view.repositoryPath)}>
            仓库：{visibleGitText(state.view.repositoryPath)}
          </span>
          <span title={visibleGitText(state.view.selectedPath)}>
            查看范围：{visibleGitText(state.view.selectedPath)}
          </span>
          <small>
            窗口独立查看 · {visibleGitText(state.view.gitVersion)}
            {state.view.linkedWorktree ? ' · linked worktree' : ''}
            {state.view.head === 'unborn' ? ' · 尚无 HEAD' : ''}
          </small>
        </div>
      )}
      {cleanupError && (
        <p className="git-view-notice git-view-error" role="alert">
          清理未确认：{visibleGitText(cleanupError)}
        </p>
      )}
      {state.notice && (
        <p
          className="git-view-notice git-view-error"
          role="alert"
          data-status={state.notice.status}
        >
          {visibleGitText(state.notice.error)}
          {state.notice.status === 'stale' && ' 请刷新后重新选择。'}
        </p>
      )}
      {(state.phase === 'selecting' || state.phase === 'loading') && (
        <p className="git-view-notice" role="status">
          {state.phase === 'selecting' ? '正在选择查看目录…' : '正在读取改动列表…'}
        </p>
      )}
      {!state.view && state.phase === 'empty' && (
        <p className="git-view-notice" role="status">
          选择本地仓库或子目录，只查看该范围内的当前改动。
        </p>
      )}
      {state.list && (
        <>
          {state.list.warnings.map((warning, index) => (
            <p className="git-view-notice" role="status" key={index}>
              {visibleGitText(warning)}
            </p>
          ))}
          <div className="git-change-list" aria-label="Git 改动列表">
            {groups.map((group) => {
              const items = state.list?.items.filter((item) => item.group === group.value) ?? []
              return (
                <section key={group.value} data-group={group.value}>
                  <h3>
                    {group.label} <span>{items.length}</span>
                    <small>
                      {group.value === 'staged' && state.view?.head === 'unborn'
                        ? '空树 → index'
                        : group.source}
                    </small>
                  </h3>
                  {items.map((item) => (
                    <button
                      key={item.itemId}
                      type="button"
                      className="git-change-item"
                      aria-pressed={state.selectedItemId === item.itemId}
                      data-item-id={item.itemId}
                      data-group={item.group}
                      data-path={item.path}
                      onClick={() => void onReadItem(item)}
                    >
                      <span className="git-change-kind">{changes[item.change]}</span>
                      <span className="git-change-path" title={visibleGitText(item.path)}>
                        {item.previousPath && `${visibleGitText(item.previousPath)} → `}
                        {visibleGitText(item.path)}
                      </span>
                      {!item.previewable && <small>不可预览</small>}
                    </button>
                  ))}
                </section>
              )
            })}
            {state.list.items.length === 0 && (
              <p className="git-view-notice" role="status">
                当前查看范围内没有改动。
              </p>
            )}
          </div>
        </>
      )}
      {state.detailLoading && (
        <p className="git-view-notice" role="status">
          正在读取所选改动…
        </p>
      )}
      {state.detail && (
        <>
          <div className="git-detail-source">
            <strong>{baselines[state.detail.baseline]}</strong>
            <span>{visibleGitText(state.detail.item.path)}</span>
            <small>
              {state.detail.bytes} 字节 · {state.detail.lineCount} 行 · 列表版本对应的当前内容
            </small>
          </div>
          <div className="git-diff-scroll" ref={content} tabIndex={0} aria-label="Git 只读内容">
            <pre className="git-diff-code">
              <code>
                {rows.map((row, index) => (
                  <span key={index} className={`git-diff-line git-diff-${row.kind}`}>
                    {row.text}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </>
      )}
      {state.list && !state.detail && !state.detailLoading && !state.notice && (
        <p className="git-view-notice">选择一项查看来源明确的差异或新文件内容。</p>
      )}
    </aside>
  )
}
