import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GitMetadata, GitWorkbenchResult } from '../../../../shared/git-workbench'
import { sameGitWorkbenchRequest } from '../../../../shared/git-workbench'
import type {
  GitPullRequestDetailData,
  GitPullRequestListData,
  GitPullRequestMethod
} from '../../../../shared/git-pr'
import { visibleGitText } from './git-presentation'

const stateLabels = { OPEN: '打开', CLOSED: '已关闭', MERGED: '已合并' }
const checkLabels = {
  pending: '等待中',
  success: '通过',
  failure: '失败',
  neutral: '中性',
  skipped: '已跳过',
  cancelled: '已取消',
  unknown: '未知'
}
function keydown(
  event: React.KeyboardEvent<HTMLDialogElement>,
  close: () => void,
  busy: boolean
): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!busy) close()
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'
    )
  ).filter((element) => element.getClientRects().length)
  const first = controls[0],
    last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

/** GitHub reads and manual merge use owned PR IDs; no chat or model request. */
export function GitPullRequestDialog({
  viewId,
  metadata,
  defaultMethod,
  onCancel,
  onChanged
}: {
  viewId: string
  metadata: GitMetadata
  defaultMethod: GitPullRequestMethod
  onCancel: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [remoteId, setRemoteId] = useState(
    metadata.remotes.find((remote) => remote.pushable)?.remoteId ??
      metadata.remotes[0]?.remoteId ??
      ''
  )
  const [listState, setListState] = useState<'open' | 'all'>('open')
  const [list, setList] = useState<GitPullRequestListData | null>(null)
  const [detail, setDetail] = useState<GitPullRequestDetailData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [method, setMethod] = useState(defaultMethod)
  const active = useRef(false)
  const running = useRef(false)
  const pending = useRef<string | null>(null)
  const first = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    active.current = true
    first.current?.focus({ preventScroll: true })
    return () => {
      active.current = false
      const requestId = pending.current
      if (requestId) void window.api.cancelGitRead(requestId).catch(() => undefined)
    }
  }, [])
  const read = async <T,>(
    operation: (identity: { requestId: string; viewId: string }) => Promise<GitWorkbenchResult<T>>
  ): Promise<T | null> => {
    if (running.current || !active.current) return null
    running.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const identity = { requestId: crypto.randomUUID(), viewId }
    pending.current = identity.requestId
    try {
      const result = await operation(identity)
      if (!active.current) return null
      if (!sameGitWorkbenchRequest(identity, result)) {
        setError('PR 返回身份已变化，请重新读取。')
        return null
      }
      if (result.status !== 'ready') {
        if (result.status !== 'cancelled') setError(result.error)
        return null
      }
      return result.data
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error ? failure.message.slice(0, 500) : 'PR 操作未完成，请重试。'
        )
      return null
    } finally {
      running.current = false
      pending.current = null
      if (active.current) setBusy(false)
    }
  }
  const loadList = async (): Promise<void> => {
    if (!remoteId) {
      setError('此仓库尚无可用远端。')
      return
    }
    const previous = detail
    const data = await read((identity) =>
      window.api.getGitPullRequests({
        ...identity,
        revision: metadata.revision,
        remoteId,
        state: listState
      })
    )
    if (!data || !active.current) return
    setList(data)
    const selected =
      previous &&
      data.items.find(
        (item) => item.number === previous.number && data.repository === previous.repository
      )
    setDetail(null)
    setConfirm(false)
    if (selected) await loadDetail(selected.prId)
  }
  const loadDetail = async (prId: string): Promise<void> => {
    const data = await read((identity) =>
      window.api.getGitPullRequest({ ...identity, revision: metadata.revision, prId })
    )
    if (!data || !active.current) return
    setDetail(data)
    setConfirm(false)
    setMethod((previous) =>
      data.mergeMethods.includes(previous) ? previous : (data.mergeMethods[0] ?? defaultMethod)
    )
  }
  const merge = async (): Promise<void> => {
    if (!detail || !confirm || !detail.mergeMethods.includes(method)) return
    const data = await read((identity) =>
      window.api.mergeGitPullRequest({
        ...identity,
        revision: metadata.revision,
        prId: detail.prId,
        prRevision: detail.prRevision,
        method
      })
    )
    if (!data || !active.current) return
    setConfirm(false)
    setNotice(data.message)
    if (data.outcome === 'success') {
      setDetail((previous) =>
        previous ? { ...previous, state: 'MERGED', mergeMethods: [] } : previous
      )
      onChanged()
    } else setError(data.message)
  }
  return (
    <div className="git-workbench-dialog-backdrop">
      <dialog
        open
        className="git-workbench-dialog git-workbench-pr-dialog"
        aria-modal="true"
        aria-label="Pull Request 管理"
        onKeyDown={(event) => keydown(event, onCancel, busy)}
      >
        <header className="git-workbench-pr-heading">
          <h3>Pull Requests</h3>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="关闭 Pull Request 管理"
          >
            关闭
          </button>
        </header>
        <div className="git-workbench-form git-workbench-pr-controls">
          <label>
            远端
            <select
              ref={first}
              aria-label="PR 远端"
              value={remoteId}
              disabled={busy}
              onChange={(event) => {
                setRemoteId(event.target.value)
                setList(null)
                setDetail(null)
                setConfirm(false)
              }}
            >
              {metadata.remotes.map((remote) => (
                <option key={remote.remoteId} value={remote.remoteId}>
                  {visibleGitText(remote.name)}
                </option>
              ))}
            </select>
          </label>
          <label>
            范围
            <select
              aria-label="PR 状态范围"
              value={listState}
              disabled={busy}
              onChange={(event) => setListState(event.target.value as 'open' | 'all')}
            >
              <option value="open">打开</option>
              <option value="all">全部</option>
            </select>
          </label>
          <button
            className="git-workbench-control"
            type="button"
            disabled={busy || !remoteId}
            onClick={() => void loadList()}
          >
            {busy ? '正在读取…' : list ? '刷新列表' : '查看 PR'}
          </button>
        </div>
        {error && (
          <p className="git-workbench-notice is-error" role="alert">
            {visibleGitText(error)}
          </p>
        )}
        {notice && (
          <p className="git-workbench-notice" role="status">
            {visibleGitText(notice)}
          </p>
        )}
        {list && (
          <p className="git-workbench-notice">
            {visibleGitText(list.repository)} · 登录账户：{visibleGitText(list.account)}
            {list.capped ? ' · 列表达到数量上限' : ''}
          </p>
        )}
        {list && (
          <div className="git-workbench-pr-layout">
            <nav aria-label="Pull Request 列表" className="git-workbench-pr-list">
              {!list.items.length && <p>当前范围没有 PR。</p>}
              {list.items.map((item) => (
                <button
                  className="git-workbench-pr-item"
                  type="button"
                  key={item.prId}
                  disabled={busy}
                  aria-pressed={detail?.number === item.number}
                  onClick={() => void loadDetail(item.prId)}
                >
                  <strong>
                    #{item.number} {visibleGitText(item.title)}
                  </strong>
                  <span>
                    {stateLabels[item.state]}
                    {item.draft ? ' · 草稿' : ''} · {visibleGitText(item.author)}
                  </span>
                </button>
              ))}
            </nav>
            <section className="git-workbench-pr-detail">
              {!detail ? (
                <p>选择 PR 查看详情和检查结果。</p>
              ) : (
                <>
                  <h3>
                    #{detail.number} {visibleGitText(detail.title)}
                  </h3>
                  <p>
                    {stateLabels[detail.state]}
                    {detail.draft ? ' · 草稿' : ''} · {visibleGitText(detail.headRefName)} →{' '}
                    {visibleGitText(detail.baseRefName)}
                  </p>
                  <p>
                    版本：{detail.headOid.slice(0, 7)} → {detail.baseOid.slice(0, 7)} ·{' '}
                    {detail.mergeable === 'CONFLICTING'
                      ? '存在冲突'
                      : detail.mergeable === 'MERGEABLE'
                        ? '可合并'
                        : '可合并性待确认'}{' '}
                    ({visibleGitText(detail.mergeStateStatus)})
                  </p>
                  <button
                    className="git-workbench-control"
                    type="button"
                    disabled={busy || confirm}
                    onClick={() => void loadDetail(detail.prId)}
                  >
                    刷新详情与检查
                  </button>
                  <div className="git-workbench-rich-markdown">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : '')}
                      components={{
                        img: ({ alt }) => <span>[图片：{visibleGitText(alt || '未加载')}]</span>,
                        a: ({ children, href }) =>
                          href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ) : (
                            <span>{children}</span>
                          )
                      }}
                    >
                      {visibleGitText(detail.body || '没有描述。')}
                    </Markdown>
                  </div>
                  <h4>检查结果</h4>
                  {!detail.checks.length ? (
                    <p>此 PR 没有检查结果。</p>
                  ) : (
                    <ul className="git-workbench-pr-checks">
                      {detail.checks.map((check, index) => (
                        <li key={index} data-status={check.status}>
                          <span>{visibleGitText(check.name)}</span>
                          <strong>{checkLabels[check.status]}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                  <a href={detail.url} target="_blank" rel="noopener noreferrer">
                    在 GitHub 查看
                  </a>
                  {detail.state === 'OPEN' && (
                    <div className="git-workbench-pr-merge">
                      <label>
                        合并方式{' '}
                        <select
                          aria-label="PR 合并方式"
                          value={method}
                          disabled={busy || confirm || !detail.mergeMethods.length}
                          onChange={(event) =>
                            setMethod(event.target.value as GitPullRequestMethod)
                          }
                        >
                          {detail.mergeMethods.map((candidate) => (
                            <option value={candidate} key={candidate}>
                              {candidate === 'merge' ? '创建合并提交 · Merge' : '压缩提交 · Squash'}
                            </option>
                          ))}
                        </select>
                      </label>
                      {!detail.mergeMethods.length && (
                        <p>当前 PR 不满足人工合并条件，请先核对草稿、冲突和检查状态。</p>
                      )}
                      {confirm ? (
                        <>
                          <p>
                            确认将 #{detail.number} 合并到 {visibleGitText(detail.baseRefName)}
                            ？将重新核对 PR 版本、账户和检查结果。
                          </p>
                          <div className="git-workbench-dialog-actions">
                            <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
                              取消
                            </button>
                            <button
                              type="button"
                              className="primary"
                              disabled={busy}
                              onClick={() => void merge()}
                            >
                              {busy ? '正在合并…' : '确认合并'}
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          className="git-workbench-control"
                          type="button"
                          disabled={busy || !detail.mergeMethods.includes(method)}
                          onClick={() => setConfirm(true)}
                        >
                          合并 PR…
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </dialog>
    </div>
  )
}
