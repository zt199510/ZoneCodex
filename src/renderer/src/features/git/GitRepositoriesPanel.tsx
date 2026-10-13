import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { GitViewScope } from '../../../../shared/git-view'
import type { GitMetadata, GitReviewData, GitReviewSource } from '../../../../shared/git-workbench'
import { sameGitWorkbenchRequest } from '../../../../shared/git-workbench'
import { Icon } from '../../components/ui/Icon'
import { visibleGitText } from './git-presentation'
import { GitWorkbenchPanel } from './GitWorkbenchPanel'
import type { useGitRepositories } from './useGitRepositories'

type Controller = ReturnType<typeof useGitRepositories>
type Aggregate = {
  view: GitViewScope
  metadata: GitMetadata | null
  review: GitReviewData | null
  error: string
}
const aggregateSources: { value: GitReviewSource; label: string }[] = [
  { value: 'uncommitted', label: '全部未提交 · Uncommitted' },
  { value: 'unstaged', label: '未暂存 · Unstaged' },
  { value: 'staged', label: '已暂存 · Staged' },
  { value: 'last-turn', label: '上一回合 · Last Turn' }
]
function name(view: GitViewScope): string {
  return visibleGitText(
    view.repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) || view.repositoryPath
  )
}

/** Aggregate operations run one repository at a time with its own revision and owned view. */
export function GitRepositoriesPanel({
  controller,
  directoryDisabled
}: {
  controller: Controller
  directoryDisabled: boolean
}): React.JSX.Element | null {
  const { state, views, selected } = controller
  const [busyViews, setBusyViews] = useState<Record<string, boolean>>({})
  const [aggregateSource, setAggregateSource] = useState<GitReviewSource>('uncommitted')
  const [groups, setGroups] = useState<Aggregate[]>([])
  const [aggregateBusy, setAggregateBusy] = useState(false)
  const [pendingRefresh, setPendingRefresh] = useState(false)
  const [loadedKey, setLoadedKey] = useState('')
  const [failedKey, setFailedKey] = useState('')
  const collectionKey = `${views.map((view) => view.viewId).join(',')}:${aggregateSource}`
  const needsRefresh =
    pendingRefresh || (loadedKey !== collectionKey && failedKey !== collectionKey)
  const unsettledReview =
    pendingRefresh || loadedKey !== collectionKey || failedKey === collectionKey
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<{ viewId: string; message: string; success: boolean }[]>(
    []
  )
  const [confirmRevert, setConfirmRevert] = useState(false)
  const [requestedFile, setRequestedFile] = useState<{
    source: GitReviewSource
    path: string
    nonce: string
  } | null>(null)
  const [width, setWidth] = useState(52)
  const panel = useRef<HTMLElement>(null)
  const resizingCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizingCleanup.current?.(), [])
  const running = useRef(false)
  const request = useRef<string | null>(null)
  const sequence = useRef(0)
  const generation = useRef(0)
  const active = useRef(selected)
  useEffect(() => {
    active.current = selected
  }, [selected])
  const blocked = useRef(directoryDisabled)
  useEffect(() => {
    blocked.current = directoryDisabled
  }, [directoryDisabled])
  const watched = useRef(new Map<string, number>())
  const anyBusy =
    aggregateBusy || controller.selecting || views.some((view) => busyViews[view.viewId])
  const busyChanged = useCallback((viewId: string, busy: boolean): void => {
    setBusyViews((previous) =>
      previous[viewId] === busy ? previous : { ...previous, [viewId]: busy }
    )
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (running.current || active.current !== 'all' || blocked.current) return
    running.current = true
    const token = ++generation.current
    const seen = sequence.current
    setAggregateBusy(true)
    const next: Aggregate[] = []
    try {
      for (const view of views) {
        if (token !== generation.current || active.current !== 'all') return
        const item: Aggregate = { view, metadata: null, review: null, error: '' }
        for (const phase of ['metadata', 'review'] as const) {
          const identity = { requestId: crypto.randomUUID(), viewId: view.viewId }
          request.current = identity.requestId
          const result =
            phase === 'metadata'
              ? await window.api.getGitMetadata(identity)
              : await window.api.reviewGitChanges({ ...identity, source: aggregateSource })
          if (token !== generation.current || active.current !== 'all') return
          request.current = null
          if (!sameGitWorkbenchRequest(identity, result)) {
            item.error = '仓库返回身份已变化，请刷新。'
            break
          }
          if (result.status !== 'ready') {
            item.error = result.status === 'cancelled' ? '读取已取消。' : result.error
            break
          }
          if (phase === 'metadata') item.metadata = result.data as GitMetadata
          else item.review = result.data as GitReviewData
        }
        next.push(item)
      }
      if (token === generation.current) {
        setGroups(next)
        setLoadedKey(collectionKey)
        setFailedKey('')
        setPendingRefresh(sequence.current !== seen)
      }
    } catch (error) {
      if (token === generation.current) {
        setFailedKey(collectionKey)
        setPendingRefresh(sequence.current !== seen)
        setResults([
          {
            viewId: '',
            success: false,
            message:
              error instanceof Error ? error.message.slice(0, 500) : '仓库读取未完成，请刷新。'
          }
        ])
      }
    } finally {
      if (token === generation.current) {
        running.current = false
        setAggregateBusy(false)
      }
    }
  }, [views, aggregateSource, collectionKey])
  useEffect(() => {
    if (
      selected !== 'all' ||
      !views.length ||
      !needsRefresh ||
      anyBusy ||
      directoryDisabled ||
      confirmRevert
    )
      return
    const timer = setTimeout(() => void refresh(), 350)
    return () => clearTimeout(timer)
  }, [selected, views.length, needsRefresh, anyBusy, directoryDisabled, confirmRevert, refresh])
  useEffect(() => {
    if (typeof window.api.onGitInvalidated !== 'function') return
    return window.api.onGitInvalidated((event) => {
      if (
        !views.some((view) => view.viewId === event.viewId) ||
        event.sequence <= (watched.current.get(event.viewId) ?? 0)
      )
        return
      watched.current.set(event.viewId, event.sequence)
      sequence.current += 1
      setPendingRefresh(true)
    })
  }, [views])
  useEffect(
    () => () => {
      generation.current += 1
      const requestId = request.current
      request.current = null
      if (requestId) void window.api.cancelGitRead(requestId).catch(() => undefined)
    },
    []
  )
  const actAcross = async (action: 'stage' | 'unstage' | 'revert'): Promise<void> => {
    if (
      running.current ||
      anyBusy ||
      (directoryDisabled && !confirmRevert) ||
      (unsettledReview && !confirmRevert) ||
      controller.cleanupError
    )
      return
    setConfirmRevert(false)
    running.current = true
    const token = ++generation.current
    setAggregateBusy(true)
    setResults([])
    const outcomes: typeof results = []
    try {
      for (const group of groups) {
        if (token !== generation.current || active.current !== 'all') return
        const files = group.review?.files.filter((file) => file.actions.includes(action)) ?? []
        if (!files.length || !group.review) continue
        const identity = { requestId: crypto.randomUUID(), viewId: group.view.viewId }
        request.current = identity.requestId
        const result = await window.api.executeGitAction({
          ...identity,
          action,
          revision: group.review.revision,
          itemIds: files.map((file) => file.itemId)
        })
        if (token !== generation.current) return
        request.current = null
        const matched = sameGitWorkbenchRequest(identity, result)
        const success = matched && result.status === 'ready' && result.data.outcome === 'success'
        const message = !matched
          ? '结果身份不一致，需要重新核对。'
          : result.status === 'ready'
            ? result.data.message
            : result.status === 'cancelled'
              ? '已取消，需刷新核对实际结果。'
              : result.error
        outcomes.push({ viewId: group.view.viewId, success, message })
        setResults([...outcomes])
        // An unknown write outcome must settle before another repository is touched.
        if (!success) {
          for (const remaining of groups.slice(groups.indexOf(group) + 1)) {
            if (remaining.review?.files.some((file) => file.actions.includes(action)))
              outcomes.push({
                viewId: remaining.view.viewId,
                success: false,
                message: '尚未执行：前一仓库结果需先核对。'
              })
          }
          setResults([...outcomes])
          break
        }
      }
    } catch (error) {
      if (token === generation.current)
        setResults([
          ...outcomes,
          {
            viewId: '',
            success: false,
            message:
              error instanceof Error ? error.message.slice(0, 500) : '操作结果未确认，请刷新核对。'
          }
        ])
    } finally {
      if (token === generation.current) {
        running.current = false
        setAggregateBusy(false)
        setPendingRefresh(true)
      }
    }
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !panel.current) return
    event.preventDefault()
    resizingCleanup.current?.()
    const parent = panel.current.parentElement
    if (!parent) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = parent.getBoundingClientRect()
    const move = (moveEvent: PointerEvent): void => {
      const pixels = bounds.right - moveEvent.clientX
      setWidth(
        Math.min(
          85,
          Math.max(Math.min(40, (320 / bounds.width) * 100), (pixels / bounds.width) * 100)
        )
      )
    }
    const stop = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      resizingCleanup.current = null
    }
    resizingCleanup.current = stop
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop, { once: true })
    document.addEventListener('pointercancel', stop, { once: true })
  }
  if (!state.open) return null
  const eligible = (action: 'stage' | 'unstage' | 'revert'): boolean =>
    groups.some((group) => group.review?.files.some((file) => file.actions.includes(action)))
  const totalFiles = groups.reduce((sum, group) => sum + (group.review?.files.length ?? 0), 0)
  return (
    <aside
      className="git-repositories"
      ref={panel}
      style={{ '--git-panel-width': `${width}%` } as CSSProperties}
      aria-label="Git 仓库与改动"
    >
      <div
        className="git-workbench-splitter"
        role="separator"
        aria-label="调整 Git 面板宽度"
        aria-orientation="vertical"
        aria-valuemin={32}
        aria-valuemax={85}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={resize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth((previous) =>
              Math.min(85, Math.max(32, previous + (event.key === 'ArrowLeft' ? 2 : -2)))
            )
          }
        }}
      />
      <div className="git-repositories-selector">
        <Icon name="folder" size={14} />
        <select
          aria-label="选择 Git 仓库"
          value={selected}
          disabled={anyBusy || directoryDisabled}
          onChange={(event) => {
            setRequestedFile(null)
            controller.selectRepository(event.target.value)
          }}
        >
          <option value="all">全部仓库 · All repos ({views.length})</option>
          {views.map((view) => (
            <option key={view.viewId} value={view.viewId}>
              {name(view)}
              {view.scopePath ? ` / ${view.scopePath}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="git-workbench-control"
          disabled={anyBusy || directoryDisabled || !!controller.cleanupError || views.length >= 8}
          onClick={() => void controller.selectDirectory()}
          title="添加手动选择的仓库，可多选目录"
        >
          添加仓库
        </button>
        {selected !== 'all' && (
          <button
            type="button"
            className="icon-button"
            aria-label="移除此仓库"
            title="从查看范围移除仓库"
            disabled={anyBusy || directoryDisabled}
            onClick={() => void controller.removeRepository(selected)}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {selected === 'all' && views.length > 0 && (
        <section className="git-workbench git-workbench-aggregate">
          <header className="git-workbench-header">
            <Icon name="code" size={16} />
            <strong>
              改动 <small>Changes · All repos</small>
            </strong>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭 Git 查看"
              onClick={() => controller.close()}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="git-workbench-toolbar">
            <select
              aria-label="全部仓库差异来源"
              value={aggregateSource}
              disabled={anyBusy || directoryDisabled}
              onChange={(event) => {
                setAggregateSource(event.target.value as GitReviewSource)
                setResults([])
              }}
            >
              {aggregateSources.map((source) => (
                <option key={source.value} value={source.value}>
                  {source.label}
                </option>
              ))}
            </select>
            <span className="git-workbench-spacer" />
            <button
              className="icon-button"
              type="button"
              aria-label="刷新全部仓库"
              disabled={anyBusy || directoryDisabled}
              onClick={() => void refresh()}
            >
              <Icon name="restore" size={14} />
            </button>
          </div>
          <label className="git-workbench-filter">
            <Icon name="search" size={13} />
            <input
              aria-label="筛选全部仓库文件"
              placeholder="筛选文件…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          {state.notice && (
            <p className="git-workbench-notice is-error" role="alert">
              {visibleGitText(state.notice.error)}
            </p>
          )}
          {controller.cleanupError && (
            <p className="git-workbench-notice is-error" role="alert">
              {visibleGitText(controller.cleanupError)}
            </p>
          )}
          {aggregateBusy && (
            <p className="git-workbench-notice" role="status">
              正在依次处理仓库…
            </p>
          )}
          {needsRefresh && !aggregateBusy && (
            <p className="git-workbench-notice" role="status">
              {confirmRevert || directoryDisabled
                ? '当前操作结束后刷新外部改动。'
                : '等待刷新仓库改动…'}
            </p>
          )}
          {results.map((result, index) => (
            <p
              className={`git-workbench-notice${result.success ? '' : ' is-error'}`}
              role={result.success ? 'status' : 'alert'}
              key={index}
            >
              {result.viewId
                ? `${views.find((view) => view.viewId === result.viewId) ? name(views.find((view) => view.viewId === result.viewId)!) : '已移除仓库'}：`
                : ''}
              {visibleGitText(result.message)}
            </p>
          ))}
          <div className="git-workbench-aggregate-groups">
            {groups.map((group) => (
              <section className="git-workbench-repository-group" key={group.view.viewId}>
                <header>
                  <button
                    className="git-workbench-control"
                    type="button"
                    disabled={anyBusy || directoryDisabled}
                    onClick={() => controller.selectRepository(group.view.viewId)}
                  >
                    {name(group.view)} <small>{visibleGitText(group.metadata?.branch ?? '')}</small>
                  </button>
                  <span>{group.review?.files.length ?? 0} 个文件</span>
                </header>
                <p
                  className="git-workbench-scope"
                  title={visibleGitText(group.view.repositoryPath)}
                >
                  {visibleGitText(group.view.repositoryPath)}
                  {group.view.scopePath ? ` / ${visibleGitText(group.view.scopePath)}` : ''}
                </p>
                {group.error ? (
                  <p className="git-workbench-notice is-error" role="alert">
                    {visibleGitText(group.error)}
                  </p>
                ) : !group.review?.files.length ? (
                  <p className="git-workbench-notice">
                    {group.metadata?.lastTurn?.state === 'capturing' &&
                    aggregateSource === 'last-turn'
                      ? '正在捕获回合差异…'
                      : group.review?.baseLabel || '此范围没有改动。'}
                  </p>
                ) : (
                  group.review.files
                    .filter((file) =>
                      file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
                    )
                    .map((file) => (
                      <button
                        type="button"
                        key={file.itemId}
                        className="git-workbench-tree-row"
                        disabled={anyBusy || directoryDisabled}
                        onClick={() => {
                          setRequestedFile({
                            source: aggregateSource,
                            path: file.path,
                            nonce: crypto.randomUUID()
                          })
                          controller.selectRepository(group.view.viewId)
                        }}
                      >
                        <Icon name="file" size={13} />
                        <span className="git-workbench-tree-name">{visibleGitText(file.path)}</span>
                        <span className="git-workbench-stat-added">+{file.additions}</span>
                        <span className="git-workbench-stat-deleted">−{file.deletions}</span>
                      </button>
                    ))
                )}
              </section>
            ))}
          </div>
          <footer className="git-workbench-status">
            <span>
              {views.length} 个仓库 · {totalFiles} 个文件
            </span>
            {(['stage', 'unstage', 'revert'] as const).map(
              (action) =>
                eligible(action) && (
                  <button
                    key={action}
                    type="button"
                    className="git-workbench-control"
                    disabled={
                      anyBusy || directoryDisabled || !!controller.cleanupError || unsettledReview
                    }
                    onClick={() =>
                      action === 'revert' ? setConfirmRevert(true) : void actAcross(action)
                    }
                  >
                    {{ stage: '暂存', unstage: '取消暂存', revert: '撤销' }[action]}全部仓库
                  </button>
                )
            )}
          </footer>
          {confirmRevert && (
            <div className="git-workbench-dialog-backdrop">
              <dialog
                open
                className="git-workbench-dialog"
                aria-modal="true"
                aria-label="撤销全部仓库确认"
              >
                <h3>撤销这些仓库的改动？</h3>
                <p>
                  将按仓库逐一撤销当前来源中的文件。每个仓库核对独立的差异版本，遇到错误会停止并显示已完成结果。
                </p>
                <div className="git-workbench-dialog-paths">
                  {groups.map((group) => (
                    <div key={group.view.viewId}>
                      {name(group.view)}：
                      {group.review?.files.filter((file) => file.actions.includes('revert'))
                        .length ?? 0}{' '}
                      个文件
                    </div>
                  ))}
                </div>
                <div className="git-workbench-dialog-actions">
                  <button type="button" onClick={() => setConfirmRevert(false)}>
                    取消
                  </button>
                  <button
                    autoFocus
                    className="danger"
                    type="button"
                    onClick={() => void actAcross('revert')}
                  >
                    确认逐仓库撤销
                  </button>
                </div>
              </dialog>
            </div>
          )}
        </section>
      )}
      {!views.length && (
        <GitWorkbenchPanel
          state={state}
          cleanupError={controller.cleanupError}
          directoryDisabled={directoryDisabled || controller.selecting}
          onSelectDirectory={controller.selectDirectory}
          onAdoptView={controller.adoptView}
          onRefresh={async () => undefined}
          onClose={() => controller.close()}
        />
      )}
      {views.map((view) => (
        <div className="git-repositories-pane" hidden={selected !== view.viewId} key={view.viewId}>
          <GitWorkbenchPanel
            state={{ ...state, view, phase: 'ready' }}
            cleanupError={controller.cleanupError}
            directoryDisabled={directoryDisabled || controller.selecting}
            active={selected === view.viewId && !controller.cleanupError}
            onBusyChange={busyChanged}
            requestedFile={selected === view.viewId ? requestedFile : null}
            onSelectDirectory={controller.selectDirectory}
            onAdoptView={controller.adoptView}
            onRefresh={async () => undefined}
            onClose={() => controller.close()}
          />
        </div>
      ))}
    </aside>
  )
}
