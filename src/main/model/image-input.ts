import { hasImageTurnNotice, parseImageDescriptor } from '../../shared/image-input'
import type { CapturedImage } from '../project/image-access'
import { AgentError } from '../errors'
import type { SendResponse } from './response-client'

/** Only the live wire payload contains pixels; the original audit array stays textual. */
export function projectImageInput(
  input: unknown[],
  turnStart: number,
  prompt: string,
  captured: CapturedImage
): unknown[] {
  captured.assertCurrent()
  const image = parseImageDescriptor(captured.image)
  if (
    !image ||
    !hasImageTurnNotice(prompt) ||
    !Number.isInteger(turnStart) ||
    turnStart < 0 ||
    turnStart >= input.length
  )
    throw new AgentError('本轮图片请求无效，请重新添加图片')
  const prefix = `data:${image.mime};base64,`
  if (
    !captured.dataUrl.startsWith(prefix) ||
    captured.dataUrl.length !== prefix.length + Math.ceil(image.bytes / 3) * 4
  )
    throw new AgentError('本轮原图片字节无效，请重新添加图片')
  const current = input[turnStart]
  if (!current || typeof current !== 'object' || Array.isArray(current))
    throw new AgentError('本轮图片与用户问题不一致')
  const user = current as Record<string, unknown>
  if (Object.keys(user).length !== 2 || user.role !== 'user' || user.content !== prompt)
    throw new AgentError('本轮图片与用户问题不一致')
  for (let index = 0; index < input.length; index++) {
    if (index === turnStart) continue
    const item = input[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (
      record.role === 'user' &&
      (index > turnStart ||
        typeof record.content !== 'string' ||
        hasImageTurnNotice(record.content))
    )
      throw new AgentError('图片历史已失效，不能复用旧图片轮次')
  }
  const live = structuredClone(input)
  live[turnStart] = {
    role: 'user',
    content: [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: captured.dataUrl }
    ]
  }
  return live
}

export function withImageInput(
  send: SendResponse,
  captured: CapturedImage,
  turnStart: number,
  prompt: string,
  assertRequestCurrent: () => boolean
): SendResponse {
  return (input, signal, options) => {
    signal.throwIfAborted()
    if (!assertRequestCurrent()) throw new AgentError('运行上下文已失效，请重新发送')
    const live = projectImageInput(input, turnStart, prompt, captured)
    signal.throwIfAborted()
    return send(live, signal, options)
  }
}
