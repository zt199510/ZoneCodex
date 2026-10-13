import path from 'node:path'
import { GitReadError } from './git-process'

const pending = new Map<string, Promise<void>>()
/** Shared by index/ref, worktree and remote actions, including different windows. */
export async function withGitRepositoryLock<T>(
  commonDirectory: string,
  signal: AbortSignal | undefined,
  body: () => Promise<T>
): Promise<T> {
  const key = path.resolve(commonDirectory).toLocaleLowerCase('en-US')
  const previous = pending.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => gate)
  pending.set(key, tail)
  let abort: (() => void) | undefined
  try {
    if (signal?.aborted) throw new GitReadError('cancelled', 'Git 操作在等待锁时已取消')
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new GitReadError('cancelled', 'Git 操作在等待锁时已取消'))
      signal?.addEventListener('abort', abort, { once: true })
    })
    // Cancelling a queued read must not wait for a long fetch/push before returning.
    await Promise.race([previous.catch(() => {}), cancelled])
    if (signal?.aborted) throw new GitReadError('cancelled', 'Git 操作在执行前已取消')
    return await body()
  } finally {
    if (abort) signal?.removeEventListener('abort', abort)
    release()
    // Keep a cancelled tail behind its predecessor. Removing it now would let a
    // later writer skip a predecessor that still owns the common-directory lock.
    void tail.then(() => {
      if (pending.get(key) === tail) pending.delete(key)
    })
  }
}
