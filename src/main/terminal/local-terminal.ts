import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { createTerminalProcess } from './terminal-process'
import type { TerminalProcess } from './terminal-process'
import { isTerminalId, isTerminalSize } from '../../shared/terminal'
import type { TerminalEvent, TerminalResult } from '../../shared/terminal'
import { getIpcWindow } from '../ipc-source'
import { getAppSettings } from '../settings/settings-service'
import { resolveTerminalShell } from '../settings/terminal-shell'
import { hasSettingsMutation } from '../settings/settings-ipc'
import { validContext, type WorkbenchContext } from '../../shared/workbench'
import { resolveExecutionContext, executionStillCurrent } from '../execution/execution-context'

// 终端会话管理
type Session = {
  conversationId?: string
  id: string
  process: TerminalProcess
  subscriptions: Array<{ dispose: () => void }>
  owner: WebContents
  exited: boolean
  exitSubscribed: boolean
  closing: boolean
  closeRequest?: Promise<TerminalResult>
  finishClose?: (result: TerminalResult) => void
}
// 终端会话映射：窗口 ID -> 会话
const sessions = new Map<string, Session>()
const starts = new Map<
  string,
  { ownerId: number; id: string; canceled: boolean; finished: Promise<void>; finish: () => void }
>()
const CLOSE_TIMEOUT_MS = 10_000
let quitting = false
const sessionKey = (ownerId: number, id: string): string => `${ownerId}:${id}`
// 获取终端请求的窗口来源
function ownerOf(event: IpcMainInvokeEvent): WebContents {
  getIpcWindow(event, '不支持的终端请求来源', { windowMustBeLive: true, senderMustBeLive: true })
  return event.sender
}
// 向窗口发送终端事件
function emit(owner: WebContents, event: TerminalEvent): void {
  if (!owner.isDestroyed()) {
    try {
      owner.send('terminal:event', event)
    } catch (error) {
      console.error('终端事件发送失败：', failure(error).error)
    }
  }
}
// 终端操作失败的统一处理
function failure(error: unknown): Extract<TerminalResult, { ok: false }> {
  const message = error instanceof Error ? error.message : '终端操作失败'
  return { ok: false, error: message.slice(0, 300) || '终端操作失败' }
}
function keepSubscription(session: Session, subscription: { dispose: () => void }): void {
  // 极快退出可以发生在订阅调用返回前。
  if (session.exited) subscription.dispose()
  else session.subscriptions.push(subscription)
}

function observeExit(session: Session): void {
  if (session.exitSubscribed || session.exited) return
  const subscription = session.process.onExit(({ exitCode, error }) => {
    if (session.exited) return
    session.exited = true
    if (sessions.get(sessionKey(session.owner.id, session.id)) === session)
      sessions.delete(sessionKey(session.owner.id, session.id))
    for (const listener of session.subscriptions.splice(0)) {
      try {
        listener.dispose()
      } catch (error) {
        console.error('终端订阅释放失败：', failure(error).error)
      }
    }
    if (error) console.error('终端宿主清理失败：', error)
    session.finishClose?.(error ? { ok: false, error } : { ok: true })
    // 显式关闭由 invoke 返回确认；自然退出才通知 renderer。
    if (!session.closing) emit(session.owner, { sessionId: session.id, type: 'exit', exitCode })
  })
  session.exitSubscribed = true
  keepSubscription(session, subscription)
}

// kill() 只请求关闭；收到退出事件后才释放窗口槽位并确认成功。
function stop(ownerId: number, id?: string): Promise<TerminalResult> {
  const pending = id ? starts.get(sessionKey(ownerId, id)) : undefined
  if (pending) pending.canceled = true
  const session = id
    ? sessions.get(sessionKey(ownerId, id))
    : [...sessions.values()].find((item) => item.owner.id === ownerId)
  // 重复关闭和旧 ID 关闭都不能误伤新会话。
  if (!session || (id !== undefined && session.id !== id))
    return pending ? pending.finished.then(() => stop(ownerId, id)) : Promise.resolve({ ok: true })
  if (session.closeRequest) return session.closeRequest
  session.closing = true
  let finish!: (result: TerminalResult) => void
  const request = new Promise<TerminalResult>((resolve) => {
    finish = resolve
  })
  session.closeRequest = request
  const timeout = setTimeout(() => {
    session.finishClose?.({ ok: false, error: '终端退出尚未确认，请重试关闭终端' })
  }, CLOSE_TIMEOUT_MS)
  session.finishClose = (result) => {
    clearTimeout(timeout)
    session.finishClose = undefined
    session.closeRequest = undefined
    finish(result)
  }
  try {
    // 创建时订阅失败也保留清理句柄，并在关闭时重试公开退出订阅。
    observeExit(session)
  } catch (error) {
    try {
      void session.process.kill().catch((cause: unknown) => {
        console.error('终端清理失败：', failure(cause).error)
      })
    } catch (killError) {
      console.error('终端清理失败：', failure(killError).error)
    }
    session.finishClose?.(failure(error))
    return request
  }
  try {
    if (!session.exited)
      void session.process.kill().catch((error: unknown) => session.finishClose?.(failure(error)))
  } catch (error) {
    // 保留监听、ID 和槽位；迟到退出仍能收口，或由用户重试。
    session.finishClose?.(failure(error))
  }
  return request
}

function cleanup(ownerId: number, id?: string): void {
  const owned = id
    ? [id]
    : [
        ...sessions.values(),
        ...[...starts.values()]
          .filter((start) => !sessions.has(sessionKey(start.ownerId, start.id)))
          .map((start) => ({ id: start.id, owner: { id: start.ownerId } }))
      ]
        .filter((session) => session.owner.id === ownerId)
        .map((session) => session.id)
  for (const sessionId of owned)
    void stop(ownerId, sessionId).then((result) => {
      if (!result.ok) console.error('终端清理失败：', result.error)
    })
}

function attachQuitCleanup(): void {
  app.on('before-quit', (event) => {
    // 仍有窗口时，先由既有关闭保护决定是否关闭，不提前结束 PTY。
    if (BrowserWindow.getAllWindows().length > 0 || sessions.size === 0) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    void Promise.all(
      [...sessions.values()].map((session) => stop(session.owner.id, session.id))
    ).then((results) => {
      const errors = results.filter((result) => !result.ok)
      if (errors.length > 0) {
        errors.forEach((result) => console.error('应用退出时终端清理失败：', result.error))
        // 没有窗口可重试时，以失败退出码记录有界清理失败，不冒充正常退出。
        app.exit(1)
        return
      }
      app.quit()
    })
  })
}

// 注册终端接口
export function attachTerminalCleanup(window: BrowserWindow): void {
  const owner = window.webContents
  const ownerId = owner.id
  const clean = (): void => cleanup(ownerId)
  // 页面刷新不能依赖 renderer 的异步 cleanup 一定送达。
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clean()
  })
  owner.on('render-process-gone', clean)
  owner.once('destroyed', clean)
  // 不挂 window.close：关闭保护可能取消这次关闭。
}
// 注册终端接口
export function registerLocalTerminal(): void {
  attachQuitCleanup()
  ipcMain.handle(
    'terminal:start',
    async (
      event,
      id: unknown,
      size: unknown,
      context?: WorkbenchContext
    ): Promise<TerminalResult> => {
      const owner = ownerOf(event)
      if (!isTerminalId(id) || !isTerminalSize(size)) {
        return { ok: false, error: '终端 ID 或尺寸无效' }
      }
      if (quitting) return { ok: false, error: '应用正在退出' }
      if (sessions.has(sessionKey(owner.id, id)) || starts.has(sessionKey(owner.id, id)))
        return { ok: false, error: '终端 ID 已存在' }
      if ([...sessions.values()].filter((session) => session.owner.id === owner.id).length >= 16)
        return { ok: false, error: '同一窗口最多运行 16 个终端' }
      if (process.platform !== 'win32') return { ok: false, error: '本课仅支持 Windows' }

      let finishStart!: () => void
      const startState = {
        ownerId: owner.id,
        id,
        canceled: false,
        finished: new Promise<void>((resolve) => {
          finishStart = resolve
        }),
        finish: () => finishStart()
      }
      starts.set(sessionKey(owner.id, id), startState)
      try {
        if (hasSettingsMutation()) return { ok: false, error: '设置正在保存，请稍后创建终端' }
        const shell = resolveTerminalShell(getAppSettings().terminalShell)
        let cwd = app.getPath('home')
        if (context !== undefined) {
          if (!validContext(context)) throw new Error('终端会话上下文无效')
          const window = getIpcWindow(event, '终端来源无效')
          const execution = await resolveExecutionContext(window.id, {
            ...context,
            mode: 'execute'
          })
          if (!executionStillCurrent(window.id, { ...context, mode: 'execute' }, execution))
            throw new Error('终端目录已变化')
          cwd = execution.info.cwd
        }
        if (startState.canceled || owner.isDestroyed() || quitting || hasSettingsMutation())
          throw new Error('终端启动上下文已失效')
        if (sessions.has(sessionKey(owner.id, id))) return { ok: false, error: '终端 ID 已存在' }
        if ([...sessions.values()].filter((session) => session.owner.id === owner.id).length >= 16)
          return { ok: false, error: '同一窗口最多运行 16 个终端' }
        const child = createTerminalProcess(id, shell, cwd, size)
        const session: Session = {
          id,
          conversationId: context?.conversationId,
          owner,
          process: child,
          subscriptions: [],
          exited: false,
          exitSubscribed: false,
          closing: false
        }
        sessions.set(sessionKey(owner.id, id), session)
        observeExit(session)
        if (!session.exited) {
          keepSubscription(
            session,
            child.onData((data) => {
              if (sessions.get(sessionKey(owner.id, id)) === session && !session.closing)
                emit(owner, { sessionId: id, type: 'data', data })
            })
          )
        }
        await child.ready
        if (session.closing) {
          return { ok: false, error: '终端启动已取消或已退出' }
        }
        return { ok: true }
      } catch (error) {
        // 若创建后订阅失败，退出未确认之前不丢失清理句柄。
        cleanup(owner.id, id)
        return failure(error)
      } finally {
        starts.delete(sessionKey(owner.id, id))
        startState.finish()
      }
    }
  )
  // 向终端发送数据
  ipcMain.handle(
    'terminal:write',
    async (event, id: unknown, data: unknown): Promise<TerminalResult> => {
      const owner = ownerOf(event)
      if (
        !isTerminalId(id) ||
        typeof data !== 'string' ||
        data.length === 0 ||
        data.length > 8192
      ) {
        return { ok: false, error: '终端输入无效或过长（单次最多 8192 字符）' }
      }
      const session = sessions.get(sessionKey(owner.id, id))
      if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
      if (session.closing) return { ok: false, error: '终端正在关闭' }
      try {
        await session.process.write(data)
        return { ok: true }
      } catch (error) {
        return failure(error)
      }
    }
  )
  // 调整终端大小
  ipcMain.handle(
    'terminal:resize',
    async (event, id: unknown, size: unknown): Promise<TerminalResult> => {
      const owner = ownerOf(event)
      if (!isTerminalId(id) || !isTerminalSize(size)) return { ok: false, error: '终端尺寸无效' }
      const session = sessions.get(sessionKey(owner.id, id))
      if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
      if (session.closing) return { ok: false, error: '终端正在关闭' }
      try {
        await session.process.resize(size.cols, size.rows)
        return { ok: true }
      } catch (error) {
        return failure(error)
      }
    }
  )
  // 关闭终端
  ipcMain.handle('terminal:close', (event, id: unknown): Promise<TerminalResult> => {
    const owner = ownerOf(event)
    if (!isTerminalId(id)) return Promise.resolve({ ok: false, error: '终端 ID 无效' })
    return stop(owner.id, id)
  })
}
