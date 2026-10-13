import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { isGitViewId, parseGitListRequest, parseGitItemRequest } from '../../shared/git-view'
import type {
  GitSelectionResult,
  GitListResult,
  GitItemResult,
  GitControlResult
} from '../../shared/git-view'
import { getIpcWindow } from '../ipc-source'
import { createGitReader } from './git-reader'
import type { GitReaderView } from './git-reader'
import { GitReadError } from './git-process'
import { gitRepositoryLimit } from '../../shared/git-repositories'
import type { GitRepositoryCollectionResult } from '../../shared/git-repositories'
import { isGitWorkbenchId } from '../../shared/git-workbench'

export interface GitViewOperation {
  requestId: string
  controller: AbortController
  done: Promise<unknown>
  phase: 'dialog' | 'read' | 'write'
  error?: string
  viewId?: string
}
export interface WindowGitState {
  generation: number
  view?: GitReaderView
  views?: Map<string, GitReaderView>
  window?: BrowserWindow
  active?: GitViewOperation
  choosing: boolean
  dead: boolean
}
const states = new Map<number, WindowGitState>()
const retiring = new Map<number, Promise<void>>()
const blockedWindows = new Map<number, string>()
const choosers = new Set<number>()
type ViewLifecycle = {
  added: (view: GitReaderView, windowId: number) => void | Promise<void>
  removed: (view: GitReaderView) => void | Promise<void>
}
const viewLifecycles = new Set<ViewLifecycle>()
let reader: ReturnType<typeof createGitReader> | undefined
function service(): ReturnType<typeof createGitReader> {
  return (reader ??= createGitReader({
    cacheRoot: path.join(app.getPath('temp'), 'ZoneCodex-git-view-' + process.pid)
  }))
}
function failure(error: unknown): { status: GitReadError['status']; error: string } {
  return {
    status: error instanceof GitReadError ? error.status : 'error',
    error:
      (error instanceof Error ? error.message : 'Git 读取失败')
        .replace(/\p{Cc}/gu, ' ')
        .slice(0, 500) || 'Git 读取失败'
  }
}
function stateOf(window: BrowserWindow): WindowGitState {
  let state = states.get(window.id)
  if (!state) {
    state = { generation: 0, choosing: false, dead: false, views: new Map(), window }
    states.set(window.id, state)
  }
  return state
}
function viewsOf(state: WindowGitState | undefined): GitReaderView[] {
  if (!state) return []
  return [
    ...new Set([...(state.views?.values() ?? []), ...(state.view ? [state.view] : [])])
  ].filter((view) => !view.disposed)
}
export function getSelectedGitViews(windowId: number): GitReaderView[] {
  const state = states.get(windowId)
  return state && !state.dead ? viewsOf(state) : []
}
async function disposeOwnedView(state: WindowGitState, view: GitReaderView): Promise<void> {
  try {
    const results = await Promise.allSettled(
      [...viewLifecycles].map((lifecycle) => Promise.resolve().then(() => lifecycle.removed(view)))
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    await service().dispose(view)
  } catch (error) {
    const message = 'Git 清理失败，查看范围退休未确认：' + failure(error).error
    if (state.window) blockedWindows.set(state.window.id, message.slice(0, 500))
    throw new GitReadError('error', message)
  }
  state.views?.delete(view.info.viewId)
  if (state.view === view) state.view = state.views?.values().next().value
}
async function adoptView(state: WindowGitState, view: GitReaderView): Promise<void> {
  if (state.dead) throw new GitReadError('cancelled', 'Git 窗口已关闭')
  const previous = state.view
  const ownedViews = state.views ?? (state.views = new Map())
  ownedViews.set(view.info.viewId, view)
  state.view = view
  try {
    for (const lifecycle of viewLifecycles) await lifecycle.added(view, state.window!.id)
    if (state.dead) throw new GitReadError('cancelled', 'Git 窗口已关闭')
  } catch (error) {
    await disposeOwnedView(state, view)
    state.view = previous?.disposed ? state.views?.values().next().value : previous
    throw error
  }
}
function source(event: IpcMainInvokeEvent): BrowserWindow {
  return getIpcWindow(event, '不支持的 Git 查看来源', {
    windowMustBeLive: true,
    senderMustBeLive: true
  })
}
async function stop(state: WindowGitState, requestId?: string): Promise<GitControlResult> {
  const active = state.active
  if (!active || (requestId !== undefined && requestId !== active.requestId))
    return { status: 'stale' }
  state.generation++
  active.controller.abort()
  if (active.phase === 'dialog') {
    // Electron has no portable native chooser cancellation. Invalidate its reply;
    // ready confirms no owned read exists, not that the OS chooser has closed.
    if (state.active === active) state.active = undefined
    return { status: 'ready' }
  }
  await active.done.catch(() => {})
  return active.error ? { status: 'error', error: active.error } : { status: 'ready' }
}
async function clear(windowId: number): Promise<void> {
  const state = states.get(windowId)
  if (!state) return
  states.delete(windowId)
  state.dead = true
  const task = (async (): Promise<void> => {
    const result = await stop(state)
    if (result.status === 'error') throw new GitReadError('error', result.error)
    const results = await Promise.allSettled(
      viewsOf(state).map((view) => disposeOwnedView(state, view))
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })()
  retiring.set(windowId, task)
  // A rejected task stays in retiring: a new document cannot overlap an unconfirmed old child.
  await task
  if (retiring.get(windowId) === task) retiring.delete(windowId)
}
export function attachGitCleanup(window: BrowserWindow): void {
  const clean = (): void => {
    void clear(window.id).catch((error) =>
      console.error('Git 缓存清理失败：', failure(error).error)
    )
  }
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clean()
  })
  window.webContents.on('render-process-gone', clean)
  window.webContents.once('destroyed', clean)
  window.once('closed', clean)
}
/** Window-owned view IDs are display scopes, never Agent permissions. */
export interface GitWorkbenchHost {
  source: (event: IpcMainInvokeEvent) => BrowserWindow
  currentView: (event: IpcMainInvokeEvent, viewId: string) => GitReaderView | undefined
  operate: <T>(
    event: IpcMainInvokeEvent,
    requestId: string,
    body: (
      state: WindowGitState,
      operation: GitViewOperation,
      assertCurrent: () => void
    ) => Promise<T>
  ) => Promise<T>
  chooserBlocked: (windowId: number) => boolean
  refreshView: (view: GitReaderView, signal?: AbortSignal) => Promise<void>
  beginChooser: (windowId: number) => () => void
  openView: (selectedPath: string, signal?: AbortSignal) => Promise<GitReaderView>
  disposeView: (view: GitReaderView) => Promise<void>
  adoptView: (state: WindowGitState, view: GitReaderView) => Promise<void>
  views: (windowId: number) => GitReaderView[]
  windowOfView: (view: GitReaderView) => BrowserWindow | undefined
  blockView: (view: GitReaderView, message: string) => void
  registerViewLifecycle: (lifecycle: ViewLifecycle) => void
}
export function registerGitView(
  isChooserBlocked: (windowId: number) => boolean,
  registerWorkbench?: (host: GitWorkbenchHost) => void
): void {
  async function operate<T>(
    event: IpcMainInvokeEvent,
    requestId: string,
    body: (
      state: WindowGitState,
      operation: GitViewOperation,
      assertCurrent: () => void
    ) => Promise<T>
  ): Promise<T> {
    const window = source(event)
    const blocked = blockedWindows.get(window.id)
    if (blocked) throw new GitReadError('error', blocked)
    await retiring.get(window.id)
    const state = stateOf(window)
    if (state.active?.phase === 'write')
      throw new GitReadError('error', 'Git 操作正在执行，请等待完成后刷新')
    const generation = ++state.generation
    const previous = state.active
    previous?.controller.abort()
    if (previous?.phase === 'read') await previous.done.catch(() => {})
    if (state.generation !== generation || state.dead)
      throw new GitReadError('cancelled', 'Git 查看请求已替换')
    if (previous?.error) throw new GitReadError('error', previous.error)
    const operation: GitViewOperation = {
      requestId,
      controller: new AbortController(),
      done: Promise.resolve(),
      phase: 'read'
    }
    state.active = operation
    const assertCurrent = (): void => {
      if (
        state.dead ||
        states.get(window.id) !== state ||
        generation !== state.generation ||
        state.active !== operation ||
        operation.controller.signal.aborted ||
        window.isDestroyed() ||
        event.sender.isDestroyed() ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new GitReadError('cancelled', 'Git 查看请求已失效')
    }
    const task = (async () => {
      assertCurrent()
      return body(state, operation, assertCurrent)
    })()
    operation.done = task
    try {
      const result = await task
      if (
        result &&
        typeof result === 'object' &&
        'outcome' in result &&
        result.outcome === 'partial-success' &&
        'message' in result &&
        typeof result.message === 'string' &&
        /退出未确认|清理失败|清理未确认/.test(result.message)
      )
        blockedWindows.set(window.id, (operation.error = result.message.slice(0, 500)))
      return result
    } catch (error) {
      if (error instanceof Error && /退出未确认|清理失败|清理未确认/.test(error.message))
        blockedWindows.set(window.id, (operation.error = failure(error).error))
      throw error
    } finally {
      if (state.active === operation) state.active = undefined
    }
  }
  ipcMain.handle('git:select', async (event, requestId: unknown): Promise<GitSelectionResult> => {
    const window = source(event)
    if (!isGitViewId(requestId)) throw new Error('Git 请求标识无效')
    let acquired = false
    try {
      if (isChooserBlocked(window.id) || choosers.has(window.id))
        throw new GitReadError('error', '请先处理当前审批、问答或关闭对话框')
      choosers.add(window.id)
      acquired = true
      return await operate(event, requestId, async (state, operation, assertCurrent) => {
        state.choosing = true
        operation.phase = 'dialog'
        let selected: Awaited<ReturnType<typeof dialog.showOpenDialog>>
        try {
          selected = await dialog.showOpenDialog(window, {
            title: '选择 Git 查看目录',
            properties: ['openDirectory']
          })
        } finally {
          state.choosing = false
        }
        assertCurrent()
        if (selected.canceled || !selected.filePaths[0]) return { status: 'cancelled', requestId }
        if (isChooserBlocked(window.id))
          throw new GitReadError('error', '当前模态等待期间不能选择新目录')
        operation.phase = 'read'
        const view = await service().open(selected.filePaths[0], operation.controller.signal)
        try {
          assertCurrent()
          for (const previous of viewsOf(state)) await disposeOwnedView(state, previous)
          assertCurrent()
          await adoptView(state, view)
          assertCurrent()
          return { status: 'ready', requestId, view: view.info }
        } catch (error) {
          if (viewsOf(state).includes(view)) await disposeOwnedView(state, view)
          else if (!view.disposed) await service().dispose(view)
          throw error
        }
      })
    } catch (error) {
      const result = failure(error)
      return result.status === 'cancelled'
        ? { status: 'cancelled', requestId }
        : { ...result, requestId }
    } finally {
      if (acquired) choosers.delete(window.id)
    }
  })
  ipcMain.handle(
    'git:repositories',
    async (event, requestId: unknown): Promise<GitRepositoryCollectionResult> => {
      const window = source(event)
      if (!isGitWorkbenchId(requestId)) throw new Error('Git 仓库列表请求无效')
      try {
        const blocked = blockedWindows.get(window.id)
        if (blocked) throw new GitReadError('error', blocked)
        await retiring.get(window.id)
        if (window.isDestroyed()) throw new GitReadError('stale', 'Git 窗口已关闭')
        return {
          requestId,
          status: 'ready',
          views: getSelectedGitViews(window.id).map((view) => ({ ...view.info })),
          addedViewIds: [],
          warnings: [],
          limit: gitRepositoryLimit
        }
      } catch (error) {
        const result = failure(error)
        return result.status === 'cancelled'
          ? { requestId, status: 'cancelled' }
          : { requestId, ...result }
      }
    }
  )
  ipcMain.handle(
    'git:add-repositories',
    async (event, requestId: unknown): Promise<GitRepositoryCollectionResult> => {
      const window = source(event)
      if (!isGitWorkbenchId(requestId)) throw new Error('Git 多目录选择请求无效')
      let acquired = false
      try {
        if (isChooserBlocked(window.id) || choosers.has(window.id))
          throw new GitReadError('error', '请先处理当前目录选择或对话框')
        choosers.add(window.id)
        acquired = true
        return await operate(event, requestId, async (state, operation, assertCurrent) => {
          state.choosing = true
          operation.phase = 'dialog'
          let selected: Awaited<ReturnType<typeof dialog.showOpenDialog>>
          try {
            selected = await dialog.showOpenDialog(window, {
              title: '添加 Git 仓库或工作树',
              properties: ['openDirectory', 'multiSelections']
            })
          } finally {
            state.choosing = false
          }
          assertCurrent()
          if (selected.canceled || !selected.filePaths.length)
            return { status: 'cancelled', requestId }
          if (isChooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
          if (selected.filePaths.length > gitRepositoryLimit)
            throw new GitReadError('too-large', `每次最多选择 ${gitRepositoryLimit} 个 Git 范围`)
          operation.phase = 'read'
          const addedViewIds: string[] = [],
            warnings: string[] = []
          const newlyOwned: GitReaderView[] = []
          try {
            for (const selectedPath of selected.filePaths) {
              assertCurrent()
              let candidate: GitReaderView | undefined
              try {
                candidate = await service().open(selectedPath, operation.controller.signal)
                assertCurrent()
                const normalized = (value: string): string =>
                  process.platform === 'win32'
                    ? path.resolve(value).toLowerCase()
                    : path.resolve(value)
                const existing = viewsOf(state).find((view) => {
                  if (
                    normalized(view.info.repositoryPath) !==
                    normalized(candidate!.info.repositoryPath)
                  )
                    return false
                  const scope = normalized(view.info.selectedPath),
                    incoming = normalized(candidate!.info.selectedPath)
                  return (
                    scope === incoming ||
                    incoming.startsWith(scope + path.sep) ||
                    scope.startsWith(incoming + path.sep)
                  )
                })
                if (existing) {
                  warnings.push('所选目录已由现有 Git 范围覆盖，请先移除重叠范围再添加。')
                  await service().dispose(candidate)
                  candidate = undefined
                  continue
                }
                if (viewsOf(state).length >= gitRepositoryLimit)
                  throw new GitReadError(
                    'too-large',
                    `当前窗口最多保留 ${gitRepositoryLimit} 个 Git 范围`
                  )
                await adoptView(state, candidate)
                newlyOwned.push(candidate)
                addedViewIds.push(candidate.info.viewId)
                candidate = undefined
                assertCurrent()
              } catch (error) {
                if (candidate) await service().dispose(candidate)
                if (
                  operation.controller.signal.aborted ||
                  state.dead ||
                  (error instanceof GitReadError && error.status === 'cancelled') ||
                  (error instanceof Error && /退出未确认|清理失败|清理未确认/.test(error.message))
                )
                  throw error
                warnings.push(failure(error).error)
              }
            }
            assertCurrent()
            return {
              requestId,
              status: 'ready',
              views: viewsOf(state).map((view) => ({ ...view.info })),
              addedViewIds,
              warnings,
              limit: gitRepositoryLimit
            }
          } catch (error) {
            // A cancelled chooser operation must not retain views unknown to its caller.
            for (const view of newlyOwned) await disposeOwnedView(state, view)
            throw error
          }
        })
      } catch (error) {
        const result = failure(error)
        return result.status === 'cancelled'
          ? { requestId, status: 'cancelled' }
          : { requestId, ...result }
      } finally {
        if (acquired) choosers.delete(window.id)
      }
    }
  )
  ipcMain.handle('git:list', async (event, value: unknown): Promise<GitListResult> => {
    source(event)
    const request = parseGitListRequest(value)
    if (!request) throw new Error('Git 列表请求无效')
    if (!getSelectedGitViews(source(event).id).some((view) => view.info.viewId === request.viewId))
      return { ...request, status: 'stale', error: 'Git 查看范围已失效' }
    try {
      return await operate(event, request.requestId, async (state, operation, assertCurrent) => {
        operation.viewId = request.viewId
        const view = viewsOf(state).find((candidate) => candidate.info.viewId === request.viewId)
        if (!view) throw new GitReadError('stale', 'Git 查看范围已失效')
        const result = await service().refresh(view, operation.controller.signal)
        assertCurrent()
        return { ...request, status: 'ready', ...result }
      })
    } catch (error) {
      const result = failure(error)
      return result.status === 'cancelled'
        ? { ...request, status: 'cancelled' }
        : { ...request, ...result }
    }
  })
  ipcMain.handle('git:read', async (event, value: unknown): Promise<GitItemResult> => {
    source(event)
    const request = parseGitItemRequest(value)
    if (!request) throw new Error('Git 项目请求无效')
    const current = getSelectedGitViews(source(event).id).find(
      (view) => view.info.viewId === request.viewId
    )
    if (
      current?.info.viewId !== request.viewId ||
      current.snapshot?.revision !== request.revision ||
      !current.snapshot.items.some((item) => item.itemId === request.itemId)
    )
      return { ...request, status: 'stale', error: 'Git 列表或项目已失效，请刷新' }
    try {
      return await operate(event, request.requestId, async (state, operation, assertCurrent) => {
        operation.viewId = request.viewId
        const view = viewsOf(state).find((candidate) => candidate.info.viewId === request.viewId)
        if (!view) throw new GitReadError('stale', 'Git 查看范围已失效')
        const result = await service().read(
          view,
          request.revision,
          request.itemId,
          operation.controller.signal
        )
        assertCurrent()
        return { ...request, status: 'ready', ...result }
      })
    } catch (error) {
      const result = failure(error)
      return result.status === 'cancelled'
        ? { ...request, status: 'cancelled' }
        : { ...request, ...result }
    }
  })
  ipcMain.handle('git:cancel', async (event, requestId: unknown): Promise<GitControlResult> => {
    const window = source(event)
    if (!isGitViewId(requestId)) throw new Error('Git 请求标识无效')
    const state = states.get(window.id)
    return state ? stop(state, requestId) : { status: 'stale' }
  })
  ipcMain.handle('git:release', async (event, viewId: unknown): Promise<GitControlResult> => {
    const window = source(event)
    if (!isGitViewId(viewId)) throw new Error('Git 查看标识无效')
    const blocked = blockedWindows.get(window.id)
    if (blocked) return { status: 'error', error: blocked }
    const state = states.get(window.id)
    const view = viewsOf(state).find((candidate) => candidate.info.viewId === viewId)
    if (!state || !view) return { status: 'stale' }
    const stopped =
      state.active?.viewId === viewId ? await stop(state) : { status: 'stale' as const }
    if (stopped.status === 'error') return stopped
    try {
      await disposeOwnedView(state, view)
      return { status: 'ready' }
    } catch (error) {
      return { status: 'error', error: failure(error).error }
    }
  })
  registerWorkbench?.({
    source,
    currentView: (event, viewId) => {
      return getSelectedGitViews(source(event).id).find((view) => view.info.viewId === viewId)
    },
    operate,
    chooserBlocked: (windowId) => isChooserBlocked(windowId) || choosers.has(windowId),
    refreshView: async (view, signal) => {
      await service().refresh(view, signal)
    },
    beginChooser: (windowId) => {
      if (isChooserBlocked(windowId) || choosers.has(windowId))
        throw new GitReadError('error', '请先处理当前目录选择或对话框')
      choosers.add(windowId)
      let finished = false
      return () => {
        if (finished) return
        finished = true
        choosers.delete(windowId)
      }
    },
    openView: (selectedPath, signal) => service().open(selectedPath, signal),
    disposeView: async (view) => {
      const state = [...states.values()].find((candidate) => viewsOf(candidate).includes(view))
      if (state) await disposeOwnedView(state, view)
      else {
        for (const lifecycle of viewLifecycles) await lifecycle.removed(view)
        await service().dispose(view)
      }
    },
    adoptView,
    views: getSelectedGitViews,
    windowOfView: (view) =>
      [...states.values()].find((state) => !state.dead && viewsOf(state).includes(view))?.window,
    blockView: (view, message) => {
      const state = [...states.values()].find((candidate) => viewsOf(candidate).includes(view))
      if (state?.window)
        blockedWindows.set(state.window.id, message.replace(/\p{Cc}/gu, ' ').slice(0, 500))
    },
    registerViewLifecycle: (lifecycle) => {
      viewLifecycles.add(lifecycle)
    }
  })
}
