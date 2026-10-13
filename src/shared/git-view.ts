// 人工 Git 查看独立于 Agent、会话与工作区授权；路径只出现在展示结果中。
export const gitViewLimits = {
  statusBytes: 1024 * 1024,
  items: 2000,
  itemBytes: 256 * 1024,
  itemLines: 4000,
  stderrBytes: 16 * 1024,
  metadataBytes: 16 * 1024 * 1024,
  readMs: 10_000,
  activeReads: 1
} as const

export type GitFailureStatus =
  'stale' | 'not-repository' | 'unavailable' | 'unsupported' | 'too-large' | 'error'
export type GitViewScope = {
  viewId: string
  selectedPath: string
  repositoryPath: string
  scopePath: string
  gitVersion: string
  head: 'present' | 'unborn'
  linkedWorktree: boolean
}
export type GitChangeItem = {
  itemId: string
  group: 'staged' | 'unstaged' | 'untracked'
  change:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'unmerged'
    | 'type-changed'
    | 'unknown'
  path: string
  previousPath: string | null
  previewable: boolean
  reason: string | null
}
export type GitListRequest = { requestId: string; viewId: string }
export type GitItemRequest = GitListRequest & { revision: string; itemId: string }
type GitFailure = { status: GitFailureStatus; error: string }
export type GitSelectionResult = { requestId: string } & (
  { status: 'ready'; view: GitViewScope } | { status: 'cancelled' } | GitFailure
)
export type GitListResult = GitListRequest &
  (
    | { status: 'ready'; revision: string; items: GitChangeItem[]; warnings: string[] }
    | { status: 'cancelled' }
    | GitFailure
  )
export type GitItemResult = GitItemRequest &
  (
    | {
        status: 'ready'
        item: GitChangeItem
        format: 'diff' | 'content'
        baseline: 'head-index' | 'empty-index' | 'index-worktree' | 'untracked'
        text: string
        bytes: number
        lineCount: number
      }
    | { status: 'cancelled' }
    | GitFailure
  )
// ready 只确认 owned 读取已收口，不能将 kill 请求冒充进程 close。
export type GitControlResult = { status: 'ready' | 'stale' } | { status: 'error'; error: string }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return typeof key === 'string' && descriptor !== undefined && 'value' in descriptor
    })
  )
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  )
}
function string(value: unknown, maximum: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= maximum &&
    !value.includes('\0')
  )
}
function errorString(value: unknown): value is string {
  return string(value, 500)
}
export function isGitViewId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value)
}
function failure(
  value: Record<string, unknown>,
  common: readonly string[]
): GitFailure | { status: 'cancelled' } | null {
  if (value.status === 'cancelled' && exact(value, [...common, 'status']))
    return { status: 'cancelled' }
  if (
    (value.status === 'stale' ||
      value.status === 'not-repository' ||
      value.status === 'unavailable' ||
      value.status === 'unsupported' ||
      value.status === 'too-large' ||
      value.status === 'error') &&
    exact(value, [...common, 'status', 'error']) &&
    errorString(value.error)
  )
    return { status: value.status, error: value.error }
  return null
}

export function parseGitListRequest(value: unknown): GitListRequest | null {
  return record(value) &&
    exact(value, ['requestId', 'viewId']) &&
    isGitViewId(value.requestId) &&
    isGitViewId(value.viewId)
    ? { requestId: value.requestId, viewId: value.viewId }
    : null
}
export function parseGitItemRequest(value: unknown): GitItemRequest | null {
  return record(value) &&
    exact(value, ['requestId', 'viewId', 'revision', 'itemId']) &&
    isGitViewId(value.requestId) &&
    isGitViewId(value.viewId) &&
    isGitViewId(value.revision) &&
    isGitViewId(value.itemId)
    ? {
        requestId: value.requestId,
        viewId: value.viewId,
        revision: value.revision,
        itemId: value.itemId
      }
    : null
}
export function sameGitListRequest(a: GitListRequest, b: GitListRequest): boolean {
  return a.requestId === b.requestId && a.viewId === b.viewId
}
export function sameGitItemRequest(a: GitItemRequest, b: GitItemRequest): boolean {
  return sameGitListRequest(a, b) && a.revision === b.revision && a.itemId === b.itemId
}

export function parseGitChangeItem(value: unknown): GitChangeItem | null {
  if (
    !record(value) ||
    !exact(value, ['itemId', 'group', 'change', 'path', 'previousPath', 'previewable', 'reason']) ||
    !isGitViewId(value.itemId) ||
    (value.group !== 'staged' && value.group !== 'unstaged' && value.group !== 'untracked') ||
    (value.change !== 'added' &&
      value.change !== 'modified' &&
      value.change !== 'deleted' &&
      value.change !== 'renamed' &&
      value.change !== 'copied' &&
      value.change !== 'unmerged' &&
      value.change !== 'type-changed' &&
      value.change !== 'unknown') ||
    !string(value.path, 32768) ||
    (value.previousPath !== null && !string(value.previousPath, 32768)) ||
    typeof value.previewable !== 'boolean' ||
    (value.previewable ? value.reason !== null : !errorString(value.reason))
  )
    return null
  return {
    itemId: value.itemId,
    group: value.group,
    change: value.change,
    path: value.path,
    previousPath: value.previousPath,
    previewable: value.previewable,
    reason: value.reason as string | null
  }
}

export function parseGitSelectionResult(value: unknown): GitSelectionResult | null {
  if (!record(value) || !isGitViewId(value.requestId)) return null
  const failed = failure(value, ['requestId'])
  if (failed) return { requestId: value.requestId, ...failed }
  if (
    value.status !== 'ready' ||
    !exact(value, ['requestId', 'status', 'view']) ||
    !record(value.view)
  )
    return null
  const view = value.view
  if (
    !exact(view, [
      'viewId',
      'selectedPath',
      'repositoryPath',
      'scopePath',
      'gitVersion',
      'head',
      'linkedWorktree'
    ]) ||
    !isGitViewId(view.viewId) ||
    !string(view.selectedPath, 32768) ||
    !string(view.repositoryPath, 32768) ||
    !string(view.scopePath, 32768, true) ||
    !string(view.gitVersion, 200) ||
    (view.head !== 'present' && view.head !== 'unborn') ||
    typeof view.linkedWorktree !== 'boolean'
  )
    return null
  return {
    requestId: value.requestId,
    status: 'ready',
    view: {
      viewId: view.viewId,
      selectedPath: view.selectedPath,
      repositoryPath: view.repositoryPath,
      scopePath: view.scopePath,
      gitVersion: view.gitVersion,
      head: view.head,
      linkedWorktree: view.linkedWorktree
    }
  }
}

export function parseGitListResult(value: unknown): GitListResult | null {
  if (!record(value)) return null
  const request = parseGitListRequest({ requestId: value.requestId, viewId: value.viewId })
  if (!request) return null
  const failed = failure(value, ['requestId', 'viewId'])
  if (failed) return { ...request, ...failed }
  if (
    value.status !== 'ready' ||
    !exact(value, ['requestId', 'viewId', 'status', 'revision', 'items', 'warnings']) ||
    !isGitViewId(value.revision) ||
    !Array.isArray(value.items) ||
    value.items.length > gitViewLimits.items ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 64 ||
    !value.warnings.every(errorString)
  )
    return null
  const items: GitChangeItem[] = []
  const ids = new Set<string>()
  for (const candidate of value.items) {
    const item = parseGitChangeItem(candidate)
    if (!item || ids.has(item.itemId)) return null
    ids.add(item.itemId)
    items.push(item)
  }
  return {
    ...request,
    status: 'ready',
    revision: value.revision,
    items,
    warnings: [...value.warnings]
  }
}

export function parseGitItemResult(value: unknown): GitItemResult | null {
  if (!record(value)) return null
  const request = parseGitItemRequest({
    requestId: value.requestId,
    viewId: value.viewId,
    revision: value.revision,
    itemId: value.itemId
  })
  if (!request) return null
  const failed = failure(value, ['requestId', 'viewId', 'revision', 'itemId'])
  if (failed) return { ...request, ...failed }
  if (
    value.status !== 'ready' ||
    !exact(value, [
      'requestId',
      'viewId',
      'revision',
      'itemId',
      'status',
      'item',
      'format',
      'baseline',
      'text',
      'bytes',
      'lineCount'
    ]) ||
    !string(value.text, gitViewLimits.itemBytes, true) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > gitViewLimits.itemBytes ||
    typeof value.lineCount !== 'number' ||
    !Number.isSafeInteger(value.lineCount) ||
    value.lineCount < 1 ||
    value.lineCount > gitViewLimits.itemLines
  )
    return null
  const item = parseGitChangeItem(value.item)
  if (!item || item.itemId !== request.itemId || !item.previewable) return null
  if (
    (item.group === 'untracked'
      ? value.format !== 'content' || value.baseline !== 'untracked'
      : value.format !== 'diff' ||
        (item.group === 'staged'
          ? value.baseline !== 'head-index' && value.baseline !== 'empty-index'
          : value.baseline !== 'index-worktree')) ||
    new TextEncoder().encode(value.text).byteLength !== value.bytes ||
    value.text.split(/\r\n|\n|\r/).length !== value.lineCount
  )
    return null
  for (let index = 0; index < value.text.length; index++) {
    const code = value.text.charCodeAt(index)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return null
  }
  return {
    ...request,
    status: 'ready',
    item,
    format: value.format as 'diff' | 'content',
    baseline: value.baseline as 'head-index' | 'empty-index' | 'index-worktree' | 'untracked',
    text: value.text,
    bytes: value.bytes,
    lineCount: value.lineCount
  }
}

export function parseGitControlResult(value: unknown): GitControlResult | null {
  if (!record(value)) return null
  if ((value.status === 'ready' || value.status === 'stale') && exact(value, ['status']))
    return { status: value.status }
  if (value.status === 'error' && exact(value, ['status', 'error']) && errorString(value.error))
    return { status: 'error', error: value.error }
  return null
}
