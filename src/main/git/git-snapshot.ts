import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { GitReadError } from './git-process'

export const gitSnapshotLimits = {
  objectBytes: 128 * 1024 * 1024,
  objectFiles: 20000,
  worktreeBytes: 32 * 1024 * 1024,
  worktreeEntries: 10000,
  trackedFileBytes: 8 * 1024 * 1024,
  metadataBytes: 16 * 1024 * 1024
} as const

export function failUnsupported(message: string): never {
  throw new GitReadError('unsupported', message)
}

export function decodeGitText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return failUnsupported('不支持非 UTF-8 文件名或内容')
  }
}

export function validRepositoryPath(value: string): boolean {
  return (
    !!value &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0') &&
    !path.posix.isAbsolute(value) &&
    value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git') &&
    !value
      .split('/')
      .some(
        (part) => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
}

export function withinScope(relative: string, scope: string, ignoreCase = false): boolean {
  if (ignoreCase) {
    relative = relative.toLowerCase()
    scope = scope.toLowerCase()
  }
  return !scope || relative === scope || relative.startsWith(scope + '/')
}

export async function assertOrdinaryPath(target: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(target)
  if (!path.isAbsolute(target) || absolute.startsWith('\\\\') || /\p{Cc}/u.test(absolute))
    failUnsupported('首版不支持网络目录、设备路径或控制字符目录')
  const parsed = path.parse(absolute)
  const tail = absolute.slice(parsed.root.length)
  if (tail.includes(':')) failUnsupported('首版不支持 ADS 或设备路径')
  let current = parsed.root
  for (const part of tail.split(path.sep).filter(Boolean)) {
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      failUnsupported('首版不支持特殊 Windows 路径')
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) failUnsupported('首版不穿透符号链接或目录联接')
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export interface Fingerprint {
  target: string
  kind: 'file' | 'directory' | 'missing'
  identity: string
  digest?: string
}

function identity(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

/** Bounded capture plus freshness. It is not an OS sandbox against concurrent hostile writers. */
export class SourceCapture {
  readonly fingerprints = new Map<string, Fingerprint>()
  metadataBytes = 0
  objectBytes = 0
  objectFiles = 0
  worktreeBytes = 0
  worktreeEntries = 0
  constructor(
    readonly signal?: AbortSignal,
    private readonly started = Date.now()
  ) {}
  check(): void {
    if (this.signal?.aborted) throw new GitReadError('cancelled', 'Git 读取已取消')
    if (Date.now() - this.started > 10000) throw new GitReadError('error', 'Git 快照读取超过 10 秒')
  }
  async directory(target: string): Promise<string[]> {
    this.check()
    await assertOrdinaryPath(target)
    const before = await fs.lstat(target)
    if (!before.isDirectory()) failUnsupported('仓库目录类型不支持')
    const names = (await fs.readdir(target)).sort()
    const after = await fs.lstat(target)
    if (identity(before) !== identity(after))
      throw new GitReadError('stale', '目录读取时已变化，请刷新')
    this.fingerprints.set(target, {
      target,
      kind: 'directory',
      identity: identity(after),
      digest: createHash('sha256').update(JSON.stringify(names)).digest('hex')
    })
    return names
  }
  async file(
    target: string,
    limit: number,
    budget?: 'metadata' | 'objects' | 'worktree'
  ): Promise<Buffer> {
    this.check()
    await assertOrdinaryPath(target)
    const before = await fs.lstat(target)
    if (!before.isFile()) failUnsupported('首版只读取普通文件')
    if (before.size > limit) throw new GitReadError('too-large', '文件超过 Git 查看限额')
    if (budget === 'metadata' && this.metadataBytes + before.size > gitSnapshotLimits.metadataBytes)
      throw new GitReadError('too-large', 'Git 元数据超过 16 MiB')
    if (
      budget === 'objects' &&
      (this.objectBytes + before.size > gitSnapshotLimits.objectBytes ||
        this.objectFiles + 1 > gitSnapshotLimits.objectFiles)
    )
      throw new GitReadError('too-large', 'Git 对象快照超过 128 MiB / 20000 文件')
    if (budget === 'worktree' && this.worktreeBytes + before.size > gitSnapshotLimits.worktreeBytes)
      throw new GitReadError('too-large', '所选工作树快照超过 32 MiB')
    const handle = await fs.open(target, constants.O_RDONLY)
    let bytes: Buffer
    try {
      if (identity(await handle.stat()) !== identity(before))
        throw new GitReadError('stale', '文件句柄已变化')
      // Never allocate based on an unbounded readFile after the first size check.
      bytes = Buffer.alloc(before.size)
      let offset = 0
      while (offset < bytes.length) {
        this.check()
        const result = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      const extra = Buffer.alloc(1)
      const tail = await handle.read(extra, 0, 1, bytes.length)
      if (
        offset !== bytes.length ||
        tail.bytesRead ||
        identity(await handle.stat()) !== identity(before)
      )
        throw new GitReadError('stale', '文件读取时已变化，请刷新')
    } finally {
      await handle.close()
    }
    const after = await fs.lstat(target)
    if (identity(after) !== identity(before))
      throw new GitReadError('stale', '文件读取时已变化，请刷新')
    this.fingerprints.set(target, {
      target,
      kind: 'file',
      identity: identity(after),
      digest: createHash('sha256').update(bytes!).digest('hex')
    })
    if (budget === 'metadata') {
      this.metadataBytes += bytes!.length
      if (this.metadataBytes > gitSnapshotLimits.metadataBytes)
        throw new GitReadError('too-large', 'Git 元数据超过 16 MiB')
    } else if (budget === 'objects') {
      this.objectBytes += bytes!.length
      if (
        ++this.objectFiles > gitSnapshotLimits.objectFiles ||
        this.objectBytes > gitSnapshotLimits.objectBytes
      )
        throw new GitReadError('too-large', 'Git 对象快照超过 128 MiB / 20000 文件')
    } else if (budget === 'worktree') {
      this.worktreeBytes += bytes!.length
      if (this.worktreeBytes > gitSnapshotLimits.worktreeBytes)
        throw new GitReadError('too-large', '所选工作树快照超过 32 MiB')
    }
    return bytes!
  }
  async optionalFile(
    target: string,
    limit: number,
    budget: 'metadata' = 'metadata'
  ): Promise<Buffer | undefined> {
    try {
      return await this.file(target, limit, budget)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.fingerprints.set(target, { target, kind: 'missing', identity: '' })
      return undefined
    }
  }
  async statFile(target: string): Promise<void> {
    this.check()
    await assertOrdinaryPath(target)
    const stat = await fs.lstat(target)
    if (!stat.isFile()) failUnsupported('不支持非普通工作树文件')
    this.fingerprints.set(target, { target, kind: 'file', identity: identity(stat) })
  }
  async verify(): Promise<void> {
    for (const original of this.fingerprints.values()) {
      this.check()
      try {
        await assertOrdinaryPath(original.target, original.kind === 'missing')
        const current = await fs.lstat(original.target)
        if (original.kind === 'missing' || identity(current) !== original.identity)
          throw new GitReadError('stale', '仓库或文件已变化，请刷新')
        if (original.digest) {
          const bytes =
            original.kind === 'directory'
              ? Buffer.from(JSON.stringify((await fs.readdir(original.target)).sort()))
              : await new SourceCapture(this.signal).file(original.target, current.size)
          if (createHash('sha256').update(bytes).digest('hex') !== original.digest)
            throw new GitReadError('stale', '仓库内容已变化，请刷新')
        }
      } catch (error) {
        if (original.kind === 'missing' && (error as NodeJS.ErrnoException).code === 'ENOENT')
          continue
        if (error instanceof GitReadError) throw error
        throw new GitReadError('stale', '仓库路径已变化，请刷新')
      }
    }
  }
}

export interface IndexEntry {
  path: string
  mode: string
  stage: number
}

/** Index v2/v3 grammar, checksum and extension lengths; split/sparse are refused structurally. */
export function parseIndex(bytes: Buffer, hashFormat: 'sha1' | 'sha256'): IndexEntry[] {
  const hashBytes = hashFormat === 'sha1' ? 20 : 32
  if (bytes.length < 12 + hashBytes || bytes.toString('ascii', 0, 4) !== 'DIRC')
    failUnsupported('不支持的 Git index')
  const version = bytes.readUInt32BE(4)
  if (version !== 2 && version !== 3)
    failUnsupported('首版支持 index v2/v3；v4 请使用外部 Git 查看')
  if (
    !createHash(hashFormat)
      .update(bytes.subarray(0, -hashBytes))
      .digest()
      .equals(bytes.subarray(-hashBytes))
  )
    throw new GitReadError('error', 'Git index 校验失败')
  const count = bytes.readUInt32BE(8)
  if (count > 100000) throw new GitReadError('too-large', 'Git index 项数超过读取上限')
  const entries: IndexEntry[] = []
  let offset = 12
  for (let n = 0; n < count; n++) {
    const start = offset
    const fixed = 42 + hashBytes
    if (offset + fixed > bytes.length - hashBytes) failUnsupported('Git index 项不完整')
    const mode = bytes
      .readUInt32BE(offset + 24)
      .toString(8)
      .padStart(6, '0')
    const flags = bytes.readUInt16BE(offset + 40 + hashBytes)
    offset += fixed
    if (flags & 0x4000) {
      if (version < 3 || offset + 2 > bytes.length - hashBytes)
        failUnsupported('Git index 扩展不完整')
      const extended = bytes.readUInt16BE(offset)
      if (extended & 0x4000) failUnsupported('首版不支持 sparse/skip-worktree index')
      offset += 2
    }
    const end = bytes.indexOf(0, offset)
    if (end < offset || end >= bytes.length - hashBytes) failUnsupported('Git index 路径不完整')
    const filename = decodeGitText(bytes.subarray(offset, end))
    if (!validRepositoryPath(filename)) failUnsupported('Git index 含不支持的路径')
    if (mode === '040000') failUnsupported('首版不支持 sparse index')
    entries.push({ path: filename, mode, stage: (flags >> 12) & 3 })
    offset = start + Math.ceil((end + 1 - start) / 8) * 8
  }
  while (offset < bytes.length - hashBytes) {
    if (offset + 8 > bytes.length - hashBytes) failUnsupported('Git index 扩展不完整')
    const signature = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32BE(offset + 4)
    if (signature === 'link' || signature === 'sdir')
      failUnsupported('首版不支持 split/sparse index')
    if (!/^[A-Z]/.test(signature)) failUnsupported('不支持的必需 index 扩展')
    offset += 8 + length
    if (offset > bytes.length - hashBytes) failUnsupported('Git index 扩展越界')
  }
  return entries
}
