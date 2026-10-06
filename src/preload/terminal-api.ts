import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseTerminalEvent, parseTerminalResult } from '../shared/terminal'

export const terminalAPI: Pick<
  AppAPI,
  'startTerminal' | 'writeTerminal' | 'resizeTerminal' | 'closeTerminal' | 'onTerminalEvent'
> = {
  startTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:start', sessionId, size)),
  writeTerminal: async (sessionId, data) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:write', sessionId, data)),
  resizeTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:resize', sessionId, size)),
  closeTerminal: async (sessionId) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:close', sessionId)),
  onTerminalEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const parsed = parseTerminalEvent(value)
      if (parsed) listener(parsed)
    }
    ipcRenderer.on('terminal:event', handler)
    return () => ipcRenderer.removeListener('terminal:event', handler)
  }
}
