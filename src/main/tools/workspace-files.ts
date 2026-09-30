import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Stats } from 'node:fs'
import type { ProjectExecutor } from './project-snapshot'
import { AgentError } from '../agent/tool-loop'

const maxFileBytes = 128 * 1024
const maxSearchBytes = 2 * 1024 * 1024
const maxSearchFiles = 200
const maxEntries = 250
const maxVisitedEntries = 3000
const maxDepth = 8
const maxResultLength = 11000
const maxReadLines = 100

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

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
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
      '列出已授权工作区内的文件和目录。path 用工作区相对路径，根目录传空字符串；recursive 控制是否递归。结果有数量和深度上限。',
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
      '在已授权工作区的 UTF-8 小文本文件中搜索区分大小写的字面量；path 是相对目录，根目录传空字符串。结果有扫描和数量上限。',
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
      '按行读取已授权工作区内的 UTF-8 文本文件；path 是工作区相对文件路径，每次最多 100 行。',
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
  assertAccess: () => boolean
): ProjectExecutor {
  const canonicalRoot = resolve(root)

  function checkAccess(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!assertAccess()) throw new AgentError('工作区授权已失效')
  }

  async function checkedPath(
    parts: string[],
    signal: AbortSignal
  ): Promise<{ path: string; info: Stats }> {
    checkAccess(signal)
    let candidate = canonicalRoot
    for (const part of parts) {
      candidate = join(candidate, part)
      const info = await lstat(candidate)
      checkAccess(signal)
      if (info.isSymbolicLink()) throw new AgentError('不读取符号链接或目录联接')
    }
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new AgentError('不读取符号链接或目录联接')
    const actual = await realpath(candidate)
    checkAccess(signal)
    if (!inside(canonicalRoot, actual) || !inside(canonicalRoot, candidate)) {
      throw new AgentError('路径超出已授权工作区')
    }
    return { path: candidate, info }
  }

  async function readText(
    parts: string[],
    signal: AbortSignal
  ): Promise<{ text: string; sha256: string } | null> {
    const before = await checkedPath(parts, signal)
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
      const pathAfter = await checkedPath(parts, signal)
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
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
        const containsControlCharacter = Array.from(text).some((character) => {
          const code = character.charCodeAt(0)
          return code < 32 && ![9, 10, 13].includes(code)
        })
        return containsControlCharacter
          ? null
          : { text, sha256: createHash('sha256').update(buffer.subarray(0, length)).digest('hex') }
      } catch {
        return null
      }
    } finally {
      await handle.close()
    }
  }

  type Entry = { path: string; type: 'file' | 'directory'; bytes?: number }
  async function walk(
    start: string[],
    recursive: boolean,
    signal: AbortSignal,
    onEntry: (entry: Entry) => Promise<boolean> | boolean
  ): Promise<{ truncated: boolean; visited: number }> {
    const pending: Array<{ parts: string[]; depth: number }> = [{ parts: start, depth: 0 }]
    let visited = 0
    let truncated = false
    while (pending.length > 0) {
      checkAccess(signal)
      const current = pending.shift()!
      const directory = await checkedPath(current.parts, signal)
      if (!directory.info.isDirectory()) throw new AgentError('目标不是目录')
      const names = (await readdir(directory.path)).sort((a, b) => a.localeCompare(b))
      const after = await checkedPath(current.parts, signal)
      if (!sameIdentity(directory.info, after.info)) throw new AgentError('目录已变化')
      for (const name of names) {
        checkAccess(signal)
        if (visited >= maxVisitedEntries) return { truncated: true, visited }
        visited += 1
        if (skippedDirectories.has(name.toLowerCase()) || skippedFiles.test(name)) continue
        const parts = [...current.parts, name]
        if (!relativeParts(parts.join('/'))) continue
        let child: { path: string; info: Stats }
        try {
          child = await checkedPath(parts, signal)
        } catch (error) {
          if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
          continue
        }
        const path = parts.join('/')
        if (child.info.isDirectory()) {
          if (!(await onEntry({ path, type: 'directory' }))) return { truncated: true, visited }
          if (recursive) {
            if (current.depth < maxDepth) pending.push({ parts, depth: current.depth + 1 })
            else truncated = true
          }
        } else if (child.info.isFile() && child.info.nlink === 1) {
          if (!(await onEntry({ path, type: 'file', bytes: child.info.size }))) {
            return { truncated: true, visited }
          }
        }
      }
    }
    return { truncated, visited }
  }

  return async (name, raw, signal) => {
    checkAccess(signal)
    if (name === 'list_workspace_files') {
      const args = parseArguments(raw, ['path', 'recursive'])
      const parts = relativeParts(args?.path, true)
      if (!args || !parts || isSkippedPath(parts) || typeof args.recursive !== 'boolean') {
        return errorResult('参数无效')
      }
      const entries: Entry[] = []
      try {
        const scan = await walk(parts, args.recursive, signal, (entry) => {
          if (entries.length >= maxEntries) return false
          entries.push(entry)
          return true
        })
        checkAccess(signal)
        return boundedResult(
          'entries',
          entries,
          { path: args.path, visited: scan.visited },
          scan.truncated
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        return errorResult(error instanceof AgentError ? error.message : '无法列出工作区目录')
      }
    }
    if (name === 'search_workspace_text') {
      const args = parseArguments(raw, ['path', 'query'])
      const parts = relativeParts(args?.path, true)
      if (
        !args ||
        !parts ||
        isSkippedPath(parts) ||
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
        const scan = await walk(parts, true, signal, async (entry) => {
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
          const file = await readText(entry.path.split('/'), signal).catch((error: unknown) => {
            if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
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
          { path: args.path, query: args.query, scannedFiles, scannedBytes, skipped },
          scan.truncated
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        return errorResult(error instanceof AgentError ? error.message : '无法搜索工作区文本')
      }
    }
    if (name === 'read_workspace_file') {
      const args = parseArguments(raw, ['path', 'startLine', 'endLine'])
      const parts = relativeParts(args?.path)
      if (
        !args ||
        !parts ||
        isSkippedPath(parts) ||
        !Number.isInteger(args.startLine) ||
        !Number.isInteger(args.endLine) ||
        (args.startLine as number) < 1 ||
        (args.endLine as number) < (args.startLine as number) ||
        (args.endLine as number) - (args.startLine as number) + 1 > maxReadLines
      )
        return errorResult('参数无效')
      try {
        const file = await readText(parts, signal)
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
        return boundedResult(
          'lines',
          selected,
          { path: args.path, totalLines: lines.length, sha256: file.sha256 },
          false
        )
      } catch (error) {
        if (error instanceof AgentError && error.message === '工作区授权已失效') throw error
        return errorResult(error instanceof AgentError ? error.message : '无法读取工作区文件')
      }
    }
    return errorResult('未知工具')
  }
}
