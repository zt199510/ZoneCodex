import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  MAX_IMAGE_BYTES,
  maxImagesPerMessage,
  maxRequestImageBytes,
  type ImageDescriptor
} from '../../../../shared/image-input'
import { getMessageImages, type ChatMessage } from '../../../../shared/conversation'
import type { OperationControl } from '../conversation/useOperation'

export type RuntimeImage = {
  image: ImageDescriptor
  src: string
  thumbnailSrc: string
}

type ImageState = {
  conversationId: string | null
  pending: RuntimeImage[]
  messages: Record<string, RuntimeImage[]>
  messageErrors: Record<string, Record<string, string>>
}

export type ImageSelectionController = {
  pending: readonly RuntimeImage[]
  messages: Readonly<Record<string, readonly RuntimeImage[]>>
  messageErrors: Readonly<Record<string, Readonly<Record<string, string>>>>
  busy: boolean
  error: string | null
  setError: (error: string | null) => void
  select: () => Promise<boolean>
  paste: (files: readonly File[]) => Promise<boolean>
  remove: (imageId: string) => Promise<boolean>
  release: () => Promise<boolean>
  bind: (messageId: string, images: readonly RuntimeImage[]) => void
  getMessage: (messageId: string) => RuntimeImage[] | null
  getImage: (imageId: string) => RuntimeImage | null
  isAvailable: (imageId: string) => boolean
  withPrepared: (images: readonly RuntimeImage[], submit: () => boolean) => Promise<boolean>
  retainMessages: (messageIds: ReadonlySet<string>, retainedImageIds?: readonly string[]) => void
}

function sameImage(left: ImageDescriptor, right: ImageDescriptor): boolean {
  return (
    left.imageId === right.imageId &&
    left.name === right.name &&
    left.mime === right.mime &&
    left.bytes === right.bytes &&
    left.width === right.width &&
    left.height === right.height
  )
}

export function useImageSelection({
  conversationId,
  messages,
  operations,
  canChange,
  ensureConversation
}: {
  conversationId: string | null
  messages: readonly ChatMessage[]
  operations: OperationControl
  canChange: () => boolean
  ensureConversation: () => Promise<string | null>
}): ImageSelectionController {
  const [state, setState] = useState<ImageState>({
    conversationId,
    pending: [],
    messages: {},
    messageErrors: {}
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stateRef = useRef(state)
  const currentConversation = useRef(conversationId)
  const changeAllowed = useRef(canChange)
  const ensureCurrentConversation = useRef(ensureConversation)
  const importing = useRef(false)
  const generation = useRef(0)
  const restoreGeneration = useRef(0)
  const messageRef = useRef(messages)
  const restoring = useRef(new Map<string, symbol>())
  const restoreJobs = useRef(new Set<Promise<void>>())
  const mounted = useRef(false)
  useLayoutEffect(() => {
    currentConversation.current = conversationId
    changeAllowed.current = canChange
    ensureCurrentConversation.current = ensureConversation
    messageRef.current = messages
  }, [conversationId, canChange, ensureConversation, messages])

  const update = useCallback((next: ImageState): void => {
    stateRef.current = next
    if (mounted.current) setState(next)
  }, [])

  const invalidate = useCallback((): void => {
    generation.current++
    restoreGeneration.current++
    restoring.current.clear()
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      invalidate()
      const previous = stateRef.current
      stateRef.current = { conversationId: null, pending: [], messages: {}, messageErrors: {} }
      if (previous.conversationId)
        void window.api.revokeConversationImages(previous.conversationId).catch(() => undefined)
    }
  }, [invalidate])

  useEffect(() => {
    if (stateRef.current.conversationId === conversationId) return
    invalidate()
    const previous = stateRef.current
    update({ conversationId, pending: [], messages: {}, messageErrors: {} })
    setError(null)
    if (previous.conversationId)
      void window.api.revokeConversationImages(previous.conversationId).catch(() => undefined)
  }, [conversationId, invalidate, update])

  const savedImages = JSON.stringify(
    messages
      .filter((message) => message.role === 'user' && getMessageImages(message).length)
      .map((message) => [message.id, getMessageImages(message)])
  )

  useEffect(() => {
    if (!conversationId || busy) return
    const id = conversationId
    const token = restoreGeneration.current
    const queued = new Map<string, ImageDescriptor>()
    for (const message of messageRef.current) {
      if (message.role !== 'user') continue
      for (const image of getMessageImages(message)) {
        if (
          !stateRef.current.messages[message.id]?.some((view) => sameImage(view.image, image)) &&
          !stateRef.current.messageErrors[message.id]?.[image.imageId] &&
          !restoring.current.has(image.imageId)
        )
          queued.set(image.imageId, image)
      }
    }
    const owners = new Map([...queued.keys()].map((imageId) => [imageId, Symbol(imageId)]))
    for (const [imageId, owner] of owners) restoring.current.set(imageId, owner)

    function currentRestore(): boolean {
      return (
        mounted.current &&
        currentConversation.current === id &&
        stateRef.current.conversationId === id &&
        restoreGeneration.current === token
      )
    }

    function restoreImage(descriptor: ImageDescriptor, view: RuntimeImage | null): void {
      const latest = stateRef.current
      const restoredMessages = { ...latest.messages }
      const messageErrors = { ...latest.messageErrors }
      for (const message of messageRef.current) {
        const descriptors = getMessageImages(message)
        if (message.role !== 'user' || !descriptors.some((image) => sameImage(image, descriptor)))
          continue
        const restored = restoredMessages[message.id] ?? []
        if (restored.some((item) => sameImage(item.image, descriptor))) continue
        if (view) {
          const available = [...restored, view]
          restoredMessages[message.id] = descriptors.flatMap((image) => {
            const item = available.find((candidate) => sameImage(candidate.image, image))
            return item ? [item] : []
          })
          const errors = { ...messageErrors[message.id] }
          delete errors[descriptor.imageId]
          if (Object.keys(errors).length) messageErrors[message.id] = errors
          else delete messageErrors[message.id]
        } else {
          messageErrors[message.id] = {
            ...messageErrors[message.id],
            [descriptor.imageId]: '图片不可用，请重新添加。'
          }
        }
      }
      update({ ...latest, messages: restoredMessages, messageErrors })
    }

    const job = (async () => {
      for (const [imageId, descriptor] of queued) {
        try {
          if (!currentRestore() || importing.current) break
          const result = await window.api.readImagePreview(id, imageId)
          if (!currentRestore()) break
          const view =
            result.status === 'ready' && sameImage(result.image, descriptor)
              ? { image: result.image, src: result.dataUrl, thumbnailSrc: result.thumbnailDataUrl }
              : null
          restoreImage(descriptor, view)
        } catch {
          if (!currentRestore()) break
          restoreImage(descriptor, null)
        } finally {
          if (restoring.current.get(imageId) === owners.get(imageId))
            restoring.current.delete(imageId)
        }
      }
      for (const [imageId, owner] of owners)
        if (restoring.current.get(imageId) === owner) restoring.current.delete(imageId)
    })()
    restoreJobs.current.add(job)
    void job.finally(() => restoreJobs.current.delete(job))
  }, [conversationId, savedImages, busy, update])

  function current(id: string, token: number): boolean {
    return mounted.current && currentConversation.current === id && generation.current === token
  }

  function getImage(imageId: string): RuntimeImage | null {
    const latest = stateRef.current
    if (latest.conversationId !== currentConversation.current) return null
    return (
      latest.pending.find((view) => view.image.imageId === imageId) ??
      Object.values(latest.messages)
        .flat()
        .find((view) => view.image.imageId === imageId) ??
      null
    )
  }

  async function importImages(files?: readonly File[]): Promise<boolean> {
    if (importing.current || !changeAllowed.current()) return false
    importing.current = true
    setBusy(true)
    setError(null)
    let id = currentConversation.current
    let token = generation.current
    let locked = false
    const imported: ImageDescriptor[] = []
    let accepted = false
    try {
      if (files) {
        if (!files.length) return false
        if (stateRef.current.pending.length + files.length > maxImagesPerMessage)
          throw new Error(`每条消息最多添加 ${maxImagesPerMessage} 张图片。`)
        for (const file of files) {
          if (
            !['image/png', 'image/jpeg'].includes(file.type) &&
            !(file.type === '' && /\.(png|jpe?g)$/i.test(file.name))
          )
            throw new Error('只支持 PNG 或 JPEG 图片。')
          if (file.size <= 0 || file.size > MAX_IMAGE_BYTES)
            throw new Error('图片不能为空，单张图片最多 5 MiB。')
        }
        if (
          files.reduce((bytes, file) => bytes + file.size, 0) +
            stateRef.current.pending.reduce((bytes, view) => bytes + view.image.bytes, 0) >
          maxRequestImageBytes
        )
          throw new Error('本组图片超过 20 MiB，请移除部分图片。')
      }
      if (!id) {
        id = await ensureCurrentConversation.current()
        if (!id || !mounted.current) return false
        if (currentConversation.current && currentConversation.current !== id) return false
        currentConversation.current = id
        if (stateRef.current.conversationId !== id)
          update({ conversationId: id, pending: [], messages: {}, messageErrors: {} })
      }
      if (!changeAllowed.current() || !operations.begin('selecting')) return false
      locked = true
      token = ++generation.current
      // Finish the current read before importing. Remaining saved previews resume
      // when the import releases its busy state.
      await Promise.allSettled([...restoreJobs.current])
      if (!current(id, token)) return false
      if (files) {
        for (const file of files) {
          const result = await window.api.importImage(id, {
            bytes: new Uint8Array(await file.arrayBuffer()),
            name: file.name || (file.type === 'image/jpeg' ? '粘贴图片.jpg' : '粘贴图片.png')
          })
          if (result.status === 'cancelled') return false
          if (result.status === 'error') throw new Error(result.error)
          imported.push(result.image)
          if (!current(id, token)) return false
        }
      } else {
        const result = await window.api.selectImage(id)
        if (result.status === 'cancelled') return false
        if (result.status === 'error') throw new Error(result.error)
        imported.push(...result.images)
      }
      if (!current(id, token)) return false
      const previous = stateRef.current
      if (previous.pending.length + imported.length > maxImagesPerMessage)
        throw new Error(`每条消息最多添加 ${maxImagesPerMessage} 张图片。`)
      if (
        [...previous.pending.map((view) => view.image), ...imported].reduce(
          (bytes, image) => bytes + image.bytes,
          0
        ) > maxRequestImageBytes
      )
        throw new Error('本组图片超过 20 MiB，请移除部分图片。')
      const ids = new Set(previous.pending.map((view) => view.image.imageId))
      const added: RuntimeImage[] = []
      for (const descriptor of imported) {
        if (ids.has(descriptor.imageId)) throw new Error('图片身份重复，请重新添加。')
        ids.add(descriptor.imageId)
        const preview = await window.api.readImagePreview(id, descriptor.imageId)
        if (preview.status === 'error') throw new Error(preview.error)
        if (!current(id, token)) return false
        if (!sameImage(preview.image, descriptor)) throw new Error('图片预览确认结果不一致。')
        added.push({
          image: preview.image,
          src: preview.dataUrl,
          thumbnailSrc: preview.thumbnailDataUrl
        })
      }
      update({ ...stateRef.current, conversationId: id, pending: [...previous.pending, ...added] })
      accepted = true
      return true
    } catch (cause) {
      if (id ? current(id, token) : mounted.current)
        setError(cause instanceof Error ? cause.message : '图片添加失败，请重新选择。')
      return false
    } finally {
      const cleanupConversationId = id
      if (cleanupConversationId && !accepted)
        await Promise.allSettled(
          imported.map((image) => window.api.revokeImage(cleanupConversationId, image.imageId))
        )
      if (locked) operations.finish('selecting')
      importing.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function remove(imageId: string): Promise<boolean> {
    const latest = stateRef.current
    const id = currentConversation.current
    if (
      !id ||
      !latest.pending.some((view) => view.image.imageId === imageId) ||
      !changeAllowed.current() ||
      !operations.begin('selecting')
    )
      return false
    const token = ++generation.current
    try {
      if (!(await window.api.revokeImage(id, imageId))) throw new Error('图片移除失败，请重试。')
      if (current(id, token)) {
        update({
          ...stateRef.current,
          pending: stateRef.current.pending.filter((view) => view.image.imageId !== imageId)
        })
        setError(null)
      }
      return true
    } catch (cause) {
      if (current(id, token))
        setError(cause instanceof Error ? cause.message : '图片移除失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }

  async function release(): Promise<boolean> {
    const latest = stateRef.current
    if (!latest.conversationId) return true
    if (!operations.begin('selecting')) return false
    try {
      if (!(await window.api.revokeConversationImages(latest.conversationId)))
        throw new Error('图片清理失败，请稍后重试。')
      invalidate()
      update({
        conversationId: latest.conversationId,
        pending: [],
        messages: {},
        messageErrors: {}
      })
      setError(null)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片清理失败，请稍后重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }

  async function withPrepared(
    images: readonly RuntimeImage[],
    submit: () => boolean
  ): Promise<boolean> {
    const id = currentConversation.current
    const frozen = [...images]
    if (
      !id ||
      !changeAllowed.current() ||
      !frozen.length ||
      frozen.length > maxImagesPerMessage ||
      new Set(frozen.map((view) => view.image.imageId)).size !== frozen.length ||
      frozen.some((view) => !getImage(view.image.imageId))
    ) {
      setError('原图片组已失效，请重新添加图片后发送。')
      return false
    }
    if (!operations.begin('selecting')) return false
    const token = generation.current
    setBusy(true)
    setError(null)
    try {
      for (const view of frozen) {
        const result = await window.api.prepareImage(id, view.image.imageId)
        if (result.status === 'error') throw new Error(result.error)
        if (!current(id, token)) return false
        if (
          !sameImage(result.image, view.image) ||
          !frozen.every((item) => getImage(item.image.imageId))
        )
          throw new Error('图片组确认结果不一致，请重新添加。')
      }
      // Transfer the preparation lock synchronously only after the whole group passed.
      operations.finish('selecting')
      return submit()
    } catch (cause) {
      if (current(id, token))
        setError(cause instanceof Error ? cause.message : '图片组确认失败，请重新添加。')
      return false
    } finally {
      operations.finish('selecting')
      if (mounted.current) setBusy(false)
    }
  }

  function bind(messageId: string, images: readonly RuntimeImage[]): void {
    const latest = stateRef.current
    if (latest.conversationId !== currentConversation.current) return
    const frozen = [...images]
    const sameDraft =
      frozen.length === latest.pending.length &&
      frozen.every((view, index) => sameImage(view.image, latest.pending[index].image))
    const messageErrors = { ...latest.messageErrors }
    delete messageErrors[messageId]
    update({
      ...latest,
      pending: sameDraft ? [] : latest.pending,
      messages: { ...latest.messages, [messageId]: frozen },
      messageErrors
    })
  }

  function retainMessages(
    messageIds: ReadonlySet<string>,
    retainedImageIds: readonly string[] = []
  ): void {
    const previous = stateRef.current
    const messages = Object.fromEntries(
      Object.entries(previous.messages).filter(([messageId]) => messageIds.has(messageId))
    )
    const messageErrors = Object.fromEntries(
      Object.entries(previous.messageErrors).filter(([messageId]) => messageIds.has(messageId))
    )
    update({ ...previous, messages, messageErrors })
    const retained = new Set([
      ...retainedImageIds,
      ...previous.pending.map((view) => view.image.imageId),
      ...Object.values(messages)
        .flat()
        .map((view) => view.image.imageId)
    ])
    if (previous.conversationId) {
      for (const imageId of new Set(
        Object.values(previous.messages)
          .flat()
          .map((view) => view.image.imageId)
      ))
        if (!retained.has(imageId))
          void window.api.revokeImage(previous.conversationId, imageId).catch(() => undefined)
    }
  }

  const visible = state.conversationId === conversationId ? state : null
  return {
    pending: visible?.pending ?? [],
    messages: visible?.messages ?? {},
    messageErrors: visible?.messageErrors ?? {},
    busy,
    error,
    setError,
    select: () => importImages(),
    paste: (files) => importImages([...files]),
    remove,
    release,
    bind,
    getMessage: (messageId) => {
      if (stateRef.current.conversationId !== currentConversation.current) return null
      const views = stateRef.current.messages[messageId]
      const message = messageRef.current.find((item) => item.id === messageId)
      const descriptors = message ? getMessageImages(message) : views?.map((view) => view.image)
      if (!views?.length || !descriptors?.length || views.length !== descriptors.length) return null
      return descriptors.every((descriptor, index) => sameImage(descriptor, views[index].image))
        ? [...views]
        : null
    },
    getImage,
    isAvailable: (imageId) => Boolean(getImage(imageId)),
    withPrepared,
    retainMessages
  }
}
