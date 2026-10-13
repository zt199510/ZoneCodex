import { parseGitSelectionResult } from './git-view'
import { isGitWorkbenchId } from './git-workbench'
import type { GitFailureStatus, GitViewScope } from './git-view'

export const gitRepositoryLimit = 8
export type GitRepositoryCollectionResult = { requestId: string } & (
  | {
      status: 'ready'
      views: GitViewScope[]
      addedViewIds: string[]
      warnings: string[]
      limit: number
    }
  | { status: 'cancelled' }
  | { status: GitFailureStatus; error: string }
)

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!
    )
  )
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  )
}
function dense(value: unknown, max: number): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    return false
  if (Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (!descriptor || !('value' in descriptor)) return false
  }
  return true
}
export function parseGitRepositoryCollectionResult(
  value: unknown
): GitRepositoryCollectionResult | null {
  if (!record(value) || !isGitWorkbenchId(value.requestId)) return null
  const requestId = value.requestId
  if (value.status === 'cancelled')
    return exact(value, ['requestId', 'status']) ? { requestId, status: 'cancelled' } : null
  if (value.status !== 'ready') {
    if (
      !['stale', 'not-repository', 'unavailable', 'unsupported', 'too-large', 'error'].includes(
        value.status as string
      ) ||
      !exact(value, ['requestId', 'status', 'error']) ||
      typeof value.error !== 'string' ||
      !value.error ||
      value.error.length > 500 ||
      /\p{Cc}/u.test(value.error)
    )
      return null
    return { requestId, status: value.status as GitFailureStatus, error: value.error }
  }
  if (
    !exact(value, ['requestId', 'status', 'views', 'addedViewIds', 'warnings', 'limit']) ||
    value.limit !== gitRepositoryLimit ||
    !dense(value.views, gitRepositoryLimit) ||
    !dense(value.addedViewIds, gitRepositoryLimit) ||
    !dense(value.warnings, gitRepositoryLimit) ||
    !value.addedViewIds.every(isGitWorkbenchId) ||
    new Set(value.addedViewIds).size !== value.addedViewIds.length ||
    !value.warnings.every(
      (entry) => typeof entry === 'string' && entry.length <= 500 && !/\p{Cc}/u.test(entry)
    )
  )
    return null
  const views: GitViewScope[] = []
  for (const candidate of value.views) {
    const parsed = parseGitSelectionResult({ requestId, status: 'ready', view: candidate })
    if (!parsed || parsed.status !== 'ready' || !isGitWorkbenchId(parsed.view.viewId)) return null
    views.push(parsed.view)
  }
  if (
    new Set(views.map((view) => view.viewId)).size !== views.length ||
    !value.addedViewIds.every((id) => views.some((view) => view.viewId === id))
  )
    return null
  return {
    requestId,
    status: 'ready',
    views,
    addedViewIds: [...value.addedViewIds],
    warnings: [...value.warnings] as string[],
    limit: gitRepositoryLimit
  }
}
