import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { WindowState } from '../../shared/window'
// 获取窗口来源
function getOwner(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不支持的窗口操作来源')
  }
  return owner
}
// 注册窗口控件
export function registerWindowControls(): void {
  ipcMain.handle('window:state', (event): WindowState => ({
    maximized: getOwner(event).isMaximized()
  }))
  ipcMain.handle('window:command', (event, action: unknown): void => {
    const owner = getOwner(event)
    switch (action) {
      case 'minimize':
        owner.minimize()
        break
      case 'toggle-maximize':
        if (owner.isMaximized()) owner.unmaximize()
        else owner.maximize()
        break
      // close 保留正常关闭事件，后续退出保护仍可阻止关闭；不能改为 destroy。
      case 'close':
        owner.close()
        break
      default:
        throw new Error('不支持的窗口操作')
    }
  })
}
// 监听窗口状态变化
export function observeWindowState(window: BrowserWindow): void {
  function publish(): void {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('window:state-changed', { maximized: window.isMaximized() })
    }
  }
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.once('closed', () => {
    window.removeListener('maximize', publish)
    window.removeListener('unmaximize', publish)
  })
}
