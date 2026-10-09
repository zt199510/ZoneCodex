import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseLibrary } from '../../shared/conversation-library'
import type { ConversationLibrary, LoadLibraryResult } from '../../shared/conversation-library'
import type { SaveConversationResult } from '../../shared/conversation'

/**
 * 创建一个会话存储实例
 * @param directory 存储目录
 * @returns 会话存储实例
 */
/**
 * 创建一个会话存储实例
 * @param directory 存储目录
 * @returns 会话存储实例
 */
export function createConversationStore(directory: string): {
  load: () => Promise<LoadLibraryResult>
  save: (
    value: unknown,
    beforeWrite?: (snapshot: ConversationLibrary) => Promise<void>
  ) => Promise<SaveConversationResult>
} {
  const file = join(directory, 'conversation.json')
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  async function readExisting(): Promise<ConversationLibrary | null> {
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
      value.version !== 8
    ) {
      throw new Error('会话格式不支持：只读取当前格式，旧记录未被覆盖或删除。')
    }
    const library = parseLibrary(value)
    if (!library) throw new Error('会话格式不支持：只读取当前格式，旧记录未被覆盖或删除。')
    return library
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
              snapshot: { version: 8, activeConversationId: null, conversations: [] }
            }
          }
          const snapshot = recoverPending(saved)
          if (JSON.stringify(snapshot) !== JSON.stringify(saved)) {
            // 将启动恢复结果持久化，返回值可以直接作为已保存基线。
            await writeLibrary(snapshot)
          }
          return { ok: true, missing: false, snapshot }
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof Error && error.message.startsWith('会话格式不支持')
                ? error.message
                : '读取失败：请检查会话格式、文件权限和磁盘。原记录未被覆盖或删除。'
          }
        }
      }),
    save: (
      value: unknown,
      beforeWrite?: (snapshot: ConversationLibrary) => Promise<void>
    ): Promise<SaveConversationResult> => {
      const snapshot = parseLibrary(value)
      if (!snapshot)
        return Promise.resolve({ ok: false, error: '会话库格式或长度不符合保存要求。' })
      return serial(async (): Promise<SaveConversationResult> => {
        try {
          // Read before replacement so an unsupported existing file cannot be overwritten.
          await readExisting()
          await beforeWrite?.(snapshot)
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
