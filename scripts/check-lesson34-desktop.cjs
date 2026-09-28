const assert = require('node:assert/strict')
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const root = join(__dirname, '..')
const profile = join(root, '.ui-check', 'lesson34-profile')
app.setPath('userData', profile)
app.disableHardwareAcceleration()

let window
let saved = { version: 5, activeConversationId: null, conversations: [] }
let pending = null
let starts = 0

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => window.webContents.executeJavaScript(code, true)
async function until(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(`Timed out: ${label}`)
}
const dom = (code, label) => until(() => evaluate(code), label || code)

async function input(text) {
  await evaluate(`(() => {
    const element = document.querySelector('#chat-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}

function resultFor(request, answer) {
  return {
    status: 'done',
    answer,
    trace: ['模拟第34课桌面回归'],
    items: [
      { role: 'user', content: request.prompt },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer }],
        phase: 'final_answer'
      }
    ]
  }
}

ipcMain.handle('conversation:load', () => ({ ok: true, missing: false, snapshot: saved }))
ipcMain.handle('conversation:save', async (_event, snapshot) => {
  saved = structuredClone(snapshot)
  return { ok: true }
})
ipcMain.handle('window:state', () => ({ maximized: false }))
ipcMain.handle('window:command', () => undefined)
ipcMain.handle('window:finish-close', () => true)
ipcMain.handle('task:list', () => [])
ipcMain.handle('agent:start', (_event, requestId, prompt, mode, history, context, taskId, conversationId) => {
  starts++
  assert.equal(mode, 'live')
  assert.deepEqual(context, { kind: 'time' })
  pending = { requestId, prompt, history, taskId, conversationId, resolve: null }
  return new Promise((resolve) => {
    pending.resolve = resolve
  })
})
ipcMain.handle('agent:cancel', (_event, requestId) => {
  if (pending?.requestId === requestId) {
    const current = pending
    pending = null
    current.resolve({ status: 'cancelled', trace: [] })
  }
  return true
})

function finish(status, answer = '') {
  const current = pending
  assert(current, 'there is an active simulated request')
  pending = null
  current.resolve(
    status === 'done'
      ? resultFor(current, answer)
      : { status: 'error', error: '模拟网络失败', trace: ['模拟第34课桌面回归'] }
  )
}

app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 1280,
      height: 840,
      useContentSize: true,
      show: false,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: join(root, 'out/preload/index.js'),
        sandbox: false,
        backgroundThrottling: false
      }
    })
    await window.loadFile(join(root, 'out/renderer/index.html'))
    await dom("!!document.querySelector('#chat-input')", 'initial render')
    await dom("!document.querySelector('#chat-input').disabled", 'storage ready')
    assert.equal(await evaluate("document.querySelector('.empty-state') !== null"), true)

    await input('空白工作台第一轮')
    await evaluate(
      "(() => { const form = document.querySelector('.composer'); form.requestSubmit(); form.requestSubmit(); })()"
    )
    await until(() => !!pending, 'first request')
    assert.equal(starts, 1, 'rapid duplicate send creates one request')
    assert.equal(await evaluate("document.querySelector('#chat-input').value"), '')
    finish('done', '第一轮完成')
    await until(
      () => saved.conversations.length === 1 && saved.conversations[0].messages.length === 2,
      'first round save'
    )
    assert.equal(saved.activeConversationId, saved.conversations[0].id)
    assert.equal(saved.conversations[0].messages[1].status, 'complete')

    await dom("!document.querySelector('#chat-input').disabled", 'after first round')
    await input('第二轮故意失败')
    await evaluate("document.querySelector('.composer').requestSubmit()")
    await until(() => !!pending, 'failed round')
    assert.equal(pending.history.length, 2, 'successful tool history is reused')
    finish('error')
    await until(
      () => saved.conversations[0].messages.at(-1)?.status === 'failed',
      'failed round save'
    )

    await dom("!document.querySelector('#chat-input').disabled", 'after failed round')
    await input('失败后继续第二轮')
    await evaluate("document.querySelector('.composer').requestSubmit()")
    await until(() => !!pending, 'follow-up after failure')
    assert.equal(pending.history.length, 2, 'failed round is excluded from history')
    finish('done', '失败后已恢复')
    await until(
      () => saved.conversations[0].messages.at(-1)?.status === 'complete',
      'recovered round save'
    )
    console.log('Lesson 34 desktop first-send checks passed.')
    window.destroy()
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(1)
  })
