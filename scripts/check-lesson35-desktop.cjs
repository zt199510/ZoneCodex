const assert = require('node:assert/strict')
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const root = join(__dirname, '..')
const profile = join(root, '.ui-check', 'lesson35-profile')
app.setPath('userData', profile)
app.disableHardwareAcceleration()

let window
let saved = { version: 5, activeConversationId: null, conversations: [] }
let pending = null
let requestNumber = 0

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

async function search(text) {
  await evaluate(`(() => {
    const element = document.querySelector('.conversation-search input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}

function resultFor(request) {
  return {
    status: 'done',
    answer: `已处理：${request.prompt}`,
    trace: ['模拟第35课桌面回归'],
    items: [
      { role: 'user', content: request.prompt },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `已处理：${request.prompt}` }],
        phase: 'final_answer'
      }
    ]
  }
}

function finish() {
  const request = pending
  assert(request, 'expected an active request')
  pending = null
  request.resolve(resultFor(request))
}

function rowFor(title) {
  return `Array.from(document.querySelectorAll('.conversation-row')).find(row => row.textContent.includes(${JSON.stringify(title)}))`
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
  requestNumber++
  pending = { requestId, prompt, mode, history, context, taskId, conversationId, resolve: null }
  return new Promise((resolve) => {
    pending.resolve = resolve
  })
})
ipcMain.handle('agent:cancel', (_event, requestId) => {
  if (pending?.requestId === requestId) {
    const request = pending
    pending = null
    request.resolve({ status: 'cancelled', trace: [] })
  }
  return true
})

app.whenReady().then(async () => {
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

  await input('第一条稳定标题')
  await evaluate("document.querySelector('.composer').requestSubmit()")
  await until(() => !!pending, 'first request')
  assert.equal(requestNumber, 1)
  assert.equal(await evaluate("document.querySelector('#chat-input').disabled"), true)
  assert.equal(await evaluate("document.querySelector('[aria-label=\"重命名会话\"]')?.disabled"), true)
  finish()
  await dom("document.querySelector('.conversation-item span').textContent === '第一条稳定标题'", 'automatic title')

  await evaluate("document.querySelector('.header-actions .quiet-button').click()")
  await until(() => saved.conversations.length === 1, 'first metadata save')
  const firstId = saved.conversations[0].id
  assert.equal(saved.conversations[0].title, '第一条稳定标题')

  await evaluate(`${rowFor('第一条稳定标题')}.querySelector('[aria-label="重命名会话"]').click()`)
  await dom("!!document.querySelector('.conversation-edit input')", 'rename editor')
  await evaluate(`(() => { const input = document.querySelector('.conversation-edit input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '用户手动标题'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.conversation-edit').requestSubmit(); })()`)
  await dom("document.querySelector('.conversation-item span').textContent === '用户手动标题'", 'renamed title')
  await evaluate("document.querySelector('.header-actions .quiet-button').click()")
  await until(() => saved.conversations[0].title === '用户手动标题', 'rename save')

  await input('后续消息不会覆盖标题')
  await evaluate("document.querySelector('.composer').requestSubmit()")
  await until(() => !!pending, 'follow-up request')
  finish()
  await dom("document.querySelector('.conversation-item span').textContent === '用户手动标题'", 'manual title remains stable')

  await search('不存在的匹配')
  await dom("document.querySelectorAll('.conversation-row').length === 0", 'search filters list')
  await search('用户手动标题')
  await dom("document.querySelectorAll('.conversation-row').length === 1", 'search title hit')
  await evaluate("document.querySelector('.search-clear').click()")

  await evaluate("document.querySelector('.conversation-create').click()")
  await dom("document.querySelectorAll('.conversation-row').length === 2", 'second conversation')
  await input('消息内容搜索词')
  await evaluate("document.querySelector('.composer').requestSubmit()")
  await until(() => !!pending, 'second request')
  finish()
  await dom("document.querySelectorAll('.conversation-row').length === 2", 'second completed')
  await evaluate("document.querySelector('.header-actions .quiet-button').click()")
  await until(() => saved.conversations.length === 2, 'second save')

  await evaluate(`${rowFor('用户手动标题')}.querySelector('[aria-label="置顶会话"]').click()`)
  await evaluate("document.querySelector('.header-actions .quiet-button').click()")
  await until(() => saved.conversations.some((item) => item.pinned), 'pin save')
  assert.equal(saved.conversations.find((item) => item.id === firstId).pinned, true)

  await search('消息内容搜索词')
  await dom("document.querySelectorAll('.conversation-row').length === 1", 'search message hit')
  await evaluate("document.querySelector('.search-clear').click()")

  const secondTitle = '消息内容搜索词'
  await evaluate(`${rowFor(secondTitle)}.querySelector('[aria-label="归档会话"]').click()`)
  await dom("document.querySelectorAll('.conversation-row').length === 1", 'archive current switches')
  assert.equal(await evaluate("document.querySelector('.conversation-item[aria-current=page] span').textContent"), '用户手动标题')
  await evaluate("document.querySelector('[role=tab][aria-selected=false]').click()")
  await dom("document.querySelectorAll('.conversation-row').length === 1", 'archive view')
  await evaluate(`document.querySelector('[aria-label="恢复会话"]').click()`)
  await dom("document.querySelectorAll('.conversation-row').length === 2", 'restore conversation')
  await evaluate("document.querySelector('.header-actions .quiet-button').click()")
  await until(() => saved.conversations.every((item) => !item.archived), 'archive state save')

  await window.reload()
  await dom("!document.querySelector('#chat-input').disabled", 'refresh restore')
  assert.equal(await evaluate("document.querySelector('.conversation-item[aria-current=page] span').textContent"), secondTitle)
  assert.equal(await evaluate("document.querySelector('.conversation-row').textContent.includes('用户手动标题')"), true)
  assert.equal(saved.conversations.find((item) => item.id === firstId).pinned, true)
  assert.equal(saved.conversations.every((item) => !item.archived), true)
  await evaluate(`${rowFor(secondTitle)}.querySelector('[aria-label="归档会话"]').click()`)
  await dom("document.querySelector('.conversation-item[aria-current=page] span').textContent === '用户手动标题'", 'archive second switches to first')
  await evaluate(`${rowFor('用户手动标题')}.querySelector('[aria-label="归档会话"]').click()`)
  await dom("!!document.querySelector('.empty-state')", 'archive last session returns to blank workbench')
  console.log('Lesson 35 desktop checks passed: title, rename, search, pin, archive, restore, refresh and busy protection.')
  window.destroy()
  app.exit(0)
}).catch((error) => {
  console.error(error)
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(1)
})
