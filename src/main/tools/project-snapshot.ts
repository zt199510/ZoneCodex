import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { AgentError } from '../errors'
import type { ProjectSelection } from '../../shared/project'

export type SourceBaseline = {
  absolutePath: string
  originalBytes: Uint8Array
  hasUtf8Bom: boolean
  newline: 'lf' | 'crlf' | 'none' | 'unsupported'
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export type ProjectSnapshot = {
  baselines?: ReadonlyMap<string, SourceBaseline>
  selection: ProjectSelection
  files: ReadonlyMap<string, readonly string[]>
  // Main-process-only canonical identities. Never sent to the renderer or model.
  sources?: ReadonlyMap<string, string>
}

const extensions = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html'])
const blockedPathParts = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'package-lock.json'
])
const maxFileBytes = 32768
const maxTotalBytes = 131072

function inside(root: string, target: string): string {
  const value = relative(root, target)
  if (!value || isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
    throw new AgentError('文件必须位于所选项目目录内')
  }
  return value
}

function allowedPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 240 ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return false
  }

  const parts = value.split('/')
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        /[. ]$/.test(part) ||
        blockedPathParts.has(part.toLowerCase()) ||
        /(^|[-_.])(secret|token|credential|password|private)([-_.]|$)/i.test(part)
    )
  ) {
    return false
  }
  return extensions.has(extname(value).toLowerCase())
}

function normalizeText(text: string): string[] {
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && ![9, 10, 13].includes(code)
    })
  ) {
    throw new AgentError('本课只读取 UTF-8 文本')
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

export async function readSelectedFile(
  root: string,
  relativePath: string,
  signal: AbortSignal
): Promise<{ bytes: number; lines: readonly string[]; baseline: SourceBaseline }> {
  let candidate = root
  for (const part of relativePath.split(sep)) {
    candidate = join(candidate, part)
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new AgentError('本课不读取符号链接或目录联接')
  }

  inside(root, await realpath(candidate))
  const before = await lstat(candidate)
  if (!before.isFile() || before.nlink !== 1) {
    throw new AgentError('只读取普通、非硬链接文件')
  }
  if (before.size > maxFileBytes) throw new AgentError('单文件最多 32 KiB')

  const handle = await open(candidate, 'r')
  try {
    const opened = await handle.stat()
    inside(root, await realpath(candidate))
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new AgentError('文件在选择期间变化，请重新选择')
    }

    const buffer = Buffer.alloc(maxFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      signal.throwIfAborted()
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    signal.throwIfAborted()
    if (length > maxFileBytes) throw new AgentError('单文件最多 32 KiB')

    const after = await handle.stat()
    // Recheck every path component after reading, including directory junctions.
    let checkedPath = root
    for (const part of relativePath.split(sep)) {
      checkedPath = join(checkedPath, part)
      if ((await lstat(checkedPath)).isSymbolicLink()) throw new AgentError('文件路径已变化')
    }
    const pathAfter = await lstat(candidate)
    if (
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      pathAfter.nlink !== 1 ||
      !pathAfter.isFile() ||
      pathAfter.size !== after.size ||
      pathAfter.mtimeMs !== after.mtimeMs ||
      pathAfter.ctimeMs !== after.ctimeMs ||
      after.nlink !== 1
    )
      throw new AgentError('文件已变化')
    if (
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      length !== after.size
    ) {
      throw new AgentError('文件正在修改，请保存完成后重新选择')
    }

    let text: string
    const originalBytes = Uint8Array.from(buffer.subarray(0, length))
    const hasUtf8Bom = length >= 3 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(hasUtf8Bom ? 3 : 0, length)
      )
    } catch {
      throw new AgentError('本课只读取 UTF-8 文本')
    }
    const withoutPairs = text.replace(/\r\n/g, '')
    const newline =
      withoutPairs.includes('\r') || (text.includes('\r\n') && withoutPairs.includes('\n'))
        ? 'unsupported'
        : text.includes('\r\n')
          ? 'crlf'
          : text.includes('\n')
            ? 'lf'
            : 'none'
    signal.throwIfAborted()
    return {
      bytes: length,
      lines: Object.freeze(normalizeText(text)),
      baseline: {
        absolutePath: candidate,
        originalBytes,
        hasUtf8Bom,
        newline,
        dev: after.dev,
        ino: after.ino,
        size: after.size,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs
      }
    }
  } finally {
    await handle.close()
  }
}

export async function createProjectSnapshot(
  directory: string,
  selected: string[],
  signal: AbortSignal
): Promise<ProjectSnapshot> {
  signal.throwIfAborted()
  if (typeof directory !== 'string' || !directory) throw new AgentError('请选择有效目录')
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 8) {
    throw new AgentError('每次请选择 1 至 8 个文件')
  }

  const lexicalRoot = resolve(directory)
  const root = await realpath(lexicalRoot)
  if (!(await stat(root)).isDirectory()) throw new AgentError('请选择有效目录')

  const files = new Map<string, readonly string[]>()
  const baselines = new Map<string, SourceBaseline>()
  const identities = new Set<string>()
  const metadata: ProjectSelection['files'] = []
  let totalBytes = 0

  for (const selectedPath of selected) {
    signal.throwIfAborted()
    if (typeof selectedPath !== 'string' || !selectedPath) {
      throw new AgentError('文件选择结果无效')
    }
    const relativePath = inside(lexicalRoot, resolve(selectedPath)).split(sep).join('/')
    if (!allowedPath(relativePath)) throw new AgentError('文件路径或类型不在本课允许范围内')

    const identity = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
    if (identities.has(identity)) throw new AgentError('文件选择结果包含重复路径')
    identities.add(identity)

    const file = await readSelectedFile(root, relativePath.replace(/\//g, sep), signal)
    totalBytes += file.bytes
    if (totalBytes > maxTotalBytes) throw new AgentError('选中文件合计最多 128 KiB')
    files.set(relativePath, file.lines)
    baselines.set(relativePath, file.baseline)
    metadata.push({ path: relativePath, bytes: file.bytes, lines: file.lines.length })
  }

  const directoryLabel = basename(root).slice(0, 80) || '项目'
  return {
    selection: {
      snapshotId: randomUUID(),
      label: directoryLabel,
      createdAt: new Date().toISOString(),
      files: metadata
    },
    files,
    baselines
  }
}

// Each picker-selected file is an individual grant, not access to a common parent directory.
// Existing files retain their immutable contents; selecting the same file explicitly refreshes it.
export async function createAttachmentSnapshot(
  selected: string[],
  signal: AbortSignal,
  previous?: ProjectSnapshot
): Promise<ProjectSnapshot> {
  signal.throwIfAborted()
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 8) {
    throw new AgentError('每次请选择 1 至 8 个文本文件')
  }
  const files = new Map(previous?.files)
  const sources = new Map(previous?.sources)
  const baselines = new Map(previous?.baselines)
  const metadata = previous?.selection.files.map((file) => ({ ...file })) ?? []
  for (const selectedPath of selected) {
    signal.throwIfAborted()
    if (typeof selectedPath !== 'string' || !isAbsolute(selectedPath)) {
      throw new AgentError('文件选择结果无效')
    }
    const absolute = resolve(selectedPath)
    const root = parse(absolute).root
    const relativePath = inside(root, absolute)
    // Validate every component and inspect links starting at the filesystem root.
    if (!allowedPath(relativePath.split(sep).join('/'))) {
      throw new AgentError('文件路径或类型不在允许范围内')
    }
    const file = await readSelectedFile(root, relativePath, signal)
    const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    const existing = [...sources].find(([, source]) => source === identity)?.[0]
    const path = existing ?? `file-${randomUUID()}/${basename(absolute)}`
    if (!allowedPath(path)) throw new AgentError('文件名过长或类型不受支持')
    const entry = { path, bytes: file.bytes, lines: file.lines.length }
    const index = metadata.findIndex((item) => item.path === path)
    if (index >= 0) metadata[index] = entry
    else metadata.push(entry)
    if (metadata.length > 8) throw new AgentError('最多添加 8 个文件，请先移除部分附件')
    if (metadata.reduce((sum, item) => sum + item.bytes, 0) > maxTotalBytes) {
      throw new AgentError('附件合计最多 128 KiB')
    }
    files.set(path, file.lines)
    sources.set(path, identity)
    baselines.set(path, file.baseline)
  }
  return {
    selection: {
      snapshotId: randomUUID(),
      label: '已选附件',
      createdAt: new Date().toISOString(),
      files: metadata
    },
    files,
    sources,
    baselines
  }
}

export function removeAttachment(snapshot: ProjectSnapshot, path: string): ProjectSnapshot | null {
  if (!snapshot.files.has(path)) throw new AgentError('附件不在当前选择中')
  const metadata = snapshot.selection.files.filter((file) => file.path !== path)
  if (metadata.length === 0) return null
  const files = new Map(snapshot.files)
  const sources = new Map(snapshot.sources)
  const baselines = new Map(snapshot.baselines)
  files.delete(path)
  sources.delete(path)
  baselines.delete(path)
  return {
    selection: {
      ...snapshot.selection,
      snapshotId: randomUUID(),
      createdAt: new Date().toISOString(),
      files: metadata
    },
    files,
    sources,
    baselines
  }
}
