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
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson57',
  'desktop-' + (packaged ? 'packaged-' : 'development-') + randomUUID()
)
const userData = path.join(evidence, 'user-data')
const project = path.join(evidence, 'project')
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
  packaged,
  realTransport: false,
  syntheticTransport: true,
  actualElectron: true,
  actualDiskTools: true,
  actualIndependentTests: true,
  processes: [],
  checks: [],
  failures: [],
  uncovered: [
    'Real network model and real summary not invoked; synthetic model transport only.',
    'Natural model repair branch and real multi-image resume not covered.'
  ]
}
let originalSnapshot, interruptedCheckpoint, beforeArtifacts
const businessBefore =
  'export function subtotal(unitCents, quantity) { return unitCents + quantity }\n'
const businessAfter =
  'export function subtotal(unitCents, quantity) { return unitCents * quantity }\n'
const protectedFiles = {
  'package.json': '{"private":true,"type":"module"}\n',
  'test.mjs':
    'import assert from "node:assert/strict"\nimport { subtotal } from "./business.js"\nconst cases = [[199,3,597],[0,7,0],[2400,0,0],[1,1,1],[125,8,1000],[999,2,1998],[10000,10,100000],[37,12,444]]\nfor (const [unit,quantity,expected] of cases) assert.equal(subtotal(unit,quantity),expected)\nconsole.log("LESSON57_FIXED_PRICE_TEST_8_PASS")\n',
  'requirements.txt':
    'Fixed price contract: subtotal(unitCents, quantity) is integer multiplication. Modify only business.js. Eight test inputs and expected outcomes are fixed before any model request; never alter test.mjs, requirements.txt or sidecar.txt.\n',
  'sidecar.txt': 'Protected independent evidence boundary.\n'
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
async function fixedTest(label) {
  const child = spawn(process.execPath, ['test.mjs'], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const result = { pid: child.pid, exitCode, stdout, stderr }
  await fs.writeFile(path.join(evidence, label + '.json'), JSON.stringify(result, null, 2))
  return result
}
async function launch(stage) {
  const mainPort = await freePort(),
    rendererPort = await freePort()
  const auditFile = path.join(evidence, stage + '-audit.json')
  const log = await fs.open(path.join(evidence, stage + '.log'), 'w')
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
  const until = async (action, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (child.exitCode !== null) throw Error('Owned app exited during ' + label)
      const value = await action()
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
        JSON.stringify({ root, stage, userData, project, auditFile }) +
        ');globalThis.__lesson57FixtureReady',
      returnByValue: true
    })
    assert.equal(
      injected.exceptionDetails,
      undefined,
      injected.exceptionDetails?.exception?.description
    )
    assert.equal(injected.result.value, true)
    await main.cdp('Debugger.resume')
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
    const audit = () => evaluate('window.electron.ipcRenderer.invoke("lesson57:observation")')
    const click = async (expression) => {
      await evaluate('(' + expression + ').click()')
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
    const save = async () => {
      await click('document.querySelector(".chat-header .quiet-button")')
      await until(
        () =>
          evaluate('document.querySelector(".save-status").textContent.includes("已同步到本地")'),
        'saved'
      )
    }
    await idle()
    await delay(stage === 'create' ? 200 : 2000)
    assert.equal((await audit()).requests.length, 0)
    assert.equal(
      (await audit()).ipc.filter((item) => ['agent:start', 'agent:resume'].includes(item.channel))
        .length,
      0
    )
    if (stage === 'reopen') {
      const loaded = await evaluate('window.api.loadConversation()')
      assert.deepEqual(loaded.snapshot, originalSnapshot)
      assert.equal(await evaluate('window.api.getPendingAgentUserInput()'), null)
      assert.equal(await evaluate('window.api.getPendingExecutionApproval()'), null)
      const records = await evaluate('window.api.listTasks()')
      assert.equal(
        records.some((task) =>
          ['running', 'waiting_input', 'waiting_approval'].includes(task.status)
        ),
        false
      )
      await until(
        () => evaluate('!!document.querySelector(".task-resume-bar button")'),
        'explicit resume control'
      )
      await click('document.querySelector(".conversation-item[title=第57课被动切换对照]")')
      await idle()
      assert.equal(await evaluate('!!document.querySelector(".task-resume-bar button")'), false)
      await click('document.querySelector(".conversation-item[title=第57课隔离价格续接]")')
      await idle()
      await until(
        () => evaluate('!!document.querySelector(".task-resume-bar button")'),
        'passive return to resumable conversation'
      )
      assert.equal((await audit()).requests.length, 0)
      assert(
        await evaluate(
          'document.querySelector(".task-resume-bar").textContent.includes("中断前的文件或命令操作可能已发生")'
        )
      )
      assert.equal(
        (await audit()).ipc.filter((item) => ['agent:start', 'agent:resume'].includes(item.channel))
          .length,
        0
      )
      const passiveScreen = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(
        path.join(evidence, 'reopen-passive.png'),
        Buffer.from(passiveScreen.data, 'base64')
      )
      report.checks.push({
        name: 'new PID default reopen and conversation switches restore original display with main/summary/title/approval/start/resume all zero',
        pass: true,
        counts: { main: 0, summary: 0, title: 0, approval: 0, start: 0, resume: 0 }
      })
    }
    await click(
      '[...document.querySelectorAll(".workspace-status button")].find(n=>/选择工作区|更换工作区/.test(n.textContent))'
    )
    await idle()
    await click('document.querySelector(".composer-permissions .permissions-trigger")')
    await click(
      '[...document.querySelectorAll(".composer-permissions .permissions-popover [role=menuitemradio]")].find(n=>n.textContent.includes("完全访问权限"))'
    )
    await idle()
    assert.equal(
      (await audit()).requests.length,
      0,
      'Directory and permission selection are passive'
    )
    if (stage === 'create') {
      const prompt =
        '修正 business.js 的价格小计：subtotal(unitCents, quantity) 应返回整数乘法。只修改此函数，保留 test.mjs、requirements.txt、sidecar.txt 原字节；修改后重新读取核对。'
      await evaluate(
        '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,' +
          JSON.stringify(prompt) +
          ');n.dispatchEvent(new Event("input",{bubbles:true}));})()'
      )
      await delay(100)
      await evaluate('document.querySelector(".composer").requestSubmit()')
      await until(
        async () => (await audit()).requests.some((item) => item.waitingForCancellation),
        'safe raw read then interrupted model stream'
      )
      assert((await audit()).requests.every((request) => request.resumeSafety === false))
      await click('document.querySelector("button[aria-label=停止生成]")')
      await idle()
      await until(
        () => evaluate('!!document.querySelector(".task-resume-bar button")'),
        'checkpoint saved after stop'
      )
      await save()
      originalSnapshot = (await evaluate('window.api.loadConversation()')).snapshot
      const resumeInfo = await evaluate('window.api.getResumableAgentTask("lesson57-fixture")')
      assert.ok(resumeInfo)
      interruptedCheckpoint = JSON.parse(
        await fs.readFile(
          path.join(userData, 'task-checkpoints', resumeInfo.taskId + '.checkpoint.json'),
          'utf8'
        )
      )
      assert.equal(interruptedCheckpoint.progress, 'interrupted')
      assert.equal(interruptedCheckpoint.reason, 'user_cancelled')
      assert.equal(await fs.readFile(path.join(project, 'business.js'), 'utf8'), businessBefore)
      report.checks.push({
        name: 'user stop persists complete raw read group and interrupted task pointer',
        pass: true
      })
    } else {
      await click('document.querySelector(".task-resume-bar button")')
      await until(
        async () => (await audit()).ipc.some((item) => item.channel === 'agent:resume'),
        'explicit resume IPC'
      )
      await idle()
      const observed = await audit()
      assert.equal(observed.requests.length, 5)
      assert(observed.requests.every((request) => request.resumeSafety))
      assert(
        observed.events.some(
          (event) =>
            event.channel === 'agent:progress' &&
            event.value.message.includes('中断前的文件或命令操作可能已发生')
        )
      )
      const startId = JSON.parse(
        await fs.readFile(path.join(evidence, 'create-audit.json'), 'utf8')
      ).ipc.find((item) => item.channel === 'agent:start').requestId
      const resumeId = observed.ipc.find((item) => item.channel === 'agent:resume').requestId
      assert.notEqual(startId, resumeId)
      assert.match(resumeId, /^[a-f0-9-]{36}$/)
      const stale = observed.events.find(
        (event) =>
          event.channel === 'agent:tool-event' &&
          event.value.callId === 'lesson57-stale-evidence-patch' &&
          event.value.phase === 'finish'
      )
      assert.ok(
        stale && JSON.parse(stale.value.output).status === 'error',
        'Old raw read hash cannot authorize resumed patch'
      )
      assert.match(JSON.parse(stale.value.output).error, /本执行请求读取/)
      const fresh = observed.events.find(
        (event) =>
          event.channel === 'agent:tool-event' &&
          event.value.callId === 'lesson57-fresh-patch' &&
          event.value.phase === 'finish'
      )
      assert.equal(JSON.parse(fresh.value.output).status, 'applied')
      await save()
      const resumedSnapshot = (await evaluate('window.api.loadConversation()')).snapshot
      const old = originalSnapshot.conversations[0],
        current = resumedSnapshot.conversations[0]
      assert.deepEqual(current.messages.slice(0, old.messages.length), old.messages)
      assert.deepEqual(current.toolRuns.slice(0, old.toolRuns.length), old.toolRuns)
      const resumedRun = current.toolRuns.at(-1)
      const resumedUser = current.messages.find((message) => message.id === resumedRun.userId)
      assert.equal(resumedUser.content, interruptedCheckpoint.prompt)
      assert.equal(resumedRun.items[0].content, resumedUser.content)
      assert.equal(current.messages.at(-1).status, 'complete')
      assert.equal(await fs.readFile(path.join(project, 'business.js'), 'utf8'), businessAfter)
      const completed = JSON.parse(
        await fs.readFile(
          path.join(
            userData,
            'task-checkpoints',
            interruptedCheckpoint.taskId + '.checkpoint.json'
          ),
          'utf8'
        )
      )
      assert.equal(completed.progress, 'completed')
      assert.equal(completed.createdAt, interruptedCheckpoint.createdAt)
      const initialRaw = JSON.parse(
        await fs.readFile(
          path.join(userData, 'task-checkpoints', interruptedCheckpoint.raw.file),
          'utf8'
        )
      )
      const completedRaw = JSON.parse(
        await fs.readFile(path.join(userData, 'task-checkpoints', completed.raw.file), 'utf8')
      )
      assert.deepEqual(completedRaw.slice(0, initialRaw.length), initialRaw)
      report.checks.push({
        name: 'explicit resumed task has new requestId, stale read denied, fresh read then real patch/re-read completes while original records and immutable raw sidecar remain intact',
        pass: true,
        startId,
        resumeId
      })
    }
    await fs.writeFile(auditFile, JSON.stringify(await audit(), null, 2))
    const screen = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(evidence, stage + '.png'), Buffer.from(screen.data, 'base64'))
  } catch (error) {
    if (evaluate)
      try {
        await fs.writeFile(
          path.join(evidence, stage + '-diagnostic.txt'),
          await evaluate('document.body.innerText')
        )
        await fs.writeFile(
          auditFile,
          JSON.stringify(
            await evaluate('window.electron.ipcRenderer.invoke("lesson57:observation")'),
            null,
            2
          )
        )
      } catch {
        /* Keep original failure. */
      }
    throw error
  } finally {
    if (evaluate)
      try {
        await evaluate('window.electron.ipcRenderer.invoke("lesson57:quit")')
      } catch {
        /* Window already retired. */
      }
    renderer?.socket.close()
    main?.socket.close()
    if (child.exitCode === null)
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    if (child.exitCode === null) {
      processResult.forcedKill = true
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    }
    processResult.exitCode = child.exitCode
    await log.close()
  }
}
try {
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  beforeArtifacts = await identify()
  await fs.writeFile(
    path.join(evidence, 'artifacts-before.json'),
    JSON.stringify(beforeArtifacts, null, 2)
  )
  await fs.writeFile(path.join(project, 'business.js'), businessBefore)
  for (const [name, text] of Object.entries(protectedFiles)) {
    await fs.writeFile(path.join(project, name), text)
    await fs.chmod(path.join(project, name), 0o444)
  }
  await fs.writeFile(
    path.join(evidence, 'fixed-contract.json'),
    JSON.stringify(
      {
        protected: Object.fromEntries(
          Object.entries(protectedFiles).map(([name, text]) => [name, hash(text)])
        ),
        initialBusiness: hash(businessBefore),
        expectedBusiness: hash(businessAfter),
        syntheticTransport: true
      },
      null,
      2
    )
  )
  assert.notEqual((await fixedTest('fixed-test-before')).exitCode, 0)
  const defaultDirectory = path.join(evidence, 'task-root', 'lesson57-fixture', 'workspace')
  await fs.mkdir(defaultDirectory, { recursive: true })
  const fixture = {
    version: 9,
    activeConversationId: 'lesson57-fixture',
    conversations: [
      {
        id: 'lesson57-fixture',
        title: '第57课隔离价格续接',
        pinned: false,
        archived: false,
        defaultDirectory,
        agentMode: 'execute',
        messages: [
          {
            id: 'fixture-user',
            role: 'user',
            mode: 'execute',
            content: '固定基线展示记录',
            status: 'complete'
          },
          {
            id: 'fixture-assistant',
            role: 'assistant',
            mode: 'execute',
            content: '基线记录保留',
            status: 'complete'
          }
        ],
        toolRuns: [],
        workspace: null,
        tasks: []
      }
    ]
  }
  const secondDirectory = path.join(evidence, 'task-root', 'lesson57-passive', 'workspace')
  await fs.mkdir(secondDirectory, { recursive: true })
  fixture.conversations.push({
    id: 'lesson57-passive',
    title: '第57课被动切换对照',
    pinned: false,
    archived: false,
    defaultDirectory: secondDirectory,
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks: []
  })
  await fs.writeFile(path.join(userData, 'conversation.json'), JSON.stringify(fixture, null, 2))
  await launch('create')
  await launch('reopen')
  assert.notEqual(report.processes[0].pid, report.processes[1].pid)
  assert.ok(report.processes.every((item) => item.exitCode === 0 && !item.forcedKill))
  for (const [name, text] of Object.entries(protectedFiles))
    assert.equal(
      await fs.readFile(path.join(project, name), 'utf8'),
      text,
      'Fixed protected bytes ' + name
    )
  const finalTest = await fixedTest('fixed-test-after')
  assert.equal(finalTest.exitCode, 0)
  assert.match(finalTest.stdout, /LESSON57_FIXED_PRICE_TEST_8_PASS/)
  assert.deepEqual(await identify(), beforeArtifacts)
  report.checks.push({
    name: 'two distinct real Electron PIDs, unchanged executable/artifacts, protected fixed tests and independent eight-case final business verification',
    pass: true,
    testPid: finalTest.pid
  })
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
      packaged,
      failures: report.failures.map((item) => item.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
