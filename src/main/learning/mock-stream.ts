// import { BrowserWindow, ipcMain } from 'electron'
// import type { IpcMainInvokeEvent } from 'electron'
// // import type { MockResult } from '../shared/api'

// type Job = { requestId: string; cancel: () => void }
// const jobs = new Map<number, Job>()
// // 检查 IPC 调用来源是否为主窗口
// function checkSource(event: IpcMainInvokeEvent): void {
//   if (
//     !BrowserWindow.fromWebContents(event.sender) ||
//     event.senderFrame !== event.sender.mainFrame
//   ) {
//     throw new Error('不支持的模拟流来源')
//   }
// }

// // 检查请求标识是否有效
// function validId(value: unknown): value is string {
//   return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
// }
// // 注册模拟流处理函数
// export function registerMockStream(): void {
//   ipcMain.handle('mock:start', (event, requestId: unknown, content: unknown) => {
//     checkSource(event)
//     if (
//       !validId(requestId) ||
//       typeof content !== 'string' ||
//       !content.trim() ||
//       content.length > 200
//     ) {
//       return { status: 'error', error: '请输入 1～200 个字符，并提供有效请求标识。' }
//     }
//     const sender = event.sender
//     if (jobs.has(sender.id)) {
//       return { status: 'error', error: '这个窗口还有模拟任务正在进行。' }
//     }

//     return new Promise<MockResult>((resolve) => {
//       const chars = Array.from(`模拟回复：我收到了“${content.trim()}”。这些文字正在分段到达。`)
//       let index = 0
//       let ended = false

//       function finish(result: MockResult): void {
//         if (ended) return
//         ended = true
//         if (timer !== undefined) clearInterval(timer)
//         jobs.delete(sender.id)
//         sender.removeListener('destroyed', cancel)
//         sender.removeListener('did-start-loading', cancel)
//         sender.removeListener('render-process-gone', cancel)
//         resolve(result)
//       }

//       function cancel(): void {
//         finish({ status: 'cancelled' })
//       }

//       jobs.set(sender.id, { requestId, cancel })
//       sender.once('destroyed', cancel)
//       sender.once('did-start-loading', cancel)
//       sender.once('render-process-gone', cancel)

//       const timer = setInterval(() => {
//         if (sender.isDestroyed()) {
//           cancel()
//           return
//         }
//         try {
//           sender.send('mock:delta', { requestId, delta: chars[index] })
//           index++
//           if (index === chars.length) finish({ status: 'done' })
//         } catch {
//           finish({ status: 'error', error: '模拟片段发送失败。' })
//         }
//       }, 150)
//     })
//   })

//   ipcMain.handle('mock:cancel', (event, requestId: unknown) => {
//     checkSource(event)
//     if (!validId(requestId)) throw new Error('请求标识不正确')
//     const job = jobs.get(event.sender.id)
//     if (job?.requestId === requestId) job.cancel()
//   })
// }
