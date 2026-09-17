// npm run check:workspace：实际 Electron + 正式编译后的 UI/preload + 内存业务替身。
// 不启动正式主进程，不读取密钥或真实会话，不调用模型。
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { mkdirSync, writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')

const root = join(__dirname, '..')
const artifacts = join(root, '.ui-check')
mkdirSync(artifacts, { recursive: true })
app.setPath('userData', join(artifacts, 'electron-profile'))
app.disableHardwareAcceleration()
let window
let saved = null
let pending = null
let saves = 0
let starts = 0
let failSave = false
let failLoad = false
let loadRelease
let maximized = false
let selection = null
let cancelSelection = false
let revocations = 0
let agentStarts = 0
const agentCalls = []
const windowActions = []
const failures = []
const closeDecisions = []
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = (code) => window.webContents.executeJavaScript(code, true)
async function until(predicate, label) {
  for (let attempt = 0; attempt < 350; attempt++) {
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(`Timed out: ${label}`)
}
const dom = (code, label) => until(() => evaluate(code), label || code)
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function input(text) {
  await evaluate(`(() => {
    const element = document.querySelector('#chat-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}
async function screenshot(name) {
  await evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
  await delay(300)
  const image = await window.webContents.capturePage()
  writeFileSync(join(artifacts, name), image.toPNG())
}
function done(status = 'done') {
  const request = pending
  pending = null
  request.resolve(status === 'error' ? { status, error: '模拟网络错误' } : { status })
}
function delta(text, requestId = pending.requestId) {
  window.webContents.send('model-stream:delta', { requestId, delta: text })
}
async function idle() {
  await dom("!document.querySelector('#chat-input').disabled", 'idle composer')
}

ipcMain.handle('window:finish-close', (_event, requestId, allow) => {
  closeDecisions.push({ requestId, allow })
  return true
})

ipcMain.handle('window:state', () => ({ maximized }))
ipcMain.handle('window:command', (_event, action) => {
  windowActions.push(action)
  if (action === 'toggle-maximize') {
    maximized = !maximized
    window.webContents.send('window:state-changed', { maximized })
  }
})
ipcMain.handle('conversation:load', async () => {
  if (loadRelease === undefined)
    await new Promise((resolve) => {
      loadRelease = resolve
    })
  if (failLoad) return { ok: false, error: '模拟损坏文件：原文件未修改。' }
  return {
    ok: true,
    missing: saved === null,
    snapshot: saved || {
      version: 4,
      activeConversationId: 'fixture-conversation',
      conversations: [{ id: 'fixture-conversation', title: '检查会话', messages: [], toolRuns: [] }]
    }
  }
})
ipcMain.handle('conversation:save', async (_event, snapshot) => {
  saves++
  await delay(120)
  if (failSave) return { ok: false, error: '模拟保存失败，请重试。' }
  saved = structuredClone(snapshot)
  return { ok: true }
})
ipcMain.handle('model-stream:start', (_event, requestId, history) => {
  starts++
  assert.equal(pending, null, 'only one model request')
  return new Promise((resolve) => {
    pending = { requestId, history, resolve }
  })
})
ipcMain.handle('model-stream:cancel', (_event, requestId) => {
  if (pending?.requestId === requestId) done('cancelled')
})

// Only synthetic file metadata; no user files or model service are accessed.
ipcMain.handle('project:select', async () => {
  await delay(80)
  if (cancelSelection) return { status: 'cancelled' }
  selection = {
    snapshotId: require('node:crypto').randomUUID(),
    label: '工作台练习项目',
    createdAt: new Date().toISOString(),
    files: Array.from({ length: 8 }, (_, index) => ({
      path: `src/features/example/module-${index + 1}.ts`,
      bytes: 240,
      lines: 10
    }))
  }
  return { status: 'selected', selection }
})
ipcMain.handle('project:remove', (_event, conversationId, snapshotId, path) => {
  assert.equal(conversationId, 'fixture-conversation')
  assert.equal(snapshotId, selection.snapshotId)
  selection = {
    ...selection,
    snapshotId: require('node:crypto').randomUUID(),
    files: selection.files.filter((file) => file.path !== path)
  }
  if (!selection.files.length) {
    selection = null
    return { status: 'cleared' }
  }
  return { status: 'selected', selection }
})
ipcMain.handle('project:revoke', (_event, snapshotId) => {
  assert.equal(snapshotId, selection?.snapshotId)
  selection = null
  revocations++
  return true
})
ipcMain.handle('agent:start', (_event, requestId, prompt, mode, history, context) => {
  agentStarts++
  agentCalls.push({ requestId, prompt, mode, history, context })
  return { status: 'cancelled', trace: [] }
})

async function openAttachments() {
  if (!(await evaluate("document.querySelector('.attachment-popover').matches(':popover-open')")))
    await click('.attachment-add')
  await dom("document.querySelector('.attachment-popover').matches(':popover-open')")
}
async function closeAttachments() {
  if (await evaluate("document.querySelector('.attachment-popover').matches(':popover-open')"))
    await click('button[aria-label="关闭附件菜单"]')
  await dom("!document.querySelector('.attachment-popover').matches(':popover-open')")
}
async function setMode(mode) {
  await openAttachments()
  await evaluate("document.querySelector('.composer-debug').open = true")
  await evaluate(`(() => {
    const select = document.querySelector('.composer-debug select');
    select.value = ${JSON.stringify(mode)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await dom(`document.querySelector('.composer-debug select').value === ${JSON.stringify(mode)}`)
  await evaluate("document.querySelector('.composer-debug').open = false")
  await closeAttachments()
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
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') failures.push(details.message)
    })
    await window.loadFile(join(root, 'out/renderer/index.html'))
    await dom("!!document.querySelector('#chat-input')", 'initial render')
    assert.equal(await evaluate("document.querySelector('#chat-input').disabled"), true)
    assert.equal(await evaluate("document.querySelector('.workspace-button') === null"), true)
    await until(() => !!loadRelease, 'load begins')
    loadRelease()
    await idle()
    assert.equal(await evaluate("document.querySelector('.composer-debug select').value"), 'live')
    assert.equal(await evaluate("document.querySelector('.chat-mode-select') === null"), true)
    await setMode('stream')
    await click('button[aria-label="最小化"]')
    await click('button[aria-label="最大化"]')
    await dom('!!document.querySelector(\'button[aria-label="还原窗口"]\')')
    await click('button[aria-label="还原窗口"]')
    await dom('!!document.querySelector(\'button[aria-label="最大化"]\')')
    await click('button[aria-label="关闭窗口"]')
    await until(() => windowActions.length === 4, 'window actions dispatched')
    assert.deepEqual(windowActions, ['minimize', 'toggle-maximize', 'toggle-maximize', 'close'])
    // 调整 CSS 高度时，控件高度也随之改变；测试结束恢复用户当前配置。
    await evaluate("document.documentElement.style.setProperty('--titlebar-height', '48px')")
    assert.equal(
      await evaluate("document.querySelector('.window-control').getBoundingClientRect().height"),
      47
    )
    await evaluate("document.documentElement.style.removeProperty('--titlebar-height')")
    await delay(900)
    assert.equal(saves, 0, 'startup does not write an empty file')
    const togglePosition = await evaluate(
      "(() => { const r = document.querySelector('.title-bar button').getBoundingClientRect(); return [r.x, r.y] })()"
    )
    assert(togglePosition[0] < 20 && togglePosition[1] < 20)
    await click('button[aria-label="收起侧栏"]')
    await dom("!document.querySelector('.sidebar')")
    assert.deepEqual(
      await evaluate(
        "(() => { const r = document.querySelector('.title-bar button').getBoundingClientRect(); return [r.x, r.y] })()"
      ),
      togglePosition
    )
    await click('button[aria-label="展开侧栏"]')
    await dom("!!document.querySelector('.sidebar')")
    await screenshot('workspace-desktop.png')

    await click('.suggestion-card')
    await dom(
      "document.querySelector('#chat-input').value.includes('代码')",
      'suggestion fills draft'
    )
    assert.equal(starts, 0, 'suggestion does not send')
    await input('请解释 React 中的状态快照。')
    // IME 和 Shift+Enter 都不能提交；普通 Enter 会提交。
    await evaluate(
      "document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))"
    )
    await evaluate(
      "document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, shiftKey: true }))"
    )
    assert.equal(starts, 0)
    await evaluate(
      "document.querySelector('#chat-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))"
    )
    await until(() => !!pending, 'model request')
    assert.equal(starts, 1)
    assert.equal(await evaluate("document.querySelector('#chat-input').value"), '')
    assert.equal(await evaluate("document.querySelector('.workspace-button') === null"), true)
    window.webContents.send('window:close-requested', 'fixture-busy-close')
    await until(() => closeDecisions.length === 1, 'busy close rejected')
    assert.equal(closeDecisions[0].allow, false)
    delta('每一次渲染，都有属于它自己的状态快照。\n\n')
    delta('setState 会安排下一次渲染，但不会改变当前函数已经拿到的变量。')
    delta('这段旧消息不应该出现', 'unrelated-request')
    await dom("document.querySelector('.message-assistant').textContent.includes('下一次渲染')")
    await delay(900)
    assert.equal(saves, 0, 'no write during streaming pauses')
    assert.equal(await evaluate("document.body.textContent.includes('旧消息不应该出现')"), false)
    done()
    await until(() => saved?.conversations[0].messages.length === 2, 'automatic save')
    assert(saved.conversations[0].messages.every((message) => message.status === 'complete'))
    await idle()
    window.webContents.send('window:close-requested', 'fixture-saved-close')
    await until(() => closeDecisions.length === 2, 'saved close allowed')
    assert.equal(closeDecisions[1].allow, true)
    await screenshot('workspace-chat.png')

    await input('这一次我会停止生成。')
    await click('button[aria-label="发送消息"]')
    await until(() => !!pending, 'second turn')
    assert.equal(pending.history.length, 3, 'successful pair is included')
    delta('这是一段尚未完成的回答。')
    await click('button[aria-label="停止生成"]')
    await until(() => saved?.conversations[0].messages.length === 4, 'cancelled turn saved')
    assert.equal(saved.conversations[0].messages[3].status, 'cancelled')
    await idle()

    failSave = true
    await input('检查失败恢复。')
    await click('button[aria-label="发送消息"]')
    await until(() => !!pending, 'third turn')
    assert.equal(pending.history.length, 3, 'cancelled pair excluded')
    done('error')
    await dom(
      "document.querySelector('.save-status').textContent.includes('暂停')",
      'save failure pauses'
    )
    const failedCount = saves
    await delay(1100)
    assert.equal(saves, failedCount, 'no retry loop')
    failSave = false
    await click('.header-actions .quiet-button')
    await until(() => saved?.conversations[0].messages.length === 6, 'manual retry')
    assert.equal(saved.conversations[0].messages[5].status, 'failed')
    await idle()

    await click('button[aria-label="清空对话"]')
    await dom("document.querySelector('dialog[open]') !== null", 'clear confirmation')
    await click('dialog[open] .dialog-actions .quiet-button')
    assert.equal(saved.conversations[0].messages.length, 6, 'cancel clear keeps messages')
    await click('button[aria-label="清空对话"]')
    await click('dialog[open] .danger-button')
    await until(() => saved.conversations[0].messages.length === 0, 'clear saved')
    assert.equal(saved.version, 4)
    assert.equal(saved.activeConversationId, 'fixture-conversation')
    await idle()

    await click('button[aria-label="收起侧栏"]')
    await dom("!document.querySelector('.sidebar')")
    window.setContentSize(680, 560)
    await delay(100)
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    assert.equal(
      await evaluate(
        "document.querySelector('.composer').getBoundingClientRect().bottom <= innerHeight"
      ),
      true
    )
    await screenshot('workspace-narrow.png')
    await click('button[aria-label="展开侧栏"]')
    await dom("getComputedStyle(document.querySelector('.sidebar-backdrop')).display !== 'none'")
    await click('.sidebar-backdrop')
    await dom("!document.querySelector('.sidebar')")

    // Unified composer: popovers never participate in document layout.
    window.setContentSize(1280, 840)
    await setMode('live')
    const bounds = () =>
      evaluate(
        "JSON.stringify(['.chat-scroll-area', '.composer'].map(s => {const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}))"
      )
    const before = await bounds()
    await openAttachments()
    assert.equal(await bounds(), before, 'opening attachments does not move chat or composer')
    assert.equal(
      await evaluate(`(() => {
      const menu = document.querySelector('.attachment-popover').getBoundingClientRect();
      const box = document.querySelector('.composer').getBoundingClientRect();
      return Math.abs(menu.width - box.width) < 1 && Math.abs(menu.left - box.left) < 1 && Math.abs(box.top - menu.bottom - 8) < 1;
    })()`),
      true,
      'menu aligns with the full composer width and top edge'
    )
    await screenshot('composer-menu-desktop.png')
    const outside = await evaluate(
      "(() => {const r=document.querySelector('.chat-header').getBoundingClientRect();return {x:Math.round(r.x+80),y:Math.round(r.y+20)}})()"
    )
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...outside
    })
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...outside
    })
    await dom("!document.querySelector('.attachment-popover').matches(':popover-open')")
    assert.equal(await bounds(), before)
    await openAttachments()
    await click('.attachment-picker')
    await dom("document.querySelectorAll('.attachment-card').length === 8")
    await input('请解释选中的文件。')
    assert.equal(
      await evaluate("document.querySelector('.composer input[type=checkbox]') === null"),
      true
    )
    await openAttachments()
    await screenshot('composer-attachments-desktop.png')
    // Native Escape dismisses and restores focus without changing sidebar state.
    await evaluate("document.querySelector('.attachment-picker').focus()")
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await dom("!document.querySelector('.attachment-popover').matches(':popover-open')")
    window.setContentSize(680, 560)
    await delay(100)
    const hasTerminal = await evaluate("!!document.querySelector('.terminal-launcher button')")
    if (hasTerminal) {
      await click('.terminal-launcher button')
      await dom("!!document.querySelector('.terminal-host .xterm')")
    }
    const narrowBefore = await bounds()
    await openAttachments()
    assert.equal(await bounds(), narrowBefore)
    assert.equal(
      await evaluate(`(() => {
      const r = document.querySelector('.attachment-popover').getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    })()`),
      true,
      'popover stays inside viewport'
    )
    await screenshot(
      hasTerminal ? 'composer-popover-narrow-terminal.png' : 'composer-popover-narrow.png'
    )
    await closeAttachments()
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
    assert.equal(
      await evaluate("document.querySelector('.chat-scroll-area').clientHeight > 0"),
      true
    )
    assert.equal(
      await evaluate(`(() => {
      const cards = document.querySelector('.attachment-cards').getBoundingClientRect();
      const input = document.querySelector('#chat-input').getBoundingClientRect();
      const box = document.querySelector('.composer').getBoundingClientRect();
      return cards.top >= box.top && cards.bottom <= input.top && cards.right <= box.right;
    })()`),
      true,
      'attachment cards live above the textarea inside the composer'
    )
    await screenshot(hasTerminal ? 'composer-narrow-terminal.png' : 'composer-narrow.png')
    if (hasTerminal) {
      await evaluate(
        "[...document.querySelectorAll('.terminal-toolbar button')].find(b => b.textContent.includes('关闭')).click()"
      )
    }
    await dom("!document.querySelector('.terminal-panel')")
    await click('button[aria-label="发送消息"]')
    await until(() => agentStarts === 1, 'authorized attachment request')
    await idle()
    assert.equal(agentCalls[0].mode, 'live')
    assert.equal(agentCalls[0].context.snapshotId, selection.snapshotId)
    assert.equal(agentCalls[0].context.allowUpload, true)
    assert.equal(agentCalls[0].context.conversationId, 'fixture-conversation')
    await dom("document.querySelectorAll('.attachment-card').length === 0")
    assert(selection, 'sending clears the composer without revoking the request snapshot')
    cancelSelection = true
    await openAttachments()
    assert.equal(
      await evaluate(
        "document.querySelector('.attachment-popover').textContent.includes('清除会话文件')"
      ),
      true,
      'sent files remain visible and revocable through the menu'
    )
    await click('.attachment-picker')
    await idle()
    await dom("document.querySelectorAll('.attachment-card').length === 0")
    cancelSelection = false
    await openAttachments()
    await click('.attachment-picker')
    await dom("document.querySelectorAll('.attachment-card').length === 8")
    cancelSelection = true
    await openAttachments()
    await click('.attachment-picker')
    await idle()
    await dom("document.querySelectorAll('.attachment-card').length === 8")
    cancelSelection = false
    await openAttachments()
    await closeAttachments()
    await click('.attachment-remove')
    await dom("document.querySelectorAll('.attachment-card').length === 7")
    assert.equal(
      await evaluate("document.querySelector('.composer input[type=checkbox]') === null"),
      true
    )
    await openAttachments()
    await click('.attachment-picker')
    await dom("document.querySelectorAll('.attachment-card').length === 8")
    await setMode('mock')
    assert.equal(selection !== null, true)
    await input('模拟附件请求')
    await click('button[aria-label="发送消息"]')
    await until(() => agentStarts === 2, 'mock attachment request')
    await idle()
    assert.equal(agentCalls[1].mode, 'mock')
    assert.equal(agentCalls[1].context.allowUpload, false)
    await dom("document.querySelectorAll('.attachment-card').length === 0")
    assert.deepEqual(agentCalls[1].history, [], 'cancelled turn is not reused')
    await setMode('stream')
    assert.equal(selection, null, 'stream debug revokes attachment grants')
    assert.equal(revocations, 1)
    await dom("document.querySelector('.attachment-cards') === null")
    await setMode('live')
    await input('你好')
    await click('button[aria-label="发送消息"]')
    await until(() => agentStarts === 3, 'unified chat without files')
    await idle()
    assert.deepEqual(agentCalls[2].context, { kind: 'time' })
    assert.equal(agentCalls[2].mode, 'live')

    // 刷新后只从内存替身恢复已保存记录；损坏加载时禁止任何写入。
    failLoad = true
    const beforeLoadFailure = saves
    await window.loadFile(join(root, 'out/renderer/index.html'))
    await dom("document.querySelector('.error-banner')?.textContent.includes('损坏文件')")
    assert.equal(await evaluate("document.querySelector('#chat-input').disabled"), true)
    await delay(900)
    assert.equal(saves, beforeLoadFailure)
    assert.deepEqual(failures, [])
    writeFileSync(
      join(artifacts, 'result.json'),
      JSON.stringify(
        {
          passed: true,
          saves,
          starts,
          cases: [
            'production preload bridge',
            'busy and saved close decisions',
            'version 4 library save',
            'loading guards',
            'startup no write',
            'suggestions',
            'IME and keyboard',
            'stream identity',
            'no pending autosave',
            'completion',
            'cancel',
            'context filtering',
            'failure pause and retry',
            'fixed titlebar sidebar toggle',
            'custom window commands and height',
            'clear confirmation',
            'responsive layout',
            'adding attachments authorizes the next real request without a checkbox',
            'attachment cancellation preserves selection and removal updates scope',
            'project request mode, ownership and cancelled history',
            'popover layout stability, Escape and narrow terminal layout',
            'load failure protection'
          ]
        },
        null,
        2
      )
    )
    console.log('Workspace checks passed. Screenshots: .ui-check/')
    window.destroy()
    app.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    if (failures.length) console.error(failures)
    if (window && !window.isDestroyed()) await screenshot('failure.png').catch(() => undefined)
    app.exit(1)
  })
