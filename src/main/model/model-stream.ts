import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ModelStreamResult } from '../../shared/api'
import { readResponseStream, StreamError } from './sse'
import { parseHistory } from './model'
import { createTask, newTaskId, updateTask } from '../agent/task-registry'
import { isTaskId } from '../../shared/task'
/// 真实流任务类型
type Job = { requestId: string; cancel: () => void }
/// 当前所有真实流任务的映射表，键为 BrowserWindow ID
const jobs = new Map<number, Job>()
/// 检查 IPC 调用来源是否为主窗口的主帧
function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (
    !owner ||
    owner.isDestroyed() ||
    owner.webContents.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('不支持的真实流来源')
  }
  return owner
}
/// 判断请求标识是否有效的类型保护函数
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}
/// 注册模型流相关的 IPC 处理器
export function registerModelStream(): void {
  ipcMain.handle(
    'model-stream:start',
    async (
      event,
      requestId: unknown,
      input: unknown,
      taskId: unknown = undefined,
      conversationId: unknown = undefined
    ): Promise<ModelStreamResult> => {
      const owner = ownerOf(event)
      /// 解析输入内容
      const history = parseHistory(input)
      if (!validId(requestId) || history === null) {
        return { status: 'error', error: '请求标识、对话格式或长度不符合要求。' }
      }

      const sender = event.sender
      const windowId = owner.id
      if (jobs.has(windowId)) return { status: 'error', error: '请等待当前真实流任务结束。' }
      const checkedConversationId =
        typeof conversationId === 'string' && validId(conversationId) ? conversationId : null
      if (!checkedConversationId) {
        return { status: 'error', error: '会话标识无效，请重新发起。' }
      }
      const controller = new AbortController()
      const lifecycleId = isTaskId(taskId) ? taskId : newTaskId()
      const task = createTask({
        taskId: lifecycleId,
        requestId,
        conversationId: checkedConversationId,
        kind: 'chat',
        windowId,
        cancel: () => controller.abort()
      })
      if (!task) return { status: 'error', error: '任务标识已使用，请重新发起。' }
      const endpoint = process.env.MODEL_ENDPOINT
      const model = process.env.MODEL_NAME
      const apiKey = process.env.MODEL_API_KEY
      if (!endpoint || !model || !apiKey) {
        updateTask(windowId, lifecycleId, 'failed', {
          error: '请配置模型地址、名称和密钥，再重启调试。'
        })
        return { status: 'error', error: '请配置模型地址、名称和密钥，再重启调试。' }
      }
      try {
        if (new URL(endpoint).protocol !== 'https:') throw new Error('协议不支持')
      } catch {
        updateTask(windowId, lifecycleId, 'failed', {
          error: '模型地址必须是有效的 HTTPS 地址。'
        })
        return { status: 'error', error: '模型地址必须是有效的 HTTPS 地址。' }
      }
      let timedOut = false
      function cancel(): void {
        controller.abort()
      }
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return
        timedOut = true
        controller.abort()
      }, 60_000)

      jobs.set(windowId, { requestId, cancel })
      updateTask(windowId, lifecycleId, 'running')
      sender.once('destroyed', cancel)
      sender.once('did-start-loading', cancel)
      sender.once('render-process-gone', cancel)

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            input: history,
            stream: true,
            store: false
          }),
          signal: controller.signal
        })

        if (!response.ok) {
          await response.body?.cancel()
          updateTask(windowId, lifecycleId, 'failed', {
            error: `模型请求失败（HTTP ${response.status}）。请检查配置、额度或服务状态。`
          })
          return {
            status: 'error',
            error: `模型请求失败（HTTP ${response.status}）。请检查配置、额度或服务状态。`
          }
        }
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (mime !== 'text/event-stream' || !response.body) {
          await response.body?.cancel()
          updateTask(windowId, lifecycleId, 'failed', {
            error: '服务未返回 SSE，请确认网关支持 Responses 流式接口。'
          })
          return { status: 'error', error: '服务未返回 SSE，请确认网关支持 Responses 流式接口。' }
        }

        await readResponseStream(response.body, (delta) => {
          if (controller.signal.aborted || sender.isDestroyed()) throw new Error('任务已取消')
          sender.send('model-stream:delta', { requestId, delta })
        })
        if (controller.signal.aborted) throw new Error('任务已取消')
        updateTask(windowId, lifecycleId, 'completed')
        return { status: 'done' }
      } catch (error: unknown) {
        if (timedOut) {
          updateTask(windowId, lifecycleId, 'timed_out', { error: '请求超过 60 秒，已停止等待。' })
          return { status: 'error', error: '请求超过 60 秒，已停止等待。' }
        }
        if (controller.signal.aborted) {
          updateTask(windowId, lifecycleId, 'cancelled', { error: '用户已取消任务' })
          return { status: 'cancelled' }
        }
        updateTask(windowId, lifecycleId, 'failed', {
          error: error instanceof StreamError ? error.message : '网络请求或流读取失败，请重试。'
        })
        return {
          status: 'error',
          error: error instanceof StreamError ? error.message : '网络请求或流读取失败，请重试。'
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
        if (jobs.get(windowId)?.requestId === requestId) jobs.delete(windowId)
        sender.removeListener('destroyed', cancel)
        sender.removeListener('did-start-loading', cancel)
        sender.removeListener('render-process-gone', cancel)
      }
    }
  )
  /// 取消模型流请求的 IPC 处理器
  ipcMain.handle('model-stream:cancel', (event, requestId: unknown) => {
    const owner = ownerOf(event)
    if (!validId(requestId)) throw new Error('请求标识不正确')
    const job = jobs.get(owner.id)
    if (job?.requestId === requestId) job.cancel()
  })
}
