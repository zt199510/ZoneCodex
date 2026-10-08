import { lstat, open } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, parse } from 'node:path'
import { maxImageBytes, maxImageDimension, maxImagePixels } from '../../shared/image-input'
import { canonicalLocalPath, sameLocalPath } from '../tools/local-path'

export type ImageHeader = { mime: 'image/png' | 'image/jpeg'; width: number; height: number }

function dimensions(mime: ImageHeader['mime'], width: number, height: number): ImageHeader {
  if (!width || !height) throw new Error('图片尺寸无效')
  if (width > maxImageDimension || height > maxImageDimension)
    throw new Error('图片每边最多 4096 像素，请重新添加较小图片')
  if (width * height > maxImagePixels) throw new Error('图片最多 1600 万像素，请重新添加较小图片')
  return { mime, width, height }
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Buffer, start: number, end: number): number {
  let value = 0xffffffff
  for (let index = start; index < end; index++)
    value = crcTable[(value ^ bytes[index]) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Decide format and bounds before Electron is permitted to decode any pixels. */
export function inspectImageHeader(bytes: Buffer): ImageHeader {
  if (!bytes.length) throw new Error('图片为空，请重新添加')
  if (bytes.length > maxImageBytes) throw new Error('单张图片最多 5 MiB，请重新添加较小图片')
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8
    let header: ImageHeader | null = null
    let data = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const end = offset + length + 12
      if (end > bytes.length) throw new Error('PNG 图片损坏或不完整')
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (
        !/^[A-Za-z]{4}$/.test(type) ||
        crc32(bytes, offset + 4, end - 4) !== bytes.readUInt32BE(end - 4)
      )
        throw new Error('PNG 图片校验失败，请重新添加')
      if (!header) {
        if (type !== 'IHDR' || length !== 13) throw new Error('PNG 图片缺少有效尺寸')
        header = dimensions(
          'image/png',
          bytes.readUInt32BE(offset + 8),
          bytes.readUInt32BE(offset + 12)
        )
        const depth = bytes[offset + 16]
        const color = bytes[offset + 17]
        const depths: Record<number, readonly number[]> = {
          0: [1, 2, 4, 8, 16],
          2: [8, 16],
          3: [1, 2, 4, 8],
          4: [8, 16],
          6: [8, 16]
        }
        if (
          !depths[color]?.includes(depth) ||
          bytes[offset + 18] !== 0 ||
          bytes[offset + 19] !== 0 ||
          bytes[offset + 20] > 1
        )
          throw new Error('PNG 编码格式无效')
      } else if (type === 'IHDR') throw new Error('PNG 图片尺寸重复')
      if (type === 'acTL') throw new Error('暂不支持动态 PNG，请添加单张截图')
      if (type === 'IDAT') data = true
      if (type === 'IEND') {
        if (length !== 0 || !data || end !== bytes.length)
          throw new Error('PNG 图片损坏或含额外内容')
        return header
      }
      offset = end
    }
    throw new Error('PNG 图片损坏或不完整')
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('仅支持真实的 PNG 或 JPEG 图片')
  let offset = 2
  let header: ImageHeader | null = null
  let scan = false
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error('JPEG 图片损坏')
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (!header || !scan || offset !== bytes.length) throw new Error('JPEG 图片损坏或含额外内容')
      return header
    }
    if (marker === 0 || marker === 0xd8 || marker === undefined)
      throw new Error('JPEG 图片标记无效')
    if (marker >= 0xd0 && marker <= 0xd7) throw new Error('JPEG 图片标记无效')
    if (offset + 2 > bytes.length) throw new Error('JPEG 图片不完整')
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 图片不完整')
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || length < 8 || header)
        throw new Error('JPEG 编码格式不支持')
      if (bytes[offset + 2] !== 8) throw new Error('JPEG 编码位深不支持')
      header = dimensions(
        'image/jpeg',
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3)
      )
    }
    offset += length
    if (marker === 0xda) {
      if (!header) throw new Error('JPEG 图片缺少有效尺寸')
      scan = true
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++
          continue
        }
        const next = bytes[offset + 1]
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2
          continue
        }
        if (next === 0xff) {
          offset++
          continue
        }
        break
      }
    }
  }
  throw new Error('JPEG 图片损坏或不完整')
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

export async function readSelectedImage(
  input: string,
  assertCurrent: () => void
): Promise<{ bytes: Buffer; name: string }> {
  assertCurrent()
  const root = parse(input).root
  if (!root) throw new Error('图片路径无效')
  const path = await canonicalLocalPath(root, input)
  assertCurrent()
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('请选择普通图片文件，不读取链接或目录')
  if (before.size > maxImageBytes) throw new Error('单张图片最多 5 MiB，请重新添加较小图片')
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (!sameFile(before, opened)) throw new Error('图片文件已变化，请重新选择')
    const bytes = Buffer.alloc(maxImageBytes + 1)
    let length = 0
    while (length < bytes.length) {
      assertCurrent()
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    assertCurrent()
    if (length > maxImageBytes) throw new Error('单张图片最多 5 MiB，请重新添加较小图片')
    const after = await handle.stat()
    const actual = await canonicalLocalPath(root, input)
    const pathAfter = await lstat(actual)
    assertCurrent()
    if (
      !sameLocalPath(path, actual) ||
      !sameFile(opened, after) ||
      !sameFile(after, pathAfter) ||
      length !== after.size
    )
      throw new Error('图片在读取期间发生变化，请重新选择')
    return { bytes: Buffer.from(bytes.subarray(0, length)), name: basename(path) }
  } finally {
    await handle.close()
  }
}
