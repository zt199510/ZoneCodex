import type { BrowserWindow } from 'electron'
import type { Stats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join, parse, relative, resolve, sep } from 'node:path'
import type { WorkspaceFileSearchResult } from '../../shared/project'
import { isAgentId } from '../../shared/agent'
import { isRelativeProjectPath, isWorkspaceFileSearchQuery } from '../../shared/project'
import { changeCapacity, SMALL_CHANGE_CAPACITY } from '../tools/change-capacity'
import { canonicalLocalPath, insideLocalPath, sameLocalPath } from '../tools/local-path'
import { isProjectSnapshotPathAllowed, readSelectedFile } from '../tools/project-snapshot'
import { isLocalReadPathAllowed } from '../tools/workspace-files'
import { captureWorkspaceAccess, hasWorkspaceSelection } from './workspace-access'

type SearchState = { controller: AbortController }
const searches = new Map<number, SearchState>()
const maxVisitedEntries = 3000
const maxDepth = 8
const maxResults = 20

function snapshotPathAllowed(target: string, directory = false): boolean {
  const path = relative(parse(target).root, target).split(sep).join('/')
  return (directory && path === '') || isProjectSnapshotPathAllowed(path, directory)
}

/** Return a local target only under the explicitly selected workspace grant. */
export async function resolveWorkspaceReferencePath(
  root: string,
  path: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  if (!isRelativeProjectPath(path)) throw new Error('文件引用路径无效')
  const target = await canonicalLocalPath(root, path)
  signal.throwIfAborted()
  if (
    !insideLocalPath(root, target) ||
    sameLocalPath(root, target) ||
    !snapshotPathAllowed(target) ||
    !isLocalReadPathAllowed(target)
  )
    throw new Error('文件不在可引用的项目范围内')
  return target
}

export async function searchWorkspaceFiles(
  window: BrowserWindow,
  conversationId: string,
  workspaceId: string,
  query: string
): Promise<WorkspaceFileSearchResult> {
  if (!isAgentId(conversationId) || !isAgentId(workspaceId) || !isWorkspaceFileSearchQuery(query))
    return { status: 'error', error: '文件搜索参数无效' }
  const workspace = captureWorkspaceAccess(window.id, conversationId)
  if (!workspace || workspace.workspaceId !== workspaceId)
    return { status: 'error', error: '项目文件夹授权已失效，请重新选择' }

  searches.get(window.id)?.controller.abort()
  const state: SearchState = { controller: new AbortController() }
  searches.set(window.id, state)
  const signal = state.controller.signal
  const stillCurrent = (): boolean => {
    if (
      signal.aborted ||
      searches.get(window.id) !== state ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      hasWorkspaceSelection(window.id)
    )
      return false
    const current = captureWorkspaceAccess(window.id, conversationId)
    return current?.workspaceId === workspaceId && current.root === workspace.root
  }
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (!stillCurrent()) throw new Error('项目文件夹已变化')
  }
  try {
    assertCurrent()
    const root = await canonicalLocalPath(workspace.root, '', true)
    assertCurrent()
    if (!sameLocalPath(root, resolve(workspace.root)))
      throw new Error('项目文件夹路径已变化，请重新选择')
    if (!snapshotPathAllowed(root, true) || !isLocalReadPathAllowed(root))
      throw new Error('此项目文件夹不在可引用的文件范围内')
    const files: Array<{ path: string }> = []
    const pending = [{ path: root, depth: 0 }]
    const needle = query.trim().replace(/\\/g, '/').toLocaleLowerCase()
    let visited = 0
    let truncated = false
    while (pending.length > 0 && files.length <= maxResults) {
      assertCurrent()
      const directory = pending.shift()!
      const checked = await canonicalLocalPath(root, directory.path, true)
      assertCurrent()
      if (!insideLocalPath(root, checked) || !sameLocalPath(checked, directory.path)) continue
      const before = await lstat(checked)
      if (!before.isDirectory() || before.isSymbolicLink()) continue
      const stream = await opendir(checked)
      const names: string[] = []
      for await (const entry of stream) {
        assertCurrent()
        if (names.length >= maxVisitedEntries - visited) {
          truncated = true
          break
        }
        names.push(entry.name)
      }
      const directoryAfter = await canonicalLocalPath(root, checked, true)
      const after = await lstat(directoryAfter)
      assertCurrent()
      if (
        !sameLocalPath(checked, directoryAfter) ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        throw new Error('项目目录在搜索期间已变化')
      names.sort((left, right) => left.localeCompare(right))
      for (const name of names) {
        assertCurrent()
        if (visited >= maxVisitedEntries) {
          truncated = true
          break
        }
        visited += 1
        const target = join(checked, name)
        if (!isLocalReadPathAllowed(target)) continue
        let info: Stats
        try {
          info = await lstat(target)
        } catch {
          continue
        }
        if (info.isSymbolicLink()) continue
        if (info.isDirectory()) {
          if (!snapshotPathAllowed(target, true)) continue
          if (directory.depth < maxDepth) pending.push({ path: target, depth: directory.depth + 1 })
          else truncated = true
          continue
        }
        const path = relative(root, target).split(sep).join('/')
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > changeCapacity(SMALL_CHANGE_CAPACITY).maxBytes ||
          !isRelativeProjectPath(path) ||
          !snapshotPathAllowed(target) ||
          !path.toLocaleLowerCase().includes(needle)
        )
          continue
        try {
          await readSelectedFile(root, path.replace(/\//g, sep), signal)
        } catch {
          assertCurrent()
          continue
        }
        assertCurrent()
        files.push({ path })
        if (files.length > maxResults) {
          truncated = true
          break
        }
      }
      if (visited >= maxVisitedEntries || files.length > maxResults) break
    }
    assertCurrent()
    return { status: 'ready', workspaceId, files: files.slice(0, maxResults), truncated }
  } catch (error) {
    if (!stillCurrent()) return { status: 'cancelled' }
    return {
      status: 'error',
      error: (error instanceof Error ? error.message : '无法搜索项目文件').slice(0, 500)
    }
  } finally {
    if (searches.get(window.id) === state) searches.delete(window.id)
  }
}

export function cleanupWorkspaceFileSearch(windowId: number): void {
  searches.get(windowId)?.controller.abort()
  searches.delete(windowId)
}
