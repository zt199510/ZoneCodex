import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAgentId } from '../../shared/agent'
import {
  maxWindowImageBytes,
  validImageName,
  type ImageDescriptor,
  type ImageImportRequest,
  type ImageSelectionResult,
  type ImagePreviewResult,
  type ImagePreparationResult
} from '../../shared/image-input'
import { inspectImageHeader, readSelectedImage } from './image-validation'
import { decodeImageThumbnail } from './image-decoder'

type ImageCallbacks = {
  isBusy: (windowId: number) => boolean
  abortImageJob: (windowId: number, imageId: string) => void
}
let callbacks: ImageCallbacks = { isBusy: () => false, abortImageJob: () => undefined }
export function configureImageAccess(next: ImageCallbacks): void {
  callbacks = next
}

type ImageEntry = {
  conversationId: string
  image: ImageDescriptor
  bytes: Buffer
  thumbnail: Buffer
  preparedUntil: number
  pins: number
  valid: boolean
}
type ImageOperation = { conversationId: string; controller: AbortController }
const images = new Map<number, Map<string, ImageEntry>>()
const operations = new Map<number, ImageOperation>()

export function hasImageSelection(windowId: number): boolean {
  return operations.has(windowId)
}

function errorResult(error: unknown): { status: 'error'; error: string } {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const message =
    code === 'ENOENT' || code === 'ENOTDIR'
      ? '图片文件不存在，请重新选择'
      : code === 'EACCES' || code === 'EPERM'
        ? '当前系统权限无法读取图片'
        : error instanceof Error
          ? error.message
          : '图片处理失败，请重新添加'
  return { status: 'error', error: message.slice(0, 500) }
}

function entryFor(windowId: number, conversationId: string, imageId: string): ImageEntry | null {
  if (!isAgentId(conversationId) || !isAgentId(imageId)) return null
  const entry = images.get(windowId)?.get(imageId)
  return entry?.valid && entry.conversationId === conversationId ? entry : null
}

function usedBytes(windowId: number): number {
  return [...(images.get(windowId)?.values() ?? [])].reduce(
    (total, entry) => total + entry.bytes.length,
    0
  )
}

async function addImage(
  window: BrowserWindow,
  conversationId: string,
  state: ImageOperation,
  bytes: Buffer,
  name: string
): Promise<ImageSelectionResult> {
  const assertCurrent = (): void => {
    if (
      operations.get(window.id) !== state ||
      state.controller.signal.aborted ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      throw new Error('图片导入已取消')
  }
  assertCurrent()
  const header = inspectImageHeader(bytes)
  if (!validImageName(name)) throw new Error('图片名称无效或超过 120 个字符')
  if (usedBytes(window.id) + bytes.length > maxWindowImageBytes)
    throw new Error('本窗口图片已达到 20 MiB，请移除待发图或切换会话后再添加')
  // The existing v6 message limit also bounds tiny-image metadata and thumbnails.
  if ((images.get(window.id)?.size ?? 0) >= 1000)
    throw new Error('本窗口图片数量已达到上限，请切换会话后再添加')
  const decoded = await decodeImageThumbnail(bytes, header, state.controller.signal)
  assertCurrent()
  const image: ImageDescriptor = {
    imageId: randomUUID(),
    name,
    mime: header.mime,
    bytes: bytes.length,
    width: decoded.width,
    height: decoded.height
  }
  let pool = images.get(window.id)
  if (!pool) {
    pool = new Map()
    images.set(window.id, pool)
  }
  pool.set(image.imageId, {
    conversationId,
    image,
    bytes,
    thumbnail: decoded.thumbnail,
    preparedUntil: 0,
    pins: 0,
    valid: true
  })
  return { status: 'selected', image: { ...image } }
}

async function withImport(
  window: BrowserWindow,
  conversationId: string,
  read: (
    state: ImageOperation,
    assertCurrent: () => void
  ) => Promise<{ bytes: Buffer; name: string } | null>
): Promise<ImageSelectionResult> {
  if (!isAgentId(conversationId)) return errorResult(new Error('会话 ID 无效'))
  if (window.isDestroyed() || window.webContents.isDestroyed())
    return errorResult(new Error('窗口已经关闭'))
  if (callbacks.isBusy(window.id) || operations.has(window.id))
    return errorResult(new Error('请先完成当前操作，再添加图片'))
  const state: ImageOperation = { conversationId, controller: new AbortController() }
  operations.set(window.id, state)
  const assertCurrent = (): void => {
    if (
      operations.get(window.id) !== state ||
      state.controller.signal.aborted ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      throw new Error('图片导入已取消')
  }
  try {
    const candidate = await read(state, assertCurrent)
    assertCurrent()
    return candidate
      ? await addImage(window, conversationId, state, candidate.bytes, candidate.name)
      : { status: 'cancelled' }
  } catch (error) {
    return state.controller.signal.aborted || operations.get(window.id) !== state
      ? { status: 'cancelled' }
      : errorResult(error)
  } finally {
    if (operations.get(window.id) === state) operations.delete(window.id)
  }
}

export function selectImage(
  window: BrowserWindow,
  conversationId: string
): Promise<ImageSelectionResult> {
  return withImport(window, conversationId, async (_state, assertCurrent) => {
    const selected = await dialog.showOpenDialog(window, {
      title: '选择随本轮问题发送的图片（仅临时保存）',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    assertCurrent()
    if (selected.canceled || selected.filePaths.length === 0) return null
    if (selected.filePaths.length !== 1) throw new Error('一次只能添加一张图片')
    return readSelectedImage(selected.filePaths[0], assertCurrent)
  })
}

export function importImage(
  window: BrowserWindow,
  conversationId: string,
  request: ImageImportRequest
): Promise<ImageSelectionResult> {
  return withImport(window, conversationId, async () => ({
    bytes: Buffer.from(request.bytes),
    name: request.name
  }))
}

export function readImagePreview(
  windowId: number,
  conversationId: string,
  imageId: string
): ImagePreviewResult {
  const entry = entryFor(windowId, conversationId, imageId)
  if (!entry) return errorResult(new Error('图片已失效，请重新添加'))
  return {
    status: 'ready',
    image: { ...entry.image },
    dataUrl: `data:${entry.image.mime};base64,${entry.bytes.toString('base64')}`,
    thumbnailDataUrl: `data:image/png;base64,${entry.thumbnail.toString('base64')}`
  }
}

export function prepareImage(
  windowId: number,
  conversationId: string,
  imageId: string
): ImagePreparationResult {
  if (callbacks.isBusy(windowId) || operations.has(windowId))
    return errorResult(new Error('请先完成当前操作，再发送图片'))
  const entry = entryFor(windowId, conversationId, imageId)
  if (!entry) return errorResult(new Error('原图片已失效，请重新添加后发送'))
  entry.preparedUntil = Date.now() + 60_000
  return { status: 'ready', image: { ...entry.image } }
}

export type CapturedImage = {
  image: ImageDescriptor
  dataUrl: string
  assertCurrent: () => void
  finish: () => void
}
export function captureImageAccess(
  windowId: number,
  conversationId: string,
  imageId: string
): CapturedImage | null {
  const entry = entryFor(windowId, conversationId, imageId)
  if (!entry || entry.preparedUntil < Date.now()) return null
  entry.preparedUntil = 0
  entry.pins++
  let finished = false
  return {
    image: { ...entry.image },
    dataUrl: `data:${entry.image.mime};base64,${entry.bytes.toString('base64')}`,
    assertCurrent: () => {
      if (finished || !entry.valid || entryFor(windowId, conversationId, imageId) !== entry)
        throw new Error('本轮原图片已失效，请重新添加')
    },
    finish: () => {
      if (finished) return
      finished = true
      entry.pins--
    }
  }
}

export function revokeImage(windowId: number, conversationId: string, imageId: string): boolean {
  if (callbacks.isBusy(windowId) || operations.has(windowId)) return false
  const pool = images.get(windowId)
  const entry = pool?.get(imageId)
  if (!entry) return true
  if (entry.conversationId !== conversationId || entry.pins) return false
  entry.valid = false
  pool?.delete(imageId)
  if (pool?.size === 0) images.delete(windowId)
  return true
}

export function revokeConversationImages(windowId: number, conversationId: string): boolean {
  if (!isAgentId(conversationId) || callbacks.isBusy(windowId)) return false
  const state = operations.get(windowId)
  if (state && state.conversationId !== conversationId) return false
  state?.controller.abort()
  if (state) operations.delete(windowId)
  const pool = images.get(windowId)
  for (const [imageId, entry] of pool ?? []) {
    if (entry.conversationId !== conversationId) continue
    entry.valid = false
    callbacks.abortImageJob(windowId, imageId)
    pool?.delete(imageId)
  }
  if (pool?.size === 0) images.delete(windowId)
  return true
}

export function cleanupImageAccess(windowId: number): void {
  operations.get(windowId)?.controller.abort()
  operations.delete(windowId)
  for (const [imageId, entry] of images.get(windowId) ?? []) {
    entry.valid = false
    callbacks.abortImageJob(windowId, imageId)
  }
  images.delete(windowId)
}
