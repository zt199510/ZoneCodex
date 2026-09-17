import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { isTerminalId, isTerminalSize } from '../../shared/terminal'
import type { TerminalEvent, TerminalResult } from '../../shared/terminal'

// 终端会话管理
type Session = {
  id: string
  process: pty.IPty
  subscriptions: Array<{ dispose: () => void }>
}
// 终端会话映射：窗口 ID -> 会话
const sessions = new Map<number, Session>()
// 获取终端请求的窗口来源
function ownerOf(event: IpcMainInvokeEvent): WebContents {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('不支持的终端请求来源')
  }
  return event.sender
}
// 向窗口发送终端事件
function emit(owner: WebContents, event: TerminalEvent): void {
  if (!owner.isDestroyed()) owner.send('terminal:event', event)
}
// 终端操作失败的统一处理
function failure(error: unknown): TerminalResult {
  return { ok: false, error: error instanceof Error ? error.message : '终端操作失败' }
}
// 停止终端会话
function stop(ownerId: number, id?: string): TerminalResult {
  const session = sessions.get(ownerId)
  // 重复关闭和旧 ID 关闭都不能误伤新会话。
  if (!session || (id !== undefined && session.id !== id)) return { ok: true }
  try {
    session.process.kill()
  } catch (error) {
    return failure(error)
  }
  sessions.delete(ownerId)
  session.subscriptions.forEach((subscription) => subscription.dispose())
  return { ok: true }
}
// 注册终端接口
export function attachTerminalCleanup(window: BrowserWindow): void {
  const owner = window.webContents
  const ownerId = owner.id
  const cleanup = (): void => {
    const result = stop(ownerId)
    if (!result.ok) console.error('终端清理失败：', result.error)
  }
  // 页面刷新不能依赖 renderer 的异步 cleanup 一定送达。
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanup()
  })
  owner.on('render-process-gone', cleanup)
  owner.once('destroyed', cleanup)
  // 不挂 window.close：关闭保护可能取消这次关闭。
}
// 注册终端接口
export function registerLocalTerminal(): void {
  ipcMain.handle('terminal:start', (event, id: unknown, size: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || !isTerminalSize(size)) {
      return { ok: false, error: '终端 ID 或尺寸无效' }
    }
    if (sessions.has(owner.id)) return { ok: false, error: '当前窗口已有终端，请先关闭' }
    if (process.platform !== 'win32') return { ok: false, error: '本课仅支持 Windows' }

    try {
      const shell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      if (!existsSync(shell)) return { ok: false, error: '未找到 Windows PowerShell' }
      const child = pty.spawn(shell, ['-NoLogo', '-NoProfile'], {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: app.getPath('home'),
        env: process.env
      })
      const session: Session = { id, process: child, subscriptions: [] }
      sessions.set(owner.id, session)
      session.subscriptions.push(
        child.onData((data) => {
          if (sessions.get(owner.id) === session) emit(owner, { sessionId: id, type: 'data', data })
        })
      )
      session.subscriptions.push(
        child.onExit(({ exitCode }) => {
          if (sessions.get(owner.id) !== session) return
          sessions.delete(owner.id)
          session.subscriptions.forEach((subscription) => subscription.dispose())
          emit(owner, { sessionId: id, type: 'exit', exitCode })
        })
      )
      return { ok: true }
    } catch (error) {
      // 如果创建后订阅阶段失败，也尝试释放已经记录的资源。
      stop(owner.id, id)
      return failure(error)
    }
  })
  // 向终端发送数据
  ipcMain.handle('terminal:write', (event, id: unknown, data: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || typeof data !== 'string' || data.length === 0 || data.length > 8192) {
      return { ok: false, error: '终端输入无效或过长（单次最多 8192 字符）' }
    }
    const session = sessions.get(owner.id)
    if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
    try {
      session.process.write(data)
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  })
  // 调整终端大小
  ipcMain.handle('terminal:resize', (event, id: unknown, size: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || !isTerminalSize(size)) return { ok: false, error: '终端尺寸无效' }
    const session = sessions.get(owner.id)
    if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
    try {
      session.process.resize(size.cols, size.rows)
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  })
  // 关闭终端
  ipcMain.handle('terminal:close', (event, id: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id)) return { ok: false, error: '终端 ID 无效' }
    return stop(owner.id, id)
  })
}
