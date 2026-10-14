import { ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isSkillId, type SkillDirectoryResult } from '../../shared/skills'
import { getIpcWindow } from '../ipc-source'
import { checkSkillDirectory } from './skill-reader'
import { assertSkillObjectProof, checkWindowsSkillObjects } from './windows-skill-objects'
import {
  cleanupSkills,
  discardConversationSkills,
  configureSkills,
  getSkillsRoot,
  listSkills,
  prepareSkill,
  releaseConversationSkills,
  releaseSkill
} from './skill-service'

export function registerSkills(userData: string): void {
  configureSkills(userData)
  const ownerOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow =>
    getIpcWindow(event, '不支持的技能操作来源', { windowMustBeLive: true, senderMustBeLive: true })
  ipcMain.handle('skills:list', async (event, conversationId: unknown) => {
    const owner = ownerOf(event)
    if (!isSkillId(conversationId)) throw new Error('技能会话标识无效')
    const result = await listSkills(owner.id, conversationId)
    ownerOf(event)
    return result
  })
  ipcMain.handle(
    'skills:prepare',
    async (event, conversationId: unknown, skillId: unknown, generation: unknown) => {
      const owner = ownerOf(event)
      if (!isSkillId(conversationId) || !isSkillId(skillId) || !isSkillId(generation))
        return { status: 'error', error: '技能选择标识无效' }
      const result = await prepareSkill(owner.id, conversationId, skillId, generation)
      ownerOf(event)
      return result
    }
  )
  ipcMain.handle('skills:release', (event, conversationId: unknown, selectionId: unknown) => {
    const owner = ownerOf(event)
    return isSkillId(conversationId) && isSkillId(selectionId)
      ? releaseSkill(owner.id, conversationId, selectionId)
      : false
  })
  ipcMain.handle('skills:release-conversation', (event, conversationId: unknown) => {
    const owner = ownerOf(event)
    return isSkillId(conversationId) ? releaseConversationSkills(owner.id, conversationId) : false
  })
  ipcMain.handle('skills:discard-conversation', (event, conversationId: unknown) => {
    const owner = ownerOf(event)
    if (!isSkillId(conversationId)) return false
    discardConversationSkills(owner.id, conversationId)
    return true
  })
  ipcMain.handle('skills:open-directory', async (event): Promise<SkillDirectoryResult> => {
    const owner = ownerOf(event)
    const root = getSkillsRoot()
    try {
      // Creation happens only after this explicit UI operation, never during discovery or startup.
      const parent = dirname(root)
      const parentInfo = await checkSkillDirectory(parent)
      assertSkillObjectProof(await checkWindowsSkillObjects([parent]), parent, parentInfo)
      await mkdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const rootInfo = await checkSkillDirectory(root)
      assertSkillObjectProof(await checkWindowsSkillObjects([root]), root, rootInfo)
      if (owner.isDestroyed() || owner.webContents.isDestroyed()) throw new Error('技能窗口已关闭')
      ownerOf(event)
      const error = await shell.openPath(root)
      ownerOf(event)
      if (error) return { status: 'error', root, error: '系统文件管理器未能打开技能目录' }
      return { status: 'opened', root }
    } catch {
      return { status: 'error', root, error: '无法创建或打开应用技能目录，请检查目录权限及链接' }
    }
  })
}

export function attachSkillsCleanup(window: BrowserWindow): void {
  const contents = window.webContents
  const cleanup = (): void => cleanupSkills(window.id)
  contents.on('zonecodex-main-navigation', cleanup)
  contents.on('render-process-gone', cleanup)
  contents.once('destroyed', cleanup)
  window.once('closed', () => {
    cleanup()
    contents.removeListener('zonecodex-main-navigation', cleanup)
    contents.removeListener('render-process-gone', cleanup)
  })
}
