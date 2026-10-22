import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { root } from '../lesson57/runtime.mjs'

const require = createRequire(import.meta.url)
const { install } = require('./desktop-fixture.cjs')
const packaged = process.argv.includes('--packaged'),
  live = process.argv.includes('--live')
const diagnosticLoad = process.env.LESSON62_DIAGNOSTIC_LOAD === '1'
assert(process.argv.slice(2).every((arg) => ['--packaged', '--live'].includes(arg)))
assert.equal(process.platform, 'win32', 'This suite observes the Windows desktop build')
const uuid = randomUUID()
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson62',
  `${live ? 'live' : 'desktop'}-${packaged ? 'packaged' : 'development'}-${uuid}`
)
const userData = path.join(evidence, 'user-data'),
  taskRoot = path.join(evidence, 'task-root')
const skillRoot = path.join(userData, 'skills'),
  skillFile = path.join(skillRoot, 'code-review/SKILL.md')
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + (live ? 450000 : 300000)
const skillBody =
  '# 项目代码审查\n\nLESSON62_FROZEN_REVIEW_A\n\n1. 使用本轮提供的读取工具核对实际代码。\n2. 优先指出错误行为，给出严重程度、文件与行号、触发条件及影响。\n3. 证据不足时说明限制，测试未执行就如实说明。\n4. 只进行代码审查并提出验证建议。\n'
const source = `---\nname: code-review\ndescription: 阅读实际代码，给出有证据的审查问题。\n---\n\n${skillBody}`
const otherSource =
  '---\nname: other-review\ndescription: 另一份验证技能。\n---\n\n# 另一技能\nLESSON62_PENDING_REVIEW_B\n'
const business =
  'export function subtotal(unitCents, quantity) {\n  const effectiveQuantity = quantity || 1\n  return unitCents * effectiveQuantity\n}\n'
const report = {
  pass: false,
  evidence,
  uuid,
  packaged,
  live,
  actualElectron: true,
  actualDisk: true,
  actualMouseKeyInput: true,
  syntheticTransport: !live,
  realModelTransport: live,
  diagnosticLoad,
  caughtExceptions: [],
  processes: [],
  checks: [],
  failures: [],
  limits: [
    'Inspector observes production main/renderer; synthetic held IPC and model replies are separately labelled.',
    'Application-level bounded ordinary-file checks do not prove an OS sandbox against arbitrary hostile concurrent changes.'
  ]
}
const check = (name, details = {}) => report.checks.push({ name, pass: true, ...details })
const assertSavedTask = (saved, requestId, messageId) => {
  const conversation = saved.conversations.find((item) =>
    item.messages.some((message) => message.id === messageId)
  )
  assert(conversation)
  const run = conversation.toolRuns.find((item) => item.requestId === requestId)
  assert(run)
  assert.equal(run.userId, messageId)
  const user = conversation.messages.find((item) => item.id === messageId)
  const assistant = conversation.messages.find((item) => item.id === run.assistantId)
  assert.equal(user?.role, 'user')
  assert.equal(user?.status, 'complete')
  assert.equal(assistant?.role, 'assistant')
  assert.equal(assistant?.status, 'complete')
  return user
}
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
  let serial = 0
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
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
          reject(Error('Bounded CDP request: ' + method))
        }, 20000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function artifactIdentity() {
  const names = [
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'tests/lesson62/desktop-check.mjs',
    'tests/lesson62/desktop-fixture.cjs'
  ]
  if (packaged)
    names.push('dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar')
  const values = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  if (packaged) {
    for (const name of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      const internal = hash(
        require('@electron/asar').extractFile(
          path.join(root, 'dist/win-unpacked/resources/app.asar'),
          path.normalize(name)
        )
      )
      assert.equal(internal, values[name], 'Current ASAR build identity: ' + name)
      values['app.asar:' + name] = internal
    }
  }
  return values
}
async function launch(stage, action) {
  const log = await fs.open(path.join(evidence, stage + '-process.log'), 'w')
  const mainPort = await freePort(),
    rendererPort = await freePort()
  const auditFile = path.join(evidence, stage + '-audit.json')
  const env = {
    ...process.env,
    APPDATA: path.join(evidence, 'appdata'),
    LOCALAPPDATA: path.join(evidence, 'localappdata')
  }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'])
    delete env[name]
  if (!live) for (const name of ['MODEL_ENDPOINT', 'MODEL_NAME', 'MODEL_API_KEY']) delete env[name]
  await fs.mkdir(env.APPDATA, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  const child = spawn(
    executable,
    [
      ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
      '--user-data-dir=' + userData,
      '--inspect-brk=127.0.0.1:' + mainPort,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + rendererPort,
      '--disable-gpu'
    ],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] }
  )
  const processRecord = { stage, pid: child.pid, forcedKill: false, exitCode: null }
  report.processes.push(processRecord)
  console.log(JSON.stringify({ evidence, stage, packaged, live, pid: child.pid }))
  let main, renderer, evaluate
  const until = async (observe, label, ms = 30000) => {
    for (const end = Math.min(Date.now() + ms, deadline); Date.now() < end;) {
      if (child.exitCode !== null) throw Error('Owned desktop exited during ' + label)
      const value = await observe()
      if (value) return value
      await delay(100)
    }
    throw Error('Observation deadline: ' + label)
  }
  try {
    const target = await until(async () => {
      try {
        return (await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json())[0]
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
    const installed = await main.cdp('Runtime.evaluate', {
      expression:
        '(' +
        install.toString() +
        ')(' +
        JSON.stringify({ root, userData, auditFile, live }) +
        ');globalThis.__lesson62FixtureReady',
      returnByValue: true
    })
    assert.equal(
      installed.exceptionDetails,
      undefined,
      installed.exceptionDetails?.exception?.description
    )
    assert.equal(installed.result.value, true)
    if (diagnosticLoad) {
      main.socket.addEventListener('message', ({ data }) => {
        const value = JSON.parse(data)
        if (value.method !== 'Debugger.paused') return
        const description = value.params.data?.description ?? ''
        if (description.startsWith('Error: 会话任务目录'))
          report.caughtExceptions.push({
            message: description.split('\n')[0],
            frames: value.params.callFrames.map((frame) => ({
              functionName: frame.functionName,
              lineNumber: frame.location.lineNumber
            }))
          })
        void main.cdp('Debugger.resume').catch(() => undefined)
      })
      await main.cdp('Debugger.setPauseOnExceptions', { state: 'all' })
    }
    await main.cdp('Debugger.resume')
    if (!diagnosticLoad) await main.cdp('Debugger.disable')
    const page = await until(async () => {
      try {
        return (await (await fetch(`http://127.0.0.1:${rendererPort}/json/list`)).json()).find(
          (item) => item.type === 'page' && item.url.includes('renderer')
        )
      } catch {
        return null
      }
    }, 'renderer page')
    renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    evaluate = async (expression) => {
      const value = await renderer.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (value.exceptionDetails)
        throw Error(value.exceptionDetails.exception?.description ?? 'Renderer observation failed')
      return value.result.value
    }
    const invoke = (channel, ...args) =>
      evaluate(
        'window.electron.ipcRenderer.invoke(' +
          JSON.stringify(channel) +
          ',...' +
          JSON.stringify(args) +
          ')'
      )
    const api = (name, ...args) =>
      evaluate('window.api[' + JSON.stringify(name) + '](...' + JSON.stringify(args) + ')')
    const audit = () => invoke('lesson62:observation')
    const configure = (value) => invoke('lesson62:configure', value)
    const click = async (selector) => {
      const position = await evaluate(
        '(()=>{const n=document.querySelector(' +
          JSON.stringify(selector) +
          ');if(!n||n.disabled)throw Error("Missing/disabled click target: "+' +
          JSON.stringify(selector) +
          ');n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);if(!h||!(h===n||n.contains(h)))throw Error("Click target blocked");return {x,y}})()'
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
    const clickText = async (selector, text) => {
      await evaluate(
        '(()=>{document.querySelectorAll("[data-lesson62-click-target]").forEach(n=>n.removeAttribute("data-lesson62-click-target"));const n=[...document.querySelectorAll(' +
          JSON.stringify(selector) +
          ')].find(n=>n.textContent.includes(' +
          JSON.stringify(text) +
          '));if(!n)throw Error("Missing text target");n.setAttribute("data-lesson62-click-target","true")})()'
      )
      await click('[data-lesson62-click-target]')
    }
    const key = async (key, code = key) => {
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: key === 'Escape' ? 27 : key === 'Enter' ? 13 : 0
      })
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: key === 'Escape' ? 27 : key === 'Enter' ? 13 : 0
      })
    }
    const idle = () =>
      until(
        () =>
          evaluate(
            '!!document.querySelector("#chat-input")&&!document.querySelector("#chat-input").disabled&&!document.querySelector("button[aria-label=停止生成],button[aria-label=正在停止]")'
          ),
        'idle composer',
        live ? 180000 : 30000
      )
    const setDraft = async (text, selector = '#chat-input') => {
      await click(selector)
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        modifiers: 2,
        windowsVirtualKeyCode: 65
      })
      await renderer.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        modifiers: 2,
        windowsVirtualKeyCode: 65
      })
      await renderer.cdp('Input.insertText', { text })
    }
    const send = async () => {
      await until(
        () => evaluate('!document.querySelector("button[aria-label=发送消息]").disabled'),
        'send enabled'
      )
      await click('button[aria-label=发送消息]')
    }
    const openSkills = async (selector) => {
      const entry =
        selector ??
        (await evaluate(
          'document.querySelector(".app-shell").classList.contains("sidebar-open")?".sidebar-skills":".rail-skills"'
        ))
      await click(entry)
      await until(
        () => evaluate('!!document.querySelector(".skills-page:not([hidden])")'),
        'standalone skills page'
      )
      return entry
    }
    const choose = async (name = 'code-review') => {
      await openSkills()
      await until(
        () =>
          evaluate(
            '[...document.querySelectorAll(".skills-page:not([hidden]) button.skills-option")].some(n=>!n.disabled&&n.textContent.includes(' +
              JSON.stringify(name) +
              '))'
          ),
        'available skill'
      )
      const beforeDetail = await audit()
      await clickText('button.skills-option', name)
      await until(
        () => evaluate('!!document.querySelector("dialog.skill-detail-dialog[open]")'),
        'skill metadata detail dialog'
      )
      const detail = await audit()
      for (const field of [
        'skillReads',
        'skillRootOperations',
        'skillDirectoryScans',
        'skillAttributeHelpers',
        'requests'
      ])
        assert.equal(detail[field].length, beforeDetail[field].length, 'Metadata detail: ' + field)
      await screenshot('skills-detail')
      await click('dialog.skill-detail-dialog[open] button.skill-use')
      await until(
        () =>
          evaluate(
            'document.querySelector(".skills-page").hidden&&!document.querySelector(".workspace-shell").hidden&&!!document.querySelector(".pending-skill")&&document.querySelector(".pending-skill").textContent.includes(' +
              JSON.stringify(name) +
              ')&&document.activeElement===document.querySelector("#chat-input")'
          ),
        'prepared skill'
      )
      await screenshot('chat-pending-skill')
    }
    const save = async () => {
      const expected = await evaluate(
        '[...document.querySelectorAll(".message")].map(n=>({id:n.dataset.messageId,status:n.dataset.status}))'
      )
      const readSaved = async () => {
        if (diagnosticLoad) return (await api('loadConversation')).snapshot
        try {
          return JSON.parse(await fs.readFile(path.join(userData, 'conversation.json'), 'utf8'))
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      }
      await until(async () => {
        // Public load restores host directory bindings; observe the isolated
        // saved file directly so checking autosave cannot change its authority.
        const saved = await readSaved()
        return saved &&
          saved.conversations.some(
            (item) =>
              item.messages.length === expected.length &&
              expected.every((visible) =>
                item.messages.some(
                  (message) => message.id === visible.id && message.status === visible.status
                )
              ) &&
              item.messages.some((message) => message.role === 'user' && message.skill)
          )
          ? saved
          : null
      }, 'autosaved skill snapshot')
      return readSaved()
    }
    const screenshot = async (name) => {
      const value = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(
        path.join(evidence, stage + '-' + name + '.png'),
        Buffer.from(value.data, 'base64')
      )
    }
    const viewport = async (width, height) => {
      await renderer.cdp('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      })
      await until(
        () => evaluate('window.innerWidth===' + width + '&&window.innerHeight===' + height),
        'responsive viewport'
      )
      await delay(450)
    }
    await idle()
    await action({
      api,
      audit,
      configure,
      evaluate,
      click,
      clickText,
      key,
      setDraft,
      send,
      openSkills,
      choose,
      save,
      screenshot,
      viewport,
      until,
      idle
    })
    await fs.writeFile(auditFile, JSON.stringify(await audit(), null, 2))
  } catch (error) {
    if (evaluate)
      try {
        await fs.writeFile(
          path.join(evidence, stage + '-focus-diagnostic.json'),
          await evaluate(
            'JSON.stringify({active:document.activeElement?.outerHTML,skillsHidden:document.querySelector(".skills-page")?.hidden,sidebar:document.querySelector(".sidebar")?.outerHTML.slice(0,400)},null,2)'
          )
        )
        await fs.writeFile(
          path.join(evidence, stage + '-diagnostic.txt'),
          await evaluate('document.body.innerText')
        )
        const screenshot = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
        await fs.writeFile(
          path.join(evidence, stage + '-failure.png'),
          Buffer.from(screenshot.data, 'base64')
        )
        await fs.writeFile(
          auditFile,
          JSON.stringify(
            await evaluate('window.electron.ipcRenderer.invoke("lesson62:observation")'),
            null,
            2
          )
        )
      } catch {
        /* Keep primary failure. */
      }
    throw error
  } finally {
    if (evaluate)
      try {
        await evaluate('window.electron.ipcRenderer.invoke("lesson62:quit")')
      } catch {
        /* Already closed. */
      }
    renderer?.socket.close()
    main?.socket.close()
    if (child.exitCode === null)
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    if (child.exitCode === null) {
      processRecord.forcedKill = true
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    }
    processRecord.exitCode = child.exitCode
    await log.close()
  }
}
let conversationId, project, acceptedSnapshot, checkpoint
try {
  if (live) {
    try {
      process.loadEnvFile(path.join(root, '.env.local'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Current model environment file is unavailable')
    }
    if (!process.env.MODEL_ENDPOINT || !process.env.MODEL_NAME || !process.env.MODEL_API_KEY)
      throw Error('Current model configuration is unavailable; no model request was sent')
  }
  await fs.mkdir(path.join(skillRoot, 'code-review'), { recursive: true })
  await fs.mkdir(path.join(skillRoot, 'other-review'), { recursive: true })
  await fs.mkdir(path.join(skillRoot, 'bad-review'), { recursive: true })
  await fs.mkdir(taskRoot, { recursive: true })
  await fs.writeFile(skillFile, source)
  await fs.writeFile(path.join(skillRoot, 'other-review/SKILL.md'), otherSource)
  await fs.writeFile(
    path.join(skillRoot, 'bad-review/SKILL.md'),
    '---\nname: bad-review\ndescription: "unsupported quoted format"\n---\n# invalid\n'
  )
  await fs.writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      version: 1,
      taskRoot,
      defaultPermissionMode: 'default',
      terminalShell: 'powershell'
    })
  )
  await fs.writeFile(
    path.join(userData, 'conversation.json'),
    JSON.stringify({ version: 9, activeConversationId: null, conversations: [] })
  )
  const artifactsBefore = await artifactIdentity()
  await fs.writeFile(
    path.join(evidence, 'artifacts-before.json'),
    JSON.stringify(artifactsBefore, null, 2)
  )
  await launch('create', async (ui) => {
    const {
      api,
      audit,
      configure,
      evaluate,
      click,
      clickText,
      key,
      setDraft,
      send,
      openSkills,
      choose,
      save,
      screenshot,
      viewport,
      until,
      idle
    } = ui
    await delay(5000)
    let observed = await audit()
    assert.equal(observed.requests.length, 0)
    assert.equal(observed.skillReads.length, 0)
    assert.equal(observed.skillRootOperations.length, 0)
    assert.equal(observed.skillDirectoryScans.length, 0)
    assert.equal(observed.skillAttributeHelpers.length, 0)
    assert.equal(
      await evaluate(
        'document.querySelectorAll(".composer-skills,.skills-trigger,.skills-popover,.composer .sidebar-skills,.composer .rail-skills,.composer .skills-option").length'
      ),
      0,
      'The skill browser and its entry do not belong to the message input'
    )
    check(
      'passive first empty launch remains zero model requests, SKILL reads, skill root operations, directory scans and attribute helpers for five seconds'
    )
    const prompt =
      '审查 business.mjs 的价格计算，数量0必须得到0，特别是 subtotal(199,0) 预期0。读取实际代码并给出问题、路径与行号、触发结果和验证建议。'
    await setDraft(prompt)
    await choose()
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
    const library = (await api('loadConversation')).snapshot
    conversationId = library.activeConversationId
    assert(conversationId)
    project = library.conversations.find((item) => item.id === conversationId).defaultDirectory
    assert(project.startsWith(taskRoot))
    await fs.writeFile(path.join(project, 'business.mjs'), business)
    const { subtotal } = await import(
      'file:///' + path.join(project, 'business.mjs').replaceAll('\\', '/') + '?fresh=' + uuid
    )
    assert.equal(subtotal(199, 0), 199)
    assert.notEqual(subtotal(199, 0), 0)
    check(
      'first selection creates the bound empty conversation and inherits the exact draft; known quantity-zero defect independently reproduces',
      { conversationId, project, independentActual: 199, expected: 0 }
    )
    observed = await audit()
    assert(observed.skillRootOperations.length > 0)
    assert(observed.skillDirectoryScans.length > 0)
    assert(observed.skillAttributeHelpers.length > 0)
    assert.equal(observed.requests.length, 0)
    if (!live) assert(observed.skillReads.some((item) => item.file.includes('other-review')))
    assert(
      observed.skillReads
        .filter((item) => item.file.includes('other-review'))
        .every((item) => item.requested === 1)
    )
    assert(observed.skillReads.some((item) => item.file === skillFile && item.requested > 1))
    const roundTripBaseline = await audit()
    const skillsEntry = await openSkills()
    assert.match(
      await evaluate('document.querySelector(".skills-page").textContent'),
      /bad-review.*不可用/s
    )
    assert.equal(
      await evaluate('!!document.querySelector(".pending-skill")?.closest(".composer")'),
      false,
      'The pending skill indicator remains outside the message input'
    )
    await screenshot('skills-library')
    const originalViewport = await evaluate('({width:window.innerWidth,height:window.innerHeight})')
    const cardsLayout = () =>
      evaluate(
        '(()=>{const page=document.querySelector(".skills-page"),cards=[...page.querySelectorAll("button.skills-option")].map(n=>n.getBoundingClientRect());return {lefts:cards.slice(0,2).map(r=>r.left),overflow:page.scrollWidth>page.clientWidth+1||document.documentElement.scrollWidth>window.innerWidth+1}})()'
      )
    const wideCards = await cardsLayout()
    assert.equal(wideCards.lefts.length, 2)
    assert(
      Math.abs(wideCards.lefts[0] - wideCards.lefts[1]) > 20,
      'A wide library uses two card columns'
    )
    assert.equal(wideCards.overflow, false)
    await viewport(620, originalViewport.height)
    const narrowCards = await cardsLayout()
    assert.equal(narrowCards.lefts.length, 2)
    assert(
      Math.abs(narrowCards.lefts[0] - narrowCards.lefts[1]) < 2,
      'A narrow library uses one card column'
    )
    assert.equal(narrowCards.overflow, false)
    await screenshot('skills-library-narrow')
    await viewport(originalViewport.width, originalViewport.height)
    check(
      'the standalone skills library changes from two card columns to one in a narrow viewport without horizontal overflow',
      { realLayout: true, wideViewport: originalViewport.width, narrowViewport: 620 }
    )
    await key('Escape')
    await delay(150)
    await fs.writeFile(
      path.join(evidence, 'return-focus-observation.json'),
      await evaluate(
        'JSON.stringify({active:document.activeElement?.outerHTML,skillsHidden:document.querySelector(".skills-page")?.hidden,sidebarInert:document.querySelector(".sidebar")?.inert},null,2)'
      )
    )
    await until(
      () =>
        evaluate(
          'document.querySelector(".skills-page").hidden&&document.activeElement===document.querySelector(' +
            JSON.stringify(skillsEntry) +
            ')'
        ),
      'Escape returns from skills to its sidebar trigger'
    )
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
    check(
      'standalone page shows bad skill reason, reads only other skill headers, and Escape restores its sidebar trigger while retaining the draft',
      { realInput: true }
    )
    await click('#sidebar-toggle')
    await until(
      () => evaluate('!document.querySelector(".app-shell").classList.contains("sidebar-open")'),
      'collapsed sidebar'
    )
    await delay(450)
    await openSkills('.rail-skills')
    const collapsedNames = await evaluate(
      '[...document.querySelectorAll(".skills-page button.skills-option")].map(n=>n.textContent)'
    )
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
    await key('Escape')
    await until(
      () =>
        evaluate(
          'document.querySelector(".skills-page").hidden&&document.activeElement===document.querySelector(".rail-skills")'
        ),
      'Escape returns to collapsed skills entry'
    )
    await click('#sidebar-toggle')
    await until(
      () => evaluate('document.querySelector(".app-shell").classList.contains("sidebar-open")'),
      'expanded sidebar'
    )
    await delay(450)
    await openSkills('.sidebar-skills')
    assert.deepEqual(
      await evaluate(
        '[...document.querySelectorAll(".skills-page button.skills-option")].map(n=>n.textContent)'
      ),
      collapsedNames
    )
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
    await key('Escape')
    await until(
      () => evaluate('document.querySelector(".skills-page").hidden'),
      'Escape returns from expanded skills entry'
    )
    const roundTripAfter = await audit()
    for (const field of [
      'skillReads',
      'skillRootOperations',
      'skillDirectoryScans',
      'skillAttributeHelpers',
      'requests'
    ])
      assert.equal(
        roundTripAfter[field].length,
        roundTripBaseline[field].length,
        'Reopening the same discovered library: ' + field
      )
    check(
      'expanded and collapsed sidebar entries show the same standalone skills page; return preserves the exact draft and pending skill with zero implicit rescans or model requests',
      { realInput: true }
    )
    await openSkills()
    const beforeRefresh = await audit()
    await click('.skills-refresh')
    await until(async () => {
      const refreshed = await audit()
      return (
        refreshed.ipc.filter(
          (item) => item.channel === 'skills:list' && item.result?.status === 'ok'
        ).length >
          beforeRefresh.ipc.filter(
            (item) => item.channel === 'skills:list' && item.result?.status === 'ok'
          ).length &&
        (await evaluate(
          '[...document.querySelectorAll(".skills-page button.skills-option")].some(n=>!n.disabled&&n.textContent.includes("code-review"))&&!document.querySelector(".pending-skill")'
        ))
      )
    }, 'explicit skill refresh completes')
    const afterRefresh = await audit()
    assert(afterRefresh.skillDirectoryScans.length > beforeRefresh.skillDirectoryScans.length)
    assert.equal(afterRefresh.requests.length, beforeRefresh.requests.length)
    await key('Escape')
    await choose()
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
    check(
      'only explicit refresh rescans the discovered skills, retires the old pending selection and permits deliberate reselection without a model request or draft loss',
      { realInput: true }
    )
    if (!live) {
      const before = observed.requests.length
      await fs.writeFile(skillFile, source + '\nchanged-before-send\n')
      await send()
      await idle()
      const failed = await audit()
      assert.equal(failed.requests.length, before)
      assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
      assert.equal(
        await evaluate(
          'document.querySelector(".pending-skill")?.textContent.includes("code-review")===true'
        ),
        true
      )
      const failedPlaceholders = await evaluate(
        '[...document.querySelectorAll(".message")].map(n=>n.dataset.status)'
      )
      assert.equal(failedPlaceholders.length, 2)
      assert(failedPlaceholders.every((status) => status === 'failed'))
      check(
        'changed selected source fails before any model/title request and preserves draft, pending skill and failed terminal placeholders'
      )
      await fs.writeFile(skillFile, source)
      await choose()
      await configure({ faults: { holdExecution: true } })
      await send()
      await until(
        async () => (await audit()).held.some((item) => item.name === 'execution'),
        'held environment'
      )
      assert.equal(
        await evaluate(
          '[...document.querySelectorAll(".sidebar-skills,.rail-skills")].every(n=>n.disabled)&&document.querySelectorAll(".sidebar-skills,.rail-skills").length===2'
        ),
        true,
        'An active task keeps both skills navigation entries disabled'
      )
      await click('button[aria-label=停止生成]')
      await configure({ release: 'execution' })
      await idle()
      assert.equal((await audit()).requests.length, before)
      assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
      check(
        'actual stop during synthetic held environment rejects late resolution and preserves the skill draft'
      )
      await configure({ faults: { holdFullSkillRead: true } })
      await send()
      await until(
        async () => (await audit()).held.some((item) => item.name === 'full-skill-read'),
        'held source freeze'
      )
      await click('button[aria-label=停止生成]')
      await configure({ release: 'full-skill-read' })
      await idle()
      assert.equal((await audit()).requests.length, before)
      assert.equal(await evaluate('document.querySelector("#chat-input").value'), prompt)
      check(
        'actual stop during synthetic held main source verification ignores late freeze, makes zero model requests and preserves draft'
      )
    }
    await click('button[aria-label=添加附件]')
    await click('.composer-plan-option')
    await idle()
    await configure({ scenario: { name: 'review' }, faults: {} })
    await send()
    await idle()
    const completed = await save()
    const active = completed.conversations.find((item) => item.id === conversationId)
    acceptedSnapshot = active.messages
      .filter((message) => message.role === 'user' && message.skill)
      .at(-1).skill
    assert.equal(acceptedSnapshot.body, skillBody)
    assert.equal(acceptedSnapshot.sourceHash, hash(Buffer.from(source)))
    assert.equal(await evaluate('document.querySelector("#chat-input").value'), '')
    assert.equal(
      await evaluate(
        'document.querySelector(".pending-skill")?.textContent.includes("code-review")===true'
      ),
      false
    )
    assert.equal(await fs.readFile(path.join(project, 'business.mjs'), 'utf8'), business)
    const transcript = await evaluate('document.querySelector(".message-list").textContent')
    assert.match(transcript, /quantity|数量/)
    assert.match(transcript, /business\.mjs/)
    const finalAnswer = await evaluate(
      '[...document.querySelectorAll(".message-assistant .message-answer")].at(-1).textContent'
    )
    assert.match(finalAnswer, /199/)
    assert.match(finalAnswer, /quantity|数量/)
    assert.match(finalAnswer, /(?:预期|应|正确).*0|0.*(?:预期|应|正确)/s)
    assert.match(finalAnswer, /business\.mjs(?::|#L?)2\b|第\s*2\s*行|\bL2\b/)
    observed = await audit()
    const main = observed.requests.filter(
      (item) => item.category === 'main' && item.scenario === 'review'
    )
    assert(main.length >= 2)
    if (!live) {
      const start = observed.ipc.filter((item) => item.channel === 'agent:start').at(-1)
      assert.equal(start.result?.status, 'done')
      const accepted = observed.events.filter(
        (event) =>
          event.channel === 'agent:skill-accepted' && event.value.requestId === start.args[0]
      )
      assert.equal(accepted.length, 1)
      assert.equal(accepted[0].value.messageId, start.args[3].userMessageId)
      assert.deepEqual(accepted[0].value.snapshot, acceptedSnapshot)
      assert.equal(
        assertSavedTask(completed, start.args[0], start.args[3].userMessageId).skill.snapshotHash,
        acceptedSnapshot.snapshotHash
      )
    }
    assert(main.every((item) => item.instructions.includes(JSON.stringify(skillBody))))
    assert(
      observed.requests
        .filter((item) => item.category !== 'main')
        .every((item) => !item.instructions.includes(JSON.stringify(skillBody)))
    )
    assert(
      observed.events.some(
        (item) =>
          item.channel === 'agent:skill-accepted' &&
          item.value.snapshot?.snapshotHash === acceptedSnapshot.snapshotHash
      )
    )
    assert(
      active.toolRuns.some((run) =>
        run.items.some(
          (item) => item.type === 'function_call' && item.name === 'read_workspace_file'
        )
      )
    )
    assert(
      active.toolRuns.some((run) =>
        run.items.some(
          (item) => item.type === 'function_call_output' && item.output.includes('quantity || 1')
        )
      )
    )
    check(
      'actual selected skill main tool-read-report-save loop uses identical frozen instructions, persists full snapshot and keeps read-only project unchanged',
      {
        realModelTransport: live,
        mainRequests: main.length,
        sourceHash: acceptedSnapshot.sourceHash,
        snapshotHash: acceptedSnapshot.snapshotHash
      }
    )
    await screenshot('review-complete')
    if (live) return
    await configure({ scenario: { name: 'ordinary' } })
    await setDraft('下一条普通消息')
    await send()
    await idle()
    const ordinaryObserved = await audit()
    const ordinaryRequests = ordinaryObserved.requests.filter(
      (item) => item.scenario === 'ordinary' && item.category === 'main'
    )
    assert.equal(ordinaryRequests.length, 1)
    assert(ordinaryRequests.every((item) => !item.instructions.includes(JSON.stringify(skillBody))))
    const ordinaryStart = ordinaryObserved.ipc
      .filter((item) => item.channel === 'agent:start')
      .at(-1)
    assert.equal(ordinaryStart.result?.status, 'done')
    const ordinarySaved = await save()
    assert.equal(
      assertSavedTask(ordinarySaved, ordinaryStart.args[0], ordinaryStart.args[3].userMessageId)
        .skill,
      undefined
    )
    check('new ordinary send does not activate an earlier message skill')
    const navigationRequests = (await audit()).requests.length
    await openSkills()
    await configure({ faults: { holdPrepare: true } })
    await clickText('button.skills-option', 'code-review')
    await click('dialog.skill-detail-dialog[open] button.skill-use')
    await until(
      async () => (await audit()).held.some((item) => item.name === 'prepare'),
      'held explicit selection'
    )
    await click('.conversation-create')
    await idle()
    await configure({ release: 'prepare' })
    await delay(300)
    assert.equal(
      await evaluate(
        'document.querySelector(".pending-skill")?.textContent.includes("code-review")===true'
      ),
      false
    )
    assert.equal((await audit()).requests.length, navigationRequests)
    const originalTitle = active.title
    await clickText('.conversation-item', originalTitle)
    await idle()
    assert.equal((await audit()).requests.length, navigationRequests)
    assert.equal(
      await evaluate(
        'document.querySelector(".pending-skill")?.textContent.includes("code-review")===true'
      ),
      false
    )
    check(
      'new conversation and native return discard a synthetic held selection result with zero model requests and no cross-conversation activation'
    )
    await choose()
    await configure({ scenario: { name: 'failure' } })
    await setDraft('原技能失败重试验证')
    await send()
    await idle()
    await choose('other-review')
    await fs.writeFile(skillFile, source + '\nnew-disk-version\n')
    await configure({ scenario: { name: 'review' } })
    const retryBaseline = (await audit()).requests.length
    await click('button[aria-label=重新生成回复]')
    await idle()
    observed = await audit()
    const retryStart = observed.ipc.filter((item) => item.channel === 'agent:start').at(-1)
    assert.equal(retryStart.args[3].skill.kind, 'message')
    const verifyReview = (start) => {
      assert.equal(start.result?.status, 'done')
      const accepted = observed.events.filter(
        (event) =>
          event.channel === 'agent:skill-accepted' && event.value.requestId === start.args[0]
      )
      assert.equal(accepted.length, 1)
      assert.equal(accepted[0].value.messageId, start.args[3].userMessageId)
      assert.deepEqual(accepted[0].value.snapshot, acceptedSnapshot)
      assert.match(start.result.answer, /business\.mjs 第2行.*quantity \|\| 1.*199.*预期0/s)
      assert(
        start.result.items.some((item) => {
          if (item.type !== 'function_call_output') return false
          const output = JSON.parse(item.output)
          return (
            output.ok &&
            output.lines?.some((line) => line.line === 2 && line.text.includes('quantity || 1'))
          )
        }),
        'Successful review includes a current tool result for the actual defect at line 2'
      )
    }
    verifyReview(retryStart)
    assert.equal(
      await evaluate('[...document.querySelectorAll(".message-assistant")].at(-1).dataset.status'),
      'complete'
    )
    const retryRequests = observed.requests
      .slice(retryBaseline)
      .filter((item) => item.category === 'main')
    assert.equal(retryRequests.length, 2)
    assert(
      retryRequests.every(
        (item) =>
          item.instructions.includes(JSON.stringify(skillBody)) &&
          !item.instructions.includes('LESSON62_PENDING_REVIEW_B')
      )
    )
    assert.equal(
      await evaluate(
        'document.querySelector(".pending-skill")?.textContent.includes("other-review")===true'
      ),
      true
    )
    const savedRetry = await save()
    const retryMessage = savedRetry.conversations
      .find((item) => item.id === conversationId)
      .messages.find((message) => message.id === retryStart.args[3].userMessageId)
    assert(retryMessage)
    assert.equal(retryMessage.status, 'complete')
    assert.equal(retryMessage.skill.snapshotHash, acceptedSnapshot.snapshotHash)
    assertSavedTask(savedRetry, retryStart.args[0], retryStart.args[3].userMessageId)
    check(
      'failed original response retries with the main original message snapshot despite selected B and changed source A',
      { syntheticTransport: true }
    )
    await click('button[aria-label=编辑消息]')
    await setDraft('编辑原审查消息：再次检查数量0并给出证据。', '#message-inline-input')
    await configure({ scenario: { name: 'review' } })
    const editBaseline = (await audit()).requests.length
    await click('.message-inline-send')
    await idle()
    observed = await audit()
    const editStart = observed.ipc.filter((item) => item.channel === 'agent:start').at(-1)
    assert.equal(editStart.args[3].skill.kind, 'message')
    verifyReview(editStart)
    assert.equal(
      await evaluate('[...document.querySelectorAll(".message-assistant")].at(-1).dataset.status'),
      'complete'
    )
    assert(
      observed.ipc.some(
        (item) =>
          item.channel === 'agent:skill-message' &&
          item.args[1] === editStart.args[3].skill.messageId &&
          item.result?.status === 'ready'
      )
    )
    const editRequests = observed.requests
      .slice(editBaseline)
      .filter((item) => item.category === 'main')
    assert.equal(editRequests.length, 2)
    assert(
      editRequests.every(
        (item) =>
          item.instructions.includes(JSON.stringify(skillBody)) &&
          !item.instructions.includes('LESSON62_PENDING_REVIEW_B')
      )
    )
    assert.equal(
      await evaluate(
        'document.querySelector(".pending-skill")?.textContent.includes("other-review")===true'
      ),
      true
    )
    const savedEdit = await save()
    const editMessage = savedEdit.conversations
      .find((item) => item.id === conversationId)
      .messages.find((message) => message.id === editStart.args[3].userMessageId)
    assert(editMessage)
    assert.equal(editMessage.status, 'complete')
    assert.equal(editMessage.skill.snapshotHash, acceptedSnapshot.snapshotHash)
    assertSavedTask(savedEdit, editStart.args[0], editStart.args[3].userMessageId)
    check(
      'native edit re-send validates original message snapshot before trimming and preserves selected B while reusing A',
      { syntheticTransport: true }
    )
    await fs.writeFile(skillFile, source)
    await click('.pending-skill-remove')
    await choose()
    await configure({ scenario: { name: 'checkpoint' } })
    await setDraft('审查价格，验证显式技能任务续接')
    await send()
    await until(
      async () =>
        (await audit()).requests.some(
          (item) => item.scenario === 'checkpoint' && item.waitingForCancellation
        ),
      'real read and checkpoint held model'
    )
    await click('button[aria-label=停止生成]')
    await idle()
    await save()
    checkpoint = await api('getResumableAgentTask', conversationId)
    assert.equal(checkpoint.skillName, 'code-review')
    await fs.rename(skillFile, skillFile + '.removed')
    check(
      'actual cancellation leaves resumable original skill metadata and the source is removed before reopening',
      { checkpointTaskId: checkpoint.taskId }
    )
  })
  await launch(
    'reopen',
    async ({
      api,
      audit,
      evaluate,
      clickText,
      configure,
      idle,
      screenshot,
      save,
      choose,
      setDraft
    }) => {
      await delay(5000)
      const passive = await audit()
      assert.equal(passive.requests.length, 0)
      assert.equal(passive.skillReads.length, 0)
      assert.equal(passive.skillRootOperations.length, 0)
      assert.equal(passive.skillDirectoryScans.length, 0)
      assert.equal(passive.skillAttributeHelpers.length, 0)
      const reopened = (await api('loadConversation')).snapshot
      assert(
        reopened.conversations
          .find((item) => item.id === conversationId)
          .messages.some((message) => message.skill?.snapshotHash === acceptedSnapshot.snapshotHash)
      )
      check(
        'new-PID passive reopening reads saved snapshot but performs zero model requests, SKILL reads, skill root operations, directory scans and attribute helpers for five seconds'
      )
      if (live) return
      assert.equal(await evaluate('!!document.querySelector(".task-resume-bar")'), false)
      await choose('other-review')
      const preservedDraft = '选B技能的未发送草稿，继续A任务时保留。'
      await setDraft(preservedDraft)
      const beforeResume = await audit()
      await configure({ scenario: { name: 'resume' } })
      await clickText('.task-resume-button', '继续此任务')
      await idle()
      const resumed = await audit()
      assert.equal(resumed.skillReads.length, beforeResume.skillReads.length)
      assert.equal(resumed.skillRootOperations.length, beforeResume.skillRootOperations.length)
      assert.equal(resumed.skillDirectoryScans.length, beforeResume.skillDirectoryScans.length)
      assert.equal(resumed.skillAttributeHelpers.length, beforeResume.skillAttributeHelpers.length)
      const resumeRequests = resumed.requests.filter((item) => item.category === 'main')
      assert.equal(resumeRequests.length, 1)
      const resumeReadCall = resumeRequests[0].input.find(
        (item) => item.type === 'function_call' && item.name === 'read_workspace_file'
      )
      assert(resumeReadCall)
      const resumeReadOutput = resumeRequests[0].input.find(
        (item) => item.type === 'function_call_output' && item.call_id === resumeReadCall.call_id
      )
      assert(resumeReadOutput)
      const checkpointRead = JSON.parse(resumeReadOutput.output)
      assert.equal(checkpointRead.ok, true)
      assert(
        checkpointRead.lines.some((line) => line.line === 2 && line.text.includes('quantity || 1'))
      )
      assert(
        resumeRequests.every(
          (item) =>
            item.instructions.includes(JSON.stringify(skillBody)) &&
            !item.instructions.includes('LESSON62_PENDING_REVIEW_B')
        )
      )
      const resume = resumed.ipc.find((item) => item.channel === 'agent:resume')
      assert(resume)
      assert.equal(resume.result?.status, 'done')
      assert.equal(resume.args[1], checkpoint.taskId)
      assert.equal(resume.args[2].skill, undefined)
      const resumeAccepted = resumed.events.filter(
        (event) =>
          event.channel === 'agent:skill-accepted' &&
          event.value.requestId === resume.args[0] &&
          event.value.messageId === resume.args[2].userMessageId
      )
      assert.equal(resumeAccepted.length, 1)
      assert.equal(resumeAccepted[0].value.snapshot.snapshotHash, acceptedSnapshot.snapshotHash)
      assert.equal(await evaluate('document.querySelector("#chat-input").value'), preservedDraft)
      assert.equal(
        await evaluate(
          'document.querySelector(".pending-skill")?.textContent.includes("other-review")===true'
        ),
        true
      )
      const savedResume = await save()
      const resumedMessage = savedResume.conversations
        .find((item) => item.id === conversationId)
        .messages.find((message) => message.id === resume.args[2].userMessageId)
      assert(resumedMessage)
      assert.equal(resumedMessage.role, 'user')
      assert.equal(resumedMessage.status, 'complete')
      assert.equal(resumedMessage.content, checkpoint.prompt)
      assert.equal(resumedMessage.skill.snapshotHash, acceptedSnapshot.snapshotHash)
      assertSavedTask(savedResume, resume.args[0], resume.args[2].userMessageId)
      assert(
        savedResume.conversations
          .find((item) => item.id === conversationId)
          .messages.filter((message) => message.skill)
          .every((message) => message.skill.snapshotHash === acceptedSnapshot.snapshotHash)
      )
      check(
        'explicit native UI resume after deleting A source uses checkpoint A with no additional source operations, preserves selected B and unsent draft, and saves a new accepted A message snapshot',
        { syntheticTransport: true }
      )
      await screenshot('resume-complete')
    }
  )
  assert.deepEqual(await artifactIdentity(), artifactsBefore)
  check('all observed built entry and ASAR identities stay unchanged during the run')
  report.pass = true
} catch (error) {
  report.failures.push(error.stack ?? String(error))
  console.error(error)
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({ pass: report.pass, evidence, checks: report.checks.length, packaged, live })
  )
  if (!report.pass) process.exitCode = 1
}
