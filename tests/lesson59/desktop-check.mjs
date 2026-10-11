import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { install } = createRequire(import.meta.url)('./desktop-fixture.cjs')
const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((arg) => arg === '--packaged'))
assert.equal(process.platform, 'win32', 'This real desktop check requires Windows')
const uuid = randomUUID()
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson59',
  'desktop-' + (packaged ? 'packaged-' : 'development-') + uuid
)
const marker = 'zonecodex-terminal-59-' + uuid
const userData = path.join(evidence, 'user-data')
const auditFile = path.join(evidence, 'desktop-audit.json')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const artifacts = packaged
  ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar']
  : ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
const report = {
  pass: false,
  evidence,
  uuid,
  marker,
  packaged,
  realTransport: false,
  syntheticTransport: true,
  actualElectron: true,
  actualPTY: true,
  actualDiskStorage: true,
  processes: [],
  checks: [],
  failures: [],
  uncovered: ['Real network model not invoked.', 'Non-Windows terminals are not supported.']
}
let main, renderer, evaluate, child, log, beforeArtifacts
let windowDestroyed = false
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function identify() {
  return Object.fromEntries(
    await Promise.all(
      artifacts.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
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
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const pending = new Map(),
    events = []
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
          reject(Error('Inspector timeout: ' + method))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function until(action, label, ms = 30000, allowExited = false) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!allowExited && child?.exitCode !== null && child?.exitCode !== undefined)
      throw Error('Owned app exited during ' + label)
    const value = await action()
    if (value) return value
    await delay(100)
  }
  throw Error('Bounded observation exceeded: ' + label)
}
async function storageFiles(directory) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const result = []
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await storageFiles(target)))
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(target)
  }
  return result
}
async function noTerminalStorage(label) {
  const files = await storageFiles(userData)
  const selected = files.filter((file) =>
    /conversation\.json$|[\\/]task-checkpoints[\\/]/.test(file)
  )
  for (const file of selected) {
    const text = await fs.readFile(file, 'utf8')
    assert.equal(text.includes(marker), false, 'PTY marker absent: ' + file)
    assert.equal(text.includes('terminalSessionId'), false, 'No terminal checkpoint field: ' + file)
  }
  report.checks.push({
    name: label,
    pass: true,
    storedFiles: selected.map((file) => path.relative(userData, file))
  })
}
async function screenshot(label) {
  const screen = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
  await fs.writeFile(path.join(evidence, label + '.png'), Buffer.from(screen.data, 'base64'))
}
try {
  await fs.mkdir(userData, { recursive: true })
  const taskRoot = path.join(evidence, 'task-root')
  const initialDirectory = path.join(taskRoot, 'lesson59-fixture', 'workspace')
  const secondDirectory = path.join(taskRoot, 'lesson59-passive', 'workspace')
  await fs.mkdir(initialDirectory, { recursive: true })
  await fs.mkdir(secondDirectory, { recursive: true })
  const previewPath = path.join(initialDirectory, 'preview.txt')
  await fs.writeFile(previewPath, 'LESSON59_REAL_FILE_PREVIEW\nIndependent local text file.\n')
  const conversation = (id, title, defaultDirectory, messages = []) => ({
    id,
    title,
    pinned: false,
    archived: false,
    defaultDirectory,
    agentMode: 'execute',
    messages,
    toolRuns: [],
    workspace: null,
    tasks: []
  })
  const fixture = {
    version: 9,
    activeConversationId: 'lesson59-fixture',
    conversations: [
      conversation('lesson59-fixture', '第59课独立终端基线', initialDirectory, [
        {
          id: 'fixture-user',
          role: 'user',
          mode: 'execute',
          content: '固定基线记录。',
          status: 'complete'
        },
        {
          id: 'fixture-assistant',
          role: 'assistant',
          mode: 'execute',
          content: '[查看固定预览](/' + previewPath.replaceAll('\\', '/') + ':1)',
          status: 'complete'
        }
      ]),
      conversation('lesson59-passive', '第59课被动切换对照', secondDirectory)
    ]
  }
  await fs.writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        taskRoot,
        defaultPermissionMode: 'default',
        terminalShell: 'powershell'
      },
      null,
      2
    )
  )
  await fs.writeFile(path.join(userData, 'conversation.json'), JSON.stringify(fixture, null, 2))
  beforeArtifacts = await identify()
  await fs.writeFile(
    path.join(evidence, 'before-artifacts.json'),
    JSON.stringify(beforeArtifacts, null, 2)
  )
  const mainPort = await freePort(),
    rendererPort = await freePort()
  const env = {
    ...process.env,
    APPDATA: path.join(evidence, 'appdata'),
    LOCALAPPDATA: path.join(evidence, 'localappdata')
  }
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'NODE_OPTIONS',
    'MODEL_ENDPOINT',
    'MODEL_NAME',
    'MODEL_API_KEY'
  ])
    delete env[name]
  await fs.mkdir(env.APPDATA, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
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
  log = await fs.open(path.join(evidence, 'desktop.log'), 'w')
  child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd]
  })
  child.on('error', (error) => report.failures.push({ message: error.message }))
  report.processes.push({ pid: child.pid, executable, args, exitCode: null, forcedKill: false })
  console.log(
    JSON.stringify({
      evidence,
      packaged,
      pid: child.pid,
      actualPTY: true,
      syntheticTransport: true
    })
  )
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
  await until(() => main.events.find((event) => event.method === 'Debugger.paused'), 'entry pause')
  const injected = await main.cdp('Runtime.evaluate', {
    expression:
      '(' +
      install.toString() +
      ')(' +
      JSON.stringify({ root, userData, auditFile }) +
      ');globalThis.__lesson59FixtureReady',
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
  evaluate = async (expression) => {
    const result = await renderer.cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description ?? 'Renderer observation failed')
    return result.result.value
  }
  const audit = () => evaluate('window.electron.ipcRenderer.invoke("lesson59:observation")')
  const click = async (selector) => {
    await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()')
    await delay(100)
  }
  const idle = () =>
    until(
      () =>
        evaluate(
          '!!document.getElementById("chat-input")&&!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成]")'
        ),
      'idle'
    )
  const open = async () => {
    await click('#terminal-panel-toggle')
    await until(
      () =>
        evaluate(
          '!!document.querySelector("#terminal-panel .terminal-host .xterm")&&[...document.querySelectorAll("#terminal-panel button")].some(n=>n.textContent==="启动终端"&&!n.disabled)'
        ),
      'terminal initialization'
    )
  }
  const start = async () => {
    await evaluate(
      '[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").click()'
    )
    await until(
      () =>
        evaluate(
          'document.querySelector("#terminal-panel .terminal-toolbar").textContent.includes("运行中")'
        ),
      'real shell start'
    )
    return (await audit()).terminals.at(-1)
  }
  const input = async (command) => {
    await evaluate('document.querySelector("#terminal-panel .xterm-helper-textarea").focus()')
    await renderer.cdp('Input.insertText', { text: command })
    await renderer.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
    await renderer.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
  }
  // The input contains separate literals so terminal echo of typed text cannot prove execution.
  const echoMarker = (suffix = '') => "echo ('zonecodex-terminal-' + '59-" + uuid + suffix + "')"
  await idle()
  const baselineBytes = await fs.readFile(path.join(userData, 'conversation.json'), 'utf8')
  const permissionBefore = await evaluate('window.api.getExecutionPermissions()')
  await open()
  assert.equal(
    (await audit()).terminals.length,
    0,
    'Opening the panel does not start shell implicitly'
  )
  const first = await start()
  assert.ok(alive(first.pid), 'Observed real shell PID is alive')
  assert.equal(
    first.cwd.toLowerCase(),
    process.env.USERPROFILE.toLowerCase(),
    'PTY starts in user home'
  )
  await input(echoMarker())
  await until(async () => (await audit()).terminals[0].output.includes(marker), 'real PTY output')
  await until(
    () =>
      evaluate(
        '[...document.querySelectorAll(".xterm-rows > div")].some(n=>n.textContent.trim()===' +
          JSON.stringify(marker) +
          ')'
      ),
    'xterm rendered echoed output line distinct from command input'
  )
  const metrics = await evaluate(
    '(()=>{const h=document.querySelector(".terminal-host");const s=document.querySelector(".terminal-toolbar span");return {width:h.clientWidth,height:h.clientHeight,size:s.textContent,output:document.querySelector(".xterm-rows").textContent}})()'
  )
  assert.ok(metrics.width > 0 && metrics.height > 0)
  assert.match(metrics.size, /[0-9]+ 列 × [0-9]+ 行/)
  const duplicate = await evaluate(
    'window.api.startTerminal("lesson59-duplicate",{cols:80,rows:24})'
  )
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /当前窗口已有终端/)
  assert.equal((await audit()).terminals.length, 1)
  assert.equal(await fs.readFile(path.join(userData, 'conversation.json'), 'utf8'), baselineBytes)
  assert.deepEqual(await evaluate('window.api.getExecutionPermissions()'), permissionBefore)
  await screenshot('terminal-real-output')
  report.checks.push({
    name: 'real PowerShell output reaches rendered xterm; bounded nonzero size; duplicate start creates no extra PTY; no disk or permission change',
    pass: true,
    pid: first.pid,
    metrics
  })
  await click('.markdown-file-reference')
  await until(
    () =>
      evaluate(
        'document.querySelector(".file-view-panel")?.textContent.includes("LESSON59_REAL_FILE_PREVIEW")'
      ),
    'actual local file preview'
  )
  await screenshot('terminal-with-file-preview')
  await evaluate(
    'document.querySelector("#terminal-panel .xterm-helper-textarea").focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:",",code:"Comma",ctrlKey:true,bubbles:true}))'
  )
  await until(
    () => evaluate('!document.querySelector(".settings-page").hidden'),
    'settings visible'
  )
  const hidden = await evaluate(
    '(()=>{const p=document.querySelector("#terminal-panel");const w=p.closest(".workspace-shell");return {hidden:w.hidden,inert:w.inert,focused:!!document.activeElement?.closest("#terminal-panel"),disabled:document.querySelector("#terminal-panel-toggle").disabled}})()'
  )
  assert.deepEqual(hidden, { hidden: true, inert: true, focused: false, disabled: true })
  assert.equal((await audit()).terminals.length, 1)
  assert.ok(alive(first.pid))
  await screenshot('settings-hidden-terminal')
  await click('.settings-back')
  await click('[aria-label="关闭源码查看"]')
  await click('.conversation-item[title="第59课被动切换对照"]')
  await idle()
  assert.ok(alive(first.pid))
  assert.equal((await audit()).terminals.length, 1)
  await click('.conversation-item[title="第59课独立终端基线"]')
  await idle()
  assert.ok(alive(first.pid))
  await evaluate('window.electron.ipcRenderer.invoke("lesson59:resize-window",680,560)')
  await until(
    () =>
      evaluate('window.innerWidth<=760&&document.querySelector(".terminal-host").clientHeight>0'),
    'narrow layout'
  )
  if (await evaluate('!!document.querySelector(".app-shell.sidebar-open")'))
    await click('.title-bar button[aria-label="收起侧栏"]')
  const narrow = await evaluate(
    '(()=>{const p=document.querySelector("#terminal-panel");const t=document.querySelector("#terminal-panel-toggle");return {windowWidth:innerWidth,windowHeight:innerHeight,panelWidth:p.clientWidth,hostHeight:p.querySelector(".terminal-host").clientHeight,toggleWidth:t.clientWidth,size:p.querySelector(".terminal-toolbar span").textContent}})()'
  )
  assert.ok(narrow.panelWidth > 0 && narrow.hostHeight > 0 && narrow.toggleWidth > 0)
  await screenshot('terminal-narrow-window')
  await evaluate('window.electron.ipcRenderer.invoke("lesson59:resize-window",1280,850)')
  await delay(250)
  const terminalOnly = await audit()
  const counts = Object.fromEntries(
    ['main', 'summary', 'title', 'approval'].map((name) => [
      name,
      terminalOnly.requests.filter((request) => request.category === name).length
    ])
  )
  counts.start = terminalOnly.ipc.filter((item) => item.channel === 'agent:start').length
  counts.resume = terminalOnly.ipc.filter((item) => item.channel === 'agent:resume').length
  assert.deepEqual(counts, { main: 0, summary: 0, title: 0, approval: 0, start: 0, resume: 0 })
  assert.equal(terminalOnly.terminals[0].killCalls, 0)
  const passiveSnapshot = (await evaluate('window.api.loadConversation()')).snapshot
  assert.deepEqual(passiveSnapshot.conversations, fixture.conversations)
  assert.equal(await evaluate('window.api.getPendingExecutionApproval()'), null)
  await fs.writeFile(
    path.join(evidence, 'terminal-only-audit.json'),
    JSON.stringify(terminalOnly, null, 2)
  )
  report.checks.push({
    name: 'settings hide and inert terminal; passive conversation changes retain same PTY; file preview and narrow layout coexist; terminal-only main/summary/title/approval/start/resume all zero',
    pass: true,
    counts,
    hidden,
    narrow
  })
  await noTerminalStorage(
    'terminal-only data absent from actual conversation/checkpoint/raw storage'
  )
  const submit = async (prompt) => {
    await evaluate(
      '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,' +
        JSON.stringify(prompt) +
        ');n.dispatchEvent(new Event("input",{bubbles:true}));})()'
    )
    await delay(100)
    await evaluate('document.querySelector(".composer").requestSubmit()')
  }
  await submit('请调用当前时间工具读取香港时间。')
  await until(async () => (await audit()).requests.length >= 2, 'fixed time tool business')
  await idle()
  const completed = await audit()
  const timeEvent = completed.events.find(
    (event) =>
      event.channel === 'agent:tool-event' &&
      event.value.callId === 'lesson59-current-time' &&
      event.value.phase === 'finish'
  )
  assert.equal(JSON.parse(timeEvent.value.output).ok, true)
  assert.equal(JSON.parse(timeEvent.value.output).timeZone, 'Asia/Hong_Kong')
  assert.match(JSON.parse(timeEvent.value.output).utc, /^20[0-9]{2}-/)
  assert.ok(alive(first.pid))
  await submit('启动第二条合成等待任务，随后由用户停止。')
  await until(
    async () => (await audit()).requests.some((request) => request.waitingForCancellation),
    'agent busy synthetic request'
  )
  await input(echoMarker('-busy'))
  await until(
    async () => (await audit()).terminals[0].output.includes(marker + '-busy'),
    'PTY input during Agent busy'
  )
  await click('button[aria-label="停止生成"]')
  await idle()
  const stopped = await audit()
  assert.ok(stopped.requests[2].cancelled)
  assert.equal(stopped.terminals[0].killCalls, 0)
  assert.ok(alive(first.pid), 'Stopping Agent preserves real user shell')
  assert.ok(
    stopped.requests.every((request) =>
      request.toolNames.every((name) => !/terminal|pty|shell/i.test(name))
    )
  )
  assert.equal(
    JSON.stringify(stopped.requests).includes(marker),
    false,
    'PTY marker never enters model input'
  )
  await screenshot('agent-stopped-terminal-alive')
  report.checks.push({
    name: 'actual get_current_time business completes over synthetic transport; PTY operates during Agent busy; stopping Agent preserves same real shell',
    pass: true,
    counts: { main: 3, summary: 0, title: 0, approval: 0 },
    timeResult: JSON.parse(timeEvent.value.output),
    shellPid: first.pid
  })
  await click('#terminal-panel-close')
  await until(() => !alive(first.pid), 'panel close shell exit')
  await until(async () => (await audit()).terminals[0].exit !== null, 'panel close real onExit')
  assert.equal(await evaluate('!!document.querySelector("#terminal-panel")'), false)
  for (let round = 0; round < 4; round++) {
    await open()
    await evaluate(
      '[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").click();document.querySelector("#terminal-panel-close").click()'
    )
    await until(async () => (await audit()).terminals.length >= round + 2, 'rapid start observed')
    const quick = (await audit()).terminals.at(-1)
    await until(() => !alive(quick.pid), 'rapid toggle shell exit')
  }
  const beforeFault = await audit()
  await evaluate('window.electron.ipcRenderer.invoke("lesson59:synthetic-terminal-failure")')
  await open()
  await evaluate(
    '[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").click()'
  )
  await until(
    () =>
      evaluate(
        '!!document.querySelector("#terminal-panel .terminal-error")&&[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").disabled'
      ),
    'synthetic failed startup keeps uncertain session blocked'
  )
  const faultError = await evaluate(
    'document.querySelector("#terminal-panel .terminal-error").textContent'
  )
  assert.ok(faultError.length > 0 && faultError.length <= 300)
  assert.ok(await evaluate('!!document.querySelector("#terminal-panel")'))
  const uncertain = (await audit()).terminals.at(-1)
  assert.ok(
    alive(uncertain.pid),
    'Real PTY remains alive after failed startup reply and first close'
  )
  assert.equal(uncertain.killCalls, 0)
  await screenshot('synthetic-startup-cleanup-failure')
  await click('#terminal-panel-close')
  await until(
    () => evaluate('!document.querySelector("#terminal-panel")'),
    'synthetic retained ID close retry'
  )
  const afterFault = await audit()
  const faultIPC = afterFault.ipc
    .slice(beforeFault.ipc.length)
    .filter((item) => item.channel.startsWith('terminal:'))
  const faultStart = faultIPC.find((item) => item.channel === 'terminal:start')
  const faultCloses = faultIPC.filter((item) => item.channel === 'terminal:close')
  assert.ok(faultStart)
  assert.ok(faultCloses.length >= 2)
  assert.ok(faultCloses.every((item) => item.args[0] === faultStart.args[0]))
  assert.equal(afterFault.terminals.length, beforeFault.terminals.length + 1)
  await until(() => !alive(uncertain.pid), 'same-ID retry kills real uncertain shell')
  assert.equal(afterFault.terminals.at(-1).killCalls, 1)
  assert.equal(afterFault.requests.length, beforeFault.requests.length)
  report.checks.push({
    name: 'synthetic startup response rejection and first close failure retain same session ID, disable restart, bound error and allow successful close retry',
    pass: true,
    syntheticTerminalFault: true,
    actualPTY: true,
    shellPid: uncertain.pid,
    errorLength: faultError.length,
    sessionId: faultStart.args[0],
    closeAttempts: faultCloses.length
  })
  await open()
  const last = await start()
  assert.ok(alive(last.pid))
  await input(echoMarker('-window'))
  await until(
    async () => (await audit()).terminals.at(-1).output.includes(marker + '-window'),
    'window-close shell marker'
  )
  await noTerminalStorage(
    'after Agent business and interruption PTY data absent from actual conversation/checkpoint/raw storage'
  )
  await screenshot('terminal-before-window-destroy')
  await evaluate('void window.electron.ipcRenderer.invoke("lesson59:destroy-window");true')
  await until(() => !alive(last.pid), 'window destruction shell exit', 30000, true)
  await until(
    async () => JSON.parse(await fs.readFile(auditFile, 'utf8')).windowDestroyed,
    'window destruction observation',
    30000,
    true
  )
  windowDestroyed = true
  const finalAudit = JSON.parse(await fs.readFile(auditFile, 'utf8'))
  assert.ok(
    finalAudit.terminals.every((terminal) => !alive(terminal.pid) && terminal.killCalls > 0)
  )
  report.checks.push({
    name: 'panel close, four rapid start/close cycles and real BrowserWindow.destroy retire all actual shell PIDs',
    pass: true,
    shells: finalAudit.terminals.map(({ pid, killCalls, exit }) => ({ pid, killCalls, exit }))
  })
  await until(
    () => finalAudit.helpers.every((helper) => !alive(helper.pid)),
    'node-pty helper processes retired',
    15000,
    true
  )
  report.checks.push({
    name: 'actual node-pty process-list helpers retired',
    pass: true,
    helpers: finalAudit.helpers
  })
  assert.deepEqual(await identify(), beforeArtifacts)
  report.checks.push({
    name: 'inspected executable and build artifacts remain unchanged during check',
    pass: true,
    artifacts: beforeArtifacts
  })
  report.pass = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
  if (evaluate) {
    try {
      await fs.writeFile(
        path.join(evidence, 'diagnostic.txt'),
        await evaluate('document.body.innerText')
      )
      await screenshot('failed-state')
    } catch {
      /* Preserve original failure when renderer is gone. */
    }
  }
} finally {
  if (evaluate && child?.exitCode === null && !windowDestroyed) {
    try {
      await evaluate('window.electron.ipcRenderer.invoke("lesson59:quit")')
    } catch {
      /* Window may already have been deliberately destroyed. */
    }
  }
  renderer?.socket.close()
  main?.socket.close()
  if (child?.exitCode === null)
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
  if (child?.exitCode === null) {
    report.processes[0].forcedKill = true
    child.kill()
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
  }
  if (child) report.processes[0].exitCode = child.exitCode
  await log?.close()
  if (log) {
    const logged = await fs.readFile(path.join(evidence, 'desktop.log'), 'utf8')
    report.nativeDiagnostics = {
      attachConsoleFailures: (logged.match(/Error: AttachConsole failed/g) ?? []).length,
      explanation:
        'node-pty process-list helper can lose AttachConsole race after the native kill has already ended the shell. Full stderr is retained; actual shell and helper PID retirement are checked independently.'
    }
  }
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      packaged,
      failures: report.failures.map((item) => item.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
