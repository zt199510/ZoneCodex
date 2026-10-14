import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  canonicalSkillSnapshot,
  isSkillDescription,
  isSkillName,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DIRECTORIES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_HEADER_BYTES,
  parseSkillSnapshot,
  type SkillSnapshot
} from '../../shared/skills'
import {
  assertSkillObjectProof,
  checkWindowsSkillObjects,
  type SkillObjectProof
} from './windows-skill-objects'

export type SkillMetadata = { name: string; description: string }
export type SkillFileIdentity = {
  root: string
  directory: string
  rootIdentity: string
  directoryIdentity: string
  fileIdentity: string
}
export type ReadSkillResult = { snapshot: SkillSnapshot; identity: SkillFileIdentity }

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('技能操作已取消')
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}
function objectIdentity(info: Stats): string {
  return JSON.stringify([info.dev, info.ino, info.birthtimeMs])
}
function fileIdentity(info: Stats): string {
  return JSON.stringify([objectIdentity(info), info.size, info.mtimeMs, info.ctimeMs, info.nlink])
}
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
/** Node lstat plus canonical path checks reject symlink/junction ancestors as well as the item. */
export async function checkSkillDirectory(directory: string): Promise<Stats> {
  const absolute = resolve(directory)
  let current = absolute
  let selected: Stats | null = null
  for (;;) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('技能目录必须是普通本地目录，不能是链接或联接')
    if (!samePath(await realpath(current), current)) throw new Error('技能目录不能经过链接或联接')
    if (!selected) selected = info
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return selected!
}

/** Enumerate at most 64 immediate directory entries; missing roots stay missing. */
export async function listSkillDirectories(root: string, signal?: AbortSignal): Promise<string[]> {
  checkAbort(signal)
  try {
    const info = await checkSkillDirectory(root)
    assertSkillObjectProof(await checkWindowsSkillObjects([root], signal), root, info)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const reader = await opendir(root)
  const directories: string[] = []
  try {
    for (;;) {
      checkAbort(signal)
      const entry = await reader.read()
      if (!entry) break
      // Links and non-directory entries still count towards the bounded enumeration.
      directories.push(entry.name)
      if (directories.length > MAX_SKILL_DIRECTORIES)
        throw new Error('技能目录项超过 64 项，请减少后刷新')
    }
  } finally {
    await reader.close()
  }
  checkAbort(signal)
  const after = await checkSkillDirectory(root)
  assertSkillObjectProof(await checkWindowsSkillObjects([root], signal), root, after)
  return directories.sort()
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('SKILL.md 必须是严格 UTF-8 文本')
  }
}
function parseHeader(
  text: string,
  expectedName: string
): { metadata: SkillMetadata; bodyStart: number } {
  const source = text.startsWith('\ufeff') ? text.slice(1) : text
  const bom = text.length - source.length
  const lines = source.split('\n')
  if (lines[0]?.replace(/\r$/, '') !== '---')
    throw new Error('SKILL.md 必须以 --- frontmatter 开头')
  const fields: Record<string, string> = {}
  let offset = bom + lines[0].length + 1
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '')
    if (line === '---') {
      if (
        Object.keys(fields).length !== 2 ||
        !isSkillName(fields.name) ||
        fields.name !== expectedName ||
        !isSkillDescription(fields.description)
      )
        throw new Error('技能必须有合法 name 和 description，且 name 与目录名相同')
      return {
        metadata: { name: fields.name, description: fields.description },
        bodyStart: offset + lines[index].length + (index < lines.length - 1 ? 1 : 0)
      }
    }
    const match = /^(name|description):[ \t]+([^\r\n]+)$/.exec(line)
    if (!match || Object.hasOwn(fields, match[1]))
      throw new Error('frontmatter 仅支持 name 与 description 各一次的单行字段')
    const value = match[2].trim()
    if (
      !value ||
      ['[', ']', '{', '}', "'", '"', '|', '>', '&', '*', '!', '%', '@', '`', '#'].includes(
        value[0]
      ) ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('frontmatter 不支持引号、嵌套、标签或多行标量')
    fields[match[1]] = value
    offset += lines[index].length + 1
  }
  throw new Error('frontmatter 必须在 4096 字节内以 --- 闭合')
}

async function withSkillFile<T>(
  root: string,
  directoryName: string,
  signal: AbortSignal | undefined,
  work: (handle: FileHandle, before: Stats) => Promise<T>,
  suppliedProof?: SkillObjectProof | null
): Promise<{ value: T; identity: SkillFileIdentity }> {
  checkAbort(signal)
  if (!isSkillName(directoryName)) throw new Error('技能目录名无效或是 Windows 保留名称')
  const absoluteRoot = resolve(root)
  const directory = join(absoluteRoot, directoryName)
  if (dirname(directory) !== absoluteRoot) throw new Error('技能路径不属于固定目录')
  const rootBefore = await checkSkillDirectory(absoluteRoot)
  const directoryBefore = await checkSkillDirectory(directory)
  const filename = join(directory, 'SKILL.md')
  const before = await lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('SKILL.md 必须是普通单硬链接文件，不能是链接')
  if (before.size < 1 || before.size > MAX_SKILL_FILE_BYTES)
    throw new Error('SKILL.md 大小须为 1 字节至 64 KiB')
  if (!samePath(await realpath(filename), filename)) throw new Error('SKILL.md 不能是链接或联接')
  const proof =
    suppliedProof ?? (await checkWindowsSkillObjects([absoluteRoot, directory, filename], signal))
  assertSkillObjectProof(proof, absoluteRoot, rootBefore)
  assertSkillObjectProof(proof, directory, directoryBefore)
  assertSkillObjectProof(proof, filename, before)
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || fileIdentity(opened) !== fileIdentity(before))
      throw new Error('技能文件已变化，请重新选择')
    const value = await work(handle, before)
    checkAbort(signal)
    const after = await handle.stat()
    const current = await lstat(filename)
    const rootAfter = await checkSkillDirectory(absoluteRoot)
    const directoryAfter = await checkSkillDirectory(directory)
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      fileIdentity(after) !== fileIdentity(before) ||
      fileIdentity(current) !== fileIdentity(before) ||
      !samePath(await realpath(filename), filename) ||
      objectIdentity(rootAfter) !== objectIdentity(rootBefore) ||
      objectIdentity(directoryAfter) !== objectIdentity(directoryBefore)
    )
      throw new Error('技能文件或目录在读取期间已变化，请重新选择')
    const finalProof =
      suppliedProof ?? (await checkWindowsSkillObjects([absoluteRoot, directory, filename], signal))
    assertSkillObjectProof(finalProof, absoluteRoot, rootAfter)
    assertSkillObjectProof(finalProof, directory, directoryAfter)
    assertSkillObjectProof(finalProof, filename, current)
    checkAbort(signal)
    return {
      value,
      identity: {
        root: absoluteRoot,
        directory,
        rootIdentity: objectIdentity(rootBefore),
        directoryIdentity: objectIdentity(directoryBefore),
        fileIdentity: objectIdentity(before)
      }
    }
  } finally {
    await handle.close()
  }
}

async function readHeader(handle: FileHandle, size: number, signal?: AbortSignal): Promise<Buffer> {
  // Reading one byte at a time makes discovery stop exactly after the closing line.
  const bytes = Buffer.alloc(Math.min(size, MAX_SKILL_HEADER_BYTES))
  let start = 0
  let lines = 0
  for (let offset = 0; offset < bytes.length; offset++) {
    checkAbort(signal)
    const result = await handle.read(bytes, offset, 1, offset)
    if (result.bytesRead !== 1) throw new Error('技能文件已变化，请刷新')
    if (bytes[offset] !== 10 && offset !== size - 1) continue
    const end = bytes[offset] === 10 ? offset : offset + 1
    const line = decode(bytes.subarray(start, end)).replace(/\r$/, '')
    if (lines > 0 && line === '---') return bytes.subarray(0, offset + 1)
    lines++
    start = offset + 1
  }
  throw new Error('frontmatter 必须在 4096 字节内以 --- 闭合')
}
export async function readSkillMetadata(
  root: string,
  directoryName: string,
  signal?: AbortSignal,
  proof?: SkillObjectProof | null
): Promise<SkillMetadata> {
  const result = await withSkillFile(
    root,
    directoryName,
    signal,
    async (handle, info) => {
      const bytes = await readHeader(handle, info.size, signal)
      const repeated = await readHeader(handle, info.size, signal)
      if (!bytes.equals(repeated)) throw new Error('技能元信息在读取期间已变化，请刷新')
      return parseHeader(decode(bytes), directoryName).metadata
    },
    proof
  )
  return result.value
}
async function readBounded(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1)
  let length = 0
  while (length < bytes.length) {
    checkAbort(signal)
    const read = await handle.read(bytes, length, bytes.length - length, length)
    if (!read.bytesRead) break
    length += read.bytesRead
  }
  if (length > MAX_SKILL_FILE_BYTES) throw new Error('SKILL.md 超过 64 KiB')
  return bytes.subarray(0, length)
}
export function createSkillSnapshot(
  metadata: SkillMetadata,
  body: string,
  sourceHash: string
): SkillSnapshot {
  const fields = { name: metadata.name, description: metadata.description, body, sourceHash }
  const snapshotHash = createHash('sha256')
    .update(canonicalSkillSnapshot(fields), 'utf8')
    .digest('hex')
  const checked = parseSkillSnapshot({ ...fields, snapshotHash })
  if (!checked) throw new Error('技能正文为空、超过 12000 字符，或快照超过 20000 字符')
  return checked
}
export function validateSkillSnapshotHash(value: unknown): boolean {
  const checked = parseSkillSnapshot(value)
  return (
    !!checked &&
    checked.snapshotHash ===
      createHash('sha256').update(canonicalSkillSnapshot(checked), 'utf8').digest('hex')
  )
}
export async function readSkillSnapshot(
  root: string,
  directoryName: string,
  signal?: AbortSignal
): Promise<ReadSkillResult> {
  const result = await withSkillFile(root, directoryName, signal, async (handle, info) => {
    const bytes = await readBounded(handle, signal)
    const repeated = await readBounded(handle, signal)
    if (bytes.length !== info.size || !bytes.equals(repeated))
      throw new Error('技能文件内容在读取期间已变化，请重新选择')
    const source = decode(bytes)
    const header = parseHeader(source, directoryName)
    if (Buffer.byteLength(source.slice(0, header.bodyStart), 'utf8') > MAX_SKILL_HEADER_BYTES)
      throw new Error('frontmatter 超过 4096 字节')
    const body = source.slice(header.bodyStart).replace(/^(?:\r?\n)+/, '')
    if (!body.trim() || body.length > MAX_SKILL_BODY_CHARS)
      throw new Error('技能正文须为 1 至 12000 字符')
    return createSkillSnapshot(
      header.metadata,
      body,
      createHash('sha256').update(bytes).digest('hex')
    )
  })
  return { snapshot: result.value, identity: result.identity }
}
