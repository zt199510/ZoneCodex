import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Stats } from 'node:fs'
import type { ProjectExecutor } from './project-file-tools'
import { AgentError } from '../errors'
import { canonicalLocalPath, insideLocalPath, localPathParts } from './local-path'

export type WorkspaceReadOptions = { isPathAllowed?: (target: string) => boolean }
export type WorkspaceReadFormat = {
  encoding: 'utf-8'
  hasUtf8Bom: boolean
  newline: 'lf' | 'crlf' | 'none' | 'unsupported'
  trailingNewlines: number
}

const maxFileBytes = 128 * 1024
const maxSearchBytes = 2 * 1024 * 1024
const maxSearchFiles = 200
const maxEntries = 250
const maxVisitedEntries = 3000
const maxDepth = 8
const maxResultLength = 11000
const maxReadLines = 100
const maxPatchLines = 80
const maxPatchTextLength = 2000

function readFormat(text: string, hasUtf8Bom: boolean): WorkspaceReadFormat {
  const separators = text.match(/\r\n|\n|\r/g) ?? []
  const newline =
    separators.length === 0
      ? 'none'
      : separators.every((separator) => separator === '\n')
        ? 'lf'
        : separators.every((separator) => separator === '\r\n')
          ? 'crlf'
          : 'unsupported'
  const trailing = text.match(/(?:\r\n|\n|\r)+$/)?.[0] ?? ''
  return {
    encoding: 'utf-8',
    hasUtf8Bom,
    newline,
    trailingNewlines: (trailing.match(/\r\n|\n|\r/g) ?? []).length
  }
}

const skippedDirectories = new Set([
  '.git',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  '.ssh',
  '.aws',
  'vendor',
  'target'
])
const skippedFiles =
  /(^\.(?:env(?:\.|$)|npmrc$|pypirc$|netrc$)|(?:^|[._-])(?:secret|credential|password|private[-_.]?key)(?:[._-]|$)|\.(?:pem|p12|pfx|key)$)/i

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseArguments(raw: string, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!isPlainRecord(value)) return null
    const actual = Object.keys(value).sort()
    const expected = [...keys].sort()
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
      ? value
      : null
  } catch {
    return null
  }
}

function relativeParts(value: unknown, allowRoot = false): string[] | null {
  if (typeof value !== 'string' || value.length > 512 || (!allowRoot && !value)) return null
  if (!value && allowRoot) return []
  if (isAbsolute(value) || value.includes('\\') || value.includes(':')) return null
  const parts = value.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        Array.from(part).some((character) => {
          const code = character.charCodeAt(0)
          return code < 32 || code === 127
        }) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  )
    return null
  return parts
}

function isSkippedPath(parts: readonly string[]): boolean {
  return (
    parts.some((part) => skippedDirectories.has(part.toLowerCase())) ||
    (parts.length > 0 && skippedFiles.test(parts[parts.length - 1]))
  )
}

/** The viewer and model reads share the existing local read exclusions. */
export function isLocalReadPathAllowed(target: string): boolean {
  return !isSkippedPath(localPathParts(target))
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function errorResult(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function boundedResult<T>(
  field: string,
  values: T[],
  rest: Record<string, unknown>,
  truncated: boolean
): string {
  let count = values.length
  while (count >= 0) {
    const result = JSON.stringify({
      ok: true,
      ...rest,
      ...('fullText' in rest && count < values.length ? { fullText: null } : {}),
      [field]: values.slice(0, count),
      truncated: truncated || count < values.length
    })
    if (result.length <= maxResultLength) return result
    count -= 1
  }
  return errorResult('结果超过大小上限')
}

export const workspaceReadTools = [
  {
    type: 'function',
    name: 'list_workspace_files',
    description:
      '列出运行权限允许的本地文件和目录。path 接受相对于默认运行目录的路径或本地绝对路径，默认目录传空字符串；recursive 控制是否递归。结果有数量和深度上限。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512 },
        recursive: { type: 'boolean' }
      },
      required: ['path', 'recursive'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'search_workspace_text',
    description:
      '在运行权限允许的本地 UTF-8 小文本文件中搜索区分大小写的字面量；path 接受相对目录或本地绝对目录，默认目录传空字符串。结果有扫描和数量上限。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512 },
        query: { type: 'string', minLength: 1, maxLength: 100 }
      },
      required: ['path', 'query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_workspace_file',
    description:
      '按需读取运行权限允许的本地 UTF-8 文件片段；path 接受相对运行目录或本地绝对路径，原字节最多128 KiB，每次最多100行、每行最多2000字符，结果最多11000字符。返回实际目标路径、原字节sha256、format与真实行号/文字。修改只需本执行请求同hash的必要完整可见行，不要求完整读取或累计全文覆盖；未返回和逐行截断的行不能作为补丁旧文依据。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 512 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 }
      },
      required: ['path', 'startLine', 'endLine'],
      additionalProperties: false
    }
  }
] as const

export function createWorkspaceReadExecutor(
  root: string,
  assertAccess: () => boolean,
  options: WorkspaceReadOptions = {}
): ProjectExecutor {
  const canonicalRoot = resolve(root)
  const genericPaths = options.isPathAllowed !== undefined

  function outputPath(target: string): string {
    return genericPaths ? target : relative(canonicalRoot, target).split(sep).join('/')
  }

  function checkedInput(value: unknown, allowRoot = false): string | null {
    if (typeof value !== 'string' || value.length > 512 || (!value && !allowRoot)) return null
    if (!genericPaths) {
      const parts = relativeParts(value, allowRoot)
      if (!parts || isSkippedPath(parts)) return null
    }
    return value
  }

  function checkAccess(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!assertAccess()) throw new AgentError('工作区授权已失效')
  }

  async function checkedPath(
    input: string,
    signal: AbortSignal
  ): Promise<{ path: string; info: Stats }> {
    checkAccess(signal)
    const candidate = await canonicalLocalPath(canonicalRoot, input, true)
    checkAccess(signal)
    if (
      genericPaths
        ? !options.isPathAllowed!(candidate) || !isLocalReadPathAllowed(candidate)
        : !insideLocalPath(canonicalRoot, candidate)
    ) {
      throw new AgentError('路径超出允许的文件范围')
    }
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new AgentError('不读取符号链接或目录联接')
    const actual = await realpath(candidate)
    checkAccess(signal)
    if (actual !== candidate) throw new AgentError('目标的实际路径已变化')
    return { path: candidate, info }
  }

  async function readText(
    path: string,
    signal: AbortSignal
  ): Promise<{ path: string; text: string; sha256: string; format: WorkspaceReadFormat } | null> {
    const before = await checkedPath(path, signal)
    if (!before.info.isFile() || before.info.nlink !== 1 || before.info.size > maxFileBytes)
      return null
    const handle = await open(before.path, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before.info)) return null
      const buffer = Buffer.alloc(maxFileBytes + 1)
      let length = 0
      while (length < buffer.length) {
        checkAccess(signal)
        const read = await handle.read(buffer, length, buffer.length - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > maxFileBytes) return null
      const after = await handle.stat()
      const pathAfter = await checkedPath(before.path, signal)
      if (
        !sameIdentity(opened, after) ||
        !sameIdentity(after, pathAfter.info) ||
        after.size !== length ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        pathAfter.info.size !== after.size ||
        pathAfter.info.mtimeMs !== after.mtimeMs ||
        pathAfter.info.ctimeMs !== after.ctimeMs
      )
        return null
      try {
        const bytes = buffer.subarray(0, length)
        const hasUtf8Bom =
          bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const containsControlCharacter = Array.from(text).some((character) => {
          const code = character.charCodeAt(0)
          return code < 32 && ![9, 10, 13].includes(code)
        })
        return containsControlCharacter
          ? null
          : {
              path: before.path,
              text,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              format: readFormat(text, hasUtf8Bom)
            }
      } catch {
        return null
      }
    } finally {
      await handle.close()
    }
  }

  type Entry = { path: string; type: 'file' | 'directory'; bytes?: number }
  async function walk(
    start: string,
    recursive: boolean,
    signal: AbortSignal,
    onEntry: (entry: Entry) => Promise<boolean> | boolean
  ): Promise<{ truncated: boolean; visited: number }> {
    const pending: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }]
    let visited = 0
    let truncated = false
    while (pending.length > 0) {
      checkAccess(signal)
      const current = pending.shift()!
      const directory = await checkedPath(current.path, signal)
      if (!directory.info.isDirectory()) throw new AgentError('目标不是目录')
      const names: string[] = []
      let directoryTruncated = false
      const stream = await opendir(directory.path)
      for await (const entry of stream) {
        checkAccess(signal)
        if (names.length >= maxVisitedEntries - visited) {
          directoryTruncated = true
          break
        }
        names.push(entry.name)
      }
      names.sort((a, b) => a.localeCompare(b))
      const after = await checkedPath(directory.path, signal)
      if (!sameIdentity(directory.info, after.info)) throw new AgentError('目录已变化')
      for (const name of names) {
        checkAccess(signal)
        if (visited >= maxVisitedEntries) return { truncated: true, visited }
        visited += 1
        if (skippedDirectories.has(name.toLowerCase()) || skippedFiles.test(name)) continue
        if (!relativeParts(name)) continue
        let child: { path: string; info: Stats }
        try {
          child = await checkedPath(join(directory.path, name), signal)
        } catch (error) {
          if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
          continue
        }
        const path = outputPath(child.path)
        if (child.info.isDirectory()) {
          if (!(await onEntry({ path, type: 'directory' }))) return { truncated: true, visited }
          if (recursive) {
            if (current.depth < maxDepth)
              pending.push({ path: child.path, depth: current.depth + 1 })
            else truncated = true
          }
        } else if (child.info.isFile() && child.info.nlink === 1) {
          if (!(await onEntry({ path, type: 'file', bytes: child.info.size }))) {
            return { truncated: true, visited }
          }
        }
      }
      if (directoryTruncated) return { truncated: true, visited }
    }
    return { truncated, visited }
  }

  return async (name, raw, signal) => {
    checkAccess(signal)
    if (name === 'list_workspace_files') {
      const args = parseArguments(raw, ['path', 'recursive'])
      const path = checkedInput(args?.path, true)
      if (!args || path === null || typeof args.recursive !== 'boolean') {
        return errorResult('参数无效')
      }
      const entries: Entry[] = []
      try {
        const target = await checkedPath(path, signal)
        const scan = await walk(target.path, args.recursive, signal, (entry) => {
          if (entries.length >= maxEntries) return false
          entries.push(entry)
          return true
        })
        checkAccess(signal)
        return boundedResult(
          'entries',
          entries,
          { path: outputPath(target.path), visited: scan.visited },
          scan.truncated
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        signal.throwIfAborted()
        return errorResult(error instanceof Error ? error.message : '无法列出本地目录')
      }
    }
    if (name === 'search_workspace_text') {
      const args = parseArguments(raw, ['path', 'query'])
      const path = checkedInput(args?.path, true)
      if (
        !args ||
        path === null ||
        typeof args.query !== 'string' ||
        !args.query.trim() ||
        args.query.length > 100 ||
        /[\r\n]/.test(args.query)
      )
        return errorResult('参数无效')
      const matches: Array<{ path: string; line: number; text: string }> = []
      let scannedFiles = 0
      let scannedBytes = 0
      let skipped = 0
      try {
        const target = await checkedPath(path, signal)
        const scan = await walk(target.path, true, signal, async (entry) => {
          if (entry.type !== 'file') return true
          if ((entry.bytes ?? 0) > maxFileBytes) {
            skipped += 1
            return true
          }
          if (
            scannedFiles >= maxSearchFiles ||
            scannedBytes + (entry.bytes ?? 0) > maxSearchBytes
          ) {
            return false
          }
          const file = await readText(entry.path, signal).catch((error: unknown) => {
            if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
            signal.throwIfAborted()
            return null
          })
          if (file === null) {
            skipped += 1
            return true
          }
          scannedFiles += 1
          scannedBytes += Buffer.byteLength(file.text, 'utf8')
          const lines = file.text.split(/\r\n|\n|\r/)
          for (let index = 0; index < lines.length; index++) {
            const position = lines[index].indexOf(args.query as string)
            if (position < 0) continue
            const start = Math.max(0, position - 50)
            matches.push({
              path: entry.path,
              line: index + 1,
              text: lines[index].slice(start, start + 240)
            })
            if (matches.length >= 30) return false
          }
          return true
        })
        checkAccess(signal)
        return boundedResult(
          'matches',
          matches,
          { path: outputPath(target.path), query: args.query, scannedFiles, scannedBytes, skipped },
          scan.truncated
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        signal.throwIfAborted()
        return errorResult(error instanceof Error ? error.message : '无法搜索本地文本')
      }
    }
    if (name === 'read_workspace_file') {
      const args = parseArguments(raw, ['path', 'startLine', 'endLine'])
      const path = checkedInput(args?.path)
      if (
        !args ||
        path === null ||
        !Number.isInteger(args.startLine) ||
        !Number.isInteger(args.endLine) ||
        (args.startLine as number) < 1 ||
        (args.endLine as number) < (args.startLine as number) ||
        (args.endLine as number) - (args.startLine as number) + 1 > maxReadLines
      )
        return errorResult('参数无效')
      try {
        const file = await readText(path, signal)
        checkAccess(signal)
        if (file === null)
          return errorResult('文件不是可读取的 UTF-8 小文本文件，或读取期间发生变化')
        const lines = file.text.split(/\r\n|\n|\r/)
        if ((args.startLine as number) > lines.length) {
          return errorResult('行号超出范围')
        }
        const endLine = Math.min(args.endLine as number, lines.length)
        const selected = lines
          .slice((args.startLine as number) - 1, endLine)
          .map((line, index) => ({
            line: (args.startLine as number) + index,
            text: line.slice(0, 2000),
            truncated: line.length > 2000
          }))
        const normalizedText = lines.join('\n')
        const fullText =
          args.startLine === 1 &&
          endLine === lines.length &&
          lines.length <= maxPatchLines &&
          normalizedText.length <= maxPatchTextLength &&
          selected.every((line) => !line.truncated)
            ? normalizedText
            : null
        return boundedResult(
          'lines',
          selected,
          {
            path: outputPath(file.path),
            totalLines: lines.length,
            sha256: file.sha256,
            format: file.format,
            fullText
          },
          false
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        signal.throwIfAborted()
        return errorResult(error instanceof Error ? error.message : '无法读取本地文件')
      }
    }
    return errorResult('未知工具')
  }
}
