import type { ModelMessage, ModelReply } from '../../shared/api'

// 解析历史消息，返回 ModelMessage 数组或 null
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
// 解析历史消息，返回 ModelMessage 数组或 null
export function parseHistory(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9 || value.length % 2 !== 1)
    return null

  const history: ModelMessage[] = []
  let total = 0
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index]
    const role = index % 2 === 0 ? 'user' : 'assistant'
    if (
      !isRecord(item) ||
      item.role !== role ||
      typeof item.content !== 'string' ||
      !item.content.trim()
    )
      return null
    if (role === 'user' && item.content.length > 4000) return null
    total += item.content.length
    if (total > 24000) return null
    history.push({ role, content: item.content })
  }
  return history
}
// 解析模型响应，返回文字内容或抛出错误
function readReply(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.output)) {
    throw new Error('响应格式不正确')
  }
  const texts: string[] = []
  for (const item of data.output) {
    if (!isRecord(item)) throw new Error('输出项格式不正确')
    if (item.type !== 'message') continue
    if (!Array.isArray(item.content)) throw new Error('消息内容格式不正确')
    for (const part of item.content) {
      if (!isRecord(part)) throw new Error('内容项格式不正确')
      if (part.type === 'refusal') throw new Error('模型未提供文字回复')
      if (part.type === 'output_text') {
        if (typeof part.text !== 'string') throw new Error('文字格式不正确')
        texts.push(part.text)
      }
    }
  }
  const content = texts.join('\n')
  if (!content.trim()) throw new Error('响应缺少文字')
  return content
}

// 模型请求状态标记，防止重复请求
let busy = false
// 向模型发送请求，返回 ModelReply 对象
export async function askModel(input: unknown): Promise<ModelReply> {
  const history = parseHistory(input)
  if (history === null) {
    return { ok: false, error: '对话格式或长度不符合要求，请清空对话后重试。' }
  }

  if (busy) return { ok: false, error: '已有请求正在进行，请稍后重试。' }

  const endpoint = process.env.MODEL_ENDPOINT
  const model = process.env.MODEL_NAME
  const apiKey = process.env.MODEL_API_KEY
  if (!endpoint || !model || !apiKey) {
    return { ok: false, error: '请配置模型地址、模型名称和密钥，再重启调试。' }
  }
  try {
    if (new URL(endpoint).protocol !== 'https:') throw new Error('协议不支持')
  } catch {
    return { ok: false, error: '模型地址必须是有效的 HTTPS 地址。' }
  }

  busy = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: history,
        store: false,
        stream: false
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      // 不把服务商原始错误体或密钥返回给页面。
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: '认证失败，请检查密钥和模型访问权限。' }
      }
      if (response.status === 429) {
        return { ok: false, error: '请求受限，请检查额度或稍后再试。' }
      }
      return { ok: false, error: `模型服务请求失败（HTTP ${response.status}）。` }
    }

    const data: unknown = await response.json()
    if (!isRecord(data) || typeof data.status !== 'string') {
      throw new Error('响应状态格式不正确')
    }
    if (data.status !== 'completed') {
      return { ok: false, error: '模型未完成回复，请稍后重试。' }
    }
    return { ok: true, content: readReply(data) }
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted
        ? '请求超过 30 秒，请稍后重试。'
        : '请求失败，请检查网络、接口地址和响应格式。'
    }
  } finally {
    clearTimeout(timer)
    busy = false
  }
}
