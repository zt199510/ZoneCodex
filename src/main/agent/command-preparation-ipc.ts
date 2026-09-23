import { BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { inspectCommandDirectory, newDirectoryId, type DirectoryRead } from '../tools/command-directory'
import { parseCommandSource, parsePrepareCommandRequest, parseSelectCommandDirectoryRequest } from '../../shared/command-preparation'
import type { CommandSource } from '../../shared/command-preparation'
import { isAgentId } from '../../shared/agent'

type Grant = { windowId: number; source: CommandSource; directory: string; read: DirectoryRead; expires: number }
const grants = new Map<string, Grant>(); const prepared = new Map<string, { preparedId:string; windowId:number; grantId:string; source:CommandSource; expires:number }>(); const selecting = new Map<number, string>()
const err = (error: string) => ({ status: 'error' as const, error: error.slice(0, 500) })
function owner(event: Electron.IpcMainInvokeEvent): BrowserWindow { const w = BrowserWindow.fromWebContents(event.sender); if (!w || w.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('不支持的目录操作来源'); return w }
function validSource(source: CommandSource): boolean { return !!parseCommandSource(source) }
export function registerCommandPreparation(isSourceAllowed: (windowId: number, source: CommandSource) => boolean = () => true): void {
  ipcMain.handle('command-directory:select', async (event, raw: unknown) => {
    const w = owner(event); const req = parseSelectCommandDirectoryRequest(raw); if (!req || !validSource(req.source) || !isSourceAllowed(w.id, req.source)) return err('目录来源无效'); if (selecting.has(w.id)) return err('目录选择正在进行')
    const token = req.operationId; selecting.set(w.id, token)
    try {
      const picked = await dialog.showOpenDialog(w, { properties: ['openDirectory'], title: '选择命令工作目录' })
      if (selecting.get(w.id) !== token || w.isDestroyed()) return { status: 'cancelled' as const }
      if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' as const }
      const read = await inspectCommandDirectory(picked.filePaths[0]); const grantId = newDirectoryId(); grants.set(grantId, { windowId:w.id, source:req.source, directory:read.directory, read, expires:Date.now()+300000 })
      return { status:'selected' as const, info:{ grantId, directory:read.directory, scripts:read.scripts, ...(read.packageManager ? { packageManager:read.packageManager } : {}), npmrc:read.npmrc, expiresAt:new Date(Date.now()+300000).toISOString() } }
    } catch (e) { return err(e instanceof Error ? e.message : '读取目录失败') } finally { if (selecting.get(w.id) === token) selecting.delete(w.id) }
  })
  ipcMain.handle('command-directory:prepare', async (event, raw: unknown) => {
    const w = owner(event); const req = parsePrepareCommandRequest(raw); if (!req || !isSourceAllowed(w.id, req.source)) return err('准备来源无效'); const g = grants.get(req.grantId); if (!g || g.windowId !== w.id || JSON.stringify(g.source) !== JSON.stringify(req.source)) return err('目录授权已失效'); if (Date.now() > g.expires) { grants.delete(req.grantId); return { status:'expired' as const, error:'目录审查已过期' } }
    try { const fresh = await inspectCommandDirectory(g.directory); if (fresh.fingerprint !== g.read.fingerprint || fresh.npmrc !== g.read.npmrc) { grants.delete(req.grantId); return { status:'conflict' as const, error:'目录配置已变化，请重新选择并读取' } } const preparedId = randomUUID(); prepared.set(preparedId,{preparedId,windowId:w.id,grantId:req.grantId,source:req.source,expires:Date.now()+60000}); return { status:'ready' as const, preparedId, grantId:req.grantId, expiresAt:new Date(Date.now()+60000).toISOString() } } catch (e) { return err(e instanceof Error ? e.message : '检查执行准备失败') }
  })
  ipcMain.handle('command-directory:release', (event, id: unknown) => { const w=owner(event); if (!isAgentId(id)) return false; const g=grants.get(id); if (g?.windowId===w.id) grants.delete(id); for (const [k,p] of prepared) if (p.windowId===w.id && p.grantId===id) prepared.delete(k); return true })
  ipcMain.handle('command-directory:cancel', (event, id: unknown) => { const w=owner(event); if (typeof id==='string' && selecting.get(w.id)===id) { selecting.delete(w.id); return true } return false })
}
export function cleanupCommandPreparation(windowId: number): void { for (const [id,g] of grants) if (g.windowId===windowId) grants.delete(id); for (const [id,p] of prepared) if (p.windowId===windowId) prepared.delete(id); selecting.delete(windowId) }
export function hasCommandPreparation(id: string): boolean { return [...prepared.values()].some(p=>p.preparedId===id && p.expires>Date.now()) }
export function claimCommandPreparation(windowId: number, preparedId: string, source: CommandSource): { directory: string } | null {
  const p = prepared.get(preparedId); if (!p || p.windowId !== windowId || p.expires <= Date.now() || JSON.stringify(p.source) !== JSON.stringify(source)) return null
  const g = grants.get(p.grantId); prepared.delete(preparedId); if (!g || g.windowId !== windowId || JSON.stringify(g.source) !== JSON.stringify(source) || g.expires <= Date.now()) return null
  grants.delete(p.grantId); return { directory: g.directory }
}
