import { BrowserWindow, ipcMain } from 'electron'
import type { Event } from 'electron'
import { randomUUID } from 'node:crypto'
// 关闭确认处理器类型
type Guard = { requestId: string | null; allowOnce: boolean }
// 关闭确认处理器映射
const guards = new WeakMap<BrowserWindow, Guard>()
// 注册关闭确认处理器
export function registerCloseGuard(): void {
  ipcMain.handle('window:finish-close', (event, requestId: unknown, allow: unknown): boolean => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('不支持的关闭确认来源')
    }
    if (
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 80 ||
      typeof allow !== 'boolean'
    )
      throw new Error('关闭确认参数不正确')
    const guard = guards.get(owner)
    if (!guard || guard.requestId !== requestId) return false

    guard.requestId = null
    if (allow) {
      guard.allowOnce = true
      owner.close()
    }
    return true
  })
}

// 注册关闭确认处理器
export function attachCloseGuard(window: BrowserWindow): void {
  if (guards.has(window)) return
  const guard: Guard = { requestId: null, allowOnce: false }
  guards.set(window, guard)
  const sender = window.webContents

  function onClose(event: Event): void {
    if (guard.allowOnce) {
      guard.allowOnce = false
      return
    }
    event.preventDefault()
    if (sender.isDestroyed()) return
    guard.requestId ??= randomUUID()
    // 连续关闭复用请求 ID。页面恢复订阅后，再次点击仍可收到请求。
    try {
      sender.send('window:close-requested', guard.requestId)
    } catch {
      guard.requestId = null
    }
  }

  function reset(): void {
    guard.requestId = null
    guard.allowOnce = false
  }

  window.on('close', onClose)
  sender.on('did-start-loading', reset)
  window.once('closed', () => {
    reset()
    window.removeListener('close', onClose)
    sender.removeListener('did-start-loading', reset)
    guards.delete(window)
  })
}
