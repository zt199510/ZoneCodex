import { ipcMain, shell } from 'electron'
import { getIpcWindow } from '../ipc-source'

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
      ? url.href
      : null
  } catch {
    return null
  }
}

export async function openExternalUrl(value: unknown): Promise<boolean> {
  const url = safeExternalUrl(value)
  if (!url) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    return false
  }
}

export function registerExternalLinks(): void {
  ipcMain.handle('external:open', (event, url: unknown) => {
    getIpcWindow(event, '不支持的打开来源')
    return openExternalUrl(url)
  })
}
