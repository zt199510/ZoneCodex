import { lstat, open } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename } from 'node:path'
import {
  hasFileViewControlCharacters,
  maxFileViewBytes,
  maxFileViewLines,
  splitFileViewLines
} from '../../shared/file-view'
import type { ProjectSnapshot } from './project-snapshot'
import { canonicalLocalPath, sameLocalPath } from './local-path'
import { isLocalReadPathAllowed } from './workspace-files'

export type FileViewContent = {
  path: string
  fileName: string
  text: string
  bytes: number
  lineCount: number
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.nlink === 1 &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function textContent(path: string, original: Uint8Array): FileViewContent {
  if (original.byteLength > maxFileViewBytes) throw new Error('文件超过 1 MiB，无法在源码面板查看')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(original)
  } catch {
    throw new Error('文件不是有效的 UTF-8 文本，无法查看')
  }
  if (hasFileViewControlCharacters(text, true))
    throw new Error('文件包含二进制或非文本内容，无法查看')
  const lineCount = splitFileViewLines(text).length
  if (lineCount > maxFileViewLines) throw new Error('文件超过 20000 行，无法在源码面板查看')
  return { path, fileName: basename(path), text, bytes: original.byteLength, lineCount }
}

/** Disk reads are bounded and do not create directories, files, or execution grants. */
export async function readLocalFileView(
  root: string,
  input: string,
  assertAccess: (target?: string) => void
): Promise<FileViewContent> {
  assertAccess()
  const path = await canonicalLocalPath(root, input)
  assertAccess(path)
  if (!isLocalReadPathAllowed(path)) throw new Error('此路径不在现有文本读取范围内')
  const before = await lstat(path)
  if (!before.isFile()) throw new Error('此路径不是可查看的普通文件')
  if (before.nlink !== 1) throw new Error('不读取硬链接文件')
  if (before.size > maxFileViewBytes) throw new Error('文件超过 1 MiB，无法在源码面板查看')
  assertAccess(path)
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (!sameFile(before, opened)) throw new Error('文件已变化，请重新打开')
    const buffer = Buffer.alloc(maxFileViewBytes + 1)
    let length = 0
    while (length < buffer.length) {
      assertAccess(path)
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    assertAccess(path)
    if (length > maxFileViewBytes) throw new Error('文件超过 1 MiB，无法在源码面板查看')
    const after = await handle.stat()
    const actualAfter = await canonicalLocalPath(root, input)
    const pathAfter = await lstat(actualAfter)
    assertAccess(path)
    if (
      !sameLocalPath(path, actualAfter) ||
      !sameFile(opened, after) ||
      !sameFile(after, pathAfter) ||
      length !== after.size
    )
      throw new Error('文件在读取期间发生变化，请重新打开')
    return textContent(path, buffer.subarray(0, length))
  } finally {
    await handle.close()
  }
}

/** Snapshot aliases use the captured immutable bytes, never the current disk version. */
export function readSnapshotFileView(snapshot: ProjectSnapshot, path: string): FileViewContent {
  if (!snapshot.files.has(path)) throw new Error('文件不在对应的已选快照中')
  const baseline = snapshot.baselines?.get(path)
  if (!baseline) throw new Error('此快照缺少完整文本，请重新选择文件')
  return textContent(path, baseline.originalBytes)
}

export function fileViewError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return '文件或运行目录不存在，可能已被移动或删除'
  if (code === 'EACCES' || code === 'EPERM') return '当前系统权限无法读取此文件'
  if (code) return '无法读取此文件，请稍后重新打开'
  return error instanceof Error ? error.message.slice(0, 500) : '无法读取此文件'
}
