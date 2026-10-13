import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import {
  parseGitWorkbenchRequest,
  parseGitReviewRequest,
  parseGitDiffRequest,
  parseGitActionRequest,
  parseGitGenerateRequest,
  parseGitFullFileRequest,
  isGitWorkbenchId
} from '../../shared/git-workbench'
import type { GitWorkbenchRequest, GitWorkbenchResult } from '../../shared/git-workbench'
import type { GitWorkbenchHost } from './git-ipc'
import { GitReadError } from './git-process'
import { createGitWorkbenchReader } from './git-workbench-reader'
import { createGitWorkbenchWriter } from './git-workbench-writer'
import { generateGitText } from './git-workbench-generation'
import { createGitWorkbenchRemote, gitRemoteTransport } from './git-workbench-remote'
import { readGitFullFile } from './git-workbench-file'
import { createGitWorkbenchWorktrees } from './git-workbench-worktrees'
import { fetchGitWorkbench } from './git-workbench-fetch'
import { initializeGitDirectory } from './git-workbench-init'
import type { GitSelectionResult } from '../../shared/git-view'
import { gitRepositoryLimit } from '../../shared/git-repositories'
import type { GitReaderView } from './git-reader'
import type { GitInvalidatedEvent } from '../../shared/git-observation'
import { createGitWorkbenchObservers } from './git-workbench-observers'
import { createGitWorkbenchTurns } from './git-workbench-turns'
import { configureGitTurnHost } from './git-turn-host'
import { createGitWorkbenchPullRequests } from './git-workbench-pr'
import {
  parseGitPullRequestListRequest,
  parseGitPullRequestDetailRequest,
  parseGitPullRequestMergeRequest
} from '../../shared/git-pr'

/** Uses the existing native selection and document retirement barrier. No second permission system. */
export function registerGitWorkbench(host: GitWorkbenchHost): void {
  const cacheRoot = path.join(app.getPath('temp'), 'ZoneCodex-git-turn-' + process.pid)
  const sequences = new Map<GitReaderView, number>()
  const observerStates = new Map<GitReaderView, Pick<GitInvalidatedEvent, 'status' | 'message'>>()
  const initialHealthDelivered = new Set<GitReaderView>()
  const emit = (
    view: GitReaderView,
    event: Omit<GitInvalidatedEvent, 'viewId' | 'sequence'>
  ): void => {
    const window = host.windowOfView(view)
    if (!window || view.disposed || window.isDestroyed() || window.webContents.isDestroyed()) return
    const sequence = (sequences.get(view) ?? 0) + 1
    sequences.set(view, sequence)
    try {
      window.webContents.send('git:invalidated', { ...event, viewId: view.info.viewId, sequence })
    } catch {
      // Retirement removes ownership before a replacement document can receive an event.
    }
  }
  const turns = createGitWorkbenchTurns({
    cacheRoot,
    onChanged: (view) => {
      const state = turns.state(view)
      if (state.message && /退出未确认|清理失败|清理未确认/.test(state.message))
        host.blockView(view, state.message)
      emit(view, { reason: 'turn', ...(observerStates.get(view) ?? { status: 'watching' }) })
    }
  })
  const observers = createGitWorkbenchObservers({
    excludeRoots: [cacheRoot, path.join(app.getPath('temp'), 'ZoneCodex-git-view-' + process.pid)],
    onInvalidate: (view, event) => {
      const status = { status: event.status, ...(event.message ? { message: event.message } : {}) }
      observerStates.set(view, status)
      emit(view, { reason: event.reason, ...status })
    }
  })
  const pullRequests = createGitWorkbenchPullRequests({})
  host.registerViewLifecycle({
    added: (view) => observers.watch(view),
    removed: async (view) => {
      // All resources settle, even if one cleanup fails. A failure keeps the host blocked.
      const results = await Promise.allSettled([
        observers.release(view),
        turns.release(view),
        pullRequests.releaseView(view.info.viewId)
      ])
      sequences.delete(view)
      observerStates.delete(view)
      initialHealthDelivered.delete(view)
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  })
  configureGitTurnHost(async (windowId) => {
    const views = host.views(windowId)
    if (!views.length) return undefined
    const token = await turns.start([...views])
    return (status) => turns.complete(token, status)
  })
  const reader = createGitWorkbenchReader({ turns })
  const writer = createGitWorkbenchWriter({})
  const remote = createGitWorkbenchRemote({})
  const worktrees = createGitWorkbenchWorktrees({
    registryRoot: path.join(app.getPath('userData'), 'git-worktree-ownership')
  })
  ipcMain.handle('git:init', async (event, requestId: unknown): Promise<GitSelectionResult> => {
    const window = host.source(event)
    if (!isGitWorkbenchId(requestId)) throw new Error('Git 初始化请求无效')
    let finishChooser: (() => void) | undefined
    try {
      finishChooser = host.beginChooser(window.id)
      return await host.operate(event, requestId, async (state, operation, assertCurrent) => {
        state.choosing = true
        operation.phase = 'dialog'
        let chosen: Awaited<ReturnType<typeof dialog.showOpenDialog>>
        try {
          chosen = await dialog.showOpenDialog(window, {
            title: '选择要初始化 Git 的目录',
            properties: ['openDirectory']
          })
        } finally {
          state.choosing = false
          finishChooser?.()
        }
        assertCurrent()
        if (chosen.canceled || !chosen.filePaths[0]) return { status: 'cancelled', requestId }
        if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
        operation.phase = 'write'
        await initializeGitDirectory(
          chosen.filePaths[0],
          path.join(app.getPath('temp'), 'ZoneCodex-git-init-' + process.pid),
          operation.controller.signal
        )
        // Initialization has already happened. A cancelled/failed adoption must say so.
        let view: Awaited<ReturnType<GitWorkbenchHost['openView']>> | undefined
        try {
          assertCurrent()
          view = await host.openView(chosen.filePaths[0], operation.controller.signal)
          assertCurrent()
          if (host.views(window.id).length >= gitRepositoryLimit)
            throw new GitReadError(
              'too-large',
              `当前窗口最多保留 ${gitRepositoryLimit} 个 Git 范围；请先移除一个范围`
            )
          const existing = host
            .views(window.id)
            .find(
              (candidate) =>
                path.resolve(candidate.info.repositoryPath).toLowerCase() ===
                path.resolve(view!.info.repositoryPath).toLowerCase()
            )
          if (existing)
            throw new GitReadError('unsupported', '该仓库已在当前窗口打开，请先移除原查看范围')
          assertCurrent()
          await host.adoptView(state, view)
          assertCurrent()
          return { status: 'ready', requestId, view: view.info }
        } catch (error) {
          if (view) await host.disposeView(view)
          throw new GitReadError(
            'error',
            '目录已初始化 Git，但打开查看未完成；请重新选择目录。' +
              (error instanceof Error ? error.message : '')
          )
        }
      })
    } catch (error) {
      if (error instanceof GitReadError && error.status === 'cancelled')
        return { status: 'cancelled', requestId }
      return {
        requestId,
        status: error instanceof GitReadError ? error.status : 'error',
        error: (error instanceof Error ? error.message : 'Git 初始化失败')
          .replace(/\p{Cc}/gu, ' ')
          .slice(0, 1000)
      }
    } finally {
      finishChooser?.()
    }
  })
  async function handle<T>(
    event: IpcMainInvokeEvent,
    request: GitWorkbenchRequest,
    body: Parameters<GitWorkbenchHost['operate']>[2]
  ): Promise<GitWorkbenchResult<T>> {
    host.source(event)
    if (!host.currentView(event, request.viewId))
      return { ...request, status: 'stale', error: 'Git 查看范围已失效，请重新选择目录' }
    try {
      const data = await host.operate(
        event,
        request.requestId,
        async (state, operation, assertCurrent) => {
          const view = host.currentView(event, request.viewId)
          if (!view || view.disposed) throw new GitReadError('stale', 'Git 查看范围已失效')
          state.view = view
          operation.viewId = request.viewId
          return body(state, operation, assertCurrent)
        }
      )
      return {
        requestId: request.requestId,
        viewId: request.viewId,
        status: 'ready',
        data: data as T
      }
    } catch (error) {
      if (error instanceof GitReadError && error.status === 'cancelled')
        return { requestId: request.requestId, viewId: request.viewId, status: 'cancelled' }
      return {
        requestId: request.requestId,
        viewId: request.viewId,
        status: error instanceof GitReadError ? error.status : 'error',
        error: (error instanceof Error ? error.message : 'Git 操作失败，请刷新确认仓库现状')
          .replace(/\p{Cc}/gu, ' ')
          .slice(0, 1000)
      }
    }
  }
  ipcMain.handle('git:metadata', async (event, value: unknown) => {
    host.source(event)
    const request = parseGitWorkbenchRequest(value)
    if (!request) throw new Error('Git 仓库请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      await host.refreshView(state.view!, operation.controller.signal)
      assertCurrent()
      await observers.watch(state.view!)
      assertCurrent()
      const result = await reader.metadata(state.view!, operation.controller.signal)
      const context = await reader.context(
        state.view!,
        result.revision,
        operation.controller.signal
      )
      const augmented = await worktrees.metadata(
        context,
        await remote.metadata(context, result, operation.controller.signal),
        operation.controller.signal
      )
      assertCurrent()
      // The first watch can publish before the chooser reply reaches the UI.
      // Deliver its limited/error health once after the UI owns this scope; never loop on metadata.
      if (!initialHealthDelivered.has(state.view!)) {
        initialHealthDelivered.add(state.view!)
        const health = observerStates.get(state.view!)
        if (health && (health.status !== 'watching' || health.message))
          emit(state.view!, { reason: 'recovery', ...health })
      }
      return augmented
    })
  })
  ipcMain.handle('git:review', async (event, value: unknown) => {
    host.source(event)
    const request = parseGitReviewRequest(value)
    if (!request) throw new Error('Git 比较请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      const result = await reader.review(state.view!, request, operation.controller.signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:diff', async (event, value: unknown) => {
    host.source(event)
    const request = parseGitDiffRequest(value)
    if (!request) throw new Error('Git 差异请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      const result = await reader.diff(state.view!, request, operation.controller.signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:action', async (event, value: unknown) => {
    const window = host.source(event)
    const request = parseGitActionRequest(value)
    if (!request) throw new Error('Git 操作请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      assertCurrent()
      let parentPath: string | undefined
      if (request.action === 'create-worktree') {
        const finishChooser = host.beginChooser(window.id)
        operation.phase = 'dialog'
        state.choosing = true
        try {
          const chosen = await dialog.showOpenDialog(window, {
            title: '选择新工作树的存放目录',
            properties: ['openDirectory']
          })
          assertCurrent()
          if (chosen.canceled || !chosen.filePaths[0])
            throw new GitReadError('cancelled', '工作树目录选择已取消')
          parentPath = chosen.filePaths[0]
        } finally {
          state.choosing = false
          finishChooser()
        }
      }
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      operation.phase = 'write'
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      if (request.action === 'fetch') {
        const env = await remote.networkEnvironment(
          context,
          request.remoteId,
          operation.controller.signal
        )
        try {
          return await fetchGitWorkbench(
            context,
            request.remoteId,
            env,
            operation.controller.signal
          )
        } finally {
          delete env.GIT_CONFIG_VALUE_0
        }
      }
      if (request.action === 'push' || request.action === 'create-pr')
        return remote.execute(context, request, operation.controller.signal)
      if (request.action === 'create-worktree' || request.action === 'remove-worktree')
        return worktrees.execute(context, request, parentPath, operation.controller.signal)
      if (request.action === 'commit-and-push') {
        const target = context.remotes.get(request.remoteId)
        if (!target || !gitRemoteTransport(target.url) || context.location.scopePath)
          throw new GitReadError('unsupported', '提交并推送需要仓库根目录及受支持的 HTTPS 远程地址')
        const before = await reader.metadata(state.view!, operation.controller.signal)
        if (!before.branch) throw new GitReadError('unsupported', '请先切换到本地分支再提交并推送')
        const committed = await writer.execute(
          context,
          {
            requestId: request.requestId,
            viewId: request.viewId,
            revision: request.revision,
            action: 'commit',
            message: request.message,
            includeUnstaged: request.includeUnstaged,
            ...(request.authorName !== undefined ? { authorName: request.authorName } : {}),
            ...(request.authorEmail !== undefined ? { authorEmail: request.authorEmail } : {})
          },
          operation.controller.signal
        )
        if (committed.headSha) state.view!.info.head = 'present'
        if (committed.outcome !== 'success' || !committed.headSha) return committed
        try {
          await host.refreshView(state.view!, operation.controller.signal)
          const data = await reader.metadata(state.view!, operation.controller.signal)
          if (data.headSha !== committed.headSha || data.branch !== before.branch)
            throw new GitReadError('stale', '提交后 HEAD 或分支发生变化，未继续推送')
          const next = await reader.context(state.view!, data.revision, operation.controller.signal)
          const selected = [...next.remotes.entries()].find(
            ([, item]) => item.name === target.name && item.url === target.url
          )
          if (!selected) throw new GitReadError('stale', '提交后远程地址发生变化，未继续推送')
          const pushed = await remote.execute(
            next,
            {
              requestId: request.requestId,
              viewId: request.viewId,
              revision: data.revision,
              action: 'push',
              remoteId: selected[0],
              forceWithLease: request.forceWithLease
            },
            operation.controller.signal
          )
          return {
            ...pushed,
            stage: 'commit-and-push',
            appliedItemIds: committed.appliedItemIds,
            headSha: committed.headSha,
            message: committed.message + '；' + pushed.message
          }
        } catch (error) {
          return {
            ...committed,
            outcome: 'partial-success' as const,
            stage: 'commit',
            message:
              '提交已完成；推送未完整确认。' +
              (error instanceof Error
                ? error.message.replace(/\p{Cc}/gu, ' ').slice(0, 700)
                : '请核对仓库和远程状态')
          }
        }
      }
      const result = await writer.execute(context, request, operation.controller.signal)
      // Only an actual manual write may transition our owned unborn view to present.
      if (request.action === 'commit' && result.headSha) state.view!.info.head = 'present'
      return result
    })
  })
  ipcMain.handle('git:generate', async (event, value: unknown) => {
    const window = host.source(event)
    const request = parseGitGenerateRequest(value)
    if (!request) throw new Error('Git 生成请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(60_000)])
      const result = await generateGitText(context, request, signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:full-file', async (event, value: unknown) => {
    host.source(event)
    const request = parseGitFullFileRequest(value)
    if (!request) throw new Error('Git 完整文件请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (turns.ownsRevision(state.view!, request.revision)) {
        const result = await turns.fullFile(state.view!, request, operation.controller.signal)
        assertCurrent()
        return result
      }
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      const result = await readGitFullFile(context, request, operation.controller.signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:pr-list', async (event, value: unknown) => {
    const window = host.source(event)
    const request = parseGitPullRequestListRequest(value)
    if (!request) throw new Error('PR 列表请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      const result = await pullRequests.list(context, request, operation.controller.signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:pr-detail', async (event, value: unknown) => {
    const window = host.source(event)
    const request = parseGitPullRequestDetailRequest(value)
    if (!request) throw new Error('PR 详情请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      const result = await pullRequests.detail(context, request, operation.controller.signal)
      assertCurrent()
      return result
    })
  })
  ipcMain.handle('git:pr-merge', async (event, value: unknown) => {
    const window = host.source(event)
    const request = parseGitPullRequestMergeRequest(value)
    if (!request) throw new Error('PR 合并请求无效')
    return handle(event, request, async (state, operation, assertCurrent) => {
      if (host.chooserBlocked(window.id)) throw new GitReadError('error', '请先处理当前对话框')
      assertCurrent()
      operation.phase = 'write'
      const context = await reader.context(
        state.view!,
        request.revision,
        operation.controller.signal
      )
      // Never discard a truthful partial result because cancellation followed a remote side effect.
      return pullRequests.merge(context, request, operation.controller.signal)
    })
  })
}
