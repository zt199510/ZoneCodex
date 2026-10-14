import { ipcMain, session } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { isAgentId } from '../../shared/agent'
import { getIpcWindow } from '../ipc-source'

type BrowserGrant = { windowId: number; conversationId: string; tabId: string; guest?: WebContents }
const grants = new Map<string, BrowserGrant>()
function allowedUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const target = new URL(url)
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password
  } catch {
    return false
  }
}
export function registerBrowserHost(): void {
  ipcMain.handle('panel:browser', (event, conversationId: unknown, tabId: unknown) => {
    const window = getIpcWindow(event, '浏览器来源无效', {
      windowMustBeLive: true,
      senderMustBeLive: true
    })
    if (!isAgentId(conversationId) || !isAgentId(tabId))
      return { ok: false, error: '浏览器标签无效' }
    const partition = `persist:zonecodex-browser-${createHash('sha256').update(`${conversationId}:${tabId}`).digest('hex')}`
    const existing = grants.get(partition)
    if (existing && existing.windowId !== window.id)
      return { ok: false, error: '此浏览器标签已在其他窗口打开' }
    if (existing?.guest?.isDestroyed()) existing.guest = undefined
    if (!existing) {
      grants.set(partition, { windowId: window.id, conversationId, tabId })
      const isolated = session.fromPartition(partition)
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
    }
    return { ok: true, data: partition }
  })
  ipcMain.handle('panel:browser-close', (event, conversationId: unknown, tabId: unknown) => {
    const window = getIpcWindow(event, '浏览器来源无效')
    for (const [partition, grant] of grants)
      if (
        grant.windowId === window.id &&
        grant.conversationId === conversationId &&
        grant.tabId === tabId
      ) {
        if (grant.guest && !grant.guest.isDestroyed()) grant.guest.close()
        grants.delete(partition)
      }
  })
}
export function attachBrowserHost(window: BrowserWindow): void {
  const contents = window.webContents
  contents.on('will-attach-webview', (event, preferences, params) => {
    const grant = grants.get(params.partition)
    if (!grant || grant.windowId !== window.id || !allowedUrl(params.src)) {
      event.preventDefault()
      return
    }
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    preferences.webviewTag = false
  })
  contents.on('did-attach-webview', (_event, guest) => {
    const grant = [...grants].find(
      ([partition, item]) =>
        item.windowId === window.id &&
        !item.guest &&
        session.fromPartition(partition) === guest.session
    )?.[1]
    if (!grant) {
      guest.close()
      return
    }
    grant.guest = guest
    guest.setWindowOpenHandler(({ url }) => {
      if (allowedUrl(url) && url !== 'about:blank' && !contents.isDestroyed())
        contents.send('panel:browser-new-tab', { conversationId: grant.conversationId, url })
      return { action: 'deny' }
    })
    guest.on('will-navigate', (event, url) => {
      if (!allowedUrl(url)) event.preventDefault()
    })
    guest.on('will-redirect', (event, url) => {
      if (!allowedUrl(url)) event.preventDefault()
    })
    guest.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase()
      if (
        input.type === 'keyDown' &&
        ((input.control && ['t', 'w', 'tab', 'pageup', 'pagedown', 'f4'].includes(key)) ||
          (input.alt && /^[1-9]$/.test(key)))
      ) {
        event.preventDefault()
        contents.send('panel:browser-key', {
          key: input.key,
          ctrlKey: input.control,
          shiftKey: input.shift,
          altKey: input.alt
        })
      }
    })
  })
  const clear = (): void => {
    for (const [partition, grant] of grants)
      if (grant.windowId === window.id) {
        if (grant.guest && !grant.guest.isDestroyed()) grant.guest.close()
        grants.delete(partition)
      }
  }
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) clear()
  })
  contents.on('render-process-gone', clear)
  window.on('closed', clear)
}
