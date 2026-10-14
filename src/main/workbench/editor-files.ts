import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { canonicalLocalPath, insideLocalPath, sameLocalPath } from '../tools/local-path'
import { isLocalReadPathAllowed } from '../tools/workspace-files'
import {
  hasFileViewControlCharacters,
  maxFileViewBytes,
  maxFileViewLines,
  splitFileViewLines
} from '../../shared/file-view'

export const fileFingerprint = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export async function readEditorDocument(
  root: string,
  input: string,
  check: (path: string) => void
): Promise<{ path: string; text: string; fingerprint: string; bom: boolean; mode: number }> {
  const path = await canonicalLocalPath(root, input)
  if (!insideLocalPath(root, path) || !isLocalReadPathAllowed(path))
    throw new Error('文件不在当前项目的文本编辑范围')
  check(path)
  const before = await lstat(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maxFileViewBytes
  )
    throw new Error('仅支持不超过 1 MiB 的普通文本文件')
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    )
      throw new Error('文件已变化，请重新读取')
    const buffer = Buffer.alloc(maxFileViewBytes + 1)
    let length = 0
    while (length < buffer.length) {
      check(path)
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await lstat(path)
    if (
      length > maxFileViewBytes ||
      length !== after.size ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !sameLocalPath(await canonicalLocalPath(root, input), path)
    )
      throw new Error('文件读取期间已变化')
    check(path)
    const bytes = buffer.subarray(0, length)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (
      hasFileViewControlCharacters(text, true) ||
      splitFileViewLines(text).length > maxFileViewLines
    )
      throw new Error('文件包含非文本内容或超过 20000 行')
    return {
      path,
      text,
      fingerprint: fileFingerprint(bytes),
      bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
      mode: after.mode
    }
  } finally {
    await handle.close()
  }
}
const writes = new Set<string>()
export async function saveEditorDocument(
  root: string,
  input: string,
  expected: string,
  text: string,
  check: (path: string) => void
): Promise<Awaited<ReturnType<typeof readEditorDocument>>> {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > maxFileViewBytes ||
    hasFileViewControlCharacters(text, true) ||
    splitFileViewLines(text).length > maxFileViewLines
  )
    throw new Error('编辑内容超过文本容量限制')
  const original = await readEditorDocument(root, input, check)
  if (original.fingerprint !== expected)
    throw new Error('CONFLICT:文件已被外部修改，请比较或重新读取')
  const lock = process.platform === 'win32' ? original.path.toLowerCase() : original.path
  if (writes.has(lock)) throw new Error('此文件正在保存，请稍后重试')
  writes.add(lock)
  const temporary = join(
    dirname(original.path),
    `.${basename(original.path)}.zonecodex-${randomUUID()}.tmp`
  )
  try {
    const normalized = text.replace(/\r\n/g, '\n')
    const newline =
      original.text.includes('\r\n') && !original.text.replace(/\r\n/g, '').includes('\n')
        ? '\r\n'
        : '\n'
    const bytes = Buffer.from(
      (original.bom ? '\uFEFF' : '') + normalized.replace(/\n/g, newline),
      'utf8'
    )
    if (bytes.length > maxFileViewBytes) throw new Error('保存后的文件超过 1 MiB')
    const handle = await open(temporary, 'wx', original.mode & 0o777)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const current = await readEditorDocument(root, input, check)
    if (current.fingerprint !== expected || !sameLocalPath(current.path, original.path))
      throw new Error('CONFLICT:文件已被外部修改，请比较或重新读取')
    check(original.path)
    await rename(temporary, original.path)
    return await readEditorDocument(root, input, check)
  } finally {
    writes.delete(lock)
    await rm(temporary, { force: true })
  }
}
