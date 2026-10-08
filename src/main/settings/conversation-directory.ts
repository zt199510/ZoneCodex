import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isAgentId } from '../../shared/agent'
import type { ConversationLibrary } from '../../shared/conversation-library'
import { isAbsoluteLocalDirectory } from '../../shared/settings'
import { getAppSettings } from './settings-service'

type Binding = { directory: string; saved: boolean }
type WindowBindings = { bindings: Map<string, Binding>; pending: Set<string> }
const windows = new Map<number, WindowBindings>()
let readSavedDirectory: (conversationId: string) => Promise<string | null> = async () => {
  throw new Error('会话存储尚未加载')
}

export function configureConversationDirectoryLookup(
  lookup: (conversationId: string) => Promise<string | null>
): void {
  readSavedDirectory = lookup
}

function stateFor(windowId: number): WindowBindings {
  let state = windows.get(windowId)
  if (!state) {
    state = { bindings: new Map(), pending: new Set() }
    windows.set(windowId, state)
  }
  return state
}

/** Resolve every component, so a later junction cannot silently change the tool directory. */
async function checkedDirectory(directory: string): Promise<string> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('会话任务目录无效')
  const canonical = await realpath(directory)
  if (canonical !== resolve(directory)) throw new Error('会话任务目录实际路径已变化')
  return canonical
}

export async function validateConversationDirectory(
  conversationId: string,
  directory: string
): Promise<string> {
  if (
    !isAgentId(conversationId) ||
    !isAbsoluteLocalDirectory(directory) ||
    basename(directory) !== 'workspace' ||
    basename(dirname(directory)) !== conversationId
  )
    throw new Error('会话任务目录绑定格式无效')
  const root = dirname(dirname(directory))
  await checkedDirectory(root)
  await checkedDirectory(dirname(directory))
  return checkedDirectory(directory)
}

export async function createConversationDirectory(
  root: string,
  conversationId: string
): Promise<string> {
  if (!isAgentId(conversationId) || !isAbsoluteLocalDirectory(root))
    throw new Error('会话或任务根目录无效')
  await mkdir(root, { recursive: true })
  const canonicalRoot = await checkedDirectory(root)
  const parent = join(canonicalRoot, conversationId)
  await mkdir(parent, { recursive: true })
  await checkedDirectory(parent)
  const directory = join(parent, 'workspace')
  await mkdir(directory, { recursive: true })
  return validateConversationDirectory(conversationId, directory)
}

/** Returned paths are pending until conversation:save successfully commits them. */
export async function bindConversationDirectory(
  windowId: number,
  conversationId: string,
  isCurrent: () => boolean
): Promise<string> {
  if (!isAgentId(conversationId)) throw new Error('会话 ID 无效')
  getAppSettings()
  const state = stateFor(windowId)
  if (state.pending.has(conversationId)) throw new Error('正在创建会话任务目录，请稍后再试')
  state.pending.add(conversationId)
  try {
    const existing = state.bindings.get(conversationId)
    const savedDirectory = existing ? null : await readSavedDirectory(conversationId)
    const previousDirectory = existing?.directory ?? savedDirectory
    const directory = previousDirectory
      ? await validateConversationDirectory(conversationId, previousDirectory)
      : await createConversationDirectory(getAppSettings().taskRoot, conversationId)
    if (!isCurrent() || windows.get(windowId) !== state)
      throw new Error('会话任务目录创建已取消，请重新创建会话')
    if (!existing) state.bindings.set(conversationId, { directory, saved: savedDirectory !== null })
    return directory
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('会话') || error.message.startsWith('读取失败'))
    )
      throw error
    throw new Error('无法创建或读取会话任务目录，请检查文件夹权限和实际路径。')
  } finally {
    state.pending.delete(conversationId)
  }
}

export function hasConversationDirectoryOperation(windowId: number): boolean {
  return (windows.get(windowId)?.pending.size ?? 0) > 0
}

/** Only the main process's bindings may be included in renderer save requests. */
export async function checkConversationDirectorySave(
  windowId: number,
  library: ConversationLibrary
): Promise<void> {
  if (library.conversations.length === 0) return
  const state = windows.get(windowId)
  if (!state) throw new Error('会话任务目录尚未绑定')
  for (const conversation of library.conversations) {
    const binding = state?.bindings.get(conversation.id)
    if (!binding || binding.directory !== conversation.defaultDirectory)
      throw new Error('会话任务目录未绑定或与主进程记录不一致')
    await validateConversationDirectory(conversation.id, binding.directory)
    if (windows.get(windowId) !== state || state.bindings.get(conversation.id) !== binding)
      throw new Error('会话任务目录绑定已失效')
  }
}

export function commitConversationDirectorySave(
  windowId: number,
  library: ConversationLibrary
): void {
  const state = windows.get(windowId)
  if (!state) return
  const retained = new Set(library.conversations.map((item) => item.id))
  for (const conversation of library.conversations) {
    const binding = state.bindings.get(conversation.id)
    if (binding?.directory === conversation.defaultDirectory) binding.saved = true
  }
  // Deleted conversations lose their execution binding; a later reuse must bind anew.
  for (const [id, binding] of state.bindings) {
    if (binding.saved && !retained.has(id)) state.bindings.delete(id)
  }
}

/** A verified local current-format file is a distinct source from renderer metadata. */
export async function restoreConversationDirectories(
  windowId: number,
  library: ConversationLibrary,
  isCurrent: () => boolean
): Promise<void> {
  getAppSettings()
  const state = stateFor(windowId)
  const bindings = new Map<string, Binding>()
  for (const conversation of library.conversations) {
    const directory = await validateConversationDirectory(
      conversation.id,
      conversation.defaultDirectory
    )
    bindings.set(conversation.id, { directory, saved: true })
  }
  if (!isCurrent() || windows.get(windowId) !== state || state.pending.size)
    throw new Error('会话任务目录恢复已取消')
  state.bindings = bindings
}

export function captureConversationDirectory(
  windowId: number,
  conversationId: string
): string | null {
  const state = windows.get(windowId)
  const binding = state?.bindings.get(conversationId)
  return binding?.saved && !state?.pending.has(conversationId) ? binding.directory : null
}

export function clearConversationDirectories(windowId: number): void {
  windows.delete(windowId)
}
