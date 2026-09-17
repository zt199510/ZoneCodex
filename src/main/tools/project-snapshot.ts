import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { AgentError } from '../agent/tool-loop'
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

export type ProjectExecutor = (
  name: string,
  argumentsText: string,
  signal: AbortSignal
) => Promise<string>

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
const maxResultLength = 12000

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function errorResult(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  )
}

function parseArguments(rawArguments: string): unknown | null {
  if (typeof rawArguments !== 'string' || rawArguments.length > 4096) return null
  try {
    return JSON.parse(rawArguments) as unknown
  } catch {
    return null
  }
}

function makeSearchSnippet(line: string, query: string): { text: string; truncated: boolean } {
  if (line.length <= 200) return { text: line, truncated: false }
  const position = line.indexOf(query)
  const start = Math.max(0, Math.min(position - 40, line.length - 200))
  return { text: line.slice(start, start + 200), truncated: true }
}

function serializeSearchResults(
  matches: Array<{ path: string; line: number; text: string }>,
  truncated: boolean
): string {
  let count = matches.length
  while (count > 0) {
    const result = JSON.stringify({
      matches: matches.slice(0, count),
      truncated: truncated || count < matches.length
    })
    if (result.length <= maxResultLength) return result
    count -= 1
  }
  return JSON.stringify({ matches: [], truncated: true })
}

function serializeReadResult(
  path: string,
  startLine: number,
  lines: readonly string[]
): string | null {
  for (let count = lines.length; count >= 1; count -= 1) {
    const text = lines.slice(0, count).join('\n')
    const result = JSON.stringify({
      path,
      startLine,
      endLine: startLine + count - 1,
      text,
      truncated: count < lines.length
    })
    if (result.length <= maxResultLength) return result
  }
  return null
}

export const projectTools = [
  {
    type: 'function',
    name: 'search_project_text',
    description:
      '在用户选中文件的只读快照中搜索区分大小写的字面量；只搜索清单内文件，不代表搜索整个项目。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\r\\n]+$' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_project_file',
    description: '按行读取用户选中文件的只读快照；path 必须来自清单，每次最多读取 80 行。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 240 },
        startLine: { type: 'integer', minimum: 1, maximum: 32769 },
        endLine: { type: 'integer', minimum: 1, maximum: 32769 }
      },
      required: ['path', 'startLine', 'endLine'],
      additionalProperties: false
    }
  }
] as const

export function createProjectExecutor(snapshot: ProjectSnapshot): ProjectExecutor {
  return async (name, rawArguments, signal) => {
    signal.throwIfAborted()
    const args = parseArguments(rawArguments)
    if (!isPlainRecord(args)) return errorResult('INVALID_ARGUMENTS')

    if (name === 'search_project_text') {
      if (
        !exactKeys(args, ['query']) ||
        typeof args.query !== 'string' ||
        !args.query.trim() ||
        args.query.length > 100 ||
        /[\r\n]/.test(args.query)
      ) {
        return errorResult('INVALID_ARGUMENTS')
      }

      const matches: Array<{ path: string; line: number; text: string }> = []
      let truncated = false
      const paths = [...snapshot.files.keys()].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      for (const path of paths) {
        signal.throwIfAborted()
        const lines = snapshot.files.get(path)
        if (!lines) continue
        for (let index = 0; index < lines.length; index += 1) {
          signal.throwIfAborted()
          const line = lines[index]
          if (!line.includes(args.query)) continue
          if (matches.length >= 20) {
            truncated = true
            break
          }
          const snippet = makeSearchSnippet(line, args.query)
          matches.push({ path, line: index + 1, text: snippet.text })
          truncated ||= snippet.truncated
        }
        if (truncated && matches.length >= 20) break
      }
      return serializeSearchResults(matches, truncated)
    }

    if (name === 'read_project_file') {
      if (
        !exactKeys(args, ['path', 'startLine', 'endLine']) ||
        typeof args.path !== 'string' ||
        !args.path ||
        !isIntegerInRange(args.startLine, 1, 32769) ||
        !isIntegerInRange(args.endLine, 1, 32769) ||
        args.endLine < args.startLine ||
        args.endLine - args.startLine + 1 > 80
      ) {
        return errorResult('INVALID_ARGUMENTS')
      }
      const lines = snapshot.files.get(args.path)
      if (!lines) return errorResult('NOT_SELECTED')
      if (args.startLine > lines.length || args.endLine > lines.length) {
        return errorResult('LINE_OUT_OF_RANGE')
      }
      const selectedLines = lines.slice(args.startLine - 1, args.endLine)
      return (
        serializeReadResult(args.path, args.startLine, selectedLines) ??
        errorResult('单行过长，无法在结果上限内完整返回')
      )
    }

    return errorResult('UNKNOWN_TOOL')
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
