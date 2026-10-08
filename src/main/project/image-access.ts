import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAgentId } from '../../shared/agent'
import type { ConversationLibrary } from '../../shared/conversation-library'
import { getMessageImages } from '../../shared/conversation'
import {
  maxWindowImageBytes,
  maxImagesPerMessage,
  validImageName,
  type ImageDescriptor,
  type ImageImportRequest,
  type ImageImportResult,
  type ImageSelectionResult,
  type ImagePreviewResult,
  type ImagePreparationResult
} from '../../shared/image-input'
import { inspectImageHeader, readSelectedImage } from './image-validation'
import { decodeImageThumbnail } from './image-decoder'
import { createImageStore, sameImage, type ImageStore } from '../storage/image-store'

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
type ImageOperation = {
  conversationId: string
  controller: AbortController
  kind: 'import' | 'restore'
}
const images = new Map<number, Map<string, ImageEntry>>()
const operations = new Map<number, ImageOperation>()
type ImageBinding = { image: ImageDescriptor; messageIds: Set<string>; pending: boolean }
export type ImageSaveCheckpoint = Map<string, Set<string>> & {
  messageGroups: Map<string, readonly string[]>
}
const bindings = new Map<number, Map<string, Map<string, ImageBinding>>>()
const messageGroups = new Map<number, Map<string, Map<string, readonly string[]>>>()
let imageStore: ImageStore | null = null
let committed = new Map<string, { conversationId: string; image: ImageDescriptor }>()
const removalQueue = new Map<string, { conversationId: string; imageId: string }>()
const restoreQueues = new Map<number, Promise<unknown>>()
const imageEpochs = new Map<number, number>()

export function configureImageStorage(directory: string): void {
  imageStore = createImageStore(directory)
}

/** Capture when the save IPC arrives, before it can wait behind an older write. */
export function captureImageSaveCheckpoint(windowId: number): ImageSaveCheckpoint {
  const checkpoint: ImageSaveCheckpoint = Object.assign(new Map<string, Set<string>>(), {
    messageGroups: new Map<string, readonly string[]>()
  })
  for (const [conversationId, pool] of bindings.get(windowId) ?? []) {
    for (const [imageId, binding] of pool)
      checkpoint.set(assetKey(conversationId, imageId), new Set(binding.messageIds))
  }
  for (const [conversationId, pool] of messageGroups.get(windowId) ?? []) {
    for (const [messageId, group] of pool)
      checkpoint.messageGroups.set(assetKey(conversationId, messageId), [...group])
  }
  return checkpoint
}

const assetKey = (conversationId: string, imageId: string): string => `${conversationId}/${imageId}`

function bindingFor(
  windowId: number,
  conversationId: string,
  imageId: string
): ImageBinding | null {
  return bindings.get(windowId)?.get(conversationId)?.get(imageId) ?? null
}

function imageReferences(
  library: ConversationLibrary
): Map<string, { conversationId: string; image: ImageDescriptor; messageIds: Set<string> }> {
  const result = new Map<
    string,
    { conversationId: string; image: ImageDescriptor; messageIds: Set<string> }
  >()
  for (const conversation of library.conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'user') continue
      for (const image of getMessageImages(message)) {
        if (!isAgentId(conversation.id)) throw new Error('图片会话归属无效')
        const key = assetKey(conversation.id, image.imageId)
        const previous = result.get(key)
        if (previous && !sameImage(previous.image, image)) throw new Error('同一图片记录不一致')
        if (previous) previous.messageIds.add(message.id)
        else
          result.set(key, {
            conversationId: conversation.id,
            image,
            messageIds: new Set([message.id])
          })
      }
    }
  }
  return result
}

function poolFor(windowId: number): Map<string, ImageEntry> {
  let pool = images.get(windowId)
  if (!pool) {
    pool = new Map()
    images.set(windowId, pool)
  }
  return pool
}

function bindingsFor(windowId: number, conversationId: string): Map<string, ImageBinding> {
  let windowBindings = bindings.get(windowId)
  if (!windowBindings) {
    windowBindings = new Map()
    bindings.set(windowId, windowBindings)
  }
  let conversationBindings = windowBindings.get(conversationId)
  if (!conversationBindings) {
    conversationBindings = new Map()
    windowBindings.set(conversationId, conversationBindings)
  }
  return conversationBindings
}

function groupsFor(windowId: number, conversationId: string): Map<string, readonly string[]> {
  let windowGroups = messageGroups.get(windowId)
  if (!windowGroups) {
    windowGroups = new Map()
    messageGroups.set(windowId, windowGroups)
  }
  let groups = windowGroups.get(conversationId)
  if (!groups) {
    groups = new Map()
    windowGroups.set(conversationId, groups)
  }
  return groups
}

function sameGroup(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** An existing message may only reuse its original complete ordered group. */
export function verifyImageMessageGroup(
  windowId: number,
  conversationId: string,
  imageIds: readonly string[],
  messageId: string
): boolean {
  const group = messageGroups.get(windowId)?.get(conversationId)?.get(messageId)
  return Boolean(group && sameGroup(group, imageIds))
}

/** Fresh imports can form a group; previously sent originals must remain together. */
export function verifyImageRequestGroup(
  windowId: number,
  conversationId: string,
  imageIds: readonly string[]
): boolean {
  if (
    !isAgentId(conversationId) ||
    !imageIds.length ||
    imageIds.length > maxImagesPerMessage ||
    new Set(imageIds).size !== imageIds.length ||
    imageIds.some((imageId) => !entryFor(windowId, conversationId, imageId))
  )
    return false
  const bound = imageIds.filter((imageId) => bindingFor(windowId, conversationId, imageId))
  return (
    !bound.length ||
    (bound.length === imageIds.length &&
      [...(messageGroups.get(windowId)?.get(conversationId)?.values() ?? [])].some((group) =>
        sameGroup(group, imageIds)
      ))
  )
}

/** Bind only after every original has been captured successfully. */
export function bindImageMessageGroup(
  windowId: number,
  conversationId: string,
  imageIds: readonly string[],
  messageId: string
): boolean {
  if (
    !isAgentId(conversationId) ||
    !isAgentId(messageId) ||
    !verifyImageRequestGroup(windowId, conversationId, imageIds)
  )
    return false
  const entries = imageIds.map((id) => entryFor(windowId, conversationId, id))
  if (entries.some((entry) => !entry)) return false
  const groups = groupsFor(windowId, conversationId)
  const previous = groups.get(messageId)
  if (previous && !sameGroup(previous, imageIds)) return false
  const pool = bindingsFor(windowId, conversationId)
  for (const entry of entries) {
    if (!entry) return false
    const imageId = entry.image.imageId
    const binding = pool.get(imageId)
    if (binding) {
      if (!binding.messageIds.has(messageId)) binding.pending = true
      binding.messageIds.add(messageId)
    } else
      pool.set(imageId, {
        image: { ...entry.image },
        messageIds: new Set([messageId]),
        pending: true
      })
  }
  groups.set(messageId, [...imageIds])
  return true
}

function assetInUse(conversationId: string, imageId: string): boolean {
  if (committed.has(assetKey(conversationId, imageId))) return true
  for (const windowBindings of bindings.values()) {
    if (windowBindings.get(conversationId)?.get(imageId)?.pending) return true
  }
  for (const pool of images.values()) {
    const entry = pool.get(imageId)
    if (entry?.conversationId === conversationId && entry.pins) return true
  }
  return false
}

async function flushImageRemovals(): Promise<void> {
  if (!imageStore) return
  for (const [key, removal] of removalQueue) {
    if (assetInUse(removal.conversationId, removal.imageId)) continue
    await imageStore.remove(removal.conversationId, removal.imageId)
    removalQueue.delete(key)
  }
}

/** Called only with a library parsed by the conversation store. */
export function rememberConversationImages(
  windowId: number,
  library: ConversationLibrary,
  checkpoint?: ImageSaveCheckpoint
): void {
  const next = imageReferences(library)
  const nextGroups = new Map<string, readonly string[]>()
  for (const conversation of library.conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'user') continue
      const group = getMessageImages(message).map((image) => image.imageId)
      groupsFor(windowId, conversation.id).set(message.id, group)
      nextGroups.set(assetKey(conversation.id, message.id), group)
    }
  }
  for (const [conversationId, pool] of messageGroups.get(windowId) ?? []) {
    for (const [messageId, group] of pool) {
      const key = assetKey(conversationId, messageId)
      if (nextGroups.has(key)) continue
      const submitted = checkpoint?.messageGroups.get(key)
      // A queued earlier save must not forget a group accepted after its arrival.
      if (checkpoint && (!submitted || !sameGroup(submitted, group))) continue
      pool.delete(messageId)
    }
    if (!pool.size) messageGroups.get(windowId)?.delete(conversationId)
  }
  const windowBindings = bindings.get(windowId)
  for (const [conversationId, pool] of windowBindings ?? []) {
    for (const [imageId, binding] of pool) {
      const key = assetKey(conversationId, imageId)
      if (next.has(key)) continue
      const submitted = checkpoint?.get(key)
      const laterMessages = checkpoint
        ? [...binding.messageIds].filter((messageId) => !submitted?.has(messageId))
        : []
      if (laterMessages.length) {
        binding.messageIds = new Set(laterMessages)
        binding.pending = true
        continue
      }
      pool.delete(imageId)
      const cached = images.get(windowId)?.get(imageId)
      if (cached?.conversationId === conversationId && !cached.pins) {
        cached.valid = false
        images.get(windowId)?.delete(imageId)
      }
      removalQueue.set(key, { conversationId, imageId })
    }
    if (!pool.size) windowBindings?.delete(conversationId)
  }
  for (const reference of next.values()) {
    const pool = bindingsFor(windowId, reference.conversationId)
    const pending = pool.get(reference.image.imageId)
    const submitted = checkpoint?.get(assetKey(reference.conversationId, reference.image.imageId))
    const laterMessages =
      checkpoint && pending
        ? [...pending.messageIds].filter((messageId) => !submitted?.has(messageId))
        : []
    const updated: ImageBinding = {
      image: { ...reference.image },
      messageIds: new Set([...reference.messageIds, ...laterMessages]),
      pending: laterMessages.some((messageId) => !reference.messageIds.has(messageId))
    }
    if (pending && sameImage(pending.image, reference.image)) Object.assign(pending, updated)
    else pool.set(reference.image.imageId, updated)
  }
  for (const [key, reference] of committed) {
    if (!next.has(key))
      removalQueue.set(key, {
        conversationId: reference.conversationId,
        imageId: reference.image.imageId
      })
  }
  committed = new Map(
    [...next].map(([key, reference]) => [
      key,
      { conversationId: reference.conversationId, image: reference.image }
    ])
  )
  void flushImageRemovals().catch(() => undefined)
}

export async function persistConversationImages(
  windowId: number,
  library: ConversationLibrary
): Promise<void> {
  for (const conversation of library.conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'user') continue
      const group = getMessageImages(message)
      if (
        group.length &&
        !verifyImageMessageGroup(
          windowId,
          conversation.id,
          group.map((image) => image.imageId),
          message.id
        )
      )
        throw new Error('消息图片组不一致，请使用原来的完整图片组')
      const known = messageGroups.get(windowId)?.get(conversation.id)?.get(message.id)
      if (
        known &&
        !sameGroup(
          known,
          group.map((image) => image.imageId)
        )
      )
        throw new Error('消息图片组不一致，请使用原来的完整图片组')
    }
  }
  const references = imageReferences(library)
  for (const reference of references.values()) {
    const stored = committed.get(assetKey(reference.conversationId, reference.image.imageId))
    if (stored && sameImage(stored.image, reference.image)) {
      const known = bindingFor(windowId, reference.conversationId, reference.image.imageId)
      if (!known || !sameImage(known.image, reference.image))
        throw new Error('图片未属于当前窗口和会话，请重新添加')
      continue
    }
    const entry = entryFor(windowId, reference.conversationId, reference.image.imageId)
    const binding = bindingFor(windowId, reference.conversationId, reference.image.imageId)
    if (entry && sameImage(entry.image, reference.image)) {
      if (!imageStore) throw new Error('图片保存服务未就绪')
      await imageStore.save(reference.conversationId, entry.image, entry.bytes)
    } else if (!binding || !sameImage(binding.image, reference.image)) {
      throw new Error('图片未属于当前窗口和会话，请重新添加')
    }
    // An already-known missing image remains an explicit broken reference. It must
    // not prevent saving unrelated text or deleting the affected conversation.
  }
}

function restoreImage(
  windowId: number,
  conversationId: string,
  imageId: string
): Promise<ImageEntry | null> {
  const epoch = imageEpochs.get(windowId) ?? 0
  const previous = restoreQueues.get(windowId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if ((imageEpochs.get(windowId) ?? 0) !== epoch) throw new Error('图片读取已取消')
      return restoreImageNow(windowId, conversationId, imageId)
    })
  restoreQueues.set(windowId, next)
  void next
    .finally(() => {
      if (restoreQueues.get(windowId) === next) restoreQueues.delete(windowId)
    })
    .catch(() => undefined)
  return next
}

async function restoreImageNow(
  windowId: number,
  conversationId: string,
  imageId: string
): Promise<ImageEntry | null> {
  const cached = entryFor(windowId, conversationId, imageId)
  if (cached) return cached
  const binding = bindingFor(windowId, conversationId, imageId)
  if (!binding || !imageStore) return null
  if (operations.has(windowId)) throw new Error('请先完成当前图片操作')
  const state: ImageOperation = {
    conversationId,
    controller: new AbortController(),
    kind: 'restore'
  }
  operations.set(windowId, state)
  try {
    const bytes = await imageStore.read(conversationId, binding.image)
    state.controller.signal.throwIfAborted()
    const header = inspectImageHeader(bytes)
    const decoded = await decodeImageThumbnail(bytes, header, state.controller.signal)
    if (
      operations.get(windowId) !== state ||
      state.controller.signal.aborted ||
      bindingFor(windowId, conversationId, imageId) !== binding
    )
      throw new Error('图片读取已取消')
    if (decoded.width !== binding.image.width || decoded.height !== binding.image.height)
      throw new Error('已保存图片尺寸不一致，请重新添加')
    const pool = poolFor(windowId)
    for (const [candidateId, candidate] of pool) {
      if (usedBytes(windowId) + bytes.length <= maxWindowImageBytes) break
      if (
        !candidate.pins &&
        !candidate.preparedUntil &&
        bindingFor(windowId, candidate.conversationId, candidateId)
      ) {
        candidate.valid = false
        pool.delete(candidateId)
      }
    }
    if (usedBytes(windowId) + bytes.length > maxWindowImageBytes)
      throw new Error('本窗口图片已达到 20 MiB，请减少本轮引用的图片')
    const entry: ImageEntry = {
      conversationId,
      image: { ...binding.image },
      bytes,
      thumbnail: decoded.thumbnail,
      preparedUntil: 0,
      pins: 0,
      valid: true
    }
    pool.set(imageId, entry)
    return entry
  } finally {
    if (operations.get(windowId) === state) operations.delete(windowId)
  }
}

export function hasImageSelection(windowId: number): boolean {
  return operations.get(windowId)?.kind === 'import'
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
): Promise<ImageDescriptor> {
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
  return { ...image }
}

async function withImport(
  window: BrowserWindow,
  conversationId: string,
  read: (
    state: ImageOperation,
    assertCurrent: () => void
  ) => Promise<{ bytes: Buffer; name: string }[] | null>
): Promise<ImageSelectionResult> {
  if (!isAgentId(conversationId)) return errorResult(new Error('会话 ID 无效'))
  if (window.isDestroyed() || window.webContents.isDestroyed())
    return errorResult(new Error('窗口已经关闭'))
  if (callbacks.isBusy(window.id) || operations.has(window.id))
    return errorResult(new Error('请先完成当前操作，再添加图片'))
  const state: ImageOperation = {
    conversationId,
    controller: new AbortController(),
    kind: 'import'
  }
  operations.set(window.id, state)
  const added: ImageDescriptor[] = []
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
    const candidates = await read(state, assertCurrent)
    assertCurrent()
    if (!candidates) return { status: 'cancelled' }
    if (!candidates.length || candidates.length > maxImagesPerMessage)
      throw new Error(`每条消息最多 ${maxImagesPerMessage} 张图片`)
    if (
      usedBytes(window.id) +
        candidates.reduce((total, candidate) => total + candidate.bytes.length, 0) >
      maxWindowImageBytes
    )
      throw new Error('本窗口图片已达到 20 MiB，请移除待发图或切换会话后再添加')
    for (const candidate of candidates) {
      added.push(await addImage(window, conversationId, state, candidate.bytes, candidate.name))
    }
    assertCurrent()
    return { status: 'selected', images: added }
  } catch (error) {
    // A failed batch cannot leave an invisible partial group in the window pool.
    for (const image of added) {
      const entry = images.get(window.id)?.get(image.imageId)
      if (entry) entry.valid = false
      images.get(window.id)?.delete(image.imageId)
    }
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
      title: '选择随本轮问题发送的图片',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    assertCurrent()
    if (selected.canceled || selected.filePaths.length === 0) return null
    if (selected.filePaths.length > maxImagesPerMessage)
      throw new Error(`每条消息最多 ${maxImagesPerMessage} 张图片`)
    const candidates: { bytes: Buffer; name: string }[] = []
    for (const path of selected.filePaths)
      candidates.push(await readSelectedImage(path, assertCurrent))
    return candidates
  })
}

export async function importImage(
  window: BrowserWindow,
  conversationId: string,
  request: ImageImportRequest
): Promise<ImageImportResult> {
  const result = await withImport(window, conversationId, async () => [
    {
      bytes: Buffer.from(request.bytes),
      name: request.name
    }
  ])
  return result.status === 'selected' ? { status: 'selected', image: result.images[0] } : result
}

export async function readImagePreview(
  windowId: number,
  conversationId: string,
  imageId: string
): Promise<ImagePreviewResult> {
  try {
    const entry = await restoreImage(windowId, conversationId, imageId)
    if (!entry) return errorResult(new Error('图片已失效，请重新添加'))
    return {
      status: 'ready',
      image: { ...entry.image },
      dataUrl: `data:${entry.image.mime};base64,${entry.bytes.toString('base64')}`,
      thumbnailDataUrl: `data:image/png;base64,${entry.thumbnail.toString('base64')}`
    }
  } catch (error) {
    return errorResult(error)
  }
}

export async function prepareImage(
  windowId: number,
  conversationId: string,
  imageId: string
): Promise<ImagePreparationResult> {
  if (callbacks.isBusy(windowId) || operations.get(windowId)?.kind === 'import')
    return errorResult(new Error('请先完成当前操作，再发送图片'))
  try {
    const entry = await restoreImage(windowId, conversationId, imageId)
    if (!entry) return errorResult(new Error('原图片已失效，请重新添加后发送'))
    if (!imageStore) throw new Error('图片保存服务未就绪')
    await imageStore.save(conversationId, entry.image, entry.bytes)
    if (entryFor(windowId, conversationId, imageId) !== entry || callbacks.isBusy(windowId))
      throw new Error('图片或运行状态已变化，请重新发送')
    entry.preparedUntil = Date.now() + 60_000
    return { status: 'ready', image: { ...entry.image } }
  } catch (error) {
    return errorResult(error)
  }
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
  return captureEntry(windowId, conversationId, imageId, entry)
}

export async function captureSavedImageAccess(
  windowId: number,
  conversationId: string,
  imageId: string,
  messageId: string
): Promise<CapturedImage | null> {
  const binding = bindingFor(windowId, conversationId, imageId)
  const group = messageGroups.get(windowId)?.get(conversationId)?.get(messageId)
  if (!binding || !binding.messageIds.has(messageId) || !group?.includes(imageId)) return null
  const entry = await restoreImage(windowId, conversationId, imageId)
  if (
    !entry ||
    bindingFor(windowId, conversationId, imageId) !== binding ||
    !verifyImageMessageGroup(windowId, conversationId, group, messageId)
  )
    return null
  const captured = captureEntry(windowId, conversationId, imageId, entry)
  const assertEntryCurrent = captured.assertCurrent
  captured.assertCurrent = () => {
    assertEntryCurrent()
    if (
      bindingFor(windowId, conversationId, imageId) !== binding ||
      !binding.messageIds.has(messageId) ||
      !verifyImageMessageGroup(windowId, conversationId, group, messageId)
    )
      throw new Error('历史图片组与原消息的关联已失效，请重新发送')
  }
  return captured
}

function captureEntry(
  windowId: number,
  conversationId: string,
  imageId: string,
  entry: ImageEntry
): CapturedImage {
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
      void flushImageRemovals().catch(() => undefined)
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
  if (!bindingFor(windowId, conversationId, imageId)) {
    removalQueue.set(assetKey(conversationId, imageId), { conversationId, imageId })
    void flushImageRemovals().catch(() => undefined)
  }
  if (pool?.size === 0) images.delete(windowId)
  return true
}

export function revokeConversationImages(windowId: number, conversationId: string): boolean {
  if (!isAgentId(conversationId) || callbacks.isBusy(windowId)) return false
  const state = operations.get(windowId)
  if (state && state.conversationId !== conversationId) return false
  imageEpochs.set(windowId, (imageEpochs.get(windowId) ?? 0) + 1)
  state?.controller.abort()
  if (state) operations.delete(windowId)
  const pool = images.get(windowId)
  for (const [imageId, entry] of pool ?? []) {
    if (entry.conversationId !== conversationId) continue
    entry.valid = false
    callbacks.abortImageJob(windowId, imageId)
    pool?.delete(imageId)
    if (!bindingFor(windowId, conversationId, imageId))
      removalQueue.set(assetKey(conversationId, imageId), { conversationId, imageId })
  }
  if (pool?.size === 0) images.delete(windowId)
  void flushImageRemovals().catch(() => undefined)
  return true
}

export function cleanupImageAccess(windowId: number, forgetWindow = false): void {
  imageEpochs.set(windowId, (imageEpochs.get(windowId) ?? 0) + 1)
  operations.get(windowId)?.controller.abort()
  operations.delete(windowId)
  for (const [imageId, entry] of images.get(windowId) ?? []) {
    entry.valid = false
    callbacks.abortImageJob(windowId, imageId)
    if (!bindingFor(windowId, entry.conversationId, imageId))
      removalQueue.set(assetKey(entry.conversationId, imageId), {
        conversationId: entry.conversationId,
        imageId
      })
  }
  images.delete(windowId)
  if (forgetWindow) {
    for (const [conversationId, pool] of bindings.get(windowId) ?? []) {
      for (const imageId of pool.keys())
        removalQueue.set(assetKey(conversationId, imageId), { conversationId, imageId })
    }
    bindings.delete(windowId)
    messageGroups.delete(windowId)
    imageEpochs.delete(windowId)
  }
  void flushImageRemovals().catch(() => undefined)
}
