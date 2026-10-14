import { app, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, opendir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getIpcWindow } from '../ipc-source'
import { isAgentId } from '../../shared/agent'
import { parsePanelState, validContext } from '../../shared/workbench'
import type {
  DirectoryEntry,
  EditorDocument,
  WorkbenchContext,
  WorkbenchResult
} from '../../shared/workbench'
import { captureWorkspaceAccess } from '../project/workspace-access'
import {
  resolveExecutionContext,
  executionStillCurrent,
  localPermission
} from '../execution/execution-context'
import { canonicalLocalPath, insideLocalPath } from '../tools/local-path'
import { isLocalReadPathAllowed } from '../tools/workspace-files'
import { readEditorDocument, saveEditorDocument } from './editor-files'

type Receipt = {
  windowId: number
  context: WorkbenchContext
  scope: string
  root: string
  path: string
  fingerprint: string
}
const receipts = new Map<string, Receipt>()
const queues = new Map<string, Promise<unknown>>()
const busy = new Map<number, number>()
export const hasEditorSave = (windowId: number): boolean => (busy.get(windowId) ?? 0) > 0
const failure = (reason: unknown): { ok: false; error: string; conflict?: boolean } => ({
  ok: false,
  error: (reason instanceof Error ? reason.message : '工作面板操作失败').slice(0, 500),
  conflict: reason instanceof Error && reason.message.startsWith('CONFLICT:')
})
function owner(event: IpcMainInvokeEvent): BrowserWindow {
  return getIpcWindow(event, '不支持的工作面板来源', {
    windowMustBeLive: true,
    senderMustBeLive: true
  })
}
export function attachWorkbenchCleanup(window: BrowserWindow): void {
  const clear = (): void => {
    for (const [id, receipt] of receipts) if (receipt.windowId === window.id) receipts.delete(id)
  }
  window.webContents.on('zonecodex-main-navigation', clear)
  window.on('closed', clear)
}
async function scope(
  event: IpcMainInvokeEvent,
  context: WorkbenchContext
): Promise<{
  window: BrowserWindow
  root: string
  scopeId: string
  check: (path: string) => void
}> {
  const window = owner(event)
  if (!validContext(context)) throw new Error('工作面板上下文无效')
  const workspace = captureWorkspaceAccess(window.id, context.conversationId)
  if ((workspace?.workspaceId ?? undefined) !== context.workspaceId)
    throw new Error('项目已变化，请重新打开')
  const execution = await resolveExecutionContext(window.id, { ...context, mode: 'execute' })
  const check = (path: string): void => {
    if (
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !executionStillCurrent(window.id, { ...context, mode: 'execute' }, execution) ||
      (captureWorkspaceAccess(window.id, context.conversationId)?.workspaceId ?? undefined) !==
        context.workspaceId
    )
      throw new Error('目录或权限已变化，请重新打开')
    if (
      !insideLocalPath(execution.info.cwd, path) ||
      localPermission(execution, 'read', path) !== 'allow'
    )
      throw new Error('当前权限不允许读取此文件')
  }
  check(execution.info.cwd)
  return { window, root: execution.info.cwd, scopeId: execution.info.scopeId, check }
}
const stateFile = (id: string): string => join(app.getPath('userData'), 'workbench', `${id}.json`)
function serial<T>(id: string, action: () => Promise<T>): Promise<T> {
  const result = (queues.get(id) ?? Promise.resolve()).then(action, action)
  queues.set(id, result)
  void result
    .finally(() => {
      if (queues.get(id) === result) queues.delete(id)
    })
    .catch(() => undefined)
  return result
}
export function registerWorkbench(): void {
  ipcMain.handle('panel:load', async (event, id: unknown) => {
    owner(event)
    if (!isAgentId(id)) return failure(Error('会话 ID 无效'))
    try {
      const handle = await open(stateFile(id), 'r')
      let bytes: Buffer
      try {
        if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('工作面板存储超过容量')
        const buffer = Buffer.alloc(16 * 1024 * 1024 + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await handle.read(buffer, length, buffer.length - length, length)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        if (length > 16 * 1024 * 1024) throw new Error('工作面板存储超过容量')
        bytes = buffer.subarray(0, length)
      } finally {
        await handle.close()
      }
      const raw = JSON.parse(bytes.toString('utf8'))
      if (raw.draftRevision !== undefined) {
        if (typeof raw.draftRevision !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.draftRevision))
          throw new Error('草稿存储引用无效')
        const draftPath = join(
          app.getPath('userData'),
          'workbench',
          `${id}.${raw.draftRevision}.drafts.json`
        )
        const draftHandle = await open(draftPath, 'r')
        try {
          if ((await draftHandle.stat()).size > 16 * 1024 * 1024)
            throw new Error('草稿存储超过容量')
          const record = JSON.parse(await draftHandle.readFile('utf8'))
          if (record.version !== 1) throw new Error('草稿存储版本无效')
          raw.drafts = record.drafts
        } finally {
          await draftHandle.close()
        }
      }
      const state = parsePanelState(raw)
      if (!state) throw new Error('工作面板存储无效，原记录已保留')
      return { ok: true, data: state }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        (error as NodeJS.ErrnoException).path === stateFile(id)
        ? { ok: true, data: null }
        : failure(error)
    }
  })
  ipcMain.handle('panel:save', async (event, id: unknown, value: unknown) => {
    owner(event)
    const state = parsePanelState(value)
    if (!isAgentId(id) || !state) return failure(Error('工作面板存储格式或容量无效'))
    return serial(id, async () => {
      const revision = randomUUID()
      const temporary = `${stateFile(id)}.${revision}.tmp`
      const draftPath = join(app.getPath('userData'), 'workbench', `${id}.${revision}.drafts.json`)
      let committed = false
      try {
        await mkdir(join(app.getPath('userData'), 'workbench'), { recursive: true })
        const draftHandle = await open(draftPath, 'wx')
        try {
          await draftHandle.writeFile(JSON.stringify({ version: 1, drafts: state.drafts }))
          await draftHandle.sync()
        } finally {
          await draftHandle.close()
        }
        const stateHandle = await open(temporary, 'wx')
        try {
          await stateHandle.writeFile(
            JSON.stringify({ ...state, drafts: {}, draftRevision: revision })
          )
          await stateHandle.sync()
        } finally {
          await stateHandle.close()
        }
        // The atomic state rename publishes a complete, immutable draft revision.
        let previousRevision: unknown
        try {
          previousRevision = JSON.parse(await readFile(stateFile(id), 'utf8')).draftRevision
        } catch {
          /* No previous state. */
        }
        await rename(temporary, stateFile(id))
        committed = true
        if (typeof previousRevision === 'string' && /^[a-f0-9-]{36}$/.test(previousRevision))
          await rm(
            join(app.getPath('userData'), 'workbench', `${id}.${previousRevision}.drafts.json`),
            { force: true }
          ).catch(() => undefined)
        return { ok: true, data: null }
      } catch (error) {
        return failure(error)
      } finally {
        await rm(temporary, { force: true })
        if (!committed) await rm(draftPath, { force: true })
      }
    })
  })
  ipcMain.handle('panel:remove', async (event, id: unknown) => {
    owner(event)
    if (!isAgentId(id)) return failure(Error('会话 ID 无效'))
    return serial(id, async () => {
      try {
        let revision: unknown
        try {
          revision = JSON.parse(await readFile(stateFile(id), 'utf8')).draftRevision
        } catch {
          /* Missing state. */
        }
        await rm(stateFile(id), { force: true })
        if (typeof revision === 'string' && /^[a-f0-9-]{36}$/.test(revision))
          await rm(join(app.getPath('userData'), 'workbench', `${id}.${revision}.drafts.json`), {
            force: true
          })
        return { ok: true, data: null }
      } catch (error) {
        return failure(error)
      }
    })
  })
  ipcMain.handle(
    'panel:directory',
    async (
      event,
      context: WorkbenchContext,
      path: unknown,
      search: unknown
    ): Promise<WorkbenchResult<DirectoryEntry[]>> => {
      try {
        if (
          typeof path !== 'string' ||
          path.length > 512 ||
          (search !== undefined && (typeof search !== 'string' || search.length > 100))
        )
          throw new Error('目录查询无效')
        const access = await scope(event, context)
        const directory = await canonicalLocalPath(access.root, path || '.', true)
        access.check(directory)
        const entries: DirectoryEntry[] = []
        let visited = 0
        const scan = async (target: string, depth: number): Promise<void> => {
          access.check(target)
          for await (const entry of await opendir(target)) {
            if (++visited > 3000 || entries.length >= 250) return
            const child = join(target, entry.name)
            if (
              entry.isSymbolicLink() ||
              !isLocalReadPathAllowed(child) ||
              ['.git', 'node_modules', '.cache'].includes(entry.name)
            )
              continue
            const rel = relative(access.root, child)
            if (!search || rel.toLowerCase().includes(String(search).toLowerCase()))
              entries.push({ name: entry.name, path: rel, directory: entry.isDirectory() })
            if (search && entry.isDirectory() && depth < 8) await scan(child, depth + 1)
          }
        }
        await scan(directory, 0)
        access.check(directory)
        return {
          ok: true,
          data: entries.sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)
          )
        }
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    'panel:read',
    async (
      event,
      context: WorkbenchContext,
      path: unknown
    ): Promise<WorkbenchResult<EditorDocument>> => {
      try {
        if (typeof path !== 'string') throw new Error('文件路径无效')
        const access = await scope(event, context)
        const document = await readEditorDocument(access.root, path, access.check)
        const id = randomUUID()
        receipts.set(id, {
          windowId: access.window.id,
          context,
          root: access.root,
          scope: access.scopeId,
          path: document.path,
          fingerprint: document.fingerprint
        })
        return {
          ok: true,
          data: {
            path: document.path,
            text: document.text,
            fingerprint: document.fingerprint,
            receipt: id,
            writable: true
          }
        }
      } catch (error) {
        return failure(error)
      }
    }
  )
  ipcMain.handle(
    'panel:write',
    async (
      event,
      context: WorkbenchContext,
      id: unknown,
      expected: unknown,
      text: unknown
    ): Promise<WorkbenchResult<EditorDocument>> => {
      const window = owner(event)
      busy.set(window.id, (busy.get(window.id) ?? 0) + 1)
      try {
        if (typeof id !== 'string' || typeof text !== 'string' || typeof expected !== 'string')
          throw new Error('保存参数无效')
        const receipt = receipts.get(id)
        const access = await scope(event, context)
        if (
          !receipt ||
          receipt.windowId !== window.id ||
          receipt.context.conversationId !== context.conversationId ||
          receipt.context.workspaceId !== context.workspaceId ||
          receipt.scope !== access.scopeId ||
          receipt.fingerprint !== expected
        )
          throw new Error('文件保存上下文已失效，请重新读取')
        // This endpoint is an explicit human editor save, not an Agent write or approval grant.
        const document = await saveEditorDocument(
          access.root,
          receipt.path,
          expected,
          text,
          access.check
        )
        receipt.fingerprint = document.fingerprint
        return {
          ok: true,
          data: {
            path: document.path,
            text: document.text,
            fingerprint: document.fingerprint,
            receipt: id,
            writable: true
          }
        }
      } catch (error) {
        return failure(error)
      } finally {
        busy.set(window.id, Math.max(0, (busy.get(window.id) ?? 1) - 1))
      }
    }
  )
  ipcMain.handle('panel:release', (event, id: unknown) => {
    const window = owner(event)
    if (typeof id === 'string' && receipts.get(id)?.windowId === window.id) receipts.delete(id)
  })
}
