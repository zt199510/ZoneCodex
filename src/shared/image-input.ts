import { isAgentId } from './agent'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const maxImageBytes = MAX_IMAGE_BYTES
export const maxWindowImageBytes = 20 * 1024 * 1024
export const maxImageDimension = 4096
export const maxImagePixels = 16_000_000
export const maxThumbnailBytes = 256 * 1024
export const imageThumbnailDimension = 160
export const IMAGE_TURN_NOTICE =
  '\n\n[本轮附有一张临时图片；图片不随历史保存，重新问图请再次添加。]'

export type ImageDescriptor = {
  imageId: string
  name: string
  mime: 'image/png' | 'image/jpeg'
  bytes: number
  width: number
  height: number
}
export type ImageImportRequest = { bytes: Uint8Array; name: string }
export type ImageReference = { imageId: string }
export type ImageSelectionResult =
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
    return record(value) && exact(value, ['imageId']) && isAgentId(value.imageId)
      ? { imageId: value.imageId }
      : null
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

export function hasImageTurnNotice(text: string): boolean {
  return text.includes(IMAGE_TURN_NOTICE.trim())
}

export function stripImageTurnNotice(text: string): string {
  return text.split(IMAGE_TURN_NOTICE.trim()).join('').trim()
}

export function appendImageTurnNotice(text: string): string {
  return `${stripImageTurnNotice(text)}${IMAGE_TURN_NOTICE}`
}
