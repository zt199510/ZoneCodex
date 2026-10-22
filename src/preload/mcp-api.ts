import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseMcpServerConfig, parseMcpServerStatus, parseMcpStatusList } from '../shared/mcp'

export const mcpAPI: Pick<AppAPI, 'listMcpServers' | 'listMcpConfigs' | 'upsertMcpServer' | 'setMcpServerEnabled' | 'removeMcpServer' | 'connectMcpServer' | 'disconnectMcpServer' | 'refreshMcpServer' | 'onMcpStatus'> = {
  listMcpServers: async () => parseMcpStatusList(await ipcRenderer.invoke('mcp:list')) ?? [],
  listMcpConfigs: async () => { const result = await ipcRenderer.invoke('mcp:configs'); if (!Array.isArray(result)) return []; return result.map(parseMcpServerConfig).filter((item): item is NonNullable<typeof item> => item !== null) },
  upsertMcpServer: async (value) => {
    const checked = parseMcpServerConfig(value); if (!checked) throw new Error('MCP 配置无效')
    const result = parseMcpServerConfig(await ipcRenderer.invoke('mcp:upsert', checked)); if (!result) throw new Error('MCP 配置结果无效'); return result
  },
  setMcpServerEnabled: async (id, enabled) => { const result = parseMcpServerStatus(await ipcRenderer.invoke('mcp:enabled', id, enabled)); if (!result) throw new Error('MCP 状态无效'); return result },
  removeMcpServer: async (id) => Boolean(await ipcRenderer.invoke('mcp:remove', id)),
  connectMcpServer: async (id) => { const result = parseMcpServerStatus(await ipcRenderer.invoke('mcp:connect', id)); if (!result) throw new Error('MCP 状态无效'); return result },
  disconnectMcpServer: async (id) => Boolean(await ipcRenderer.invoke('mcp:disconnect', id)),
  refreshMcpServer: async (id) => { const result = parseMcpServerStatus(await ipcRenderer.invoke('mcp:refresh', id)); if (!result) throw new Error('MCP 状态无效'); return result },
  onMcpStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => { const status = parseMcpServerStatus(value); if (status) listener(status) }
    ipcRenderer.on('mcp:status', handler); return () => ipcRenderer.removeListener('mcp:status', handler)
  }
}
