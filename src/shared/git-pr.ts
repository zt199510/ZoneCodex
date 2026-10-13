import { isGitWorkbenchId } from './git-workbench'
import type { GitWorkbenchRequest, GitWorkbenchResult } from './git-workbench'

export type GitPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'
export type GitPullRequestMethod = 'merge' | 'squash'
export type GitPullRequestListRequest = GitWorkbenchRequest & {
  revision: string
  remoteId: string
  state: 'open' | 'all'
}
export type GitPullRequestDetailRequest = GitWorkbenchRequest & { revision: string; prId: string }
export type GitPullRequestMergeRequest = GitPullRequestDetailRequest & {
  prRevision: string
  method: GitPullRequestMethod
}
export type GitPullRequestItem = {
  prId: string
  number: number
  title: string
  url: string
  state: GitPullRequestState
  draft: boolean
  headRefName: string
  baseRefName: string
  author: string
}
export type GitPullRequestListData = {
  repository: string
  account: string
  items: GitPullRequestItem[]
  capped: boolean
}
export type GitPullRequestCheck = {
  name: string
  status: 'pending' | 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | 'unknown'
}
export type GitPullRequestDetailData = GitPullRequestItem & {
  repository: string
  account: string
  prRevision: string
  body: string
  headOid: string
  baseOid: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  mergeMethods: GitPullRequestMethod[]
  checks: GitPullRequestCheck[]
}
export type GitPullRequestMergeData = {
  prId: string
  number: number
  url: string
  outcome: 'success' | 'partial-success'
  message: string
}
export type GitPullRequestListResult = GitWorkbenchResult<GitPullRequestListData>
export type GitPullRequestDetailResult = GitWorkbenchResult<GitPullRequestDetailData>
export type GitPullRequestMergeResult = GitWorkbenchResult<GitPullRequestMergeData>
export interface GitPullRequestAPI {
  getGitPullRequests(request: GitPullRequestListRequest): Promise<GitPullRequestListResult>
  getGitPullRequest(request: GitPullRequestDetailRequest): Promise<GitPullRequestDetailResult>
  mergeGitPullRequest(request: GitPullRequestMergeRequest): Promise<GitPullRequestMergeResult>
}

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
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  )
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || !!value.length) &&
    value.length <= max &&
    !/\p{Cc}/u.test(value.replace(/[\t\r\n]/g, ''))
  )
}
function array(value: unknown, max: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) =>
      Object.getOwnPropertyDescriptor(value, index)
    ).every((item) => !!item && 'value' in item)
  )
}
function base(value: Record<string, unknown>): boolean {
  return (
    isGitWorkbenchId(value.requestId) &&
    isGitWorkbenchId(value.viewId) &&
    isGitWorkbenchId(value.revision)
  )
}
export function parseGitPullRequestListRequest(value: unknown): GitPullRequestListRequest | null {
  return record(value) &&
    exact(value, ['requestId', 'viewId', 'revision', 'remoteId', 'state']) &&
    base(value) &&
    isGitWorkbenchId(value.remoteId) &&
    ['open', 'all'].includes(value.state as string)
    ? (structuredClone(value) as GitPullRequestListRequest)
    : null
}
export function parseGitPullRequestDetailRequest(
  value: unknown
): GitPullRequestDetailRequest | null {
  return record(value) &&
    exact(value, ['requestId', 'viewId', 'revision', 'prId']) &&
    base(value) &&
    isGitWorkbenchId(value.prId)
    ? (structuredClone(value) as GitPullRequestDetailRequest)
    : null
}
export function parseGitPullRequestMergeRequest(value: unknown): GitPullRequestMergeRequest | null {
  return record(value) &&
    exact(value, ['requestId', 'viewId', 'revision', 'prId', 'prRevision', 'method']) &&
    base(value) &&
    isGitWorkbenchId(value.prId) &&
    isGitWorkbenchId(value.prRevision) &&
    ['merge', 'squash'].includes(value.method as string)
    ? (structuredClone(value) as GitPullRequestMergeRequest)
    : null
}
const itemKeys = [
  'prId',
  'number',
  'title',
  'url',
  'state',
  'draft',
  'headRefName',
  'baseRefName',
  'author'
]
function validItem(value: Record<string, unknown>): boolean {
  return (
    isGitWorkbenchId(value.prId) &&
    Number.isSafeInteger(value.number) &&
    Number(value.number) > 0 &&
    text(value.title, 1024) &&
    text(value.url, 2048) &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(value.url) &&
    value.url.endsWith('/' + value.number) &&
    ['OPEN', 'CLOSED', 'MERGED'].includes(value.state as string) &&
    typeof value.draft === 'boolean' &&
    text(value.headRefName, 1024) &&
    text(value.baseRefName, 1024) &&
    text(value.author, 256, true)
  )
}
function result<T>(
  value: unknown,
  valid: (data: unknown) => boolean
): GitWorkbenchResult<T> | null {
  if (!record(value) || !isGitWorkbenchId(value.requestId) || !isGitWorkbenchId(value.viewId))
    return null
  if (
    value.status === 'ready' &&
    exact(value, ['requestId', 'viewId', 'status', 'data']) &&
    valid(value.data)
  )
    return structuredClone(value) as GitWorkbenchResult<T>
  if (value.status === 'cancelled' && exact(value, ['requestId', 'viewId', 'status']))
    return structuredClone(value) as GitWorkbenchResult<T>
  return ['stale', 'not-repository', 'unavailable', 'unsupported', 'too-large', 'error'].includes(
    value.status as string
  ) &&
    exact(value, ['requestId', 'viewId', 'status', 'error']) &&
    text(value.error, 1000)
    ? (structuredClone(value) as GitWorkbenchResult<T>)
    : null
}
export function parseGitPullRequestListResult(value: unknown): GitPullRequestListResult | null {
  return result(
    value,
    (data) =>
      record(data) &&
      exact(data, ['repository', 'account', 'items', 'capped']) &&
      text(data.repository, 256) &&
      text(data.account, 256) &&
      typeof data.capped === 'boolean' &&
      array(data.items, 100) &&
      data.items.every((item) => record(item) && exact(item, itemKeys) && validItem(item)) &&
      new Set(data.items.map((item) => (item as GitPullRequestItem).prId)).size ===
        data.items.length
  )
}
export function parseGitPullRequestDetailResult(value: unknown): GitPullRequestDetailResult | null {
  return result(
    value,
    (data) =>
      record(data) &&
      exact(data, [
        ...itemKeys,
        'repository',
        'account',
        'prRevision',
        'body',
        'headOid',
        'baseOid',
        'mergeable',
        'mergeStateStatus',
        'mergeMethods',
        'checks'
      ]) &&
      validItem(data) &&
      text(data.repository, 256) &&
      text(data.account, 256) &&
      isGitWorkbenchId(data.prRevision) &&
      text(data.body, 64 * 1024, true) &&
      typeof data.headOid === 'string' &&
      /^[a-f0-9]{40}$/.test(data.headOid) &&
      typeof data.baseOid === 'string' &&
      /^[a-f0-9]{40}$/.test(data.baseOid) &&
      ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(data.mergeable as string) &&
      text(data.mergeStateStatus, 64) &&
      array(data.mergeMethods, 2) &&
      data.mergeMethods.every((method) => ['merge', 'squash'].includes(method as string)) &&
      new Set(data.mergeMethods).size === data.mergeMethods.length &&
      array(data.checks, 200) &&
      data.checks.every(
        (check) =>
          record(check) &&
          exact(check, ['name', 'status']) &&
          text(check.name, 1024) &&
          ['pending', 'success', 'failure', 'neutral', 'skipped', 'cancelled', 'unknown'].includes(
            check.status as string
          )
      )
  )
}
export function parseGitPullRequestMergeResult(value: unknown): GitPullRequestMergeResult | null {
  return result(
    value,
    (data) =>
      record(data) &&
      exact(data, ['prId', 'number', 'url', 'outcome', 'message']) &&
      isGitWorkbenchId(data.prId) &&
      Number.isSafeInteger(data.number) &&
      Number(data.number) > 0 &&
      text(data.url, 2048) &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*$/.test(data.url) &&
      data.url.endsWith('/' + data.number) &&
      ['success', 'partial-success'].includes(data.outcome as string) &&
      text(data.message, 1000)
  )
}
