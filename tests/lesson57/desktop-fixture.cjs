/* Synthetic model transport; unchanged real Electron/tool/disk adapters. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const { app, ipcMain, dialog } = require('electron')
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://lesson57-fixture.invalid/responses'
  process.env.MODEL_NAME = 'lesson57-synthetic'
  process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  const audit = { pid: process.pid, realTransport: false, requests: [], ipc: [], events: [] }
  const save = () => fs.writeFileSync(config.auditFile, JSON.stringify(audit, null, 2))
  const call = (id, name, args) => ({
    type: 'function_call',
    call_id: id,
    name,
    arguments: JSON.stringify(args)
  })
  const read = (id) =>
    call(id, 'read_workspace_file', { path: 'business.js', startLine: 1, endLine: 10 })
  const patch = (id, input) => {
    const result = input
      .filter((item) => item.type === 'function_call_output')
      .map((item) => {
        try {
          return JSON.parse(item.output)
        } catch {
          return null
        }
      })
      .filter((item) => item && item.sha256)
      .at(-1)
    if (!result) throw Error('No real prior read result in protocol')
    return call(id, 'apply_workspace_patch', {
      path: 'business.js',
      expectedSha256: result.sha256,
      patch:
        '*** Begin Patch\n*** Update File: business.js\n@@\n-export function subtotal(unitCents, quantity) { return unitCents + quantity }\n+export function subtotal(unitCents, quantity) { return unitCents * quantity }\n*** End Patch'
    })
  }
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== process.env.MODEL_ENDPOINT || init.method !== 'POST')
      throw Error('Fixture rejects unexpected network')
    const body = JSON.parse(init.body)
    const category = body.instructions.includes('你负责为桌面聊天会话生成标题')
      ? 'title'
      : body.instructions.includes('独立风险评估器')
        ? 'approval'
        : body.tools.length
          ? 'main'
          : 'summary'
    const request = {
      category,
      input: body.input,
      atUTC: new Date().toISOString(),
      resumeSafety:
        body.instructions.includes('本次是用户明确触发的任务续接。') &&
        body.instructions.includes('不得声称跨进程恰好执行一次。')
    }
    audit.requests.push(request)
    save()
    if (category !== 'main') throw Error('Fixture rejects title/summary/approval requests')
    const number = audit.requests.length
    if (config.stage === 'create' && number === 2) {
      request.waitingForCancellation = true
      save()
      return await new Promise((_resolve, reject) => {
        const abort = () => {
          request.cancelled = true
          save()
          reject(new DOMException('User interrupted synthetic stream', 'AbortError'))
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })
    }
    let output
    if (config.stage === 'create') output = [read('lesson57-original-read')]
    else if (number === 1) output = [patch('lesson57-stale-evidence-patch', body.input)]
    else if (number === 2) output = [read('lesson57-fresh-read')]
    else if (number === 3) output = [patch('lesson57-fresh-patch', body.input)]
    else if (number === 4) output = [read('lesson57-verify-read')]
    else if (number === 5)
      output = [
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            { type: 'output_text', text: '价格函数已修正；实际读取、补丁与重读记录可核对。' }
          ]
        }
      ]
    else throw Error('Unexpected extra request')
    const event = { type: 'response.completed', response: { status: 'completed', output } }
    return new Response('data: ' + JSON.stringify(event) + '\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      if (channel.startsWith('agent:'))
        audit.ipc.push({
          channel,
          requestId: args[0],
          checkpointTaskId: channel === 'agent:resume' ? args[1] : undefined
        })
      const result = await handler(event, ...args)
      save()
      return result
    })
  handle('lesson57:observation', () => audit)
  handle('lesson57:quit', () => {
    setImmediate(() => app.exit(0))
    return true
  })
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [config.project] })
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel.startsWith('agent:')) audit.events.push({ channel, value: args[0] })
      save()
      return send(channel, ...args)
    }
  })
  globalThis.__lesson57FixtureReady = true
  save()
}
module.exports = { install }
