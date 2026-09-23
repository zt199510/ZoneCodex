import { randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, sep } from 'node:path'
import type { Stats } from 'node:fs'
import { readSelectedFile, type ProjectSnapshot } from './project-snapshot'
import { prepareChange, type PreparedContent } from './change-preparation'
import type { CommitStatus } from '../../shared/change-commit'

export type CommitPhase = 'validating' | 'staging' | 'replacing' | 'verifying' | 'finished'
export type RecoveryFile = { id: string; path: string; dev: number; ino: number; bytes: Uint8Array }
export type CommitOutcome = {
  status: CommitStatus
  message: string
  recovery: RecoveryFile | null
  cleanupWarning: boolean
}
// Internal adapter only. No IPC parameter can select or override filesystem operations.
export type CommitIO = { open: typeof open; rename: typeof rename; unlink: typeof unlink }
const defaultIO: CommitIO = { open, rename, unlink }
const equal = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b))
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean =>
  a.dev === b.dev && a.ino === b.ino
const read = (path: string, signal: AbortSignal): ReturnType<typeof readSelectedFile> =>
  readSelectedFile(parse(path).root, relative(parse(path).root, path), signal)

async function checkParent(directory: string, identity?: Stats): Promise<Stats> {
  const root = parse(directory).root
  let current = root
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory')
  }
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (identity && !same(identity, info)))
    throw new Error('Changed directory')
  return info
}

export async function commitChange(
  snapshot: ProjectSnapshot,
  content: PreparedContent,
  signal: AbortSignal,
  canReplace: () => boolean,
  onPhase: (phase: CommitPhase) => void,
  io: CommitIO = defaultIO
): Promise<CommitOutcome> {
  const target = content.baseline.absolutePath
  const directory = dirname(target)
  const alias = [...(snapshot.baselines ?? [])].find(
    ([, baseline]) => baseline === content.baseline
  )?.[0]
  let parent: Stats | undefined
  let temporary: { path: string; identity: Stats } | undefined
  let incompleteBackup: { path: string; identity: Stats } | undefined
  let recovery: RecoveryFile | null = null
  let attempted = false
  const result: CommitOutcome = {
    status: 'error',
    message: '提交前检查或备份失败，本次未替换目标',
    recovery: null,
    cleanupWarning: false
  }
  const uncancelled = new AbortController().signal
  async function validate(): Promise<boolean> {
    signal.throwIfAborted()
    if (!alias) throw new Error('Missing baseline')
    const prepared = await prepareChange(snapshot, alias, content.proposedText, signal)
    if (prepared.status === 'conflict') return false
    if (prepared.status !== 'prepared' || !equal(prepared.candidateBytes, content.candidateBytes))
      throw new Error('Invalid candidate')
    return true
  }
  async function stage(
    path: string,
    bytes: Uint8Array,
    isBackup: boolean,
    mode: number
  ): Promise<Stats> {
    await checkParent(directory, parent)
    signal.throwIfAborted()
    const handle = await io.open(path, 'wx', mode & 0o777)
    let identity: Stats
    try {
      identity = await handle.stat()
      if (!identity.isFile() || identity.nlink !== 1) throw new Error('Unsafe staged file')
      if (!isBackup) temporary = { path, identity }
      else incompleteBackup = { path, identity }
      let offset = 0
      while (offset < bytes.length) {
        signal.throwIfAborted()
        const written = await handle.write(bytes, offset, bytes.length - offset, offset)
        if (written.bytesWritten <= 0) throw new Error('Short write')
        offset += written.bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    const verified = (await read(path, signal)).baseline
    if (!same(identity, verified) || !equal(verified.originalBytes, bytes))
      throw new Error('Staging verification failed')
    return identity
  }
  try {
    onPhase('validating')
    // This exercise supports local drive paths, not UNC/device namespaces.
    if (process.platform === 'win32' && !/^[a-z]:\\/i.test(target))
      throw new Error('Unsupported filesystem path')
    if (!(await validate())) {
      result.status = 'conflict'
      result.message = '文件已变化，本次未替换目标，请重新选择文件并生成建议'
      return result
    }
    parent = await checkParent(directory)
    const targetInfo = await lstat(target)
    onPhase('staging')
    const id = randomUUID()
    const backupPath = join(directory, `.zonecodex-${id}.bak`)
    const backupIdentity = await stage(
      backupPath,
      content.baseline.originalBytes,
      true,
      targetInfo.mode
    )
    recovery = {
      id,
      path: backupPath,
      dev: backupIdentity.dev,
      ino: backupIdentity.ino,
      bytes: Uint8Array.from(content.baseline.originalBytes)
    }
    incompleteBackup = undefined
    result.recovery = recovery
    const tempPath = join(directory, `.zonecodex-${id}.tmp`)
    const tempIdentity = await stage(tempPath, content.candidateBytes, false, targetInfo.mode)
    // Verify owned artifacts and parent, then reread the target as the last asynchronous check.
    await checkParent(directory, parent)
    for (const [path, identity, bytes] of [
      [backupPath, backupIdentity, content.baseline.originalBytes],
      [tempPath, tempIdentity, content.candidateBytes]
    ] as const) {
      const checked = (await read(path, signal)).baseline
      if (!same(identity, checked) || !equal(bytes, checked.originalBytes))
        throw new Error('Staged file changed')
    }
    if (!(await validate())) {
      result.status = 'conflict'
      result.message = '备份期间文件已变化，本次未替换目标，请重新选择文件'
      return result
    }
    signal.throwIfAborted()
    if (!canReplace()) throw new Error('Grant expired')
    // Deliberately no await between the authorization gate and issuing rename.
    // Rename is NOT a compare-and-swap with an external editor.
    onPhase('replacing')
    attempted = true
    await io.rename(tempPath, target)
    onPhase('verifying')
    await checkParent(directory, parent)
    const after = (await read(target, uncancelled)).baseline
    if (!same(tempIdentity, after) || !equal(after.originalBytes, content.candidateBytes))
      throw new Error('Commit verification failed')
    temporary = undefined
    result.status = 'applied'
    result.message = '已提交，旧附件授权已清除，请重新选择文件后继续'
    return result
  } catch {
    result.status = attempted ? 'uncertain' : signal.aborted ? 'cancelled' : 'error'
    result.message = attempted
      ? '已尝试替换，无法确认最终文件状态，请检查目标与备份；不要直接重试'
      : signal.aborted
        ? '已在替换前取消，本次未替换目标'
        : result.message
    return result
  } finally {
    // Never roll back the target: it may already contain a newer external edit.
    for (const owned of [incompleteBackup, !attempted ? temporary : undefined]) {
      if (!owned) continue
      try {
        await checkParent(directory, parent)
        const info = await lstat(owned.path)
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1 ||
          !same(info, owned.identity)
        )
          result.cleanupWarning = true
        else await io.unlink(owned.path)
      } catch {
        result.cleanupWarning = true
      }
    }
    if (attempted && result.status === 'uncertain') result.cleanupWarning = true
    onPhase('finished')
  }
}

export async function verifyRecovery(file: RecoveryFile): Promise<boolean> {
  try {
    const readback = (await read(file.path, new AbortController().signal)).baseline
    return (
      same(file, readback) &&
      equal(file.bytes, readback.originalBytes) &&
      basename(file.path) === `.zonecodex-${file.id}.bak`
    )
  } catch {
    return false
  }
}
