// Isolated actual Electron workbench acceptance. Build/package first; no model requests.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

assert(process.argv.includes('--run'), 'Build the current app before running with --run')
assert(process.argv.every((value, index) => index < 2 || ['--run', '--packaged'].includes(value)))
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const packaged = process.argv.includes('--packaged')
const stage = packaged ? 'packaged' : 'development'
const evidence = path.join(root, '.ui-check/workbench-ui', stage + '-' + randomUUID())
const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zc-panel-')))
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const require = createRequire(import.meta.url)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const report = {
  pass: false,
  stage,
  packaged,
  evidence,
  userData,
  actualElectron: true,
  actualDiskStorage: true,
  actualUIInput:
    'Trusted CDP mouse/key/text input for the app; guest page fixture actions use executeJavaScript with a user gesture. Shell writes are real IPC commands, observed separately by session ID. Responsive dimensions are explicitly emulated. Main inspector supplies isolated userData, cancels the directory chooser, observes IPC, and closes only this owned app.',
  syntheticData:
    'Two self-authored conversation records, one sample skill header, and a local HTTP fixture. Files, native browser guests, storage and two shells are real. No model is invoked.',
  modelNetwork:
    'Main fetch is blocked/counted before app initialization; zero model submission or external URL opening is allowed.',
  checks: [],
  failures: [],
  processes: [],
  screenshots: [],
  notCovered: [
    'No model, external websites, native chooser, clipboard or IME acceptance. Guest DOM actions explicitly use executeJavaScript with a user gesture; the tab reorder uses a synthetic DataTransfer. No pixel equality claim against upstream Codex.'
  ]
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail })
const primaryId = randomUUID(),
  alternateId = randomUUID()
const primaryTitle = '合成验证 · 初始空对话'
const alternateTitle = '合成验证 · 已有对话'
const message = (id, role, content) => ({ id, role, content, status: 'complete', mode: 'execute' })
const fixtureConversation = (id, title, messages) => ({
  id,
  title,
  pinned: false,
  archived: false,
  defaultDirectory: path.join(userData, 'chats', id, 'workspace'),
  agentMode: 'execute',
  messages,
  toolRuns: [],
  workspace: null,
  tasks: []
})
const initialSnapshot = {
  version: 9,
  activeConversationId: primaryId,
  conversations: [
    fixtureConversation(primaryId, primaryTitle, []),
    fixtureConversation(alternateId, alternateTitle, [
      message('existing-user', 'user', '自编写的已有消息'),
      message('existing-assistant', 'assistant', '这是隔离的界面验收记录。')
    ])
  ]
}
await fs.mkdir(userData, { recursive: true })
await fs.mkdir(evidence, { recursive: true })
for (const item of initialSnapshot.conversations)
  await fs.mkdir(item.defaultDirectory, { recursive: true })
await fs.writeFile(
  path.join(userData, 'conversation.json'),
  JSON.stringify(initialSnapshot, null, 2)
)
await fs.writeFile(
  path.join(evidence, 'synthetic-initial-library.json'),
  JSON.stringify(initialSnapshot, null, 2)
)
await fs.mkdir(path.join(userData, 'skills', 'sample-ui-skill'), { recursive: true })
await fs.writeFile(
  path.join(userData, 'skills', 'sample-ui-skill', 'SKILL.md'),
  '---\nname: sample-ui-skill\ndescription: 自编写的界面验收技能，仅展示元数据。\n---\n# UI sample\nDo not send any messages.\n'
)

async function artifactIdentity() {
  const names = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
  if (packaged)
    names.push('dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar')
  const identities = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  if (packaged)
    for (const name of names.slice(0, 3)) {
      const embedded = hash(
        require('@electron/asar').extractFile(
          path.join(root, 'dist/win-unpacked/resources/app.asar'),
          path.normalize(name)
        )
      )
      assert.equal(
        embedded,
        identities[name],
        'The packaged entry matches the current build: ' + name
      )
    }
  return identities
}
report.artifactBefore = await artifactIdentity()
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function connect(url) {
  const socket = new WebSocket(url),
    pending = new Map(),
    events = []
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let serial = 0
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data)
    if (!value.id) {
      events.push(value)
      return
    }
    const target = pending.get(value.id)
    if (!target) return
    pending.delete(value.id)
    clearTimeout(target.timer)
    value.error ? target.reject(Error(JSON.stringify(value.error))) : target.resolve(value.result)
  })
  return {
    socket,
    events,
    cdp: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++serial
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error('Bounded inspector request: ' + method))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
function installIsolation(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://new-chat-ui-fixture.invalid/responses'
  process.env.MODEL_NAME = 'new-chat-ui-no-model'
  process.env.MODEL_API_KEY = 'synthetic-never-sent'
  const audit = {
    modelFetchAttempts: 0,
    ipc: [],
    pid: process.pid,
    external: [],
    pickerCancellations: []
  }
  globalThis.fetch = async () => {
    audit.modelFetchAttempts++
    throw Error('Model network blocked for new-chat UI acceptance')
  }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      audit.ipc.push({
        channel,
        at: Date.now(),
        context: channel === 'terminal:start' ? args[2] : undefined,
        ...(channel.startsWith('terminal:') ? { sessionId: args[0] } : {})
      })
      return listener(event, ...args)
    })
  shell.openExternal = async (url) => {
    audit.external.push(url)
    throw Error('No external URL opening in new-chat UI acceptance')
  }
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1)
    audit.pickerCancellations.push({ properties: options?.properties, at: Date.now() })
    return { canceled: true, filePaths: [] }
  }
  audit.popups = []
  audit.loading = []
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('did-attach-webview', (_e, g) => {
      const setter = g.setWindowOpenHandler.bind(g)
      g.setWindowOpenHandler = (fn) =>
        setter((d) => {
          audit.popups.push(d)
          return fn(d)
        })
    })
    w.webContents.on('did-start-loading', () =>
      audit.loading.push({ kind: 'load', at: Date.now() })
    )
    w.webContents.on('did-start-navigation', (_e, url, inPlace, mainFrame) =>
      audit.loading.push({ kind: 'navigation', url, inPlace, mainFrame, at: Date.now() })
    )
  })
  globalThis.__workbenchUIAcceptance = { audit, app, BrowserWindow }
  return true
}
// Exercise the exact imperative compatibility entry used by chat/source file links.
function openFixtureReference(reference, source) {
  const element = document.querySelector('.workbench-workspace')
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  for (let fiber = element[key]; fiber; fiber = fiber.return) {
    if (typeof fiber.ref?.current?.openFile === 'function') {
      fiber.ref.current.openFile(reference, { messageId: 'fixture-reference', source }, element)
      return true
    }
  }
  throw Error('Workbench file-link compatibility handle missing')
}
async function launch(action) {
  const mainPort = await freePort(),
    rendererPort = await freePort()
  const env = {
    ...process.env,
    APPDATA: path.join(evidence, 'appdata'),
    LOCALAPPDATA: path.join(evidence, 'localappdata')
  }
  for (const name of Object.keys(env))
    if (/^(MODEL_|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|NODE_OPTIONS$)/i.test(name))
      delete env[name]
  await fs.mkdir(env.APPDATA, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  const log = await fs.open(path.join(evidence, 'electron.log'), 'w')
  const args = [
    ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
    '--user-data-dir=' + userData,
    '--inspect-brk=127.0.0.1:' + mainPort,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + rendererPort,
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--in-process-gpu'
  ]
  const child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd]
  })
  const ownedProcess = { stage, pid: child.pid, args, exitCode: null, forcedKill: false }
  report.processes.push(ownedProcess)
  console.log(JSON.stringify({ stage, pid: child.pid, evidence }))
  let main, renderer
  const until = async (observe, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (child.exitCode !== null) throw Error('Owned Electron exited during ' + label)
      const value = await observe()
      if (value) return value
      await delay(80)
    }
    throw Error('Observation timeout: ' + label)
  }
  try {
    const target = await until(async () => {
      try {
        return (await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0]
      } catch {
        return null
      }
    }, 'main inspector')
    main = await connect(target.webSocketDebuggerUrl)
    await main.cdp('Runtime.enable')
    await main.cdp('Debugger.enable')
    await main.cdp('Runtime.runIfWaitingForDebugger')
    await until(
      () => main.events.some((event) => event.method === 'Debugger.paused'),
      'entry pause'
    )
    const injected = await main.cdp('Runtime.evaluate', {
      expression:
        '(' + installIsolation.toString() + ')(' + JSON.stringify({ root, userData }) + ')',
      returnByValue: true
    })
    assert.equal(
      injected.exceptionDetails,
      undefined,
      injected.exceptionDetails?.exception?.description
    )
    assert.equal(injected.result.value, true)
    await main.cdp('Debugger.resume')
    await main.cdp('Debugger.disable')
    const page = await until(async () => {
      try {
        return (await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()).find(
          (item) => item.type === 'page' && item.url.includes('renderer')
        )
      } catch {
        return null
      }
    }, 'renderer')
    renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await renderer.cdp('Network.enable')
    const evaluate = async (expression) => {
      const value = await renderer.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (value.exceptionDetails)
        throw Error(value.exceptionDetails.exception?.description || 'Renderer evaluation failed')
      return value.result.value
    }
    const observeMain = async (expression) => {
      const value = await main.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (value.exceptionDetails)
        throw Error(value.exceptionDetails.exception?.description || 'Main observation failed')
      return value.result.value
    }
    const clickExpression = async (expression, label) => {
      const position = await evaluate(
        '(()=>{const n=' +
          expression +
          ';if(!n||n.disabled)throw Error("Missing or disabled target: "+' +
          JSON.stringify(label) +
          ');n.scrollIntoView({block:"nearest",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);if(!h||!(h===n||n.contains(h)))throw Error("Blocked click: "+' +
          JSON.stringify(label) +
          ');return{x,y}})()'
      )
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...position,
        button: 'left',
        clickCount: 1
      })
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...position,
        button: 'left',
        clickCount: 1
      })
      await delay(100)
    }
    const click = (selector) =>
      clickExpression('document.querySelector(' + JSON.stringify(selector) + ')', selector)
    const clickText = (selector, text) =>
      clickExpression(
        'Array.from(document.querySelectorAll(' +
          JSON.stringify(selector) +
          ')).find(n=>n.innerText.trim()===' +
          JSON.stringify(text) +
          '&&n.getClientRects().length&&!n.closest("[hidden]"))',
        text
      )
    const key = async (value, code = value, modifiers = 0) => {
      const vk =
        value === 'Enter'
          ? 13
          : value === 'Escape'
            ? 27
            : value === 'Backspace'
              ? 8
              : /^[a-z]$/i.test(value)
                ? value.toUpperCase().charCodeAt(0)
                : undefined
      const extra = vk ? { windowsVirtualKeyCode: vk } : {}
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: value,
        code,
        modifiers,
        ...extra,
        ...(value === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {})
      })
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: value,
        code,
        modifiers,
        ...extra
      })
      await delay(50)
    }
    const fill = async (text) => {
      await click('#chat-input')
      await key('a', 'KeyA', 2)
      await key('Backspace')
      if (text) await renderer.cdp('Input.insertText', { text })
      await delay(100)
    }
    const screenshot = async (name) => {
      const shot = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
      const output = path.join(evidence, name + '.png')
      await fs.writeFile(output, Buffer.from(shot.data, 'base64'))
      report.screenshots.push(output)
    }
    const viewport = async (width, height) => {
      await renderer.cdp('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await until(
        () => evaluate('innerWidth===' + width + '&&innerHeight===' + height),
        'responsive viewport'
      )
      await delay(400)
    }
    const idle = () =>
      until(
        () =>
          evaluate(
            '!!document.querySelector("#chat-input")&&!document.querySelector("#chat-input").disabled&&!document.querySelector(".conversation-create").disabled'
          ),
        'navigation and input ready'
      )
    await idle()
    await action({
      evaluate,
      observeMain,
      until,
      click,
      clickText,
      key,
      fill,
      screenshot,
      viewport,
      idle,
      renderer
    })
    const audit = await observeMain('globalThis.__workbenchUIAcceptance.audit')
    assert.equal(audit.modelFetchAttempts, 0)
    assert.equal(audit.external.length, 0)
    assert.equal(
      audit.ipc.some((item) =>
        ['agent:start', 'agent:resume', 'conversation-title:start'].includes(item.channel)
      ),
      false
    )
    const network = renderer.events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => event.params.request.url)
      .filter((url) => /^https?:/i.test(url))
    assert(
      network.every((url) => url.startsWith('http://127.0.0.1:')),
      'Only local fixture website traffic'
    )
    report.rendererExternalRequests = network
    await fs.writeFile(
      path.join(evidence, 'application-audit.json'),
      JSON.stringify(audit, null, 2)
    )
    check('Every action remains zero model requests and external network operations', {
      modelFetchAttempts: audit.modelFetchAttempts
    })
  } catch (error) {
    if (renderer)
      try {
        const shot = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
        await fs.writeFile(path.join(evidence, 'failed.png'), Buffer.from(shot.data, 'base64'))
        const snapshot = await renderer.cdp('Runtime.evaluate', {
          expression: 'document.body.innerText',
          returnByValue: true
        })
        await fs.writeFile(path.join(evidence, 'failed-dom.txt'), snapshot.result.value || '')
      } catch {
        /* Preserve the primary assertion. */
      }
    throw error
  } finally {
    if (main && child.exitCode === null)
      try {
        const observed = await main.cdp('Runtime.evaluate', {
          expression: 'globalThis.__workbenchUIAcceptance.audit',
          returnByValue: true
        })
        if (observed.result?.value)
          await fs.writeFile(
            path.join(evidence, 'application-audit.json'),
            JSON.stringify(observed.result.value, null, 2)
          )
        await main.cdp('Runtime.evaluate', {
          expression:
            'setImmediate(()=>{for(const w of globalThis.__workbenchUIAcceptance.BrowserWindow.getAllWindows())w.destroy();globalThis.__workbenchUIAcceptance.app.quit()});true',
          returnByValue: true
        })
      } catch {
        /* The owned app may already have closed. */
      }
    main?.socket.close()
    renderer?.socket.close()
    if (child.exitCode === null)
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(15000)])
    if (child.exitCode === null) {
      ownedProcess.forcedKill = true
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    }
    ownedProcess.exitCode = child.exitCode
    await log.close()
  }
  assert.equal(
    ownedProcess.forcedKill,
    false,
    'Owned app cleans up without forced process termination'
  )
  assert.equal(ownedProcess.exitCode, 0)
}

const website = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(
    `<title>${req.url === '/two' ? '第二页' : '本地测试网页'}</title><h1>Workbench fixture</h1><input id="retained"><a href="/two">Next</a><a href="/popup" target="_blank">Popup</a>`
  )
})
await new Promise((resolve) => website.listen(0, '127.0.0.1', resolve))
const websiteURL = 'http://127.0.0.1:' + website.address().port
const file = path.join(initialSnapshot.conversations[0].defaultDirectory, 'sample.ts')
await fs.writeFile(file, '\uFEFFconst original = 1;\r\n')
try {
  await launch(
    async ({
      evaluate,
      observeMain,
      until,
      click,
      clickText,
      key,
      fill,
      screenshot,
      viewport,
      renderer
    }) => {
      await viewport(1400, 900)
      await fill('聊天草稿保持不变')
      await evaluate('window.__originalChatInput=document.querySelector("#chat-input");true')
      await click('.panel-launcher')
      await until(() => evaluate('!!document.querySelector(".panel-new-page")'), 'new tools page')
      assert(
        await evaluate(
          'document.querySelector(".workbench-workspace").classList.contains("layout-split")'
        )
      )
      await screenshot('01-split-tools')
      const topControls = await evaluate(
        '(()=>{const a=document.querySelector(".panel-launcher"),b=document.querySelector(".thread-summary-toggle");if(!a||!b||!a.getClientRects().length||!b.getClientRects().length)return null;const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return{x:x.toJSON(),y:y.toJSON(),overlap:x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top}})()'
      )
      if (topControls) assert.equal(topControls.overlap, false)
      check('Workbench launcher and chat summary controls have separate hit areas', { topControls })
      await click('[aria-label="完整视图"]')
      assert(
        await evaluate(
          'document.querySelector(".workbench-workspace").classList.contains("layout-full")'
        )
      )
      await screenshot('02-full-tools')
      await click('[data-tab-id="chat"]')
      assert.equal(
        await evaluate(
          'document.querySelector("#chat-input")===window.__originalChatInput&&document.querySelector("#chat-input").value'
        ),
        '聊天草稿保持不变'
      )
      await clickText('.conversation-item', alternateTitle)
      await until(
        () =>
          evaluate(
            'Boolean(document.querySelector(".panel-launcher")?.getClientRects().length&&document.querySelector(".thread-summary-toggle")?.getClientRects().length)'
          ),
        'aligned chat toolbar actions'
      )
      const alignedTopControls = await evaluate(
        '(()=>{const a=document.querySelector(".panel-launcher"),b=document.querySelector(".thread-summary-toggle");if(!a||!b)throw Error("Missing aligned chat toolbar actions");const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return{x:x.toJSON(),y:y.toJSON(),widthEqual:Math.abs(x.width-y.width)<0.1,heightEqual:Math.abs(x.height-y.height)<0.1,topAligned:Math.abs(x.top-y.top)<0.1,gap:Math.round((y.left-x.right)*100)/100,rightInset:Math.round((document.querySelector(".thread-toolbar").getBoundingClientRect().right-y.right)*100)/100}})()'
      )
      assert.equal(alignedTopControls.widthEqual, true)
      assert.equal(alignedTopControls.heightEqual, true)
      assert.equal(alignedTopControls.topAligned, true)
      assert.equal(alignedTopControls.gap, 8)
      assert.equal(alignedTopControls.rightInset, 8)
      check('Summary and new-tab controls share the Codex toolbar geometry', {
        topControls: alignedTopControls
      })
      await screenshot('04-aligned-toolbar')
      await clickText('.conversation-item', primaryTitle)
      await until(
        () => evaluate('Boolean(document.querySelector(".panel-tab:not([data-tab-id=chat])"))'),
        'primary workbench tab after toolbar check'
      )
      await click('.panel-tab:not([data-tab-id="chat"])')
      await click('[aria-label="左右分屏"]')
      await viewport(700, 800)
      assert(
        await evaluate(
          'document.querySelector(".workbench-workspace").classList.contains("layout-full")'
        )
      )
      await screenshot('03-narrow-full')
      await viewport(1400, 900)
      assert(
        await evaluate(
          'document.querySelector(".workbench-workspace").classList.contains("layout-split")'
        )
      )
      check('Chat/split/full and responsive fallback preserve a single input and its draft')
      const divider = await evaluate(
        '(()=>{const r=document.querySelector(".panel-splitter").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+100}})()'
      )
      const beforeWidth = await evaluate(
        'document.querySelector("[aria-label=工作面板]").getBoundingClientRect().width'
      )
      report.divider = { beforeWidth, ...divider }
      await renderer.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...divider })
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...divider,
        button: 'left',
        clickCount: 1
      })
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: divider.x - 55,
        y: divider.y,
        button: 'left',
        buttons: 1
      })
      await delay(150)
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: divider.x - 55,
        y: divider.y,
        button: 'left',
        clickCount: 1
      })
      report.divider.afterWidth = await evaluate(
        'document.querySelector("[aria-label=工作面板]").getBoundingClientRect().width'
      )
      await until(
        async () =>
          (await evaluate(
            'document.querySelector("[aria-label=工作面板]").getBoundingClientRect().width'
          )) >
          beforeWidth + 30,
        'divider resize'
      )
      const firstTab = await evaluate('document.querySelector(".panel-tab").dataset.tabId')
      async function newToolsTab() {
        if (await evaluate('!!document.querySelector(".panel-tabs-header")'))
          await click('.panel-tabs-header [aria-label="新建标签页"]')
        else await click('.panel-launcher')
      }
      await newToolsTab()
      await newToolsTab()
      async function contextMenu(tabId) {
        const point = await evaluate(
          '(()=>{const r=document.querySelector(' +
            JSON.stringify('[data-tab-id="' + tabId + '"]') +
            ').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()'
        )
        await renderer.cdp('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...point,
          button: 'right',
          clickCount: 1
        })
        await renderer.cdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button: 'right',
          clickCount: 1
        })
        await until(
          () => evaluate('!!document.querySelector(".panel-context-menu")'),
          'tab context menu'
        )
      }
      const secondTab = await evaluate('document.querySelectorAll(".panel-tab")[1].dataset.tabId')
      await contextMenu(secondTab)
      await clickText('.panel-context-menu button', '关闭右侧标签页')
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===2'),
        'close right tabs'
      )
      await contextMenu(firstTab)
      await clickText('.panel-context-menu button', '关闭其他标签页')
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===1'),
        'close other tabs'
      )
      await newToolsTab()
      await click('.panel-tab[aria-selected=true]')
      await key('Home', 'Home')
      assert.equal(await evaluate('document.activeElement.dataset.tabId'), firstTab)
      await key('End', 'End')
      await key('Delete', 'Delete')
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===1'),
        'delete tab keyboard'
      )
      check(
        'Divider pointer resize, context close-right/close-other and Home/End/Delete tab controls'
      )
      await clickText('.panel-tool-grid button', '改动')
      await until(
        () =>
          evaluate(
            '!!document.querySelector(' +
              JSON.stringify('.panel-page:not([hidden]) [aria-label="Git 改动查看"]') +
              ')'
          ),
        'existing Git workbench host'
      )
      await screenshot('10-git-workbench')
      await key('w', 'KeyW', 2)
      await newToolsTab()
      await evaluate(
        '(()=>{const e=document.querySelector(".workbench-workspace"),k=Object.keys(e).find(n=>n.startsWith("__reactFiber$"));for(let f=e[k];f;f=f.return){if(typeof f.ref?.current?.openSources==="function"){f.ref.current.openSources();return true}}throw Error("Missing sources compatibility entry")})()'
      )
      await until(
        () => evaluate('!!document.querySelector(".panel-page:not([hidden]) .panel-source-list")'),
        'real sources host'
      )
      assert.equal(
        await evaluate(
          'document.querySelector(".panel-page:not([hidden]) .panel-source-list").textContent'
        ),
        '当前会话还没有来源。'
      )
      await screenshot('11-sources')
      await key('w', 'KeyW', 2)
      await newToolsTab()
      check('Existing Git workbench and real empty sources list open within unified content hosts')
      await clickText('.panel-tool-grid button', '文件')
      await until(
        () =>
          evaluate(
            '!![...document.querySelectorAll(".panel-files-list button")].find(n=>n.textContent.includes("sample.ts"))'
          ),
        'real directory listing'
      )
      await clickText('.panel-files-list button', 'sample.ts')
      await until(
        () =>
          evaluate(
            '!!document.querySelector(".panel-page:not([hidden]) .cm-content[contenteditable=true]")'
          ),
        'editable file'
      )
      const editor = '.panel-page:not([hidden]) .cm-content'
      await click(editor)
      await key('a', 'KeyA', 2)
      await renderer.cdp('Input.insertText', { text: 'const saved = 2;\n'.replace('\\n', '\n') })
      await until(() => evaluate('!!document.querySelector(".panel-dirty-dot")'), 'dirty file')
      await key('s', 'KeyS', 2)
      await until(
        async () => (await fs.readFile(file, 'utf8')).includes('saved = 2'),
        'manual disk save'
      )
      await until(
        () => evaluate('!document.querySelector(".panel-dirty-dot")'),
        'saved marker cleared'
      )
      await screenshot('04-file-editor')
      check('Real UTF-8 file edits save only on Ctrl+S')
      await key('w', 'KeyW', 2)
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===1'),
        'close saved file'
      )
      await key('t', 'KeyT', 10)
      await until(
        () =>
          evaluate(
            'document.querySelectorAll(".panel-tab").length===2&&!!document.querySelector(".panel-page:not([hidden]) .cm-content[contenteditable=true]")'
          ),
        'reopen selected file'
      )
      await key('PageUp', 'PageUp', 2)
      assert.equal(
        await evaluate('document.querySelector(".panel-tab[aria-selected=true]").title'),
        '文件'
      )
      await key('PageDown', 'PageDown', 2)
      assert.equal(
        await evaluate('document.querySelector(".panel-tab[aria-selected=true]").title'),
        'sample.ts'
      )
      await key('1', 'Digit1', 1)
      assert.equal(
        await evaluate('document.querySelector(".panel-tab[aria-selected=true]").title'),
        '文件'
      )
      await key('9', 'Digit9', 1)
      assert.equal(
        await evaluate('document.querySelector(".panel-tab[aria-selected=true]").title'),
        'sample.ts'
      )
      await evaluate(
        '(()=>{const nodes=[...document.querySelectorAll(".panel-tab-container")],data=new DataTransfer();data.setData("application/zonecodex-tab",nodes[1].querySelector("[data-tab-id]").dataset.tabId);nodes[0].dispatchEvent(new DragEvent("drop",{dataTransfer:data,bubbles:true,cancelable:true}));return true})()'
      )
      assert.equal(await evaluate('document.querySelector(".panel-tab").title'), 'sample.ts')
      check(
        'Ctrl+W, reopen, PageUp/PageDown, Alt slots and reorder; drag drop uses synthetic DOM DataTransfer'
      )
      await click(editor)
      await renderer.cdp('Input.insertText', { text: '// local draft' })
      await fs.writeFile(file, 'const external = 3;\r\n'.replace(/\\r\\n/g, '\r\n'))
      await key('s', 'KeyS', 2)
      await until(
        () => evaluate('!!document.querySelector(".panel-conflict")'),
        'external modification conflict'
      )
      assert((await fs.readFile(file, 'utf8')).includes('external = 3'))
      await clickText('.panel-conflict button', '比较版本')
      await until(() => evaluate('!!document.querySelector(".panel-compare")'), 'compare versions')
      await screenshot('05-external-conflict')
      await clickText('.panel-compare button', '关闭比较')
      await key('w', 'KeyW', 2)
      await until(
        () => evaluate('!!document.querySelector("dialog[open]")'),
        'unsaved close prompt'
      )
      await clickText('dialog button', '取消')
      assert(await evaluate('!!document.querySelector(".panel-dirty-dot")'))
      check(
        'External modifications are not overwritten; comparison and canceled close retain draft'
      )
      await key('t', 'KeyT', 2)
      await until(
        () => evaluate('!!document.querySelector(".panel-page:not([hidden]) .panel-browser")'),
        'browser tab'
      )
      await click('.panel-page:not([hidden]) [aria-label="搜索或输入网址"]')
      await renderer.cdp('Input.insertText', { text: websiteURL })
      await key('Enter')
      let guestExpression = `process.getBuiltinModule('module').createRequire(${JSON.stringify(root + '/package.json')})('electron').webContents.getAllWebContents().find(w=>w.getType()==='webview'&&w.getURL().startsWith(${JSON.stringify(websiteURL)}))`
      const guestEval = (expression) =>
        observeMain(
          '(' + guestExpression + ').executeJavaScript(' + JSON.stringify(expression) + ',true)'
        )
      await until(() => observeMain('Boolean(' + guestExpression + ')'), 'actual browser guest')
      const guestId = await observeMain('(' + guestExpression + ').id')
      guestExpression = `process.getBuiltinModule('module').createRequire(${JSON.stringify(root + '/package.json')})('electron').webContents.fromId(${guestId})`
      await until(
        () => guestEval('Boolean(document.querySelector("#retained"))'),
        'loaded local site'
      )
      const isolation = await guestEval(
        '({api:typeof window.api,require:typeof require,process:typeof process})'
      )
      assert.deepEqual(isolation, { api: 'undefined', require: 'undefined', process: 'undefined' })
      await guestEval('document.querySelector("#retained").value="retained state";true')
      await screenshot('06-native-browser')
      await key('t', 'KeyT', 2)
      await key('w', 'KeyW', 2)
      assert.equal(await guestEval('document.querySelector("#retained").value'), 'retained state')
      await guestEval('document.querySelector("a").click();true')
      await until(
        () => observeMain('(' + guestExpression + ')?.getURL().endsWith("/two")'),
        'browser navigation'
      )
      report.browserHistoryBeforeBack = await observeMain(
        '(' +
          guestExpression +
          ').navigationHistory.getAllEntries().map(e=>({url:e.url,title:e.title}))'
      )
      await click('.panel-page:not([hidden]) [aria-label="后退"]')
      report.browserAfterBack = await observeMain(
        '({url:(' +
          guestExpression +
          ').getURL(), index:(' +
          guestExpression +
          ').navigationHistory.getActiveIndex()})'
      )
      await until(
        () =>
          observeMain('(' + guestExpression + ')?.getURL()===' + JSON.stringify(websiteURL + '/')),
        'browser back'
      )
      report.popupPreferences = await observeMain(
        '(' + guestExpression + ').getLastWebPreferences()'
      )
      report.popupAttributes = await evaluate(
        'document.querySelector(".panel-page:not([hidden]) webview").outerHTML'
      )
      report.popupResult = await guestEval('Boolean(window.open("/popup","_blank"))')
      await delay(300)
      report.popupObserved = await evaluate(
        '[...document.querySelectorAll(".panel-tab")].map(n=>({title:n.title,id:n.dataset.tabId}))'
      )
      await until(() => evaluate('document.querySelectorAll(".panel-tab").length===4'), 'popup tab')
      check('Native webview isolation, navigation, retained page instance and popup routing')
      await observeMain(
        '(' +
          guestExpression +
          ').focus();(' +
          guestExpression +
          ').sendInputEvent({type:"keyDown",keyCode:"T",modifiers:["control"]});(' +
          guestExpression +
          ').sendInputEvent({type:"keyUp",keyCode:"T",modifiers:["control"]});true'
      )
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===5'),
        'shortcut from focused browser guest'
      )
      const middlePosition = await evaluate(
        '(()=>{const r=document.querySelector(".panel-tab[aria-selected=true]").getBoundingClientRect();return{x:r.left+40,y:r.top+r.height/2}})()'
      )
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...middlePosition,
        button: 'middle',
        clickCount: 1
      })
      await renderer.cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...middlePosition,
        button: 'middle',
        clickCount: 1
      })
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===4'),
        'middle-click close'
      )
      await key('t', 'KeyT', 10)
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===5'),
        'reopen middle closed browser'
      )
      await key('F4', 'F4', 2)
      await until(
        () => evaluate('document.querySelectorAll(".panel-tab").length===4'),
        'Ctrl+F4 close'
      )
      check('Focused webview shortcuts, middle-click close and reopening preserve neighboring tabs')
      await evaluate(
        'window.__terminalOutput={};window.api.onTerminalEvent(e=>{if(e.type==="data")window.__terminalOutput[e.sessionId]=(window.__terminalOutput[e.sessionId]||"")+e.data})'
      )
      for (let i = 0; i < 2; i++) {
        await click('.panel-tabs-header [aria-label="新建标签页"]')
        await clickText('.panel-page:not([hidden]) .panel-tool-grid button', '终端')
        await until(
          () =>
            evaluate(
              'document.querySelector(".panel-page:not([hidden]) .terminal-toolbar strong")?.textContent.includes("运行中")'
            ),
          'real terminal ' + i
        )
      }
      const ids = await observeMain(
        'globalThis.__workbenchUIAcceptance.audit.ipc.filter(i=>i.channel==="terminal:start").map(i=>i.sessionId)'
      )
      assert.equal(new Set(ids).size, 2)
      const markers = ids.map(() => 'WORKBENCH_' + randomUUID())
      for (let i = 0; i < 2; i++)
        assert(
          (
            await evaluate(
              'window.api.writeTerminal(' +
                JSON.stringify(ids[i]) +
                ',' +
                JSON.stringify('Write-Output "' + markers[i] + '"\r') +
                ')'
            )
          ).ok
        )
      await until(
        () =>
          evaluate(
            'window.__terminalOutput[' +
              JSON.stringify(ids[0]) +
              ']?.includes(' +
              JSON.stringify(markers[0]) +
              ')&&window.__terminalOutput[' +
              JSON.stringify(ids[1]) +
              ']?.includes(' +
              JSON.stringify(markers[1]) +
              ')'
          ),
        'separate shell outputs'
      )
      report.terminalOutput = await evaluate('window.__terminalOutput')
      assert(
        !(await evaluate(
          'window.__terminalOutput[' +
            JSON.stringify(ids[0]) +
            '].includes(' +
            JSON.stringify(markers[1]) +
            ')'
        ))
      )
      await screenshot('07-multiple-terminals')
      await key('w', 'KeyW', 2)
      await until(
        () => evaluate('document.querySelectorAll(".terminal-panel").length===1'),
        'terminal close cleanup'
      )
      check('Two real shells retain output independently and closed terminal waits for cleanup')
      const historicalFile = path.join(
        initialSnapshot.conversations[0].defaultDirectory,
        'snapshot.ts'
      )
      await fs.writeFile(historicalFile, 'const historical = 1;\n')
      await observeMain(
        'process.getBuiltinModule("module").createRequire(' +
          JSON.stringify(root + '/package.json') +
          ')("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:[' +
          JSON.stringify(historicalFile) +
          ']});true'
      )
      const attachment = await evaluate(
        'window.api.selectProjectFiles(' + JSON.stringify(primaryId) + ')'
      )
      report.snapshotSelection = attachment
      assert.equal(attachment.status, 'selected', JSON.stringify(attachment))
      const reference = { path: attachment.selection.files[0].path, startLine: 1 }
      await fs.writeFile(historicalFile, 'const current = 2;\n')
      assert(
        await evaluate(
          '(' +
            openFixtureReference.toString() +
            ')(' +
            JSON.stringify(reference) +
            ',' +
            JSON.stringify({ kind: 'snapshot', snapshotId: attachment.selection.snapshotId }) +
            ')'
        )
      )
      await until(
        () =>
          evaluate(
            'document.querySelector(".panel-page:not([hidden]) .cm-content")?.textContent.includes("historical = 1")'
          ),
        'real historical snapshot'
      )
      assert.equal(
        await evaluate(
          'document.querySelector(".panel-page:not([hidden]) .cm-content").getAttribute("contenteditable")'
        ),
        'false'
      )
      await screenshot('09-readonly-snapshot')
      assert(
        await evaluate(
          '(' +
            openFixtureReference.toString() +
            ')(' +
            JSON.stringify({ path: 'snapshot.ts', startLine: 1 }) +
            ',' +
            JSON.stringify({ kind: 'local' }) +
            ')'
        )
      )
      await until(
        () =>
          evaluate(
            'document.querySelector(".panel-page:not([hidden]) .cm-content")?.textContent.includes("current = 2")'
          ),
        'separate live file'
      )
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".panel-tab")].filter(n=>n.title==="snapshot.ts").length'
        ),
        2
      )
      await key('w', 'KeyW', 2)
      await key('w', 'KeyW', 2)
      check(
        'Real selected snapshot stays read-only and separate from changed disk file through the file-link compatibility entry'
      )
      await observeMain(
        'globalThis.__workbenchUIAcceptance.BrowserWindow.getAllWindows()[0].close();true'
      )
      await until(
        () => evaluate('!!document.querySelector("dialog.panel-save-dialog[open]")'),
        'window dirty file prompt'
      )
      await clickText('dialog button', '取消')
      assert(await evaluate('!!document.querySelector(".panel-dirty-dot")'))
      check('Actual window close can be canceled without dropping file drafts')
      const longName = 'long-title-' + 'abcdefghij'.repeat(8) + '.ts'
      await fs.writeFile(
        path.join(initialSnapshot.conversations[0].defaultDirectory, longName),
        'const longTitle = true;\n'
      )
      await evaluate(
        '(' +
          openFixtureReference.toString() +
          ')(' +
          JSON.stringify({ path: longName, startLine: 1 }) +
          ',' +
          JSON.stringify({ kind: 'local' }) +
          ')'
      )
      await until(
        () =>
          evaluate(
            'document.querySelector(".panel-tab[aria-selected=true]")?.title===' +
              JSON.stringify(longName)
          ),
        'long file title'
      )
      await viewport(700, 800)
      const tabMetrics = await evaluate(
        '(()=>{const t=document.querySelector(".panel-tab[aria-selected=true]"),r=t.getBoundingClientRect(),s=document.querySelector(".panel-tabs"),b=s.getBoundingClientRect();return{height:r.height,width:r.width,scroll:s.scrollWidth,client:s.clientWidth,title:t.title,visible:r.left>=b.left-1&&r.right<=b.right+1}})()'
      )
      assert.equal(tabMetrics.height, 32)
      assert(tabMetrics.width >= 90 && tabMetrics.width <= 240)
      assert(tabMetrics.scroll > tabMetrics.client)
      assert(tabMetrics.visible, 'New active long-title tab remains visible after narrowing')
      await screenshot('12-narrow-long-title')
      await key('w', 'KeyW', 2)
      await viewport(1400, 900)
      check(
        'Long file titles stay within 90–240px and tab strip scrolls in narrow full view',
        tabMetrics
      )

      await delay(700)
      const panel = JSON.parse(
        await fs.readFile(path.join(userData, 'workbench', primaryId + '.json'), 'utf8')
      )
      panel.drafts = JSON.parse(
        await fs.readFile(
          path.join(userData, 'workbench', primaryId + '.' + panel.draftRevision + '.drafts.json'),
          'utf8'
        )
      ).drafts
      assert(Object.values(panel.drafts).some((d) => d.text.includes('local draft')))
      assert.equal(panel.tabs.filter((t) => t.kind === 'terminal').length, 1)
      check('Independent versioned panel state and unsaved draft persisted to disk')
    }
  )
  await launch(async ({ evaluate, until, click, screenshot }) => {
    await until(
      () => evaluate('document.querySelectorAll(".panel-tab").length>=3'),
      'restored tabs'
    )
    assert.equal(await evaluate('document.querySelectorAll(".terminal-panel").length'), 1)
    assert(
      await evaluate(
        'document.querySelector(".terminal-toolbar strong").textContent.includes("未启动")'
      )
    )
    assert(await evaluate('!!document.querySelector(".panel-dirty-dot")'))
    await clickTextDummy()
    async function clickTextDummy() {
      await click(
        '[data-tab-id="' +
          (await evaluate(
            '[...document.querySelectorAll(".panel-tab")].find(n=>n.title==="sample.ts").dataset.tabId'
          )) +
          '"]'
      )
    }
    await until(
      () =>
        evaluate(
          'document.querySelector(".panel-page:not([hidden]) .cm-content")?.textContent.includes("local draft")'
        ),
      'restored editor draft'
    )
    await screenshot('08-restored-draft')
    check('Restart restores draft and tab order; terminal waits for explicit start')
  })
  report.artifactAfter = await artifactIdentity()
  assert.deepEqual(report.artifactAfter, report.artifactBefore)
  report.pass = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
} finally {
  await new Promise((resolve) => website.close(resolve))
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      stage,
      evidence,
      checks: report.checks.length,
      failures: report.failures.map((f) => f.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
