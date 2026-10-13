import type { GitChangeItem, GitFailureStatus } from './git-view'
import type { GitTurnCaptureState } from './git-observation'
import { parseGitTurnCaptureState } from './git-observation'
export function isGitWorkbenchId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

/** Manual desktop Git contract. IDs belong to a window/document, never to Agent authority. */
export const gitWorkbenchLimits = {
  diffBytes: 32 * 1024 * 1024,
  patchBytes: 64 * 1024 * 1024,
  files: 2000,
  refs: 2000,
  commits: 200,
  searchMatches: 250,
  messageBytes: 64 * 1024
} as const
export type GitReviewSource =
  'branch' | 'commit' | 'uncommitted' | 'staged' | 'unstaged' | 'last-turn'
export type GitFileAction = 'stage' | 'unstage' | 'revert'
export type GitWorkbenchRequest = { requestId: string; viewId: string }
export type GitReviewRequest = GitWorkbenchRequest & {
  source: GitReviewSource
  baseRefId?: string
  commitId?: string
  hideWhitespace?: boolean
}
export type GitDiffRequest = GitWorkbenchRequest & { revision: string; itemId: string }
export type GitReviewFile = {
  itemId: string
  path: string
  previousPath: string | null
  change: GitChangeItem['change']
  additions: number
  deletions: number
  binary: boolean
  actions: GitFileAction[]
}
export type GitReviewData = {
  revision: string
  source: GitReviewSource
  baseLabel: string
  files: GitReviewFile[]
  stageCounts: { staged: number; unstaged: number; untracked: number }
  warnings: string[]
}
export type GitHunk = {
  hunkId: string
  header: string
  startLine: number
  endLine: number
  actions: GitFileAction[]
}
export type GitDiffData = { itemId: string; text: string; binary: boolean; hunks: GitHunk[] }
export type GitBranch = {
  refId: string
  name: string
  current: boolean
  remote: boolean
  oid: string
}
export type GitCommit = {
  commitId: string
  sha: string
  subject: string
  author: string
  timestamp: number
}
export type GitRemote = {
  remoteId: string
  name: string
  url: string
  pushable: boolean
  reason: string | null
}
export type GitWorktree = {
  worktreeId: string
  path: string
  branch: string | null
  head: string
  current: boolean
  locked: boolean
}
export type GitCapability = { name: string; available: boolean; reason: string | null }
export type GitMetadata = {
  revision: string
  branch: string | null
  headSha: string | null
  ahead: number
  behind: number
  branches: GitBranch[]
  commits: GitCommit[]
  remotes: GitRemote[]
  worktrees: GitWorktree[]
  capabilities: GitCapability[]
  lastTurn?: GitTurnCaptureState
}
type GitActionBase = GitWorkbenchRequest & { revision: string }
export type GitActionRequest = GitActionBase &
  (
    | { action: GitFileAction; itemIds: string[]; hunkIds?: string[] }
    | {
        action: 'commit'
        message: string
        includeUnstaged: boolean
        authorName?: string
        authorEmail?: string
      }
    | {
        action: 'commit-and-push'
        message: string
        includeUnstaged: boolean
        authorName?: string
        authorEmail?: string
        remoteId: string
        forceWithLease: boolean
      }
    | { action: 'create-branch'; name: string }
    | { action: 'checkout'; refId: string }
    | { action: 'push'; remoteId: string; forceWithLease: boolean }
    | { action: 'fetch'; remoteId: string }
    | { action: 'create-worktree'; name: string; refId: string; branchPrefix?: string }
    | { action: 'remove-worktree'; worktreeId: string }
    | { action: 'create-pr'; title: string; body: string; draft: boolean; baseRefId: string }
  )
export type GitActionData = {
  outcome: 'success' | 'partial-success'
  stage: string
  appliedItemIds: string[]
  message: string
  headSha?: string
}
export type GitWorkbenchResult<T> = GitWorkbenchRequest &
  (
    | { status: 'ready'; data: T }
    | { status: 'cancelled' }
    | { status: GitFailureStatus; error: string }
  )
export type GitMetadataResult = GitWorkbenchResult<GitMetadata>
export type GitReviewResult = GitWorkbenchResult<GitReviewData>
export type GitDiffResult = GitWorkbenchResult<GitDiffData>
export type GitActionResult = GitWorkbenchResult<GitActionData>
export type GitGenerateRequest = GitWorkbenchRequest & {
  revision: string
  purpose: 'commit' | 'pr'
  guidance?: string
  baseRefId?: string
  includeUnstaged?: boolean
}
export type GitGeneratedText = { subject: string; body: string }
export type GitGenerateResult = GitWorkbenchResult<GitGeneratedText>
export type GitFullFileRequest = GitDiffRequest & { side: 'base' | 'current' }
export type GitFullFileData = { itemId: string; path: string; side: 'base' | 'current' } & (
  | { format: 'text'; text: string }
  | {
      format: 'image'
      mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
      base64: string
    }
  | { format: 'binary' | 'missing' }
)
export type GitFullFileResult = GitWorkbenchResult<GitFullFileData>

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!
  )
}
function shape(value: Record<string, unknown>, keys: string[], optional: string[] = []): boolean {
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
  )
}
function text(value: unknown, max = 4096, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= max &&
    !/\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}
function array(value: unknown, maximum: number): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    return false
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))
  )
    return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !('value' in descriptor)) return false
  }
  return true
}
function ids(value: unknown, max = gitWorkbenchLimits.files): value is string[] {
  return array(value, max) && value.every(isGitWorkbenchId) && new Set(value).size === value.length
}
const sourceNames: GitReviewSource[] = [
  'branch',
  'commit',
  'uncommitted',
  'staged',
  'unstaged',
  'last-turn'
]
const fileActions: GitFileAction[] = ['stage', 'unstage', 'revert']
export function parseGitWorkbenchRequest(value: unknown): GitWorkbenchRequest | null {
  return record(value) &&
    shape(value, ['requestId', 'viewId']) &&
    isGitWorkbenchId(value.requestId) &&
    isGitWorkbenchId(value.viewId)
    ? { requestId: value.requestId, viewId: value.viewId }
    : null
}
function base(value: Record<string, unknown>): GitWorkbenchRequest | null {
  return parseGitWorkbenchRequest({ requestId: value.requestId, viewId: value.viewId })
}
export function parseGitReviewRequest(value: unknown): GitReviewRequest | null {
  if (
    !record(value) ||
    !shape(value, ['requestId', 'viewId', 'source'], ['baseRefId', 'commitId', 'hideWhitespace'])
  )
    return null
  const request = base(value)
  if (
    !request ||
    !sourceNames.includes(value.source as GitReviewSource) ||
    (value.baseRefId !== undefined &&
      (!isGitWorkbenchId(value.baseRefId) || value.source !== 'branch')) ||
    (value.commitId !== undefined &&
      (!isGitWorkbenchId(value.commitId) || value.source !== 'commit')) ||
    (value.hideWhitespace !== undefined && typeof value.hideWhitespace !== 'boolean')
  )
    return null
  return {
    ...request,
    source: value.source as GitReviewSource,
    ...(value.baseRefId !== undefined ? { baseRefId: value.baseRefId as string } : {}),
    ...(value.commitId !== undefined ? { commitId: value.commitId as string } : {}),
    ...(value.hideWhitespace !== undefined
      ? { hideWhitespace: value.hideWhitespace as boolean }
      : {})
  }
}
export function parseGitDiffRequest(value: unknown): GitDiffRequest | null {
  if (!record(value) || !shape(value, ['requestId', 'viewId', 'revision', 'itemId'])) return null
  const request = base(value)
  return request && isGitWorkbenchId(value.revision) && isGitWorkbenchId(value.itemId)
    ? { ...request, revision: value.revision, itemId: value.itemId }
    : null
}
export function parseGitActionRequest(value: unknown): GitActionRequest | null {
  if (!record(value)) return null
  const request = base(value)
  if (!request || !isGitWorkbenchId(value.revision)) return null
  const keys = ['requestId', 'viewId', 'revision', 'action']
  let valid = false
  if (fileActions.includes(value.action as GitFileAction))
    valid =
      shape(value, [...keys, 'itemIds'], ['hunkIds']) &&
      ids(value.itemIds) &&
      value.itemIds.length > 0 &&
      (value.hunkIds === undefined || (ids(value.hunkIds) && value.hunkIds.length > 0))
  else if (value.action === 'commit')
    valid =
      shape(value, [...keys, 'message', 'includeUnstaged'], ['authorName', 'authorEmail']) &&
      text(value.message, gitWorkbenchLimits.messageBytes) &&
      value.message.trim().length > 0 &&
      typeof value.includeUnstaged === 'boolean' &&
      (value.authorName === undefined || text(value.authorName, 200)) &&
      (value.authorEmail === undefined ||
        (text(value.authorEmail, 254) && !/[\s<>]/.test(value.authorEmail)))
  else if (value.action === 'commit-and-push') {
    const { remoteId, forceWithLease, ...commit } = value
    valid =
      shape(
        value,
        [...keys, 'message', 'includeUnstaged', 'remoteId', 'forceWithLease'],
        ['authorName', 'authorEmail']
      ) &&
      isGitWorkbenchId(remoteId) &&
      typeof forceWithLease === 'boolean' &&
      !!parseGitActionRequest({ ...commit, action: 'commit' })
  } else if (value.action === 'create-branch')
    valid = shape(value, [...keys, 'name']) && text(value.name, 240) && !/[\r\n]/.test(value.name)
  else if (value.action === 'checkout')
    valid = shape(value, [...keys, 'refId']) && isGitWorkbenchId(value.refId)
  else if (value.action === 'push')
    valid =
      shape(value, [...keys, 'remoteId', 'forceWithLease']) &&
      isGitWorkbenchId(value.remoteId) &&
      typeof value.forceWithLease === 'boolean'
  else if (value.action === 'fetch')
    valid = shape(value, [...keys, 'remoteId']) && isGitWorkbenchId(value.remoteId)
  else if (value.action === 'create-worktree')
    valid =
      shape(value, [...keys, 'name', 'refId'], ['branchPrefix']) &&
      text(value.name, 120) &&
      !/[<>:"/\\|?*\r\n]/.test(value.name) &&
      value.name !== '.' &&
      value.name !== '..' &&
      isGitWorkbenchId(value.refId) &&
      (value.branchPrefix === undefined ||
        (text(value.branchPrefix, 120, true) && !/[\r\n\0]/.test(value.branchPrefix)))
  else if (value.action === 'remove-worktree')
    valid = shape(value, [...keys, 'worktreeId']) && isGitWorkbenchId(value.worktreeId)
  else if (value.action === 'create-pr')
    valid =
      shape(value, [...keys, 'title', 'body', 'draft', 'baseRefId']) &&
      text(value.title, 256) &&
      !/[\r\n]/.test(value.title) &&
      text(value.body, gitWorkbenchLimits.messageBytes, true) &&
      typeof value.draft === 'boolean' &&
      isGitWorkbenchId(value.baseRefId)
  return valid ? (structuredClone(value) as GitActionRequest) : null
}
export function parseGitGenerateRequest(value: unknown): GitGenerateRequest | null {
  if (
    !record(value) ||
    !shape(
      value,
      ['requestId', 'viewId', 'revision', 'purpose'],
      ['guidance', 'baseRefId', 'includeUnstaged']
    )
  )
    return null
  const request = base(value)
  if (
    !request ||
    !isGitWorkbenchId(value.revision) ||
    !['commit', 'pr'].includes(value.purpose as string) ||
    (value.guidance !== undefined && !text(value.guidance, 4000, true)) ||
    (value.baseRefId !== undefined &&
      (!isGitWorkbenchId(value.baseRefId) || value.purpose !== 'pr')) ||
    (value.includeUnstaged !== undefined &&
      (typeof value.includeUnstaged !== 'boolean' || value.purpose !== 'commit'))
  )
    return null
  return structuredClone(value) as GitGenerateRequest
}
export function parseGitFullFileRequest(value: unknown): GitFullFileRequest | null {
  if (
    !record(value) ||
    !shape(value, ['requestId', 'viewId', 'revision', 'itemId', 'side']) ||
    !['base', 'current'].includes(value.side as string)
  )
    return null
  const request = parseGitDiffRequest({
    requestId: value.requestId,
    viewId: value.viewId,
    revision: value.revision,
    itemId: value.itemId
  })
  return request ? { ...request, side: value.side as 'base' | 'current' } : null
}
function validFile(value: unknown): value is GitReviewFile {
  if (
    !record(value) ||
    !shape(value, [
      'itemId',
      'path',
      'previousPath',
      'change',
      'additions',
      'deletions',
      'binary',
      'actions'
    ])
  )
    return false
  return (
    isGitWorkbenchId(value.itemId) &&
    text(value.path) &&
    (value.previousPath === null || text(value.previousPath)) &&
    [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'unmerged',
      'type-changed',
      'unknown'
    ].includes(value.change as string) &&
    count(value.additions) &&
    count(value.deletions) &&
    typeof value.binary === 'boolean' &&
    array(value.actions, 3) &&
    value.actions.every((action) => fileActions.includes(action as GitFileAction)) &&
    new Set(value.actions).size === value.actions.length
  )
}
function validMetadata(value: unknown): value is GitMetadata {
  if (
    !record(value) ||
    !shape(
      value,
      [
        'revision',
        'branch',
        'headSha',
        'ahead',
        'behind',
        'branches',
        'commits',
        'remotes',
        'worktrees',
        'capabilities'
      ],
      ['lastTurn']
    )
  )
    return false
  return (
    isGitWorkbenchId(value.revision) &&
    (value.lastTurn === undefined || parseGitTurnCaptureState(value.lastTurn) !== null) &&
    (value.branch === null || text(value.branch, 1024)) &&
    (value.headSha === null || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.headSha as string)) &&
    count(value.ahead) &&
    count(value.behind) &&
    array(value.branches, gitWorkbenchLimits.refs) &&
    value.branches.every(
      (item) =>
        record(item) &&
        shape(item, ['refId', 'name', 'current', 'remote', 'oid']) &&
        isGitWorkbenchId(item.refId) &&
        text(item.name, 1024) &&
        typeof item.current === 'boolean' &&
        typeof item.remote === 'boolean' &&
        text(item.oid, 64, true)
    ) &&
    array(value.commits, gitWorkbenchLimits.commits) &&
    value.commits.every(
      (item) =>
        record(item) &&
        shape(item, ['commitId', 'sha', 'subject', 'author', 'timestamp']) &&
        isGitWorkbenchId(item.commitId) &&
        text(item.sha, 64) &&
        text(item.subject, 4096, true) &&
        text(item.author, 1024, true) &&
        count(item.timestamp)
    ) &&
    array(value.remotes, 100) &&
    value.remotes.every(
      (item) =>
        record(item) &&
        shape(item, ['remoteId', 'name', 'url', 'pushable', 'reason']) &&
        isGitWorkbenchId(item.remoteId) &&
        text(item.name, 1024) &&
        text(item.url, 4096, true) &&
        typeof item.pushable === 'boolean' &&
        (item.reason === null || text(item.reason))
    ) &&
    array(value.worktrees, 2000) &&
    value.worktrees.every(
      (item) =>
        record(item) &&
        shape(item, ['worktreeId', 'path', 'branch', 'head', 'current', 'locked']) &&
        isGitWorkbenchId(item.worktreeId) &&
        text(item.path, 32768) &&
        (item.branch === null || text(item.branch, 1024)) &&
        text(item.head, 64, true) &&
        typeof item.current === 'boolean' &&
        typeof item.locked === 'boolean'
    ) &&
    array(value.capabilities, 100) &&
    value.capabilities.every(
      (item) =>
        record(item) &&
        shape(item, ['name', 'available', 'reason']) &&
        text(item.name, 100) &&
        typeof item.available === 'boolean' &&
        (item.reason === null || text(item.reason))
    )
  )
}
function validReview(value: unknown): value is GitReviewData {
  return (
    record(value) &&
    shape(value, ['revision', 'source', 'baseLabel', 'files', 'stageCounts', 'warnings']) &&
    isGitWorkbenchId(value.revision) &&
    sourceNames.includes(value.source as GitReviewSource) &&
    text(value.baseLabel, 2048, true) &&
    array(value.files, gitWorkbenchLimits.files) &&
    value.files.every(validFile) &&
    new Set(value.files.map((file) => file.itemId)).size === value.files.length &&
    record(value.stageCounts) &&
    shape(value.stageCounts, ['staged', 'unstaged', 'untracked']) &&
    count(value.stageCounts.staged) &&
    count(value.stageCounts.unstaged) &&
    count(value.stageCounts.untracked) &&
    array(value.warnings, 100) &&
    value.warnings.every((warning) => text(warning))
  )
}
function validDiff(value: unknown): value is GitDiffData {
  return (
    record(value) &&
    shape(value, ['itemId', 'text', 'binary', 'hunks']) &&
    isGitWorkbenchId(value.itemId) &&
    text(value.text, gitWorkbenchLimits.diffBytes, true) &&
    new TextEncoder().encode(value.text as string).byteLength <= gitWorkbenchLimits.diffBytes &&
    typeof value.binary === 'boolean' &&
    array(value.hunks, 100000) &&
    value.hunks.every(
      (item) =>
        record(item) &&
        shape(item, ['hunkId', 'header', 'startLine', 'endLine', 'actions']) &&
        isGitWorkbenchId(item.hunkId) &&
        text(item.header, 4096) &&
        count(item.startLine) &&
        count(item.endLine) &&
        item.endLine >= item.startLine &&
        array(item.actions, 3) &&
        item.actions.every((action) => fileActions.includes(action as GitFileAction)) &&
        new Set(item.actions).size === item.actions.length
    )
  )
}
function validAction(value: unknown): value is GitActionData {
  return (
    record(value) &&
    shape(value, ['outcome', 'stage', 'appliedItemIds', 'message'], ['headSha']) &&
    (value.outcome === 'success' || value.outcome === 'partial-success') &&
    text(value.stage, 100) &&
    ids(value.appliedItemIds) &&
    text(value.message, 4096, true) &&
    (value.headSha === undefined || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.headSha as string))
  )
}
function result<T>(
  value: unknown,
  validate: (data: unknown) => data is T
): GitWorkbenchResult<T> | null {
  if (!record(value)) return null
  const request = base(value)
  if (!request) return null
  if (value.status === 'cancelled' && shape(value, ['requestId', 'viewId', 'status']))
    return { ...request, status: 'cancelled' }
  if (
    ['stale', 'not-repository', 'unavailable', 'unsupported', 'too-large', 'error'].includes(
      value.status as string
    ) &&
    shape(value, ['requestId', 'viewId', 'status', 'error']) &&
    text(value.error, 4096)
  )
    return { ...request, status: value.status as GitFailureStatus, error: value.error }
  return value.status === 'ready' &&
    shape(value, ['requestId', 'viewId', 'status', 'data']) &&
    validate(value.data)
    ? { ...request, status: 'ready', data: structuredClone(value.data) }
    : null
}
export const parseGitMetadataResult = (value: unknown): GitMetadataResult | null =>
  result(value, validMetadata)
export const parseGitReviewResult = (value: unknown): GitReviewResult | null =>
  result(value, validReview)
export const parseGitDiffResult = (value: unknown): GitDiffResult | null => result(value, validDiff)
export const parseGitActionResult = (value: unknown): GitActionResult | null =>
  result(value, validAction)
export const parseGitGenerateResult = (value: unknown): GitGenerateResult | null =>
  result(
    value,
    (data: unknown): data is GitGeneratedText =>
      record(data) &&
      shape(data, ['subject', 'body']) &&
      text(data.subject, 256) &&
      !/[\r\n]/.test(data.subject) &&
      text(data.body, 16000, true)
  )
export const parseGitFullFileResult = (value: unknown): GitFullFileResult | null =>
  result(value, (data: unknown): data is GitFullFileData => {
    if (
      !record(data) ||
      !isGitWorkbenchId(data.itemId) ||
      !text(data.path) ||
      !['base', 'current'].includes(data.side as string)
    )
      return false
    const keys = ['itemId', 'path', 'side', 'format']
    if (data.format === 'text')
      return (
        shape(data, [...keys, 'text']) &&
        text(data.text, 8 * 1024 * 1024, true) &&
        new TextEncoder().encode(data.text as string).byteLength <= 8 * 1024 * 1024
      )
    if (data.format === 'image')
      return (
        shape(data, [...keys, 'mime', 'base64']) &&
        ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(data.mime as string) &&
        typeof data.base64 === 'string' &&
        data.base64.length <= 12 * 1024 * 1024 &&
        data.base64.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)
      )
    return ['binary', 'missing'].includes(data.format as string) && shape(data, keys)
  })
export function sameGitWorkbenchRequest(
  left: GitWorkbenchRequest,
  right: GitWorkbenchRequest
): boolean {
  return left.requestId === right.requestId && left.viewId === right.viewId
}
