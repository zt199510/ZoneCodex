import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { GitChangeItem, GitViewScope } from '../../../../shared/git-view'
import type {
  GitDiffData,
  GitFileAction,
  GitFullFileData,
  GitGeneratedText,
  GitGenerateRequest,
  GitMetadata,
  GitReviewFile,
  GitReviewSource,
  GitWorkbenchRequest
} from '../../../../shared/git-workbench'
import { Icon } from '../../components/ui/Icon'
import { highlightedCode } from '../files/source-highlight'
import '../../assets/git-workbench.css'
import { visibleGitText } from './git-presentation'
import type { GitViewState } from './useGitView'
import { useGitWorkbench } from './useGitWorkbench'
import { GitPullRequestDialog } from './GitPullRequestDialog'
import type { GitActionInput } from './useGitWorkbench'
import {
  loadGitWorkbenchPreferences,
  saveGitWorkbenchPreferences,
  validGitBranchPrefix
} from './git-workbench-preferences'
import type { GitWorkbenchPreferences } from './git-workbench-preferences'
import {
  diffWordSegments,
  expandWorkbenchDiff,
  parseWorkbenchDiff,
  searchDiffRows,
  splitHunkRows
} from './workbench-diff'
import type { WordSegment, WorkbenchDiffLine } from './workbench-diff'

const sources: { value: GitReviewSource; label: string; english: string }[] = [
  { value: 'branch', label: '分支比较', english: 'Branch' },
  { value: 'last-turn', label: '上一回合', english: 'Last Turn' },
  { value: 'uncommitted', label: '全部未提交', english: 'Uncommitted' },
  { value: 'unstaged', label: '未暂存', english: 'Unstaged' },
  { value: 'staged', label: '已暂存', english: 'Staged' },
  { value: 'commit', label: '已提交', english: 'Commits / Committed' }
]
const changes = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unmerged: '!',
  'type-changed': 'T',
  unknown: '?'
} as const
const actionLabels: Record<GitFileAction, string> = {
  stage: '暂存',
  unstage: '取消暂存',
  revert: '撤销'
}
type ManualAction =
  | 'commit'
  | 'commit-and-push'
  | 'create-branch'
  | 'checkout'
  | 'push'
  | 'fetch'
  | 'create-worktree'
  | 'remove-worktree'
  | 'create-pr'
const manualLabels: Record<ManualAction, string> = {
  commit: '提交改动',
  'commit-and-push': '提交并推送',
  'create-branch': '创建并切换分支',
  checkout: '切换分支',
  push: '推送',
  fetch: '获取远端更新',
  'create-worktree': '创建工作树',
  'remove-worktree': '删除工作树',
  'create-pr': '创建 Pull Request'
}
type RevertTarget = { itemIds: string[]; hunkIds?: string[]; paths: string[]; revision: string }
type Options = {
  mode: 'auto' | 'unified' | 'split'
  wrap: boolean
  words: boolean
  hideImports: boolean
  collapsed: boolean
  full: boolean
  rich: boolean
}
const previewLanguages: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  py: 'python',
  sh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  diff: 'diff'
}

function modalKeys(
  event: React.KeyboardEvent<HTMLDialogElement>,
  onCancel: () => void,
  busy: boolean
): void {
  if (event.key === 'Escape' && !busy) {
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'
    )
  ).filter((element) => element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function highlighted(text: string, query: string): React.ReactNode {
  const clean = visibleGitText(text)
  if (!query.trim()) return clean
  const needle = query.toLocaleLowerCase()
  const lower = clean.toLocaleLowerCase()
  const result: React.ReactNode[] = []
  let from = 0
  let found = lower.indexOf(needle)
  while (found >= 0) {
    if (found > from) result.push(clean.slice(from, found))
    result.push(<mark key={found}>{clean.slice(found, found + query.length)}</mark>)
    from = found + query.length
    found = lower.indexOf(needle, from)
  }
  if (from < clean.length) result.push(clean.slice(from))
  return result
}
function LineText({
  line,
  segments,
  query
}: {
  line: WorkbenchDiffLine
  segments?: WordSegment[]
  query: string
}): React.JSX.Element {
  return (
    <span className="git-workbench-line-text">
      {segments
        ? segments.map((segment, index) => (
            <span
              key={index}
              className={segment.changed ? `git-workbench-word is-${line.kind}` : undefined}
            >
              {highlighted(segment.text, query)}
            </span>
          ))
        : highlighted(line.text, query)}
      {!line.text && '\u00a0'}
    </span>
  )
}

function RichVersion({
  version,
  wrap
}: {
  version: GitFullFileData
  wrap: boolean
}): React.JSX.Element {
  const [page, setPage] = useState(0)
  const text = version.format === 'text' ? version.text : ''
  const lines = useMemo(() => text.split('\n'), [text])
  const pages = Math.max(1, Math.ceil(lines.length / 2000))
  const currentPage = Math.min(page, pages - 1)
  const extension = version.path.split('.').at(-1)?.toLowerCase() ?? ''
  const code = useMemo(
    () =>
      highlightedCode(
        visibleGitText(lines.slice(currentPage * 2000, (currentPage + 1) * 2000).join('\n')),
        previewLanguages[extension] ?? 'text'
      ),
    [lines, currentPage, extension]
  )
  const markdown = /^(md|mdx|markdown)$/.test(extension) && text.length <= 128 * 1024
  return (
    <section className="git-workbench-rich-version">
      <header>
        {version.side === 'base' ? '原文件' : '当前文件'} · {visibleGitText(version.path)}
      </header>
      {version.format === 'missing' ? (
        <div className="git-workbench-empty">此版本中没有该文件。</div>
      ) : version.format === 'binary' ? (
        <div className="git-workbench-empty">此二进制格式无法预览。</div>
      ) : version.format === 'image' ? (
        <div className="git-workbench-rich-image">
          <img
            src={`data:${version.mime};base64,${version.base64}`}
            alt={visibleGitText(version.path)}
          />
        </div>
      ) : markdown ? (
        <div className="git-workbench-rich-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : '')}
            components={{
              img: ({ alt }) => (
                <span className="git-workbench-muted">[图片：{alt || '未加载'}]</span>
              ),
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
            {visibleGitText(text)}
          </Markdown>
        </div>
      ) : (
        <>
          <pre className={`git-workbench-rich-code${wrap ? ' is-wrap' : ''}`} tabIndex={0}>
            <code>{code}</code>
          </pre>
          {pages > 1 && (
            <div className="git-workbench-status">
              <span>
                第 {currentPage + 1} / {pages} 段
              </span>
              <button
                type="button"
                disabled={!currentPage}
                onClick={() => setPage((value) => value - 1)}
              >
                上一段
              </button>
              <button
                type="button"
                disabled={currentPage + 1 >= pages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一段
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function RichPreview({
  files,
  split,
  wrap
}: {
  files: { base: GitFullFileData; current: GitFullFileData }
  split: boolean
  wrap: boolean
}): React.JSX.Element {
  const [side, setSide] = useState<'base' | 'current'>(
    files.current.format === 'missing' ? 'base' : 'current'
  )
  return (
    <div className="git-workbench-rich">
      {!split && (
        <div className="git-workbench-toolbar">
          {(['base', 'current'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={side === value}
              onClick={() => setSide(value)}
            >
              {value === 'base' ? '原文件' : '当前文件'}
            </button>
          ))}
        </div>
      )}
      <div className={`git-workbench-rich-content${split ? ' is-split' : ''}`}>
        {(split ? (['base', 'current'] as const) : [side]).map((value) => (
          <RichVersion key={value} version={files[value]} wrap={wrap} />
        ))}
      </div>
    </div>
  )
}

function DiffBody({
  detail,
  fullFiles,
  file,
  options,
  disabled,
  onAction
}: {
  detail: GitDiffData
  fullFiles: { base: GitFullFileData; current: GitFullFileData } | null
  file: GitReviewFile
  options: Options
  disabled: boolean
  onAction: (action: GitFileAction, hunkId?: string) => void
}): React.JSX.Element {
  const diff = useMemo(() => {
    const parsed = parseWorkbenchDiff(detail.text)
    if (!options.full || !fullFiles) return parsed
    const before = fullFiles.base.format === 'text' ? fullFiles.base.text : null
    const after = fullFiles.current.format === 'text' ? fullFiles.current.text : null
    return expandWorkbenchDiff(parsed, before, after)
  }, [detail.text, fullFiles, options.full])
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [matchLimit, setMatchLimit] = useState(250)
  const [page, setPage] = useState(0)
  const [closedHunks, setClosedHunks] = useState<Set<string>>(() => new Set())
  const scroll = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(true)
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element) return
    const observer = new ResizeObserver(() => setNarrow(element.clientWidth < 600))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const matches = useMemo(() => searchDiffRows(diff, query, matchLimit), [diff, query, matchLimit])
  const activeMatch = matches.matches[matchIndex % Math.max(1, matches.matches.length)]
  const size = 2000
  const rowCount = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  const pageCount = Math.max(1, Math.ceil(rowCount / size))
  const pageStart = Math.min(page, pageCount - 1) * size
  const pageEnd = pageStart + size
  const split =
    options.mode === 'split' ||
    (options.mode === 'auto' && !narrow && file.additions > 0 && file.deletions > 0)
  const navigateMatch = (step: number): void => {
    if (!matches.matches.length) return
    const next = (matchIndex + step + matches.matches.length) % matches.matches.length
    setMatchIndex(next)
    const match = matches.matches[next]
    let row = 0
    for (const hunk of diff.hunks) {
      const index = hunk.lines.findIndex((line) => line.key === match.lineKey)
      if (index >= 0) {
        row += index
        break
      }
      row += hunk.lines.length
    }
    setPage(Math.floor(row / size))
    setClosedHunks((previous) => {
      const next = new Set(previous)
      next.delete(match.hunkKey)
      return next
    })
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        scroll.current
          ?.querySelector('[data-current-match="true"]')
          ?.scrollIntoView({ block: 'center', behavior: 'instant' })
      )
    )
  }
  const ranges = useMemo(() => {
    const result: { start: number; end: number }[] = []
    let start = 0
    for (const hunk of diff.hunks) {
      const end = start + hunk.lines.length
      result.push({ start, end })
      start = end
    }
    return result
  }, [diff])
  const shown = diff.hunks.map((hunk, index) => {
    const { start, end } = ranges[index]
    if (end <= pageStart || start >= pageEnd) return null
    const complete = start >= pageStart && end <= pageEnd
    const lines = hunk.lines.slice(Math.max(0, pageStart - start), Math.max(0, pageEnd - start))
    const hidesRows =
      options.hideImports &&
      lines.some((line) =>
        /^\s*(?:import\b|from\s+\S+\s+import\b|(?:const|let|var)\s+.*?\brequire\s*\()/.test(
          line.text
        )
      )
    const visible = options.hideImports
      ? lines.filter(
          (line) =>
            !/^\s*(?:import\b|from\s+\S+\s+import\b|(?:const|let|var)\s+.*?\brequire\s*\()/.test(
              line.text
            )
        )
      : lines
    const original = hunk.sourceHunkIndex === null ? null : detail.hunks[hunk.sourceHunkIndex]
    const hunkId = original?.header === hunk.header ? original.hunkId : undefined
    const collapsed = options.collapsed || closedHunks.has(hunk.key)
    const pairs = splitHunkRows({ ...hunk, lines: visible })
    const wordMap = new Map<string, WordSegment[]>()
    if (options.words)
      for (const pair of pairs) {
        if (pair.before?.kind === 'deleted' && pair.after?.kind === 'added') {
          const segments = diffWordSegments(pair.before.text, pair.after.text)
          wordMap.set(pair.before.key, segments.before)
          wordMap.set(pair.after.key, segments.after)
        }
      }
    return (
      <section className="git-workbench-hunk" key={hunk.key} data-hunk-id={hunkId}>
        <div className="git-workbench-hunk-header">
          <button
            className="icon-button"
            type="button"
            title={collapsed ? '展开差异块' : '折叠差异块'}
            aria-label={collapsed ? '展开差异块' : '折叠差异块'}
            disabled={options.collapsed}
            onClick={() =>
              setClosedHunks((previous) => {
                const next = new Set(previous)
                if (next.has(hunk.key)) next.delete(hunk.key)
                else next.add(hunk.key)
                return next
              })
            }
          >
            <Icon
              name="chevron"
              size={12}
              style={{ transform: collapsed ? undefined : 'rotate(90deg)' }}
            />
          </button>
          <code>{visibleGitText(hunk.header)}</code>
          {(!complete || hidesRows) && <small>部分行已隐藏</small>}
          {hunk.sourceHunkIndex !== null &&
            (hunkId ? (original?.actions ?? []) : []).map((action) => (
              <button
                key={action}
                type="button"
                className="git-workbench-control"
                disabled={disabled || !hunkId || !complete || hidesRows || detail.binary}
                title={
                  !complete || hidesRows
                    ? '先显示此差异块的全部行，再操作差异块。'
                    : `${actionLabels[action]}此差异块`
                }
                onClick={() => onAction(action, hunkId)}
              >
                {actionLabels[action]}
              </button>
            ))}
          {hunkId && original?.actions.length === 0 && file.actions.length > 0 && (
            <small>请使用文件操作</small>
          )}
        </div>
        {!collapsed && (
          <div className="git-workbench-lines">
            {split
              ? pairs.map((pair) => (
                  <div
                    key={pair.key}
                    className={`git-workbench-split-row${activeMatch && [pair.before?.key, pair.after?.key].includes(activeMatch.lineKey) ? ' is-search-current' : ''}`}
                    data-current-match={
                      !!activeMatch &&
                      [pair.before?.key, pair.after?.key].includes(activeMatch.lineKey)
                    }
                  >
                    {(['before', 'after'] as const).map((side) => {
                      const line = pair[side]
                      return (
                        <div
                          key={side}
                          className={`git-workbench-split-cell${line ? ` is-${line.kind}` : ''}`}
                          data-side={side}
                        >
                          <span className="git-workbench-line-number">
                            {side === 'before' ? line?.oldLine : line?.newLine}
                          </span>
                          <span className="git-workbench-line-sign">
                            {line?.kind === 'added' ? '+' : line?.kind === 'deleted' ? '−' : ''}
                          </span>
                          {line && (
                            <LineText line={line} segments={wordMap.get(line.key)} query={query} />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ))
              : visible.map((line) => (
                  <div
                    key={line.key}
                    className={`git-workbench-line git-diff-line is-${line.kind}${activeMatch?.lineKey === line.key ? ' is-search-current' : ''}`}
                    data-line={line.newLine ?? line.oldLine}
                    data-current-match={activeMatch?.lineKey === line.key}
                  >
                    <span className="git-workbench-line-number">{line.oldLine}</span>
                    <span className="git-workbench-line-number">{line.newLine}</span>
                    <span className="git-workbench-line-sign">
                      {line.kind === 'added' ? '+' : line.kind === 'deleted' ? '−' : ''}
                    </span>
                    <LineText line={line} segments={wordMap.get(line.key)} query={query} />
                  </div>
                ))}
          </div>
        )}
      </section>
    )
  })
  return (
    <>
      <div className="git-workbench-search">
        <Icon name="search" size={13} />
        <input
          aria-label="在差异中查找"
          placeholder="在差异中查找…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setMatchIndex(0)
            setMatchLimit(250)
          }}
        />
        <span>
          {query &&
            `${matches.matches.length ? (matchIndex % matches.matches.length) + 1 : 0} / ${matches.total}`}
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="上一个匹配"
          disabled={!matches.matches.length}
          onClick={() => navigateMatch(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="下一个匹配"
          disabled={!matches.matches.length}
          onClick={() => navigateMatch(1)}
        >
          ↓
        </button>
        {matches.capped && (
          <button
            type="button"
            className="git-workbench-control"
            onClick={() => setMatchLimit((value) => value + 250)}
          >
            加载更多匹配
          </button>
        )}
      </div>
      <div
        className={`git-workbench-diff git-diff-scroll${options.wrap ? ' is-wrap' : ''}`}
        ref={scroll}
        tabIndex={0}
        aria-label="Git 差异内容"
        data-diff-mode={split ? 'split' : 'unified'}
      >
        {detail.binary || diff.binary ? (
          <div className="git-workbench-empty">
            <strong>二进制文件</strong>
            <p>二进制文件的文本差异不可显示。</p>
          </div>
        ) : diff.renameOnly && !options.full ? (
          <div className="git-workbench-empty">
            <strong>文件重命名，内容未变</strong>
          </div>
        ) : !diff.hunks.length ? (
          <div className="git-workbench-empty">
            <strong>没有文本差异</strong>
            {diff.metadata.length > 0 && (
              <pre className="git-workbench-diff-meta">
                {visibleGitText(diff.metadata.join('\n'))}
              </pre>
            )}
          </div>
        ) : (
          <>
            {diff.metadata.length > 0 && (
              <details>
                <summary className="git-workbench-control">差异信息</summary>
                <pre className="git-workbench-diff-meta">
                  {visibleGitText(diff.metadata.join('\n'))}
                </pre>
              </details>
            )}
            {shown}
          </>
        )}
      </div>
      {pageCount > 1 && (
        <div className="git-workbench-status">
          <span>
            此文件较大，分段显示 · {page + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="git-workbench-control"
            disabled={page === 0}
            onClick={() => {
              setPage((value) => value - 1)
              scroll.current?.scrollTo(0, 0)
            }}
          >
            上一段
          </button>
          <button
            type="button"
            className="git-workbench-control"
            disabled={page >= pageCount - 1}
            onClick={() => {
              setPage((value) => value + 1)
              scroll.current?.scrollTo(0, 0)
            }}
          >
            下一段
          </button>
        </div>
      )}
    </>
  )
}

function FileTree({
  files,
  selectedItemId,
  viewed,
  disabled,
  onRead
}: {
  files: GitReviewFile[]
  selectedItemId: string | null
  viewed: Set<string>
  disabled: boolean
  onRead: (file: GitReviewFile) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const rows = useMemo(() => {
    const result: (
      | { kind: 'folder'; path: string; name: string; depth: number }
      | { kind: 'file'; file: GitReviewFile; name: string; depth: number }
    )[] = []
    const seen = new Set<string>()
    const matching = files
      .filter((file) => file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
      .sort((left, right) => left.path.localeCompare(right.path))
    for (const file of matching) {
      const parts = file.path.split('/')
      let hidden = false
      for (let i = 0; i < parts.length - 1; i += 1) {
        const path = parts.slice(0, i + 1).join('/')
        if (!seen.has(path)) {
          seen.add(path)
          result.push({ kind: 'folder', path, name: parts[i], depth: i })
        }
        if (!filter && folded.has(path)) {
          hidden = true
          break
        }
      }
      if (!hidden)
        result.push({
          kind: 'file',
          file,
          name: parts.at(-1) ?? file.path,
          depth: parts.length - 1
        })
    }
    return result
  }, [files, filter, folded])
  return (
    <div className="git-workbench-tree" aria-label="改动文件树">
      <label className="git-workbench-filter">
        <Icon name="search" size={13} />
        <input
          aria-label="筛选改动文件"
          placeholder="筛选文件…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter && (
          <button
            type="button"
            className="icon-button"
            aria-label="清除文件筛选"
            onClick={() => setFilter('')}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </label>
      <div className="git-workbench-tree-items" role="tree">
        {rows.map((row) =>
          row.kind === 'folder' ? (
            <button
              key={row.path}
              type="button"
              role="treeitem"
              aria-expanded={!folded.has(row.path) || !!filter}
              className="git-workbench-tree-row git-workbench-tree-folder"
              style={{ paddingLeft: 8 + row.depth * 11 }}
              onClick={() =>
                setFolded((previous) => {
                  const next = new Set(previous)
                  if (next.has(row.path)) next.delete(row.path)
                  else next.add(row.path)
                  return next
                })
              }
            >
              <Icon
                name="chevron"
                size={10}
                style={{ transform: folded.has(row.path) && !filter ? undefined : 'rotate(90deg)' }}
              />
              <Icon name="folder" size={12} />
              <span className="git-workbench-tree-name">{visibleGitText(row.name)}</span>
            </button>
          ) : (
            <button
              key={row.file.path}
              type="button"
              role="treeitem"
              aria-selected={selectedItemId === row.file.itemId}
              aria-pressed={selectedItemId === row.file.itemId}
              className={`git-workbench-tree-row git-change-item${viewed.has(row.file.path) ? ' is-viewed' : ''}`}
              style={{ paddingLeft: 8 + row.depth * 11 }}
              data-item-id={row.file.itemId}
              data-path={row.file.path}
              disabled={disabled}
              title={visibleGitText(
                row.file.previousPath
                  ? `${row.file.previousPath} → ${row.file.path}`
                  : row.file.path
              )}
              onClick={() => onRead(row.file)}
            >
              <Icon name={viewed.has(row.file.path) ? 'check' : 'file'} size={12} />
              <span className="git-workbench-tree-name">{visibleGitText(row.name)}</span>
              <span className="git-workbench-tree-kind">{changes[row.file.change]}</span>
              {row.file.additions > 0 && (
                <span className="git-workbench-stat-added">+{row.file.additions}</span>
              )}
              {row.file.deletions > 0 && (
                <span className="git-workbench-stat-deleted">−{row.file.deletions}</span>
              )}
            </button>
          )
        )}
        {rows.length === 0 && (
          <p className="git-workbench-notice">{filter ? '没有匹配文件' : '没有改动文件'}</p>
        )}
      </div>
    </div>
  )
}

function ActionDialog({
  mode,
  metadata,
  busy,
  generating,
  error,
  onCancel,
  onExecute,
  onCommit,
  onGenerate,
  generationCapability,
  preferences
}: {
  mode: ManualAction
  metadata: GitMetadata
  busy: boolean
  generating: boolean
  error: string
  onCancel: () => void
  onExecute: (action: GitActionInput, revision: string) => Promise<boolean>
  onCommit: () => void
  onGenerate: (
    options: Omit<GitGenerateRequest, keyof GitWorkbenchRequest | 'revision'>
  ) => Promise<GitGeneratedText | null>
  generationCapability: { available: boolean; reason: string }
  preferences: GitWorkbenchPreferences
}): React.JSX.Element {
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null)
  const pushes = mode === 'push' || mode === 'commit-and-push'
  const [message, setMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(false)
  const [authorName, setAuthorName] = useState('')
  const [authorEmail, setAuthorEmail] = useState('')
  const [name, setName] = useState('')
  const [refId, setRefId] = useState(
    metadata.branches.find((branch) =>
      mode === 'checkout' ? !branch.current && !branch.remote : branch.current
    )?.refId ??
      metadata.branches[0]?.refId ??
      ''
  )
  const [remoteId, setRemoteId] = useState(
    metadata.remotes.find((remote) => (pushes ? remote.pushable : true))?.remoteId ?? ''
  )
  const [worktreeId, setWorktreeId] = useState(
    metadata.worktrees.find((worktree) => !worktree.current && !worktree.locked)?.worktreeId ?? ''
  )
  const [forceWithLease, setForceWithLease] = useState(preferences.forceWithLease)
  const [draft, setDraft] = useState(preferences.draftPR)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [localError, setLocalError] = useState('')
  const isCommit = mode === 'commit' || mode === 'commit-and-push'
  const [guidance, setGuidance] = useState(
    isCommit ? preferences.commitGuidance : preferences.prGuidance
  )
  useLayoutEffect(() => {
    first.current?.focus({ preventScroll: true })
  }, [])
  const chosenWorktree = metadata.worktrees.find((worktree) => worktree.worktreeId === worktreeId)
  const generate = async (): Promise<void> => {
    setLocalError('')
    const candidate = await onGenerate({
      purpose: isCommit ? 'commit' : 'pr',
      ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
      ...(isCommit ? { includeUnstaged } : refId ? { baseRefId: refId } : {})
    })
    if (!candidate) return
    if (isCommit) setMessage(candidate.subject + (candidate.body ? `\n\n${candidate.body}` : ''))
    else {
      setTitle(candidate.subject)
      setBody(candidate.body)
    }
  }
  const submit = async (): Promise<void> => {
    setLocalError('')
    let action: GitActionInput
    if (isCommit) {
      if (!message.trim()) {
        setLocalError('请填写提交说明。')
        return
      }
      const commit = {
        message,
        includeUnstaged,
        ...(authorName.trim() ? { authorName: authorName.trim() } : {}),
        ...(authorEmail.trim() ? { authorEmail: authorEmail.trim() } : {})
      }
      action =
        mode === 'commit-and-push'
          ? { ...commit, action: 'commit-and-push', remoteId, forceWithLease }
          : { ...commit, action: 'commit' }
    } else if (mode === 'create-branch') {
      if (!name.trim()) {
        setLocalError('请填写分支名称。')
        return
      }
      action = {
        action: mode,
        name: name.trim().startsWith(preferences.branchPrefix)
          ? name.trim()
          : preferences.branchPrefix + name.trim()
      }
    } else if (mode === 'checkout') {
      if (!refId) return
      action = { action: mode, refId }
    } else if (mode === 'push') {
      if (!remoteId) return
      action = { action: mode, remoteId, forceWithLease }
    } else if (mode === 'fetch') {
      if (!remoteId) return
      action = { action: mode, remoteId }
    } else if (mode === 'create-worktree') {
      if (!name.trim() || !refId) {
        setLocalError('请填写目录名并选择分支。')
        return
      }
      action = { action: mode, name: name.trim(), refId, branchPrefix: preferences.branchPrefix }
    } else if (mode === 'remove-worktree') {
      if (!worktreeId) return
      action = { action: mode, worktreeId }
    } else {
      if (!title.trim() || !refId) {
        setLocalError('请填写标题并选择目标分支。')
        return
      }
      action = { action: 'create-pr', title: title.trim(), body, draft, baseRefId: refId }
    }
    if (await onExecute(action, metadata.revision)) onCancel()
  }
  const branchSelect = (
    <label>
      分支
      <select
        ref={
          mode === 'checkout'
            ? (element) => {
                first.current = element
              }
            : undefined
        }
        value={refId}
        onChange={(event) => setRefId(event.target.value)}
      >
        {metadata.branches
          .filter((branch) => mode !== 'checkout' || !branch.current)
          .map((branch) => (
            <option key={branch.refId} value={branch.refId}>
              {branch.name}
              {branch.remote ? '（远端）' : ''}
            </option>
          ))}
      </select>
    </label>
  )
  const remoteSelect = (
    <label>
      远端
      <select
        ref={(element) => {
          first.current = element
        }}
        value={remoteId}
        onChange={(event) => setRemoteId(event.target.value)}
      >
        {metadata.remotes.map((remote) => (
          <option
            key={remote.remoteId}
            value={remote.remoteId}
            disabled={pushes && !remote.pushable}
          >
            {remote.name}
            {remote.reason ? ` · ${remote.reason}` : ''}
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="git-workbench-dialog-backdrop">
      <dialog
        open
        className="git-workbench-dialog"
        aria-modal="true"
        aria-label={manualLabels[mode]}
        onKeyDown={(event) => modalKeys(event, onCancel, busy && !generating)}
      >
        <h3>{manualLabels[mode]}</h3>
        <form
          className="git-workbench-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <fieldset disabled={busy} className="git-workbench-form-fields">
            {isCommit && (
              <>
                <label>
                  提交说明
                  <textarea
                    ref={(element) => {
                      first.current = element
                    }}
                    value={message}
                    maxLength={64000}
                    placeholder="描述本次改动…"
                    onChange={(event) => setMessage(event.target.value)}
                    required
                  />
                </label>
                <label className="is-checkbox">
                  <input
                    type="checkbox"
                    checked={includeUnstaged}
                    onChange={(event) => setIncludeUnstaged(event.target.checked)}
                  />
                  包含未暂存改动
                </label>
                <button
                  type="button"
                  className="git-workbench-control"
                  disabled={busy || !generationCapability.available}
                  title={
                    generationCapability.available
                      ? '根据当前改动生成可编辑的提交说明'
                      : generationCapability.reason
                  }
                  onClick={() => void generate()}
                >
                  <Icon name="spark" size={13} />
                  生成提交说明
                </button>
                <details>
                  <summary>提交作者（仓库未配置时填写）</summary>
                  <label>
                    姓名
                    <input
                      value={authorName}
                      maxLength={200}
                      onChange={(event) => setAuthorName(event.target.value)}
                    />
                  </label>
                  <label>
                    邮件
                    <input
                      type="email"
                      value={authorEmail}
                      maxLength={254}
                      onChange={(event) => setAuthorEmail(event.target.value)}
                    />
                  </label>
                </details>
              </>
            )}
            {mode === 'create-branch' && (
              <label>
                分支名称
                <input
                  ref={(element) => {
                    first.current = element
                  }}
                  value={name}
                  maxLength={240}
                  placeholder={`${preferences.branchPrefix}new-branch`}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
            )}
            {mode === 'checkout' && (
              <>
                {branchSelect}
                <p>切换将更新工作目录。若会覆盖未提交改动，请先提交后重试。</p>
                <button
                  type="button"
                  className="git-workbench-control"
                  disabled={busy}
                  onClick={onCommit}
                >
                  先提交改动…
                </button>
              </>
            )}
            {(pushes || mode === 'fetch') && (
              <>
                {remoteSelect}
                <p>
                  {pushes
                    ? '将当前分支推送到所选远端。'
                    : '获取所选远端的分支和对象，不合并当前工作目录。'}
                </p>
                {pushes && (
                  <label className="is-checkbox">
                    <input
                      type="checkbox"
                      checked={forceWithLease}
                      onChange={(event) => setForceWithLease(event.target.checked)}
                    />
                    使用 force-with-lease
                  </label>
                )}
              </>
            )}
            {mode === 'create-worktree' && (
              <>
                <label>
                  新工作树目录名
                  <input
                    ref={(element) => {
                      first.current = element
                    }}
                    value={name}
                    maxLength={120}
                    placeholder="new-worktree"
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </label>
                {branchSelect}
                <p>继续后选择父目录，在独立工作树中检出所选分支。</p>
              </>
            )}
            {mode === 'remove-worktree' && (
              <>
                <label>
                  工作树
                  <select
                    ref={(element) => {
                      first.current = element
                    }}
                    value={worktreeId}
                    onChange={(event) => setWorktreeId(event.target.value)}
                  >
                    {metadata.worktrees
                      .filter((worktree) => !worktree.current && !worktree.locked)
                      .map((worktree) => (
                        <option key={worktree.worktreeId} value={worktree.worktreeId}>
                          {worktree.branch ?? 'Detached HEAD'} · {worktree.path}
                        </option>
                      ))}
                  </select>
                </label>
                <p>删除所选工作树目录及其登记。操作只接受干净且未锁定的工作树。</p>
                {chosenWorktree && (
                  <div className="git-workbench-dialog-paths">
                    {visibleGitText(chosenWorktree.path)}
                  </div>
                )}
              </>
            )}
            {mode === 'create-pr' && (
              <>
                <label>
                  标题
                  <input
                    ref={(element) => {
                      first.current = element
                    }}
                    value={title}
                    maxLength={256}
                    onChange={(event) => setTitle(event.target.value)}
                    required
                  />
                </label>
                <label>
                  说明
                  <textarea
                    value={body}
                    maxLength={64000}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
                {branchSelect}
                <label className="is-checkbox">
                  <input
                    type="checkbox"
                    checked={draft}
                    onChange={(event) => setDraft(event.target.checked)}
                  />
                  创建为草稿
                </label>
                <p>使用当前主机已登录的 GitHub CLI 创建 Pull Request。</p>
                <button
                  type="button"
                  className="git-workbench-control"
                  disabled={busy || !refId || !generationCapability.available}
                  title={
                    generationCapability.available
                      ? '根据分支改动生成可编辑的标题和说明'
                      : generationCapability.reason
                  }
                  onClick={() => void generate()}
                >
                  <Icon name="spark" size={13} />
                  生成 PR 内容
                </button>
              </>
            )}
            {(isCommit || mode === 'create-pr') && (
              <details>
                <summary>生成指导（可选）</summary>
                <label>
                  写作要求
                  <textarea
                    value={guidance}
                    maxLength={4000}
                    placeholder="例如：用中文，说明改动原因…"
                    onChange={(event) => setGuidance(event.target.value)}
                  />
                </label>
                <p>生成后可编辑内容，再由你确认提交或创建。</p>
              </details>
            )}
          </fieldset>
          {(localError || error) && (
            <p className="git-workbench-notice is-error" role="alert">
              {visibleGitText(localError || error)}
            </p>
          )}
          <div className="git-workbench-dialog-actions">
            <button type="button" disabled={busy && !generating} onClick={onCancel}>
              {generating ? '停止生成' : '取消'}
            </button>
            <button
              className={mode === 'remove-worktree' ? 'danger' : 'primary'}
              type="submit"
              disabled={
                busy ||
                ((pushes || mode === 'fetch') && !remoteId) ||
                (mode === 'remove-worktree' && !worktreeId) ||
                (['checkout', 'create-worktree', 'create-pr'].includes(mode) && !refId)
              }
            >
              {busy ? '正在处理…' : manualLabels[mode]}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

function GitSettingsDialog({
  preferences,
  onSave,
  onCancel
}: {
  preferences: GitWorkbenchPreferences
  onSave: (value: GitWorkbenchPreferences) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(preferences)
  const [error, setError] = useState('')
  const first = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => first.current?.focus({ preventScroll: true }), [])
  return (
    <div className="git-workbench-dialog-backdrop">
      <dialog
        open
        className="git-workbench-dialog"
        aria-modal="true"
        aria-label="Git 设置"
        onKeyDown={(event) => modalKeys(event, onCancel, false)}
      >
        <h3>Git 设置</h3>
        <form
          className="git-workbench-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!validGitBranchPrefix(draft.branchPrefix)) {
              setError('分支前缀请以 / 结尾，或留空。')
              return
            }
            onSave(draft)
          }}
        >
          <label>
            分支前缀
            <input
              ref={first}
              value={draft.branchPrefix}
              maxLength={100}
              placeholder="codex/"
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, branchPrefix: event.target.value }))
              }
            />
          </label>
          <label className="is-checkbox">
            <input
              type="checkbox"
              checked={draft.forceWithLease}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, forceWithLease: event.target.checked }))
              }
            />
            推送默认使用 force-with-lease
          </label>
          <label className="is-checkbox">
            <input
              type="checkbox"
              checked={draft.draftPR}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, draftPR: event.target.checked }))
              }
            />
            Pull Request 默认创建为草稿
          </label>
          <label>
            PR 默认合并方式
            <select
              aria-label="默认 PR 合并方式"
              value={draft.mergeMethod}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  mergeMethod: event.target.value as 'merge' | 'squash'
                }))
              }
            >
              <option value="squash">压缩提交 · Squash</option>
              <option value="merge">创建合并提交 · Merge</option>
            </select>
          </label>
          <label>
            提交说明生成指导
            <textarea
              value={draft.commitGuidance}
              maxLength={4000}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, commitGuidance: event.target.value }))
              }
            />
          </label>
          <label>
            PR 内容生成指导
            <textarea
              value={draft.prGuidance}
              maxLength={4000}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, prGuidance: event.target.value }))
              }
            />
          </label>
          <p>默认值应用于下次打开的操作窗口，可在确认前修改。</p>
          {error && (
            <p className="git-workbench-notice is-error" role="alert">
              {error}
            </p>
          )}
          <div className="git-workbench-dialog-actions">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            <button type="submit" className="primary">
              保存
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

export function GitWorkbenchPanel({
  state: view,
  cleanupError,
  directoryDisabled,
  onSelectDirectory,
  onAdoptView,
  onClose,
  active = true,
  onBusyChange,
  requestedFile
}: {
  state: GitViewState
  cleanupError: string
  directoryDisabled: boolean
  onSelectDirectory: () => Promise<void>
  onAdoptView?: (view: GitViewScope) => void
  onRefresh: () => Promise<void>
  onReadItem?: (item: GitChangeItem) => Promise<void>
  onClose: () => void
  active?: boolean
  onBusyChange?: (viewId: string, busy: boolean) => void
  requestedFile?: { source: GitReviewSource; path: string; nonce: string } | null
}): React.JSX.Element | null {
  const [options, setOptions] = useState<Options>({
    mode: 'auto',
    wrap: false,
    words: true,
    hideImports: false,
    collapsed: false,
    full: false,
    rich: false
  })
  const [showTree, setShowTree] = useState(true)
  const [treeWidth, setTreeWidth] = useState(190)
  const treeResizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => treeResizeCleanup.current?.(), [])
  const [maximized, setMaximized] = useState(false)
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  const [revert, setRevert] = useState<RevertTarget | null>(null)
  const [skipRevertConfirmation, setSkipRevertConfirmation] = useState(false)
  const [manual, setManual] = useState<ManualAction | null>(null)
  const [clipboardNotice, setClipboardNotice] = useState('')
  const [preferences, setPreferences] = useState<GitWorkbenchPreferences>(() => {
    try {
      return loadGitWorkbenchPreferences(window.localStorage)
    } catch {
      return loadGitWorkbenchPreferences()
    }
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prOpen, setPrOpen] = useState(false)
  const [initializing, setInitializing] = useState(false)
  const refreshPaused = !!revert || !!manual || settingsOpen || prOpen || initializing
  const workbench = useGitWorkbench(view, refreshPaused || directoryDisabled, active)
  const { state, readFullFiles } = workbench
  const [initializationNotice, setInitializationNotice] = useState('')
  const initialization = useRef<{ mounted: boolean; requestId: string | null }>({
    mounted: false,
    requestId: null
  })
  useEffect(() => {
    const record = initialization.current
    record.mounted = true
    return () => {
      record.mounted = false
      const requestId = record.requestId
      record.requestId = null
      if (requestId) void window.api.cancelGitRead(requestId).catch(() => undefined)
    }
  }, [])
  const close = useRef<HTMLButtonElement>(null)
  const toolbarMenu = useRef<HTMLDetailsElement>(null)
  const actionMenu = useRef<HTMLDetailsElement>(null)
  const refreshRunning = useRef(false)
  useLayoutEffect(() => {
    if (view.open && active) close.current?.focus({ preventScroll: true })
  }, [view.open, active])
  const files = useMemo(() => state.review?.files ?? [], [state.review])
  const file = files.find((candidate) => candidate.itemId === state.selectedItemId)
  useEffect(() => {
    if (
      (options.full || options.rich) &&
      file &&
      state.detail?.itemId === file.itemId &&
      !state.fullFiles &&
      !state.busy &&
      !state.notice
    )
      void readFullFiles(file)
  }, [
    options.full,
    options.rich,
    file,
    state.detail,
    state.fullFiles,
    state.busy,
    state.notice,
    readFullFiles
  ])
  const requested = useRef<string | null>(null)
  useEffect(() => {
    if (!active || !requestedFile || requested.current === requestedFile.nonce || state.busy) return
    if (state.source !== requestedFile.source) {
      void workbench.selectSource(requestedFile.source)
      return
    }
    const target = files.find((candidate) => candidate.path === requestedFile.path)
    if (!target) return
    requested.current = requestedFile.nonce
    void workbench.readFile(target)
  }, [active, requestedFile, state.busy, state.source, files, workbench])
  useEffect(() => {
    if (view.view) onBusyChange?.(view.view.viewId, !!state.busy || refreshPaused)
  }, [view.view, state.busy, refreshPaused, onBusyChange])
  const resizeTree = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    treeResizeCleanup.current?.()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const initial = treeWidth
    const max = (event.currentTarget.closest('.git-workbench-body')?.clientWidth ?? 600) * 0.45
    const move = (pointer: PointerEvent): void =>
      setTreeWidth(Math.max(120, Math.min(max, initial + startX - pointer.clientX)))
    const stop = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      treeResizeCleanup.current = null
    }
    treeResizeCleanup.current = stop
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop, { once: true })
    document.addEventListener('pointercancel', stop, { once: true })
  }
  const disabled = !!state.busy || initializing || view.phase !== 'ready' || directoryDisabled
  const writeDisabled = disabled || !!cleanupError
  const stats = files.reduce(
    (sum, item) => ({ added: sum.added + item.additions, deleted: sum.deleted + item.deletions }),
    { added: 0, deleted: 0 }
  )
  const closeMenus = (): void => {
    if (toolbarMenu.current) toolbarMenu.current.open = false
    if (actionMenu.current) actionMenu.current.open = false
  }
  const refresh = async (): Promise<void> => {
    if (refreshRunning.current || writeDisabled) return
    refreshRunning.current = true
    closeMenus()
    try {
      await workbench.refresh()
    } finally {
      refreshRunning.current = false
    }
  }
  const act = (action: GitFileAction, itemIds: string[], hunkIds?: string[]): void => {
    const review = state.review
    if (!review || writeDisabled || !itemIds.length) return
    closeMenus()
    if (action === 'revert' && !skipRevertConfirmation) {
      setRevert({
        itemIds: [...itemIds],
        ...(hunkIds ? { hunkIds: [...hunkIds] } : {}),
        revision: review.revision,
        paths: itemIds.map((id) => files.find((item) => item.itemId === id)?.path ?? '')
      })
    } else
      void workbench.execute({ action, itemIds, ...(hunkIds ? { hunkIds } : {}) }, review.revision)
  }
  const copyPatch = async (): Promise<void> => {
    closeMenus()
    if (!state.detail || state.detail.binary) return
    let marker = `ZONECODEX_DIFF_${crypto.randomUUID().replace(/-/g, '')}`
    while (state.detail.text.split('\n').includes(marker)) marker += '_'
    try {
      await navigator.clipboard.writeText(
        `git apply --3way <<'${marker}'\n${state.detail.text}${state.detail.text.endsWith('\n') ? '' : '\n'}${marker}\n`
      )
      setClipboardNotice('已复制当前文件的 git apply 命令。')
    } catch {
      setClipboardNotice('无法写入剪贴板，请重试。')
    }
  }
  const showManual = (mode: ManualAction): void => {
    closeMenus()
    if (!writeDisabled && workbench.capability(mode).available) setManual(mode)
  }
  const initializeRepository = async (): Promise<void> => {
    if (!onAdoptView || initializing || directoryDisabled || state.busy || cleanupError) return
    const requestId = crypto.randomUUID()
    initialization.current.requestId = requestId
    setInitializing(true)
    setInitializationNotice('')
    try {
      const result = await window.api.initializeGitRepository(requestId)
      if (
        !initialization.current.mounted ||
        initialization.current.requestId !== requestId ||
        result.requestId !== requestId
      ) {
        if (result.status === 'ready') await window.api.releaseGitView(result.view.viewId)
        if (initialization.current.mounted)
          setInitializationNotice('初始化结果身份已变化，请重新选择目录。')
        return
      }
      if (result.status === 'ready') onAdoptView(result.view)
      else if (result.status !== 'cancelled') setInitializationNotice(result.error)
    } catch (error) {
      if (initialization.current.mounted)
        setInitializationNotice(
          error instanceof Error
            ? error.message.slice(0, 500)
            : '初始化未完成，请重新选择目录确认。'
        )
    } finally {
      if (initialization.current.requestId === requestId) initialization.current.requestId = null
      if (initialization.current.mounted) setInitializing(false)
    }
  }
  if (!view.open) return null
  return (
    <aside
      id={active ? 'git-panel' : undefined}
      className={`git-workbench${maximized ? ' is-maximized' : ''}`}
      aria-label="Git 改动查看"
    >
      <header className="git-workbench-header">
        <Icon name="code" size={16} />
        <strong>
          改动 <small>Changes</small>
        </strong>
        {state.metadata && (
          <button
            type="button"
            className="git-workbench-control"
            disabled={writeDisabled || !workbench.capability('checkout').available}
            title={workbench.capability('checkout').reason || '切换分支'}
            onClick={() => showManual('checkout')}
          >
            {visibleGitText(
              state.metadata.branch ?? (state.metadata.headSha ? 'Detached HEAD' : '尚无提交')
            )}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title={maximized ? '还原面板宽度' : '展开面板'}
          aria-label={maximized ? '还原面板宽度' : '展开面板'}
          onClick={() => setMaximized((value) => !value)}
        >
          <Icon name="panel" size={15} />
        </button>
        <button
          ref={close}
          id={active ? 'git-panel-close' : undefined}
          className="icon-button"
          type="button"
          aria-label="关闭 Git 查看"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="git-workbench-toolbar">
        <button
          id={active ? 'git-view-select' : undefined}
          type="button"
          className="git-workbench-control"
          disabled={directoryDisabled || initializing || !!state.busy || view.phase === 'selecting'}
          onClick={() => void onSelectDirectory()}
          title={view.view ? visibleGitText(view.view.selectedPath) : '选择仓库或子目录'}
        >
          <Icon name="folder" size={13} />
          {view.view ? '换目录' : '选择目录'}
        </button>
        {!view.view && (
          <button
            type="button"
            className="git-workbench-control"
            disabled={!onAdoptView || directoryDisabled || initializing || !!cleanupError}
            onClick={() => void initializeRepository()}
          >
            初始化仓库
          </button>
        )}
        <select
          id={active ? 'git-workbench-source' : undefined}
          aria-label="差异来源"
          disabled={disabled || !view.view}
          value={state.source}
          onChange={(event) => {
            closeMenus()
            void workbench.selectSource(event.target.value as GitReviewSource)
          }}
        >
          {sources.map((source) => (
            <option key={source.value} value={source.value}>
              {source.label} · {source.english}
            </option>
          ))}
        </select>
        <span className="git-workbench-spacer" />
        <button
          id={active ? 'git-view-refresh' : undefined}
          type="button"
          className="icon-button"
          title="刷新改动"
          aria-label="刷新改动"
          disabled={!view.view || disabled}
          onClick={() => void refresh()}
        >
          <Icon name="restore" size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={showTree ? '隐藏文件树' : '显示文件树'}
          aria-label={showTree ? '隐藏文件树' : '显示文件树'}
          aria-pressed={showTree}
          onClick={() => setShowTree((value) => !value)}
        >
          <Icon name="folder" size={14} />
        </button>
        <details className="git-workbench-menu" ref={toolbarMenu}>
          <summary aria-label="差异选项" title="差异选项">
            <Icon name="more" size={15} />
          </summary>
          <div className="git-workbench-menu-body">
            <label>
              差异布局
              <select
                aria-label="差异布局"
                value={options.mode}
                onChange={(event) =>
                  setOptions((previous) => ({
                    ...previous,
                    mode: event.target.value as Options['mode']
                  }))
                }
              >
                <option value="auto">Auto</option>
                <option value="unified">统一视图</option>
                <option value="split">并排视图</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.wrap}
                onChange={(event) =>
                  setOptions((previous) => ({ ...previous, wrap: event.target.checked }))
                }
              />
              自动换行
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.words}
                onChange={(event) =>
                  setOptions((previous) => ({ ...previous, words: event.target.checked }))
                }
              />
              字词差异
            </label>
            <label>
              <input
                type="checkbox"
                checked={state.hideWhitespace}
                disabled={disabled}
                onChange={(event) => void workbench.setHideWhitespace(event.target.checked)}
              />
              忽略空白
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.hideImports}
                onChange={(event) =>
                  setOptions((previous) => ({ ...previous, hideImports: event.target.checked }))
                }
              />
              隐藏导入行
            </label>
            <button
              type="button"
              onClick={() => {
                setOptions((previous) => ({ ...previous, collapsed: !previous.collapsed }))
                closeMenus()
              }}
            >
              {options.collapsed ? '展开全部差异' : '折叠全部差异'}
            </button>
            <hr />
            <button
              type="button"
              onClick={() => {
                closeMenus()
                setSettingsOpen(true)
              }}
            >
              Git 设置…
            </button>
            <button
              type="button"
              disabled={!state.detail || state.detail.binary || disabled}
              onClick={() => void copyPatch()}
            >
              复制 git apply 命令
            </button>
            <label>
              <input
                type="checkbox"
                checked={options.full}
                disabled={disabled}
                onChange={(event) =>
                  setOptions((previous) => ({ ...previous, full: event.target.checked }))
                }
              />
              完整文件
            </label>
            <label>
              <input
                type="checkbox"
                checked={options.rich}
                disabled={disabled}
                onChange={(event) =>
                  setOptions((previous) => ({ ...previous, rich: event.target.checked }))
                }
              />
              富预览
            </label>
          </div>
        </details>
        <details className="git-workbench-menu" ref={actionMenu}>
          <summary aria-label="Git 操作" title="Git 操作">
            <Icon name="code" size={15} />
          </summary>
          <div className="git-workbench-menu-body">
            {(Object.keys(manualLabels) as ManualAction[]).map((mode) => {
              const capability = workbench.capability(mode)
              return (
                <button
                  type="button"
                  key={mode}
                  disabled={writeDisabled || !capability.available}
                  title={capability.available ? manualLabels[mode] : capability.reason}
                  onClick={() => showManual(mode)}
                >
                  {manualLabels[mode]}
                </button>
              )
            })}
            <button
              type="button"
              disabled={writeDisabled || !state.metadata?.remotes.length}
              onClick={() => {
                closeMenus()
                setPrOpen(true)
              }}
            >
              查看 Pull Requests…
            </button>
            <hr />
            <small>操作由你发起。提交说明和 PR 内容可填写或点击生成。</small>
          </div>
        </details>
      </div>
      {view.view && (
        <div className="git-workbench-scope">
          <span title={visibleGitText(view.view.repositoryPath)}>
            仓库：{visibleGitText(view.view.repositoryPath)}
          </span>
          <span title={visibleGitText(view.view.selectedPath)}>
            范围：{visibleGitText(view.view.scopePath || '整个仓库')}
          </span>
          {state.metadata && (
            <span>
              ↑{state.metadata.ahead} ↓{state.metadata.behind}
            </span>
          )}
        </div>
      )}
      {state.source === 'branch' && state.metadata && (
        <div className="git-workbench-toolbar">
          <span>分支比较</span>
          <span>{visibleGitText(state.metadata.branch ?? 'HEAD')} →</span>
          <select
            aria-label="对比分支"
            value={state.baseRefId}
            disabled={disabled}
            onChange={(event) => void workbench.selectBase(event.target.value)}
          >
            {state.metadata.branches.map((branch) => (
              <option key={branch.refId} value={branch.refId}>
                {branch.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {state.source === 'commit' && state.metadata && (
        <div className="git-workbench-toolbar">
          <span>提交</span>
          <select
            aria-label="选择提交"
            value={state.commitId}
            disabled={disabled}
            onChange={(event) => void workbench.selectCommit(event.target.value)}
          >
            {state.metadata.commits.map((commit) => (
              <option key={commit.commitId} value={commit.commitId}>
                {commit.sha.slice(0, 7)} · {commit.subject}
              </option>
            ))}
          </select>
          {!state.metadata.commits.length && (
            <span className="git-workbench-muted">当前分支没有提交。</span>
          )}
        </div>
      )}
      {(cleanupError || view.notice) && (
        <p className="git-workbench-notice is-error" role="alert">
          {visibleGitText(cleanupError || view.notice?.error || '')}
        </p>
      )}
      {state.notice && (
        <p className="git-workbench-notice is-error" role="alert" data-status={state.noticeStatus}>
          {visibleGitText(state.notice)}
          {state.noticeStatus === 'stale' && ' 请刷新后重新选择。'}
        </p>
      )}
      {state.actionResult && (
        <p
          className={`git-workbench-notice${state.actionResult.outcome === 'partial-success' ? ' is-error' : ''}`}
          role={state.actionResult.outcome === 'partial-success' ? 'alert' : 'status'}
        >
          {state.actionResult.outcome === 'partial-success' ? '部分步骤完成：' : ''}
          {visibleGitText(state.actionResult.message)}
          {state.actionResult.outcome === 'partial-success' && `（${state.actionResult.stage}）`}
        </p>
      )}
      {clipboardNotice && (
        <p className="git-workbench-notice" role="status">
          {clipboardNotice}
        </p>
      )}
      {initializationNotice && (
        <p className="git-workbench-notice is-error" role="alert">
          {visibleGitText(initializationNotice)}
        </p>
      )}
      {initializing && (
        <p className="git-workbench-notice" role="status">
          正在选择目录并初始化仓库…
        </p>
      )}
      {state.refreshPending && (
        <p className="git-workbench-notice" role="status">
          {refreshPaused || state.busy
            ? '检测到外部改动，当前操作结束后刷新。'
            : '检测到外部改动，正在等待刷新…'}
        </p>
      )}
      {state.watchStatus && state.watchStatus !== 'watching' && (
        <p className="git-workbench-notice" role="status">
          {visibleGitText(state.watchMessage || '自动刷新暂不可用，可手动刷新。')}
        </p>
      )}
      {state.review?.warnings.map((warning, index) => (
        <p className="git-workbench-notice" role="status" key={index}>
          {visibleGitText(warning)}
        </p>
      ))}
      {state.source === 'uncommitted' &&
        !!state.review?.stageCounts.staged &&
        !!state.review.stageCounts.unstaged && (
          <p className="git-workbench-notice" role="status">
            含已暂存与未暂存改动的文件请切换到 Unstaged / Staged 操作差异块，也可使用文件级操作。
          </p>
        )}
      {(view.phase === 'selecting' ||
        view.phase === 'loading' ||
        state.busy === 'metadata' ||
        state.busy === 'review' ||
        state.busy === 'action' ||
        state.busy === 'generation') && (
        <p className="git-workbench-notice" role="status">
          {view.phase === 'selecting'
            ? '正在选择目录…'
            : state.busy === 'generation'
              ? '正在生成候选内容…'
              : state.busy === 'action'
                ? '正在执行 Git 操作…'
                : '正在刷新改动…'}
        </p>
      )}
      {!view.view ? (
        <div className="git-workbench-empty">
          <Icon name="folder" size={26} />
          <strong>查看项目改动</strong>
          <p>选择本地 Git 仓库或子目录，查看差异、提交与分支。</p>
          <button
            type="button"
            className="git-workbench-control"
            disabled={directoryDisabled || initializing || view.phase === 'selecting'}
            onClick={() => void onSelectDirectory()}
          >
            选择目录
          </button>
        </div>
      ) : (
        <div className="git-workbench-body">
          <div className="git-workbench-review">
            {file && (
              <div className="git-workbench-file-header">
                <Icon name="file" size={13} />
                <strong title={visibleGitText(file.path)}>
                  {file.previousPath && `${visibleGitText(file.previousPath)} → `}
                  {visibleGitText(file.path)}
                </strong>
                <span className="git-workbench-stat-added">+{file.additions}</span>
                <span className="git-workbench-stat-deleted">−{file.deletions}</span>
                <label>
                  <input
                    type="checkbox"
                    aria-label="标记文件已查看"
                    checked={viewed.has(file.path)}
                    onChange={(event) =>
                      setViewed((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(file.path)
                        else next.delete(file.path)
                        return next
                      })
                    }
                  />
                  已查看
                </label>
                {file.change === 'unmerged' && <span title="文件有合并冲突">⚠ 冲突</span>}
                {file.actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className="git-workbench-control"
                    disabled={writeDisabled}
                    onClick={() => act(action, [file.itemId])}
                  >
                    {actionLabels[action]}文件
                  </button>
                ))}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="复制文件路径"
                  title="复制文件路径"
                  onClick={() => {
                    void navigator.clipboard.writeText(file.path).then(
                      () => setClipboardNotice('已复制文件路径。'),
                      () => setClipboardNotice('无法写入剪贴板。')
                    )
                  }}
                >
                  <Icon name="copy" size={12} />
                </button>
              </div>
            )}
            {(state.busy === 'diff' || state.busy === 'file') && !state.detail ? (
              <div className="git-workbench-empty">
                <p role="status">{state.busy === 'file' ? '正在读取完整文件…' : '正在读取差异…'}</p>
              </div>
            ) : options.rich && state.fullFiles ? (
              <RichPreview
                key={file?.path}
                files={state.fullFiles}
                split={options.mode === 'split'}
                wrap={options.wrap}
              />
            ) : file && state.detail ? (
              <DiffBody
                key={file.path}
                detail={state.detail}
                fullFiles={state.fullFiles}
                file={file}
                options={options}
                disabled={writeDisabled}
                onAction={(action, hunkId) =>
                  act(action, [file.itemId], hunkId ? [hunkId] : undefined)
                }
              />
            ) : (
              <div className="git-workbench-empty">
                <strong>
                  {state.source === 'last-turn'
                    ? state.metadata?.lastTurn?.state === 'capturing'
                      ? '正在捕获当前回合'
                      : state.metadata?.lastTurn?.state === 'failed' ||
                          state.metadata?.lastTurn?.state === 'error'
                        ? '上一回合捕获未完成'
                        : '暂无上一回合改动'
                    : state.review && !files.length
                      ? '当前来源没有改动'
                      : '选择文件查看差异'}
                </strong>
                {state.source === 'last-turn' && (
                  <p>
                    {state.metadata?.lastTurn?.message ||
                      (state.metadata?.lastTurn?.state === 'capturing'
                        ? '回合结束后可查看独立保存的差异。'
                        : state.metadata?.lastTurn?.turnNumber
                          ? `回合 ${state.metadata.lastTurn.turnNumber}：${state.metadata.lastTurn.state}，此范围没有可显示差异。`
                          : '添加仓库之后的新回合会独立捕获差异。')}
                  </p>
                )}
                {state.notice && (
                  <button
                    type="button"
                    className="git-workbench-control"
                    disabled={disabled}
                    onClick={() => void workbench.refresh()}
                  >
                    刷新重试
                  </button>
                )}
              </div>
            )}
          </div>
          {showTree && (
            <div
              className="git-workbench-tree-container"
              style={{ '--git-tree-width': `${treeWidth}px` } as CSSProperties}
            >
              <div
                className="git-workbench-tree-splitter"
                role="separator"
                aria-label="调整文件树宽度"
                aria-orientation="vertical"
                tabIndex={0}
                aria-valuemin={120}
                aria-valuemax={450}
                aria-valuenow={Math.round(treeWidth)}
                onPointerDown={resizeTree}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    setTreeWidth((previous) =>
                      Math.max(
                        120,
                        Math.min(450, previous + (event.key === 'ArrowLeft' ? 10 : -10))
                      )
                    )
                  }
                }}
              />
              <FileTree
                files={files}
                selectedItemId={state.selectedItemId}
                viewed={viewed}
                disabled={writeDisabled}
                onRead={(item) => void workbench.readFile(item)}
              />
            </div>
          )}
        </div>
      )}
      {state.review && (
        <footer className="git-workbench-status">
          <span>
            {files.length} 个文件 <span className="git-workbench-stat-added">+{stats.added}</span>{' '}
            <span className="git-workbench-stat-deleted">−{stats.deleted}</span>
          </span>
          <span title={state.review.baseLabel}>{visibleGitText(state.review.baseLabel)}</span>
          {(['stage', 'unstage', 'revert'] as const).map((action) => {
            const eligible = files.filter((item) => item.actions.includes(action))
            return (
              eligible.length > 0 && (
                <button
                  type="button"
                  className="git-workbench-control"
                  key={action}
                  disabled={writeDisabled}
                  onClick={() =>
                    act(
                      action,
                      eligible.map((item) => item.itemId)
                    )
                  }
                >
                  {actionLabels[action]}全部
                </button>
              )
            )
          })}
        </footer>
      )}
      {revert && (
        <div className="git-workbench-dialog-backdrop">
          <dialog
            open
            className="git-workbench-dialog"
            aria-modal="true"
            aria-label="撤销改动确认"
            onKeyDown={(event) => modalKeys(event, () => setRevert(null), state.busy === 'action')}
          >
            <h3>撤销改动？</h3>
            <p>
              {revert.hunkIds
                ? '此操作移除所选差异块的改动。'
                : '此操作移除以下文件在当前差异来源中的改动。'}
              请确认后继续。
            </p>
            <div className="git-workbench-dialog-paths">
              {revert.paths.map((path) => (
                <div key={path}>{visibleGitText(path)}</div>
              ))}
            </div>
            <label className="git-workbench-control">
              <input
                type="checkbox"
                checked={skipRevertConfirmation}
                onChange={(event) => setSkipRevertConfirmation(event.target.checked)}
              />
              本次打开不再询问
            </label>
            {state.notice && (
              <p className="git-workbench-notice is-error" role="alert">
                {visibleGitText(state.notice)}
              </p>
            )}
            <div className="git-workbench-dialog-actions">
              <button
                type="button"
                disabled={state.busy === 'action'}
                onClick={() => setRevert(null)}
              >
                取消
              </button>
              <button
                autoFocus
                type="button"
                className="danger"
                disabled={state.busy === 'action'}
                onClick={() => {
                  const target = revert
                  void workbench
                    .execute(
                      {
                        action: 'revert',
                        itemIds: target.itemIds,
                        ...(target.hunkIds ? { hunkIds: target.hunkIds } : {})
                      },
                      target.revision
                    )
                    .then((success) => {
                      if (success) setRevert(null)
                    })
                }}
              >
                {state.busy === 'action' ? '正在撤销…' : '确认撤销'}
              </button>
            </div>
          </dialog>
        </div>
      )}
      {manual && state.metadata && (
        <ActionDialog
          key={manual}
          mode={manual}
          metadata={state.metadata}
          busy={!!state.busy}
          generating={state.busy === 'generation'}
          error={state.notice}
          onCancel={() => {
            if (state.busy === 'generation') void workbench.cancel()
            setManual(null)
          }}
          onExecute={workbench.execute}
          onCommit={() => setManual('commit')}
          onGenerate={workbench.generate}
          generationCapability={workbench.capability('generate')}
          preferences={preferences}
        />
      )}
      {prOpen && view.view && state.metadata && (
        <GitPullRequestDialog
          viewId={view.view.viewId}
          metadata={state.metadata}
          defaultMethod={preferences.mergeMethod}
          onCancel={() => {
            setPrOpen(false)
            void workbench.refresh()
          }}
          onChanged={() => setClipboardNotice('PR 已合并，关闭窗口后刷新仓库。')}
        />
      )}
      {settingsOpen && (
        <GitSettingsDialog
          preferences={preferences}
          onCancel={() => setSettingsOpen(false)}
          onSave={(value) => {
            try {
              saveGitWorkbenchPreferences(window.localStorage, value)
              setPreferences(value)
              setSettingsOpen(false)
              setClipboardNotice('Git 默认设置已保存。')
            } catch (error) {
              setClipboardNotice(
                error instanceof Error ? error.message.slice(0, 500) : 'Git 设置保存未完成。'
              )
            }
          }}
        />
      )}
    </aside>
  )
}
