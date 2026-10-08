import { isAgentId } from './agent'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const maxImageBytes = MAX_IMAGE_BYTES
export const maxWindowImageBytes = 20 * 1024 * 1024
export const maxRequestImageBytes = maxWindowImageBytes
export const maxImagesPerMessage = 8
export const maxRequestImages = 100
export const maxImageDimension = 4096
export const maxImagePixels = 16_000_000
export const maxThumbnailBytes = 256 * 1024
export const imageThumbnailDimension = 160
export const IMAGE_TURN_NOTICE = '\n\n[本条消息附有一张图片，图片随会话保存。]'

export type ImageDescriptor = {
  imageId: string
  name: string
  mime: 'image/png' | 'image/jpeg'
  bytes: number
  width: number
  height: number
}
export type ImageImportRequest = { bytes: Uint8Array; name: string }
export type ImageReference = { imageId: string; messageId?: string }
export type ImageHistoryReference = { index: number; messageId: string; imageId: string }
export type ImageSelectionResult =
  | { status: 'selected'; images: ImageDescriptor[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }
export type ImageImportResult =
  | { status: 'selected'; image: ImageDescriptor }
  | { status: 'cancelled' }
  | { status: 'error'; error: string }
export type ImagePreviewResult =
  | { status: 'ready'; image: ImageDescriptor; dataUrl: string; thumbnailDataUrl: string }
  | { status: 'error'; error: string }
export type ImagePreparationResult =
  { status: 'ready'; image: ImageDescriptor } | { status: 'error'; error: string }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function integer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max
}

function imageArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  return keys.every((key) => {
    if (key === 'length') return true
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}

export function validImageName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 120 &&
    !/[\\/]/.test(value) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}

export function parseImageDescriptor(value: unknown): ImageDescriptor | null {
  try {
    if (
      !record(value) ||
      !exact(value, ['imageId', 'name', 'mime', 'bytes', 'width', 'height']) ||
      !isAgentId(value.imageId) ||
      !validImageName(value.name) ||
      (value.mime !== 'image/png' && value.mime !== 'image/jpeg') ||
      !integer(value.bytes, maxImageBytes) ||
      !integer(value.width, maxImageDimension) ||
      !integer(value.height, maxImageDimension) ||
      value.width * value.height > maxImagePixels
    )
      return null
    return {
      imageId: value.imageId,
      name: value.name,
      mime: value.mime,
      bytes: value.bytes,
      width: value.width,
      height: value.height
    }
  } catch {
    return null
  }
}

export function parseImageReference(value: unknown): ImageReference | null {
  try {
    if (
      !record(value) ||
      !exact(value, Object.hasOwn(value, 'messageId') ? ['imageId', 'messageId'] : ['imageId']) ||
      !isAgentId(value.imageId) ||
      (Object.hasOwn(value, 'messageId') && !isAgentId(value.messageId))
    )
      return null
    return {
      imageId: value.imageId,
      ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {})
    }
  } catch {
    return null
  }
}

export function parseImageDescriptors(value: unknown): ImageDescriptor[] | null {
  try {
    if (!imageArray(value, maxImagesPerMessage)) return null
    const images: ImageDescriptor[] = []
    const identities = new Set<string>()
    let totalBytes = 0
    for (const item of value) {
      const image = parseImageDescriptor(item)
      if (!image || identities.has(image.imageId)) return null
      totalBytes += image.bytes
      if (totalBytes > maxRequestImageBytes) return null
      identities.add(image.imageId)
      images.push(image)
    }
    return images
  } catch {
    return null
  }
}

export function parseImageReferences(value: unknown): ImageReference[] | null {
  try {
    if (!imageArray(value, maxImagesPerMessage)) return null
    const references: ImageReference[] = []
    const identities = new Set<string>()
    for (const item of value) {
      const reference = parseImageReference(item)
      if (
        !reference ||
        identities.has(reference.imageId) ||
        (references.length > 0 && reference.messageId !== references[0].messageId)
      )
        return null
      identities.add(reference.imageId)
      references.push(reference)
    }
    return references
  } catch {
    return null
  }
}

export function parseImageHistoryReferences(value: unknown): ImageHistoryReference[] | null {
  try {
    if (!imageArray(value, maxRequestImages)) return null
    const messages = new Set<string>()
    const identities = new Set<string>()
    const references: ImageHistoryReference[] = []
    let previousIndex = -1
    let messageId: string | undefined
    let groupCount = 0
    for (const item of value) {
      if (
        !record(item) ||
        !exact(item, ['index', 'messageId', 'imageId']) ||
        typeof item.index !== 'number' ||
        !Number.isInteger(item.index) ||
        item.index < 0 ||
        item.index >= 300 ||
        item.index < previousIndex ||
        !isAgentId(item.messageId) ||
        !isAgentId(item.imageId)
      )
        return null
      if (item.index !== previousIndex) {
        if (messages.has(item.messageId)) return null
        messages.add(item.messageId)
        identities.clear()
        messageId = item.messageId
        previousIndex = item.index
        groupCount = 0
      }
      if (
        item.messageId !== messageId ||
        identities.has(item.imageId) ||
        ++groupCount > maxImagesPerMessage
      )
        return null
      identities.add(item.imageId)
      references.push({ index: item.index, messageId: item.messageId, imageId: item.imageId })
    }
    return references
  } catch {
    return null
  }
}

export function parseImageImportRequest(value: unknown): ImageImportRequest | null {
  try {
    if (
      !record(value) ||
      !exact(value, ['bytes', 'name']) ||
      !(value.bytes instanceof Uint8Array) ||
      !integer(value.bytes.byteLength, maxImageBytes) ||
      !validImageName(value.name)
    )
      return null
    return { bytes: new Uint8Array(value.bytes), name: value.name }
  } catch {
    return null
  }
}

function errorResult(value: Record<string, unknown>): { status: 'error'; error: string } | null {
  return exact(value, ['status', 'error']) &&
    typeof value.error === 'string' &&
    value.error.trim() &&
    value.error.length <= 500
    ? { status: 'error', error: value.error }
    : null
}

export function parseImageSelectionResult(value: unknown): ImageSelectionResult | null {
  try {
    if (!record(value)) return null
    if (value.status === 'error') return errorResult(value)
    if (value.status === 'cancelled')
      return exact(value, ['status']) ? { status: 'cancelled' } : null
    const images = parseImageDescriptors(value.images)
    return value.status === 'selected' && exact(value, ['status', 'images']) && images
      ? { status: 'selected', images }
      : null
  } catch {
    return null
  }
}

export function parseImageImportResult(value: unknown): ImageImportResult | null {
  try {
    if (!record(value)) return null
    if (value.status === 'error') return errorResult(value)
    if (value.status === 'cancelled')
      return exact(value, ['status']) ? { status: 'cancelled' } : null
    const image = parseImageDescriptor(value.image)
    return value.status === 'selected' && exact(value, ['status', 'image']) && image
      ? { status: 'selected', image }
      : null
  } catch {
    return null
  }
}

export function parseImagePreparationResult(value: unknown): ImagePreparationResult | null {
  try {
    if (!record(value)) return null
    if (value.status === 'error') return errorResult(value)
    const image = parseImageDescriptor(value.image)
    return value.status === 'ready' && exact(value, ['status', 'image']) && image
      ? { status: 'ready', image }
      : null
  } catch {
    return null
  }
}

function validDataUrl(value: unknown, mime: string, bytes: number): value is string {
  if (typeof value !== 'string') return false
  const prefix = `data:${mime};base64,`
  const expectedLength = Math.ceil(bytes / 3) * 4
  if (!value.startsWith(prefix) || value.length !== prefix.length + expectedLength) return false
  const encoded = value.slice(prefix.length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return (encoded.length / 4) * 3 - padding === bytes
}

export function parseImagePreviewResult(value: unknown): ImagePreviewResult | null {
  try {
    if (!record(value)) return null
    if (value.status === 'error') return errorResult(value)
    const image = parseImageDescriptor(value.image)
    if (
      value.status !== 'ready' ||
      !exact(value, ['status', 'image', 'dataUrl', 'thumbnailDataUrl']) ||
      !image ||
      !validDataUrl(value.dataUrl, image.mime, image.bytes) ||
      typeof value.thumbnailDataUrl !== 'string'
    )
      return null
    const prefix = 'data:image/png;base64,'
    const encoded = value.thumbnailDataUrl.slice(prefix.length)
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const bytes = (encoded.length / 4) * 3 - padding
    if (
      !integer(bytes, maxThumbnailBytes) ||
      !validDataUrl(value.thumbnailDataUrl, 'image/png', bytes)
    )
      return null
    return {
      status: 'ready',
      image,
      dataUrl: value.dataUrl,
      thumbnailDataUrl: value.thumbnailDataUrl
    }
  } catch {
    return null
  }
}

export function getImageTurnNoticeCount(text: string): number | null {
  if (text.includes(IMAGE_TURN_NOTICE.trim())) return 1
  const match = text.match(/\[本条消息附有([1-8])张图片，图片随会话保存。\]/)
  return match ? Number(match[1]) : null
}

export function hasImageTurnNotice(text: string): boolean {
  return getImageTurnNoticeCount(text) !== null
}

export function stripImageTurnNotice(text: string): string {
  return text
    .replace(/\[本条消息附有\d+张图片，图片随会话保存。\]/g, '')
    .split(IMAGE_TURN_NOTICE.trim())
    .join('')
    .trim()
}

export function appendImageTurnNotice(text: string, count = 1): string {
  if (!integer(count, maxImagesPerMessage)) throw new Error('图片数量超过本条消息上限')
  const notice =
    count === 1 ? IMAGE_TURN_NOTICE : `\n\n[本条消息附有${count}张图片，图片随会话保存。]`
  return `${stripImageTurnNotice(text)}${notice}`
}
