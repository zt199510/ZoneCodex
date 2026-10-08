import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAgentId } from '../../shared/agent'
import { parseImageDescriptor, type ImageDescriptor } from '../../shared/image-input'
import { readSelectedImage } from '../project/image-validation'

export function sameImage(left: ImageDescriptor, right: ImageDescriptor): boolean {
  return (
    left.imageId === right.imageId &&
    left.name === right.name &&
    left.mime === right.mime &&
    left.bytes === right.bytes &&
    left.width === right.width &&
    left.height === right.height
  )
}

export type ImageStore = ReturnType<typeof createImageStore>

/** Original bytes live beside the conversation record, never inside message JSON. */
export function createImageStore(directory: string): {
  read: (conversationId: string, image: ImageDescriptor) => Promise<Buffer>
  save: (conversationId: string, image: ImageDescriptor, bytes: Buffer) => Promise<void>
  remove: (conversationId: string, imageId: string) => Promise<void>
} {
  const root = join(directory, 'conversation-images')
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  const paths = (
    conversationId: string,
    imageId: string
  ): { folder: string; data: string; info: string } => {
    if (!isAgentId(conversationId) || !isAgentId(imageId)) throw new Error('图片归属无效')
    const folder = join(root, conversationId)
    return { folder, data: join(folder, `${imageId}.bin`), info: join(folder, `${imageId}.json`) }
  }
  const regularDirectory = async (path: string): Promise<void> => {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('图片保存目录无效')
  }
  const prepareDirectory = async (folder: string): Promise<void> => {
    await mkdir(root, { recursive: true })
    await regularDirectory(root)
    await mkdir(folder, { recursive: true })
    await regularDirectory(folder)
  }

  async function readOriginal(conversationId: string, image: ImageDescriptor): Promise<Buffer> {
    const path = paths(conversationId, image.imageId)
    await regularDirectory(root)
    await regularDirectory(path.folder)
    const stat = await lstat(path.info)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048)
      throw new Error('已保存图片信息损坏，请重新添加')
    const metadata: unknown = JSON.parse(await readFile(path.info, 'utf8'))
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('已保存图片信息损坏，请重新添加')
    const checked = metadata as Record<string, unknown>
    const descriptor = parseImageDescriptor(checked.image)
    if (
      Object.keys(checked).length !== 2 ||
      !descriptor ||
      !sameImage(descriptor, image) ||
      typeof checked.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checked.sha256)
    )
      throw new Error('已保存图片信息不一致，请重新添加')
    const selected = await readSelectedImage(path.data, () => undefined)
    if (selected.bytes.length !== image.bytes || digest(selected.bytes) !== checked.sha256)
      throw new Error('已保存图片损坏或发生变化，请重新添加')
    return selected.bytes
  }

  async function read(conversationId: string, image: ImageDescriptor): Promise<Buffer> {
    try {
      return await readOriginal(conversationId, image)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw Object.assign(new Error('已保存图片不存在，请重新添加'), { code })
      if (code === 'EACCES' || code === 'EPERM') throw new Error('当前系统权限无法读取已保存图片')
      if (error instanceof SyntaxError) throw new Error('已保存图片信息损坏，请重新添加')
      throw error
    }
  }

  async function save(
    conversationId: string,
    image: ImageDescriptor,
    bytes: Buffer
  ): Promise<void> {
    const path = paths(conversationId, image.imageId)
    await prepareDirectory(path.folder)
    try {
      const existing = await read(conversationId, image)
      if (!existing.equals(bytes)) throw new Error('原图片已发生变化，请重新添加')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const token = randomUUID()
    const temporaryData = join(path.folder, `${token}.bin.tmp`)
    const temporaryInfo = join(path.folder, `${token}.json.tmp`)
    try {
      await writeFile(temporaryData, bytes, { flag: 'wx' })
      await writeFile(temporaryInfo, JSON.stringify({ image, sha256: digest(bytes) }), {
        flag: 'wx'
      })
      await regularDirectory(root)
      await regularDirectory(path.folder)
      await rename(temporaryData, path.data)
      await rename(temporaryInfo, path.info)
    } finally {
      await rm(temporaryData, { force: true }).catch(() => undefined)
      await rm(temporaryInfo, { force: true }).catch(() => undefined)
    }
  }

  async function remove(conversationId: string, imageId: string): Promise<void> {
    const path = paths(conversationId, imageId)
    try {
      await regularDirectory(root)
      await regularDirectory(path.folder)
      await rm(path.info, { force: true })
      await rm(path.data, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  return { read, save, remove }
}
