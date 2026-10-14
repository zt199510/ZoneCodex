import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const moduleRequire = createRequire(import.meta.url)
const { install } = moduleRequire('./desktop-fixture.cjs')
const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((argument) => argument === '--packaged'))
assert.equal(process.platform, 'win32', 'Real lesson60 desktop validation requires Windows')
const uuid = randomUUID()
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson60',
  'desktop-' + (packaged ? 'packaged-' : 'development-') + uuid
)
const userData = path.join(evidence, 'user-data')
const taskRoot = path.join(evidence, 'task-root')
const project = path.join(taskRoot, 'lesson60-fixture', 'workspace')
const protectedDirectory = path.join(evidence, 'controlled-outside-writable-root')
const marker = 'zonecodex-terminal-60-' + uuid
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 330000
const terminalStatuses = ['completed', 'cancelled', 'failed', 'timed_out', 'interrupted']
const report = {
  pass: false,
  evidence,
  uuid,
  packaged,
  marker,
  realTransport: false,
  syntheticTransport: true,
  actualElectron: true,
  actualPTY: true,
  observerMovedToUtility: true,
  actualDiskStorage: true,
  uiInput:
    'Chat, permission, plan and stop controls use trusted CDP mouse/key input. The currently unmounted terminal panel is exercised through the real public preload startTerminal/writeTerminal API, with separately observed actual PowerShell PTY output. Observation/faults and modal whole-task cancellation use separately labelled existing APIs.',
  checks: [],
  failures: [],
  processes: [],
  notCovered: [
    'The baseline App does not mount TerminalPanel, ChatHeader or WorkspaceStatus. Legacy terminal-panel mouse/keyboard interaction, manual header save, clear-current-conversation confirmation and workspace status text are not covered. Current autosave, plan controls and stop controls are exercised; real terminal APIs retain the PTY isolation/retirement assertions.',
    'No real model or reviewer networking. SSE responses, held replies, reply failures and stale event replay are synthetic.',
    'The approval dialog is modal and contains no whole-task stop control. Whole-task cancellation during that wait uses the legal existing cancelAgentRequest API and is not claimed as an outside UI click.',
    'PTY command output, the helper-reported public native exit and actual utility-process retirement are observed. Shell PIDs, Conout Workers, process-list helpers and native module loads inside the utility process are not directly observed; native HPCON/pipe handles and arbitrary command descendants remain outside this evidence.',
    'The initial orphan TaskRecord is an explicitly synthetic historical fixture. New-PID checkpoint/history reopening uses records actually saved after real owner cancellation.'
  ]
}
const check = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail })
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function identify() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'scripts/node-pty-cleanup/manifest.json'), 'utf8')
  )
  assert.equal(manifest.package, 'node-pty')
  assert.equal(manifest.version, '1.1.0')
  assert.equal(Object.keys(manifest.files).length, 5)
  const mainBuildNames = ['out/main/index.js', 'out/main/terminal-host.js']
  const artifactNames = packaged
    ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar', ...mainBuildNames]
    : [...mainBuildNames, 'out/preload/index.js', 'out/renderer/index.html']
  const cleanupNames = Object.keys(manifest.files).map(
    (name) => 'node_modules/node-pty/lib/' + name.replaceAll('\\', '/')
  )
  const identities = Object.fromEntries(
    await Promise.all(
      [
        ...artifactNames,
        ...cleanupNames,
        'scripts/node-pty-cleanup/manifest.json',
        'tests/lesson60/desktop-check.mjs',
        'tests/lesson60/desktop-fixture.cjs'
      ].map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  for (const [index, identity] of Object.values(manifest.files).entries())
    assert.equal(identities[cleanupNames[index]], identity.patchedSha256)
  if (packaged) {
    const { extractFile } = moduleRequire('@electron/asar')
    for (const name of [...cleanupNames, ...mainBuildNames]) {
      const internal = hash(
        extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))
      )
      assert.equal(
        internal,
        identities[name],
        'Directory-package built entry/helper and node-pty cleanup identity: ' + name
      )
      identities['app.asar:' + name] = internal
    }
  }
  return identities
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
          reject(Error('Bounded inspector request: ' + method))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function filesUnder(directory) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(filename)))
    else if (entry.isFile()) files.push(filename)
  }
  return files
}
async function assertTerminalIsolation(audit, label) {
  assert.equal(
    JSON.stringify(audit.requests).includes(marker),
    false,
    'PTY output absent from all main/summary/title/reviewer inputs'
  )
  const files = (await filesUnder(userData)).filter((filename) =>
    /conversation\.json$|[\\/]task-checkpoints[\\/]/.test(filename)
  )
  for (const filename of files) {
    const text = await fs.readFile(filename, 'utf8')
    assert.equal(text.includes(marker), false, 'PTY marker absent in real saved data: ' + filename)
    assert.equal(text.includes('terminalSessionId'), false)
    if (filename.endsWith('.checkpoint.json')) {
      const checkpoint = JSON.parse(text)
      for (const key of [
        'approvalId',
        'grantId',
        'executionId',
        'scopeId',
        'terminalSessionId',
        'readEvidence'
      ])
        assert.equal(Object.hasOwn(checkpoint, key), false)
    }
  }
  check(label, {
    modelInputs: audit.requests.length,
    files: files.map((filename) => path.relative(userData, filename))
  })
}
let originalSnapshot, stoppedCheckpoint, stoppedStart, oldApproval, oldQuestion, beforeArtifacts
const initialOrphan = {
  taskId: 'lesson60-synthetic-orphan',
  requestId: 'lesson60-synthetic-orphan-request',
  conversationId: 'lesson60-fixture',
  kind: 'agent',
  status: 'waiting_input',
  createdAt: '2026-10-11T00:00:00.000Z',
  startedAt: '2026-10-11T00:00:00.000Z',
  finishedAt: null,
  result: null,
  error: null
}
async function launch(stage, action) {
  const auditFile = path.join(evidence, stage + '-audit.json')
  const log = await fs.open(path.join(evidence, stage + '-desktop.log'), 'w')
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
  const child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd]
  })
  const processResult = {
    stage,
    pid: child.pid,
    executable,
    args,
    exitCode: null,
    forcedKill: false
  }
  report.processes.push(processResult)
  console.log(
    JSON.stringify({ evidence, stage, pid: child.pid, packaged, syntheticTransport: true })
  )
  let main, renderer, evaluate
  const until = async (observe, label, ms = 30000, allowExited = false) => {
    for (const end = Math.min(Date.now() + ms, deadline); Date.now() < end;) {
      if (!allowExited && child.exitCode !== null) throw Error('Owned app exited during ' + label)
      const value = await observe()
      if (value) return value
      await delay(100)
    }
    throw Error('Bounded observation exceeded: ' + label)
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
      () => main.events.find((event) => event.method === 'Debugger.paused'),
      'entry pause'
    )
    const injected = await main.cdp('Runtime.evaluate', {
      expression:
        '(' +
        install.toString() +
        ')(' +
        JSON.stringify({ root, userData, auditFile, stage }) +
        ');globalThis.__lesson60FixtureReady',
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
      const value = await renderer.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (value.exceptionDetails)
        throw Error(value.exceptionDetails.exception?.description ?? 'Renderer observation failed')
      return value.result.value
    }
    const api = (name, ...args) =>
      evaluate('window.api[' + JSON.stringify(name) + '](...' + JSON.stringify(args) + ')')
    const invoke = (channel, ...args) =>
      evaluate(
        'window.electron.ipcRenderer.invoke(' +
          JSON.stringify(channel) +
          ',...' +
          JSON.stringify(args) +
          ')'
      )
    const audit = () => invoke('lesson60:observation')
    const configure = (value) => invoke('lesson60:configure', value)
    const replay = (channel, value) => invoke('lesson60:replay', channel, value)
    const screenshot = async (label) => {
      const shot = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(
        path.join(evidence, stage + '-' + label + '.png'),
        Buffer.from(shot.data, 'base64')
      )
    }
    const click = async (selector) => {
      const position = await evaluate(
        '(()=>{const n=document.querySelector(' +
          JSON.stringify(selector) +
          ');if(!n)throw Error("Missing click target");if(n.disabled)throw Error("Disabled click target");n.scrollIntoView({block:"nearest",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!(hit===n||n.contains(hit)))throw Error("Target blocked by another UI surface: "+' +
          JSON.stringify(selector) +
          ');return {x,y}})()'
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
    const idle = () =>
      until(
        () =>
          evaluate(
            '!!document.getElementById("chat-input")&&!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成],button[aria-label=正在停止]")'
          ),
        'idle'
      )
    const save = async () => {
      const expected = await evaluate(
        '[...document.querySelectorAll(".message")].map(n=>({id:n.dataset.messageId,status:n.dataset.status}))'
      )
      const title = await evaluate(
        'document.querySelector(".conversation-item[aria-current=page]").title'
      )
      const liveTasks = await api('listTasks')
      // Read the isolated file directly: loadConversation restores directory grants and
      // repeated IPC reads can change their identities during the actual autosave.
      return until(async () => {
        const snapshot = JSON.parse(
          await fs.readFile(path.join(userData, 'conversation.json'), 'utf8')
        )
        const active = snapshot.conversations.find((item) => item.title === title)
        const tasks = snapshot.conversations.flatMap((item) => item.tasks)
        return active &&
          snapshot.activeConversationId === active.id &&
          active.messages.length === expected.length &&
          expected.every((visible) =>
            active.messages.some(
              (message) => message.id === visible.id && message.status === visible.status
            )
          ) &&
          tasks.find((task) => task.taskId === initialOrphan.taskId)?.status === 'interrupted' &&
          liveTasks.every((task) =>
            tasks.some((saved) => saved.taskId === task.taskId && saved.status === task.status)
          )
          ? snapshot
          : null
      }, 'actual autosaved messages and owner task states')
    }
    const mode = async (value) => {
      assert.ok(['execute', 'plan'].includes(value))
      const planning = await evaluate('!!document.querySelector(".composer-plan-indicator")')
      if ((value === 'plan') !== planning) {
        if (value === 'plan') {
          await click('button[aria-label="添加附件"]')
          await click('.attachment-popover:popover-open .composer-plan-option')
        } else await click('button[aria-label="退出计划模式"]')
      }
      await idle()
      assert.equal(
        await evaluate('!!document.querySelector(".composer-plan-indicator")'),
        value === 'plan'
      )
    }
    const permissions = async (value) => {
      await click('.composer-permissions .permissions-trigger')
      await click('.composer-permissions .permissions-popover [data-mode="' + value + '"]')
    }
    const submit = async (prompt) => {
      await idle()
      await click('#chat-input')
      await renderer.cdp('Input.insertText', { text: prompt })
      await until(
        () => evaluate('!document.querySelector("button[aria-label=发送消息]").disabled'),
        'send enabled'
      )
      await click('button[aria-label="发送消息"]')
    }
    const startScenario = async (name, extra = {}) => {
      await configure({ scenario: { name, ...extra } })
      await submit('第60课隔离验证：' + name + '。按当前权限执行固定受控步骤。')
    }
    const startIPC = async (name) =>
      (await audit()).ipc.findLast(
        (item) => item.channel === 'agent:start' && item.scenario === name
      )
    const ownedTask = async (start) =>
      (await api('listTasks')).find((task) => task.requestId === start.args[0])
    const waitTask = async (start, status) =>
      until(async () => {
        const task = await ownedTask(start)
        return task?.status === status ? task : null
      }, 'owner status ' + status)
    const busy = async (label) => {
      assert.equal(
        await evaluate(
          'document.querySelector(".composer-permissions .permissions-trigger").disabled'
        ),
        true
      )
      const before = await api('getExecutionPermissions'),
        tasks = await api('listTasks')
      const rejected = await evaluate(
        'window.api.setExecutionPermissions("full-access").then(()=>({accepted:true}),e=>({accepted:false,error:e.message}))'
      )
      assert.equal(rejected.accepted, false)
      assert.match(rejected.error, /当前任务结束/)
      assert.deepEqual(await api('getExecutionPermissions'), before)
      assert.deepEqual(await api('listTasks'), tasks)
      check(label, { actualMainIPC: true, permissions: before, taskCount: tasks.length })
    }
    let terminalHost
    const openTerminal = async () => {
      const sessionId = randomUUID()
      assert.deepEqual(await api('startTerminal', sessionId, { cols: 100, rows: 24 }), { ok: true })
      await until(async () => {
        const observed = await audit()
        return observed.utilityHosts.some((host) => host.sessionId === sessionId && host.ready)
      }, 'actual public terminal API starts PowerShell PTY')
      const opened = await audit()
      assert.equal(opened.observerMovedToUtility, true)
      assert.equal(opened.testOverridesUtilityHostForkArguments, false)
      terminalHost = opened.utilityHosts.at(-1)
      assert.ok(terminalHost.spawned && terminalHost.ready && terminalHost.sessionId)
      assert.equal(terminalHost.serviceName, 'ZoneCodex Terminal')
      assert.ok(alive(terminalHost.pid))
      assert.equal(terminalHost.nativeExit, null)
      assert.equal(terminalHost.exitedAtUTC, null)
      assert.equal(terminalHost.sessionId, sessionId)
      return terminalHost
    }
    const echo = async (suffix) => {
      const before = await audit()
      const requests = before.requests.length
      const launches = before.ipc.filter((item) =>
        ['agent:start', 'agent:resume'].includes(item.channel)
      ).length
      const authorityChannels =
        /^(agent:resolve-execution|agent:start$|agent:resume$|execution:approval-respond|agent:user-input-respond|command-directory:|command-execution:|workspace:|project:)/
      const authorityCalls = before.ipc.filter((item) =>
        authorityChannels.test(item.channel)
      ).length
      assert.deepEqual(
        await api(
          'writeTerminal',
          terminalHost.sessionId,
          "echo ('zonecodex-terminal-' + '60-" + uuid + '-' + suffix + "')\r"
        ),
        { ok: true }
      )
      const observed = await until(async () => {
        const value = await audit()
        return value.utilityHosts
          .find(
            (host) => host.pid === terminalHost.pid && host.sessionId === terminalHost.sessionId
          )
          ?.output.includes(marker + '-' + suffix)
          ? value
          : null
      }, 'executed PTY echo ' + suffix)
      const currentHost = observed.utilityHosts.find(
        (host) => host.pid === terminalHost.pid && host.sessionId === terminalHost.sessionId
      )
      assert.ok(alive(currentHost.pid))
      assert.equal(currentHost.nativeExit, null)
      assert.equal(currentHost.exitedAtUTC, null)
      assert.ok(currentHost.dataMessages > 0)
      assert.equal(
        observed.ipc.filter(
          (item) => item.channel === 'terminal:close' && item.args[0] === terminalHost.sessionId
        ).length,
        0
      )
      assert.equal(observed.requests.length, requests)
      assert.equal(
        observed.ipc.filter((item) => ['agent:start', 'agent:resume'].includes(item.channel))
          .length,
        launches
      )
      assert.equal(
        observed.ipc.filter((item) => authorityChannels.test(item.channel)).length,
        authorityCalls
      )
      check('same real PowerShell PTY survives ' + suffix + ' with zero new Agent calls', {
        stage,
        utilityHostPid: terminalHost.pid,
        sessionId: terminalHost.sessionId,
        actualPublicPreloadAPI: true,
        terminalPanelUI: false,
        actualNativePTYOutput: true,
        shellPidDirectlyObserved: false
      })
    }
    const blockedSend = async (label) => {
      assert.equal(
        await evaluate(
          'document.querySelector(".composer-permissions .permissions-trigger").dataset.mode'
        ),
        'unknown'
      )
      assert.equal(
        await evaluate(
          'document.querySelector(".composer-permissions .permissions-trigger").disabled'
        ),
        true
      )
      assert.equal(await evaluate('document.getElementById("chat-input").disabled'), true)
      const before = await audit()
      // Deliberate synthetic form event checks the real request guard while ordinary controls are disabled.
      await evaluate(
        '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,"未知权限不得发送");n.dispatchEvent(new Event("input",{bubbles:true}));})()'
      )
      await delay(100)
      await evaluate('document.querySelector(".composer").requestSubmit()')
      await delay(200)
      const after = await audit()
      assert.equal(after.requests.length, before.requests.length)
      assert.equal(
        after.ipc.filter((item) =>
          ['agent:start', 'agent:resume', 'agent:resolve-execution'].includes(item.channel)
        ).length,
        before.ipc.filter((item) =>
          ['agent:start', 'agent:resume', 'agent:resolve-execution'].includes(item.channel)
        ).length
      )
      await evaluate(
        '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,"");n.dispatchEvent(new Event("input",{bubbles:true}));})()'
      )
      check(label, { syntheticFormSubmission: true, actualNoStartOrResolve: true })
    }
    await idle()
    await action({
      child,
      stage,
      api,
      invoke,
      audit,
      until,
      evaluate,
      click,
      idle,
      save,
      mode,
      permissions,
      submit,
      startScenario,
      startIPC,
      ownedTask,
      waitTask,
      busy,
      openTerminal,
      echo,
      configure,
      replay,
      screenshot,
      blockedSend
    })
    await assertTerminalIsolation(
      await audit(),
      stage +
        ': PTY absent from model/reviewer input, actual conversation/raw/checkpoint; no persisted authority'
    )
    await screenshot('final')
  } catch (error) {
    if (evaluate) {
      try {
        await fs.writeFile(
          path.join(evidence, stage + '-diagnostic.txt'),
          await evaluate('document.body.innerText')
        )
        const shot = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
        await fs.writeFile(
          path.join(evidence, stage + '-failed.png'),
          Buffer.from(shot.data, 'base64')
        )
      } catch {
        /* Preserve the initial failure. */
      }
    }
    throw error
  } finally {
    if (evaluate && child.exitCode === null) {
      try {
        await evaluate('window.electron.ipcRenderer.invoke("lesson60:quit")')
      } catch {
        /* Window may already be gone. */
      }
    }
    main?.socket.close()
    renderer?.socket.close()
    if (child.exitCode === null)
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(15000)])
    if (child.exitCode === null) {
      processResult.forcedKill = true
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    }
    processResult.exitCode = child.exitCode
    await log.close()
    const diagnostics = await fs.readFile(path.join(evidence, stage + '-desktop.log'), 'utf8')
    processResult.attachConsoleFailures = (diagnostics.match(/AttachConsole failed/g) ?? []).length
  }
  assert.equal(
    processResult.forcedKill,
    false,
    'Production terminal quit barrier needs no forced app termination'
  )
  assert.equal(child.exitCode, 0, 'Real application exits normally')
  assert.equal(
    processResult.attachConsoleFailures,
    0,
    'Retained logs contain zero AttachConsole failures'
  )
  const finalAudit = JSON.parse(await fs.readFile(auditFile, 'utf8'))
  await until(
    () => finalAudit.utilityHosts.every((host) => host.exitedAtUTC !== null && !alive(host.pid)),
    'actual utility-host process retirement',
    10000,
    true
  )
  assert.equal(finalAudit.observerMovedToUtility, true)
  assert.ok(finalAudit.utilityHosts.length >= 1)
  assert.ok(
    finalAudit.utilityHosts.every(
      (host) =>
        host.spawned &&
        host.ready &&
        host.dataMessages > 0 &&
        Number.isInteger(host.nativeExit?.exitCode) &&
        host.exitedAtUTC !== null &&
        host.exitCode === 0 &&
        host.errors.length === 0
    )
  )
  assert.ok(
    finalAudit.quitEvents.some(
      (event) => event.type === 'will-quit' && event.unsettledUtilityHosts === 0
    )
  )
  check(
    stage +
      ': normal application quit observes native PTY exit and actual utility-host retirement with zero AttachConsole failure',
    {
      appPid: child.pid,
      utilityHosts: finalAudit.utilityHosts.map(
        ({ pid, sessionId, nativeExit, exitCode, exitedAtUTC }) => ({
          pid,
          sessionId,
          nativeExit,
          exitCode,
          exitedAtUTC
        })
      ),
      observerMovedToUtility: finalAudit.observerMovedToUtility,
      unobservedInternalPTY: finalAudit.unobservedInternalPTY
    }
  )
  return finalAudit
}
try {
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await fs.mkdir(protectedDirectory, { recursive: true })
  const conversation = (id, title, tasks = []) => ({
    id,
    title,
    pinned: false,
    archived: false,
    defaultDirectory: path.join(taskRoot, id, 'workspace'),
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks
  })
  const fixture = {
    version: 9,
    activeConversationId: 'lesson60-fixture',
    conversations: [
      conversation('lesson60-fixture', '第60课隔离一致性', [initialOrphan]),
      conversation('lesson60-passive', '第60课被动切换对照'),
      conversation('lesson60-deletion', '第60课删除旧任务对照')
    ]
  }
  for (const item of fixture.conversations)
    await fs.mkdir(item.defaultDirectory, { recursive: true })
  await fs.writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify(
      { version: 1, taskRoot, defaultPermissionMode: 'default', terminalShell: 'powershell' },
      null,
      2
    )
  )
  await fs.writeFile(path.join(userData, 'conversation.json'), JSON.stringify(fixture, null, 2))
  await fs.writeFile(
    path.join(evidence, 'synthetic-history-fixture.json'),
    JSON.stringify(fixture, null, 2)
  )
  beforeArtifacts = await identify()
  await fs.writeFile(
    path.join(evidence, 'before-artifacts.json'),
    JSON.stringify(beforeArtifacts, null, 2)
  )
  await launch('create', async (ui) => {
    const {
      stage,
      api,
      invoke,
      audit,
      until,
      evaluate,
      click,
      idle,
      save,
      mode,
      permissions,
      startScenario,
      startIPC,
      waitTask,
      busy,
      openTerminal,
      echo,
      configure,
      replay,
      screenshot,
      blockedSend
    } = ui
    const baseline = await api('getExecutionPermissions')
    assert.deepEqual(baseline, { mode: 'default', revision: 0 })
    await openTerminal()
    await echo('baseline')
    await permissions('default')
    await idle()
    assert.deepEqual(await api('getExecutionPermissions'), baseline)
    assert.equal(
      (await audit()).ipc.filter((item) => item.channel === 'execution:permissions-set').length,
      0,
      'Same UI value does not send a change'
    )
    await permissions('full-access')
    await idle()
    assert.deepEqual(await api('getExecutionPermissions'), { mode: 'full-access', revision: 1 })
    await click('.conversation-item[title="第60课被动切换对照"]')
    await idle()
    assert.deepEqual(await api('getExecutionPermissions'), { mode: 'full-access', revision: 1 })
    await click('.conversation-item[title="第60课隔离一致性"]')
    await idle()
    await permissions('default')
    await idle()
    assert.deepEqual(await api('getExecutionPermissions'), { mode: 'default', revision: 2 })
    assert.equal((await audit()).requests.length, 0)
    assert.equal(
      (await audit()).ipc.filter((item) => ['agent:start', 'agent:resume'].includes(item.channel))
        .length,
      0
    )
    check(
      'real idle permission menu, same value, ABA and chat switches preserve window authority with main/summary/title/reviewer/start/resume all zero',
      { first: baseline, last: await api('getExecutionPermissions') }
    )
    const reconciled = await save()
    const orphan = reconciled.conversations[0].tasks.find(
      (task) => task.taskId === initialOrphan.taskId
    )
    assert.equal(orphan.status, 'interrupted')
    check(
      'real renderer reconciliation marks explicitly synthetic historical orphan interrupted without starting Agent',
      { syntheticHistoricalTask: true, actualSavedRecord: orphan }
    )

    const beforeResolve = (await audit()).requests.length
    await configure({ faults: { holdResolve: true } })
    await startScenario('resolve-stop')
    await until(
      async () =>
        (await audit()).synthetic.some(
          (item) => item.kind === 'held-reply' && item.name === 'resolve'
        ),
      'held real resolve result'
    )
    await click('button[aria-label="停止生成"]')
    await idle()
    assert.equal(await invoke('lesson60:release', 'resolve'), true)
    await delay(250)
    assert.equal((await audit()).requests.length, beforeResolve)
    assert.equal(await startIPC('resolve-stop'), undefined)
    await echo('resolve-stop')
    check(
      'real UI stop during execution-context resolution retires placeholder; synthetic late real resolve reply starts no task or model request',
      { syntheticHeldReply: true }
    )

    const rejectTarget = path.join(protectedDirectory, 'rejected.txt')
    await startScenario('reject', { target: rejectTarget })
    await until(
      () => evaluate('!!document.querySelector(".execution-approval[open]")'),
      'actual approval modal'
    )
    const rejectedStart = await startIPC('reject')
    await waitTask(rejectedStart, 'waiting_approval')
    await busy(
      'real approval wait disables permission UI and actual busy main IPC rejects with unchanged revision/tasks'
    )
    assert.equal(
      await evaluate('document.querySelector(".execution-approval-cancel").textContent.trim()'),
      '拒绝本次操作'
    )
    await screenshot('reject-operation')
    await click('.execution-approval-cancel')
    await idle()
    await waitTask(rejectedStart, 'completed')
    assert.equal((await filesUnder(protectedDirectory)).includes(rejectTarget), false)
    const rejectedAudit = await audit()
    assert.equal(
      rejectedAudit.ipc.some(
        (item) => item.channel === 'agent:cancel' && item.args[0] === rejectedStart.args[0]
      ),
      false
    )
    const rejectedOutput = rejectedAudit.events.find(
      (item) =>
        item.channel === 'agent:tool-event' &&
        item.value.requestId === rejectedStart.args[0] &&
        item.value.name === 'create_workspace_file' &&
        item.value.phase === 'finish'
    )
    assert.ok(rejectedOutput)
    assert.equal(JSON.parse(rejectedOutput.value.output).status, 'cancelled')
    await echo('reject-operation')
    check(
      'trusted click rejects one actual file approval without write or whole-task cancel; denied tool result is cancelled while actual Agent owner completes normally',
      { requestId: rejectedStart.args[0], actualFileAbsent: rejectTarget }
    )

    await permissions('auto-approve')
    await idle()
    for (const reviewer of ['risky', 'malformed']) {
      const name = 'review-' + reviewer,
        target = path.join(protectedDirectory, name + '.txt')
      await startScenario(name, { target, reviewer })
      await until(
        () => evaluate('!!document.querySelector(".execution-approval[open]")'),
        'manual fallback ' + reviewer
      )
      assert.ok(
        (await audit()).requests.some(
          (request) => request.scenario === name && request.category === 'approval'
        )
      )
      await click('.execution-approval-cancel')
      await idle()
      assert.equal((await filesUnder(protectedDirectory)).includes(target), false)
      check(
        'synthetic ' +
          reviewer +
          ' risk review requires actual manual approval and real rejection produces no file',
        { syntheticReviewer: true, actualModalAndDisk: true }
      )
    }
    await permissions('default')
    await idle()
    const stoppedTarget = path.join(protectedDirectory, 'late-approval-must-not-create.txt')
    await startScenario('approval-stop', { target: stoppedTarget })
    await until(
      () => evaluate('!!document.querySelector(".execution-approval[open]")'),
      'whole-task approval wait'
    )
    oldApproval = await api('getPendingExecutionApproval')
    const approvalStart = await startIPC('approval-stop')
    assert.equal(await api('cancelAgentRequest', approvalStart.args[0]), true)
    await idle()
    await waitTask(approvalStart, 'cancelled')
    assert.equal(await api('respondToExecutionApproval', oldApproval.approvalId, true), false)
    await replay('execution:approval-change', oldApproval)
    await delay(250)
    assert.equal(await evaluate('!!document.querySelector(".execution-approval[open]")'), false)
    assert.equal(await api('getPendingExecutionApproval'), null)
    assert.equal((await filesUnder(protectedDirectory)).includes(stoppedTarget), false)
    await echo('approval-task-stop')
    check(
      'legal existing cancellation API ends actual modal approval wait; late real response false and synthetic stale event cannot reopen dialog or create file',
      {
        uiWholeTaskStopAvailable: false,
        actualExistingAPI: true,
        syntheticReplay: true,
        requestId: approvalStart.args[0]
      }
    )

    await mode('plan')
    await startScenario('question-stop')
    await until(
      () =>
        evaluate(
          '!!document.querySelector(".plan-question-card")&&!!document.querySelector("button[aria-label=停止生成]")'
        ),
      'real plan question and whole-task stop control'
    )
    const questionStart = await startIPC('question-stop')
    oldQuestion = await api('getPendingAgentUserInput')
    await waitTask(questionStart, 'waiting_input')
    await busy(
      'real question wait disables permission UI and actual main IPC rejects without state mutation'
    )
    await screenshot('waiting-question')
    await click('.plan-question-actions button[type="button"]')
    await idle()
    await waitTask(questionStart, 'cancelled')
    const lateAnswer = {
      requestId: oldQuestion.requestId,
      inputId: oldQuestion.inputId,
      answers: oldQuestion.questions.map((question) => ({
        id: question.id,
        answer: question.options[0].label
      }))
    }
    assert.equal(await invoke('agent:user-input-respond', lateAnswer), false)
    assert.equal(await api('respondToAgentUserInput', lateAnswer), false)
    await replay('agent:user-input-change', oldQuestion)
    await delay(250)
    assert.equal(await evaluate('!!document.querySelector(".plan-question-card")'), false)
    assert.equal(await api('getPendingAgentUserInput'), null)
    await echo('question-task-stop')
    check(
      'trusted plan card stop cancels actual whole task; late main/preload answers rejected and synthetic old question does not restore UI',
      { actualMainResponse: false, syntheticReplay: true }
    )
    await mode('execute')

    await configure({ faults: { cancelFailure: true } })
    await startScenario('running-stop')
    await until(
      async () =>
        (await audit()).requests.some(
          (request) => request.scenario === 'running-stop' && request.waitingForCancellation
        ),
      'running real task synthetic stream'
    )
    const runningStart = await startIPC('running-stop')
    await busy(
      'real running task disables permission UI and busy main IPC preserves mode/revision/tasks'
    )
    await click('button[aria-label="停止生成"]')
    await until(
      () =>
        evaluate(
          'document.body.innerText.includes("停止请求失败")&&!!document.querySelector("button[aria-label=停止生成]:not(:disabled)")'
        ),
      'truthful failed cancellation'
    )
    await waitTask(runningStart, 'running')
    await screenshot('cancel-send-failed')
    check(
      'synthetic cancellation send failure keeps real owner running and restores enabled stop with truthful error',
      { failureBeforeOwner: true }
    )
    await configure({ faults: { cancelFailure: false, cancelFalse: true } })
    await click('button[aria-label="停止生成"]')
    await until(
      async () =>
        (await audit()).synthetic.some((item) => item.kind === 'cancel-false-before-owner'),
      'synthetic legal false cancellation reply'
    )
    await until(
      () =>
        evaluate(
          'document.body.innerText.includes("停止请求未获接受")&&!!document.querySelector("button[aria-label=停止生成]:not(:disabled)")'
        ),
      'false cancellation restores retry control'
    )
    await waitTask(runningStart, 'running')
    assert.equal(await evaluate('!!document.querySelector("button[aria-label=正在停止]")'), false)
    await screenshot('cancel-false-not-accepted')
    check(
      'synthetic legal false cancel reply keeps real owner running and restores enabled retry instead of sticking in stopping or writing a terminal status',
      { actualPreloadBoolean: false, syntheticOwnerNotCalled: true }
    )
    await configure({ faults: { cancelFalse: false, holdAbort: true } })
    await click('button[aria-label="停止生成"]')
    await until(
      () =>
        evaluate(
          '!!document.querySelector("button[aria-label=正在停止]:disabled")&&document.getElementById("chat-input").placeholder.includes("正在请求停止")'
        ),
      'transient stopping UI'
    )
    await waitTask(runningStart, 'running')
    assert.equal(await evaluate('!!document.querySelector("button[aria-label=停止生成]")'), false)
    await screenshot('stopping-before-owner-result')
    assert.equal(await invoke('lesson60:release', 'abort'), true)
    await idle()
    const cancelled = await waitTask(runningStart, 'cancelled')
    await replay('task:state', { record: { ...cancelled, status: 'running', finishedAt: null } })
    await replay('task:state', {
      record: {
        ...cancelled,
        status: 'completed',
        result: 'LESSON60_STALE_COMPLETION',
        error: null
      }
    })
    await replay('agent:message-event', {
      requestId: cancelled.requestId,
      messageId: 'response-99-attempt-0-message-0',
      phase: 'final_answer',
      text: 'LESSON60_STALE_COMPLETION'
    })
    await delay(200)
    const cancelledSnapshot = await save()
    assert.equal(
      cancelledSnapshot.conversations[0].tasks.find((task) => task.taskId === cancelled.taskId)
        .status,
      'cancelled'
    )
    assert.equal(JSON.stringify(cancelledSnapshot).includes('LESSON60_STALE_COMPLETION'), false)
    await echo('running-owner-stop')
    check(
      'transient stopping stays disabled before held transport settles; actual owner cancellation and renderer terminal guard ignore synthetic late running/completed/message events',
      { syntheticAbortHold: true, syntheticReplay: true, taskId: cancelled.taskId }
    )

    await click('.conversation-item[title="第60课删除旧任务对照"]')
    await idle()
    await startScenario('deletion')
    await idle()
    const deletionStart = await startIPC('deletion'),
      deletionTask = await waitTask(deletionStart, 'completed')
    if (await evaluate('!!document.querySelector("button[aria-label=清空对话]")')) {
      await click('button[aria-label="清空对话"]')
      await until(
        () => evaluate('!!document.querySelector(".confirm-dialog[open]")'),
        'actual clear confirmation'
      )
      await click('.confirm-dialog .danger-button')
      await idle()
      await replay('task:state', {
        record: { ...deletionTask, status: 'running', finishedAt: null }
      })
      await replay('task:state', { record: deletionTask })
      await delay(200)
      const deletedSnapshot = await save()
      assert.deepEqual(
        deletedSnapshot.conversations.find(
          (conversation) => conversation.id === 'lesson60-deletion'
        ).tasks,
        []
      )
      check(
        'trusted clear-current-conversation removes tasks; synthetic late running/terminal events do not reinsert deleted records',
        { syntheticReplay: true, actualSavedEmptyTasks: true }
      )
    } else {
      report.notCovered.push(
        stage +
          ': clear-current-conversation late-event reinsertion scenario unavailable because baseline ChatHeader is unmounted. The original clear/dialog/saved-empty-task assertions remain conditional on that real control; this run does not claim them as passed.'
      )
    }
    await click('.conversation-item[title="第60课隔离一致性"]')
    await idle()

    const effectTarget = path.join(protectedDirectory, 'effect-before-stop.txt')
    await startScenario('effect-stop', { target: effectTarget })
    await until(
      () => evaluate('!!document.querySelector(".execution-approval[open]")'),
      'actual effect approval'
    )
    await click('.execution-approval-confirm')
    await until(
      async () =>
        (await audit()).requests.some(
          (request) => request.scenario === 'effect-stop' && request.waitingForCancellation
        ),
      'real file effect then held stream'
    )
    assert.equal(await fs.readFile(effectTarget, 'utf8'), 'LESSON60_CONTROLLED_REAL_EFFECT\n')
    const effectStart = await startIPC('effect-stop')
    await click('button[aria-label="停止生成"]')
    await idle()
    await waitTask(effectStart, 'cancelled')
    assert.equal(await fs.readFile(effectTarget, 'utf8'), 'LESSON60_CONTROLLED_REAL_EFFECT\n')
    const effectAudit = await audit()
    const created = effectAudit.events.find(
      (event) =>
        event.channel === 'agent:tool-event' &&
        event.value.requestId === effectStart.args[0] &&
        event.value.phase === 'finish'
    )
    assert.equal(JSON.parse(created.value.output).status, 'created')
    const effectPointerPath = path.join(
      userData,
      'task-checkpoints',
      effectStart.args[4] + '.checkpoint.json'
    )
    const effectPointer = JSON.parse(await fs.readFile(effectPointerPath, 'utf8'))
    assert.equal(effectPointer.progress, 'interrupted')
    assert.equal(effectPointer.reason, 'user_cancelled')
    const effectRawPath = path.join(userData, 'task-checkpoints', effectPointer.raw.file)
    const effectRawBytes = await fs.readFile(effectRawPath)
    const effectRaw = JSON.parse(effectRawBytes.toString('utf8'))
    const effectCall = effectRaw.find(
      (item) =>
        item.type === 'function_call' &&
        item.name === 'create_workspace_file' &&
        JSON.parse(item.arguments).path === effectTarget
    )
    assert.ok(effectCall, 'Actual immutable raw retains the approved create call')
    const effectResult = effectRaw.find(
      (item) => item.type === 'function_call_output' && item.call_id === effectCall.call_id
    )
    assert.ok(effectResult, 'Actual immutable raw retains the observed create result')
    assert.equal(JSON.parse(effectResult.output).status, 'created')
    await echo('actual-effect-preserved')
    check(
      'trusted approval performs one actual controlled write before UI stop; bytes and actual created tool/raw/checkpoint evidence survive cancellation without rollback claim',
      {
        actualEffect: effectTarget,
        sha256: hash(await fs.readFile(effectTarget)),
        checkpoint: path.relative(userData, effectPointerPath),
        raw: path.relative(userData, effectRawPath),
        rawSha256: hash(effectRawBytes),
        toolFact: JSON.parse(effectResult.output)
      }
    )

    const beforeFault = (await audit()).requests.length
    await configure({ faults: { setReplyFailure: true, readback: 'hold' } })
    await permissions('full-access')
    await until(
      () =>
        evaluate(
          'document.querySelector(".composer-permissions .permissions-trigger").dataset.mode==="unknown"'
        ),
      'unknown permission while readback held'
    )
    await blockedSend(
      'accepted permission change with synthetic reply failure and held real readback clears stale UI state and blocks synthetic form submission'
    )
    await echo('permission-readback-loading')
    await screenshot('unknown-readback-loading')
    assert.equal(await invoke('lesson60:release', 'readback'), true)
    await idle()
    const recovered = await api('getExecutionPermissions')
    assert.equal(recovered.mode, 'full-access')
    assert.equal(
      await evaluate(
        'document.querySelector(".composer-permissions .permissions-trigger").dataset.mode'
      ),
      'full-access'
    )
    assert.equal((await audit()).requests.length, beforeFault)
    check(
      'actual permission readback recovers accepted main mode/revision after synthetic lost set reply',
      { recovered }
    )

    await startScenario('checkpoint')
    await until(
      async () =>
        (await audit()).requests.some(
          (request) => request.scenario === 'checkpoint' && request.waitingForCancellation
        ),
      'actual safe time group checkpoint'
    )
    stoppedStart = await startIPC('checkpoint')
    await click('button[aria-label="停止生成"]')
    await idle()
    await waitTask(stoppedStart, 'cancelled')
    await until(
      () => evaluate('!!document.querySelector(".task-resume-bar button")'),
      'actual resumable checkpoint control'
    )
    originalSnapshot = await save()
    const resumeInfo = await api('getResumableAgentTask', 'lesson60-fixture')
    stoppedCheckpoint = JSON.parse(
      await fs.readFile(
        path.join(userData, 'task-checkpoints', resumeInfo.taskId + '.checkpoint.json'),
        'utf8'
      )
    )
    assert.equal(stoppedCheckpoint.progress, 'interrupted')
    assert.equal(stoppedCheckpoint.reason, 'user_cancelled')
    await fs.copyFile(
      path.join(userData, 'conversation.json'),
      path.join(evidence, 'actual-stopped-conversation.snapshot.json')
    )
    await fs.writeFile(
      path.join(evidence, 'actual-stopped-checkpoint.snapshot.json'),
      JSON.stringify(stoppedCheckpoint, null, 2)
    )
    check(
      'real UI owner stop and actual autosave persist interrupted checkpoint/raw and cancelled history for new-PID reopening',
      { taskId: stoppedCheckpoint.taskId, requestId: stoppedStart.args[0] }
    )

    await configure({ faults: { setReplyFailure: true, readback: 'fail' } })
    await permissions('auto-approve')
    await until(
      () =>
        evaluate(
          'document.querySelector(".composer-permissions .permissions-trigger").dataset.mode==="unknown"&&document.querySelector(".composer-permissions .permissions-trigger").textContent.includes("权限未知")'
        ),
      'persistent readback failure'
    )
    await blockedSend(
      'persistent synthetic permission readback failure stays unknown and prevents new resolve/start/model requests'
    )
    await echo('persistent-permission-unknown')
    await screenshot('persistent-permission-unknown')
    assert.equal(await api('getPendingExecutionApproval'), null)
    assert.equal(await api('getPendingAgentUserInput'), null)
  })
  await launch('reopen', async (ui) => {
    const {
      child,
      api,
      audit,
      until,
      evaluate,
      click,
      idle,
      save,
      permissions,
      openTerminal,
      echo,
      configure,
      screenshot
    } = ui
    assert.notEqual(child.pid, report.processes[0].pid)
    await delay(1000)
    assert.deepEqual((await api('loadConversation')).snapshot, originalSnapshot)
    assert.deepEqual(
      await api('getExecutionPermissions'),
      { mode: 'default', revision: 0 },
      'New window reads settings, not prior execution mode'
    )
    assert.equal(await api('getPendingExecutionApproval'), null)
    assert.equal(await api('getPendingAgentUserInput'), null)
    assert.ok((await api('listTasks')).every((task) => terminalStatuses.includes(task.status)))
    await until(
      () => evaluate('!!document.querySelector(".task-resume-bar button")'),
      'passive resume display'
    )
    await click('.conversation-item[title="第60课被动切换对照"]')
    await idle()
    await click('.conversation-item[title="第60课隔离一致性"]')
    await idle()
    await until(
      () => evaluate('!!document.querySelector(".task-resume-bar button")'),
      'passive return resume display'
    )
    await openTerminal()
    await echo('new-pid-passive')
    assert.equal((await audit()).requests.length, 0)
    assert.equal(
      (await audit()).ipc.filter((item) => ['agent:start', 'agent:resume'].includes(item.channel))
        .length,
      0
    )
    await screenshot('passive-reopen')
    check(
      'actual different application PID reopens real saved cancelled task/raw; chat switches and independent PTY restore display with all model/start/resume requests zero',
      {
        oldPid: report.processes[0].pid,
        newPid: child.pid,
        currentPermissions: await api('getExecutionPermissions')
      }
    )
    await permissions('auto-approve')
    await idle()
    const current = await api('getExecutionPermissions')
    assert.deepEqual(current, { mode: 'auto-approve', revision: 1 })
    assert.equal((await audit()).requests.length, 0)
    await configure({ scenario: { name: 'resume' } })
    await click('.task-resume-bar button')
    await until(
      async () => (await audit()).ipc.some((item) => item.channel === 'agent:resume'),
      'explicit real resume IPC'
    )
    await idle()
    const observed = await audit(),
      resumedIPC = observed.ipc.find((item) => item.channel === 'agent:resume')
    assert.notEqual(resumedIPC.args[0], stoppedStart.args[0])
    assert.notEqual(resumedIPC.args[3], stoppedStart.args[4])
    assert.equal(resumedIPC.args[1], stoppedCheckpoint.taskId)
    assert.equal(resumedIPC.args[2].execution.mode, current.mode)
    assert.equal(resumedIPC.args[2].execution.revision, current.revision)
    assert.ok(
      observed.requests.length >= 2 &&
        observed.requests.every((request) => request.category === 'main' && request.resumeSafety)
    )
    const resumedSnapshot = await save()
    const old = originalSnapshot.conversations[0],
      now = resumedSnapshot.conversations[0]
    assert.deepEqual(now.messages.slice(0, old.messages.length), old.messages)
    assert.deepEqual(now.toolRuns.slice(0, old.toolRuns.length), old.toolRuns)
    const oldRecord = now.tasks.find((task) => task.taskId === stoppedStart.args[4])
    assert.equal(oldRecord.status, 'cancelled')
    const newRecord = now.tasks.find((task) => task.taskId === resumedIPC.args[3])
    assert.equal(newRecord.status, 'completed')
    const completed = JSON.parse(
      await fs.readFile(
        path.join(userData, 'task-checkpoints', stoppedCheckpoint.taskId + '.checkpoint.json'),
        'utf8'
      )
    )
    assert.equal(completed.progress, 'completed')
    assert.equal(completed.taskId, stoppedCheckpoint.taskId)
    assert.equal(completed.createdAt, stoppedCheckpoint.createdAt)
    const oldRaw = JSON.parse(
      await fs.readFile(path.join(userData, 'task-checkpoints', stoppedCheckpoint.raw.file), 'utf8')
    )
    const newRaw = JSON.parse(
      await fs.readFile(path.join(userData, 'task-checkpoints', completed.raw.file), 'utf8')
    )
    assert.deepEqual(newRaw.slice(0, oldRaw.length), oldRaw)
    assert.equal(await api('respondToExecutionApproval', oldApproval.approvalId, true), false)
    assert.equal(
      await api('respondToAgentUserInput', {
        requestId: oldQuestion.requestId,
        inputId: oldQuestion.inputId,
        answers: oldQuestion.questions.map((question) => ({
          id: question.id,
          answer: question.options[0].label
        }))
      }),
      false
    )
    await echo('explicit-resume-current-permission')
    check(
      'trusted explicit resume uses current auto-approve mode/revision and fresh request/task identities; old cancelled TaskRecord and immutable raw prefix survive, old approval/question do not return',
      {
        current,
        oldRequestId: stoppedStart.args[0],
        newRequestId: resumedIPC.args[0],
        oldTaskId: stoppedStart.args[4],
        newTaskId: resumedIPC.args[3],
        checkpointTaskId: completed.taskId
      }
    )
  })
  assert.deepEqual(await identify(), beforeArtifacts)
  check(
    'inspected development/package artifacts and complete five-file node-pty cleanup manifest are unchanged throughout both real app PIDs',
    { artifacts: beforeArtifacts }
  )
  report.pass = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
} finally {
  await fs.mkdir(evidence, { recursive: true })
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      uuid,
      packaged,
      checks: report.checks.length,
      failures: report.failures.map((failure) => failure.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
