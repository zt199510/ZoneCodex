import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseLibrary, readLibrary } from '../../shared/conversation-library'
import type { ConversationLibrary, LoadLibraryResult } from '../../shared/conversation-library'
import type { SaveConversationResult } from '../../shared/conversation'

/**
 * 创建一个会话存储实例
 * @param directory 存储目录
 * @returns 会话存储实例
 */
type Existing = {
  bytes: Buffer
  library: ConversationLibrary
  sourceVersion: 1 | 2 | 3 | 4
}

/**
 * 创建一个会话存储实例
 * @param directory 存储目录
 * @returns 会话存储实例
 */
export function createConversationStore(directory: string): {
  load: () => Promise<LoadLibraryResult>
  save: (value: unknown) => Promise<SaveConversationResult>
} {
  const file = join(directory, 'conversation.json')
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  async function readExisting(): Promise<Existing | null> {
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }
      throw error
    }
    if (bytes.length > 8_000_000) throw new Error('文件过大')
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    ) {
      throw new Error('文件格式或版本不支持')
    }
    const sourceVersion = value.version
    const library = readLibrary(value, sourceVersion === 1 ? randomUUID() : '')
    if (!library) throw new Error('文件格式或版本不支持')
    return { bytes, library, sourceVersion }
  }

  /**
   * 恢复待处理的会话
   * @param library 会话库
   * @returns 恢复后的会话库
   */
  function recoverPending(library: ConversationLibrary): ConversationLibrary {
    return {
      ...library,
      conversations: library.conversations.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.status === 'pending' ? { ...message, status: 'failed' } : message
        )
      }))
    }
  }

  async function writeLibrary(library: ConversationLibrary): Promise<void> {
    const text = JSON.stringify(library, null, 2)
    if (Buffer.byteLength(text, 'utf8') > 8_000_000) throw new Error('文件过大')
    const temporary = join(directory, `conversation-${randomUUID()}.tmp`)
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  return {
    load: () =>
      serial(async (): Promise<LoadLibraryResult> => {
        try {
          const saved = await readExisting()
          if (!saved) {
            return {
              ok: true,
              missing: true,
              snapshot: { version: 4, activeConversationId: null, conversations: [] }
            }
          }
          const snapshot = recoverPending(saved.library)
          // 旧版本先备份原始字节，再统一写入版本 4。
          if (saved.sourceVersion !== snapshot.version) {
            const backup = join(
              directory,
              `conversation-v${saved.sourceVersion}-${randomUUID()}.bak`
            )
            await writeFile(backup, saved.bytes, { flag: 'wx' })
            await writeLibrary(snapshot)
          } else if (JSON.stringify(snapshot) !== JSON.stringify(saved.library)) {
            // 将启动恢复结果持久化，返回值可以直接作为已保存基线。
            await writeLibrary(snapshot)
          }
          return { ok: true, missing: false, snapshot }
        } catch {
          return {
            ok: false,
            error: '读取或迁移失败：请检查文件格式、备份权限和磁盘。不要删除原记录。'
          }
        }
      }),
    save: (value: unknown): Promise<SaveConversationResult> => {
      const snapshot = parseLibrary(value)
      if (!snapshot)
        return Promise.resolve({ ok: false, error: '会话库格式或长度不符合保存要求。' })
      return serial(async (): Promise<SaveConversationResult> => {
        try {
          const existing = await readExisting()
          // 旧版本必须先走 load 的备份迁移流程，save 不绕过它。
          if (existing && existing.sourceVersion !== snapshot.version)
            throw new Error('请先加载旧记录')
          await writeLibrary(snapshot)
          return { ok: true }
        } catch {
          return {
            ok: false,
            error: '保存失败：请检查权限、磁盘或已有文件格式。未主动删除原文件。'
          }
        }
      })
    }
  }
}
