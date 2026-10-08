import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_IMAGE_BYTES, type ImageDescriptor } from '../../../../shared/image-input'
import type { OperationControl } from '../conversation/useOperation'

export type RuntimeImage = {
  image: ImageDescriptor
  src: string
  thumbnailSrc: string
}

type ImageState = {
  conversationId: string | null
  pending: RuntimeImage | null
  messages: Record<string, RuntimeImage>
}

export type ImageSelectionController = {
  pending: RuntimeImage | null
  messages: Readonly<Record<string, RuntimeImage>>
  busy: boolean
  error: string | null
  setError: (error: string | null) => void
  select: () => Promise<boolean>
  paste: (file: File) => Promise<boolean>
  remove: () => Promise<boolean>
  release: () => Promise<boolean>
  bind: (messageId: string, image: RuntimeImage) => void
  getMessage: (messageId: string) => RuntimeImage | null
  getImage: (imageId: string) => RuntimeImage | null
  isAvailable: (imageId: string) => boolean
  withPrepared: (image: RuntimeImage, submit: () => boolean) => Promise<boolean>
  retainMessages: (messageIds: ReadonlySet<string>, retainedImageId?: string) => void
}

export function useImageSelection({
  conversationId,
  operations,
  canChange,
  ensureConversation
}: {
  conversationId: string | null
  operations: OperationControl
  canChange: () => boolean
  ensureConversation: () => Promise<string | null>
}): ImageSelectionController {
  const [state, setState] = useState<ImageState>({ conversationId, pending: null, messages: {} })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const stateRef = useRef(state)
  const currentConversation = useRef(conversationId)
  const changeAllowed = useRef(canChange)
  const ensureCurrentConversation = useRef(ensureConversation)
  const importing = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    currentConversation.current = conversationId
    changeAllowed.current = canChange
    ensureCurrentConversation.current = ensureConversation
  }, [conversationId, canChange, ensureConversation])

  const update = useCallback((next: ImageState): void => {
    stateRef.current = next
    if (mounted.current) setState(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      const previous = stateRef.current
      stateRef.current = { conversationId: null, pending: null, messages: {} }
      if (previous.conversationId)
        void window.api.revokeConversationImages(previous.conversationId).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (stateRef.current.conversationId === conversationId) return
    generation.current++
    const previous = stateRef.current
    update({ conversationId, pending: null, messages: {} })
    setError(null)
    if (previous.conversationId)
      void window.api.revokeConversationImages(previous.conversationId).catch(() => undefined)
  }, [conversationId, update])

  function current(id: string, token: number): boolean {
    return mounted.current && currentConversation.current === id && generation.current === token
  }

  function isAvailable(imageId: string): boolean {
    const latest = stateRef.current
    return (
      latest.conversationId === currentConversation.current &&
      (latest.pending?.image.imageId === imageId ||
        Object.values(latest.messages).some((image) => image.image.imageId === imageId))
    )
  }

  async function importImage(file?: File): Promise<boolean> {
    if (importing.current || !changeAllowed.current()) return false
    importing.current = true
    setBusy(true)
    setError(null)
    let id = currentConversation.current
    let token = generation.current
    let locked = false
    let imported: ImageDescriptor | null = null
    try {
      if (file && (file.size <= 0 || file.size > MAX_IMAGE_BYTES)) {
        throw new Error('图片为空或超过5 MiB，请选择较小的PNG或JPEG图片。')
      }
      if (!id) {
        id = await ensureCurrentConversation.current()
        if (!id || !mounted.current) return false
        if (currentConversation.current && currentConversation.current !== id) return false
        currentConversation.current = id
        if (stateRef.current.conversationId !== id) {
          update({ conversationId: id, pending: null, messages: {} })
        }
      }
      if (!changeAllowed.current() || !operations.begin('selecting')) return false
      locked = true
      token = ++generation.current
      const result = file
        ? await window.api.importImage(id, {
            bytes: new Uint8Array(await file.arrayBuffer()),
            name: file.name || '粘贴图片.png'
          })
        : await window.api.selectImage(id)
      if (result.status === 'cancelled') return false
      if (result.status === 'error') throw new Error(result.error)
      imported = result.image
      if (!current(id, token)) return false
      const preview = await window.api.readImagePreview(id, imported.imageId)
      if (preview.status === 'error') throw new Error(preview.error)
      if (!current(id, token) || preview.image.imageId !== imported.imageId) return false
      const previous = stateRef.current
      const next: RuntimeImage = {
        image: preview.image,
        src: preview.dataUrl,
        thumbnailSrc: preview.thumbnailDataUrl
      }
      update({ ...previous, conversationId: id, pending: next })
      imported = null
      if (previous.pending && previous.pending.image.imageId !== next.image.imageId)
        await window.api.revokeImage(id, previous.pending.image.imageId)
      return true
    } catch (cause) {
      if (id ? current(id, token) : mounted.current)
        setError(cause instanceof Error ? cause.message : '图片添加失败，请重新选择。')
      return false
    } finally {
      if (id && imported) void window.api.revokeImage(id, imported.imageId).catch(() => undefined)
      if (locked) operations.finish('selecting')
      importing.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function remove(): Promise<boolean> {
    const latest = stateRef.current
    const id = currentConversation.current
    if (!id || !latest.pending || !changeAllowed.current() || !operations.begin('selecting'))
      return false
    const target = latest.pending.image.imageId
    try {
      if (!(await window.api.revokeImage(id, target))) throw new Error('图片移除失败，请重试。')
      if (currentConversation.current === id && stateRef.current.pending?.image.imageId === target)
        update({ ...stateRef.current, pending: null })
      setError(null)
      return true
    } catch (cause) {
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
      generation.current++
      update({ conversationId: latest.conversationId, pending: null, messages: {} })
      setError(null)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '图片清理失败，请稍后重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }

  async function withPrepared(image: RuntimeImage, submit: () => boolean): Promise<boolean> {
    const id = currentConversation.current
    if (!id || !changeAllowed.current() || !isAvailable(image.image.imageId)) {
      setError('原图片已失效，请重新添加图片后发送。')
      return false
    }
    if (!operations.begin('selecting')) return false
    const token = generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.prepareImage(id, image.image.imageId)
      if (result.status === 'error') throw new Error(result.error)
      if (!current(id, token) || !isAvailable(image.image.imageId)) return false
      if (result.image.imageId !== image.image.imageId) throw new Error('图片确认结果不一致。')
      // Release the preparation lock and submit synchronously in the same turn.
      operations.finish('selecting')
      return submit()
    } catch (cause) {
      if (current(id, token))
        setError(cause instanceof Error ? cause.message : '图片确认失败，请重新添加。')
      return false
    } finally {
      operations.finish('selecting')
      if (mounted.current) setBusy(false)
    }
  }

  function bind(messageId: string, image: RuntimeImage): void {
    const latest = stateRef.current
    if (latest.conversationId !== currentConversation.current) return
    update({
      ...latest,
      pending: latest.pending?.image.imageId === image.image.imageId ? null : latest.pending,
      messages: { ...latest.messages, [messageId]: image }
    })
  }

  function retainMessages(messageIds: ReadonlySet<string>, retainedImageId?: string): void {
    const previous = stateRef.current
    const messages = Object.fromEntries(
      Object.entries(previous.messages).filter(([messageId]) => messageIds.has(messageId))
    )
    update({ ...previous, messages })
    const retained = new Set([
      retainedImageId,
      previous.pending?.image.imageId,
      ...Object.values(messages).map((view) => view.image.imageId)
    ])
    if (previous.conversationId) {
      for (const imageId of new Set(
        Object.values(previous.messages).map((view) => view.image.imageId)
      ))
        if (!retained.has(imageId))
          void window.api.revokeImage(previous.conversationId, imageId).catch(() => undefined)
    }
  }

  const visible = state.conversationId === conversationId ? state : null
  return {
    pending: visible?.pending ?? null,
    messages: visible?.messages ?? {},
    busy,
    error,
    setError,
    select: () => importImage(),
    paste: (file) => importImage(file),
    remove,
    release,
    bind,
    getMessage: (messageId) =>
      stateRef.current.conversationId === currentConversation.current
        ? (stateRef.current.messages[messageId] ?? null)
        : null,
    getImage: (imageId) => {
      const latest = stateRef.current
      if (latest.conversationId !== currentConversation.current) return null
      return latest.pending?.image.imageId === imageId
        ? latest.pending
        : (Object.values(latest.messages).find((view) => view.image.imageId === imageId) ?? null)
    },
    isAvailable,
    withPrepared,
    retainMessages
  }
}
