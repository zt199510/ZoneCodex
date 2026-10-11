import {
  getImageTurnNoticeCount,
  maxImagesPerMessage,
  maxRequestImages,
  maxRequestImageBytes,
  parseImageDescriptor
} from '../../shared/image-input'
import type { CapturedImage } from '../project/image-access'
import { AgentError } from '../errors'
import type { SendResponse } from './response-client'

export type CapturedImageInput = { index: number; prompt: string; captured: CapturedImage }

export function projectConversationImageInput(
  input: unknown[],
  images: readonly CapturedImageInput[],
  turnStart: number,
  prompt: string
): unknown[] {
  if (!Number.isInteger(turnStart) || turnStart < 0 || turnStart >= input.length)
    throw new AgentError('图片与用户问题不一致')
  if (images.length > maxRequestImages) throw new AgentError('本轮图片数量超过上限')
  const expected = new Map<number, CapturedImageInput[]>()
  let previousIndex = -1
  let totalBytes = 0
  for (const imageInput of images) {
    if (
      !Number.isInteger(imageInput.index) ||
      imageInput.index < previousIndex ||
      imageInput.index < 0 ||
      imageInput.index > turnStart
    )
      throw new AgentError('图片历史位置或顺序无效')
    const group = expected.get(imageInput.index) ?? []
    if (
      group.length >= maxImagesPerMessage ||
      group.some(
        (candidate) => candidate.captured.image.imageId === imageInput.captured.image.imageId
      )
    )
      throw new AgentError('消息图片组重复或超过上限')
    const image = parseImageDescriptor(imageInput.captured.image)
    if (!image) throw new AgentError('原图片描述无效，请重新添加')
    totalBytes += image.bytes
    if (totalBytes > maxRequestImageBytes) throw new AgentError('本轮引用的图片超过 20 MiB')
    group.push(imageInput)
    expected.set(imageInput.index, group)
    previousIndex = imageInput.index
  }
  const live = structuredClone(input)
  for (let index = 0; index < input.length; index++) {
    const item = input[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const user = item as Record<string, unknown>
    if (user.role !== 'user') continue
    if (
      index > turnStart ||
      Object.keys(user).length !== 2 ||
      typeof user.content !== 'string' ||
      (index === turnStart && user.content !== prompt)
    )
      throw new AgentError('图片与用户问题不一致')
    const imageInputs = expected.get(index)
    if (getImageTurnNoticeCount(user.content) !== (imageInputs?.length ?? null))
      throw new AgentError('历史图片不可用，请重新添加后发送')
    if (!imageInputs) continue
    const wireImages = imageInputs.map((imageInput) => {
      const { captured } = imageInput
      captured.assertCurrent()
      const image = parseImageDescriptor(captured.image)
      if (!image || imageInput.prompt !== user.content) throw new AgentError('图片与用户问题不一致')
      const prefix = `data:${image.mime};base64,`
      if (
        !captured.dataUrl.startsWith(prefix) ||
        captured.dataUrl.length !== prefix.length + Math.ceil(image.bytes / 3) * 4
      )
        throw new AgentError('原图片字节无效，请重新添加图片')
      return { type: 'input_image', image_url: captured.dataUrl }
    })
    live[index] = {
      role: 'user',
      content: [{ type: 'input_text', text: user.content }, ...wireImages]
    }
    expected.delete(index)
  }
  if (expected.size) throw new AgentError('图片历史位置无效')
  return live
}

/** Only the live wire payload contains pixels; the original audit array stays textual. */
export function projectImageInput(
  input: unknown[],
  turnStart: number,
  prompt: string,
  captured: CapturedImage
): unknown[] {
  return projectConversationImageInput(
    input,
    [{ index: turnStart, prompt, captured }],
    turnStart,
    prompt
  )
}

export function withConversationImageInput(
  send: SendResponse,
  images: readonly CapturedImageInput[],
  turnStart: number,
  prompt: string,
  assertRequestCurrent: () => boolean
): SendResponse {
  return (input, signal, options) => {
    signal.throwIfAborted()
    if (!assertRequestCurrent()) throw new AgentError('运行上下文已失效，请重新发送')
    const mapped = remapConversationImages(input, images, turnStart, options?.originalIndices)
    const live = projectConversationImageInput(input, mapped.images, mapped.turnStart, prompt)
    signal.throwIfAborted()
    return send(live, signal, options)
  }
}

/** Images stay attached to their original user message, even when earlier text is summarized. */
export function remapConversationImages(
  input: unknown[],
  images: readonly CapturedImageInput[],
  turnStart: number,
  originalIndices?: readonly number[]
): { images: readonly CapturedImageInput[]; turnStart: number } {
  if (originalIndices === undefined) return { images, turnStart }
  if (!Array.isArray(originalIndices) || originalIndices.length !== input.length)
    throw new AgentError('上下文图片位置映射无效')
  const positions = new Map<number, number>()
  let previous = -1
  for (const [index, original] of originalIndices.entries()) {
    if (!Number.isInteger(original) || original < -1 || (original >= 0 && original <= previous))
      throw new AgentError('上下文图片位置映射无效')
    if (original === -1) {
      const item = input[index]
      if (!item || typeof item !== 'object' || (item as Record<string, unknown>).role === 'user')
        throw new AgentError('整理资料不能替代图片用户消息')
    } else {
      positions.set(original, index)
      previous = original
    }
  }
  const mappedStart = positions.get(turnStart)
  if (mappedStart === undefined) throw new AgentError('上下文整理丢失当前用户问题')
  const mappedImages = images.map((image) => {
    const index = positions.get(image.index)
    if (index === undefined) throw new AgentError('上下文整理丢失原图片组')
    return { ...image, index }
  })
  return { images: mappedImages, turnStart: mappedStart }
}

export function withImageInput(
  send: SendResponse,
  captured: CapturedImage,
  turnStart: number,
  prompt: string,
  assertRequestCurrent: () => boolean
): SendResponse {
  return withConversationImageInput(
    send,
    [{ index: turnStart, prompt, captured }],
    turnStart,
    prompt,
    assertRequestCurrent
  )
}
