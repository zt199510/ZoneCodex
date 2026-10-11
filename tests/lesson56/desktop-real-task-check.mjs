import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { root, createEvidence, delay, sourceIdentity, loadRealConfiguration } from './runtime.mjs'
import {
  prepareBusiness,
  desktopHistory,
  protocolPairs,
  validateBusiness,
  captureDiskFacts
} from './business.mjs'

const require = createRequire(import.meta.url)
const { install } = require('./real-observer.cjs')
const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((arg) => arg === '--packaged'))
const evidence = await createEvidence('real-desktop-' + (packaged ? 'packaged' : 'development'))
const userData = path.join(evidence, 'user-data')
const artifacts = packaged
  ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar']
  : ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const report = {
  pass: false,
  evidence,
  packaged,
  model: 'gpt-6.1-sol',
  realTransport: true,
  syntheticHistory: true,
  historyBoundary:
    'Ten valid earlier complete plan turns are self-authored fixtures, not naturally produced model history. Summary, task, actual tools and commands use unchanged real product/model.',
  checks: [],
  processes: [],
  failures: [],
  uncovered: []
}
let before, stored, business

async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
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
        const id = ++serial,
          timer = setTimeout(() => {
            pending.delete(id)
            reject(Error('Inspector observation timeout: ' + method))
          }, 15000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function launch(stage) {
  const mainPort = await port(),
    rendererPort = await port(),
    auditFile = path.join(evidence, stage + '-audit.json')
  const log = await fs.open(path.join(evidence, stage + '.log'), 'w')
  const env = {
    ...process.env,
    APPDATA: path.join(evidence, 'appdata'),
    LOCALAPPDATA: path.join(evidence, 'localappdata')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_OPTIONS
  delete env.LESSON56_OBSERVER_CONFIG
  await fs.mkdir(env.APPDATA, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  const args = [
    ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
    '--user-data-dir=' + userData,
    '--inspect-brk=127.0.0.1:' + mainPort,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + rendererPort,
    '--disable-gpu'
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
    startedAtUTC: new Date().toISOString(),
    exitCode: null,
    signalCode: null,
    forcedKill: false
  }
  report.processes.push(processResult)
  console.log(
    JSON.stringify({
      evidence,
      stage,
      pid: child.pid,
      packaged,
      realTransport: true,
      syntheticHistory: true
    })
  )
  let main, client, evaluate
  const until = async (action, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (child.exitCode !== null)
        throw Error('Owned app exited while observing ' + label + ': ' + child.exitCode)
      const value = await action()
      if (value) return value
      await delay(100)
    }
    throw Error('Bounded observation exceeded: ' + label)
  }
  try {
    const mainTarget = await until(async () => {
      try {
        return (await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0]
      } catch {
        return null
      }
    }, 'main inspector')
    main = await connect(mainTarget.webSocketDebuggerUrl)
    await main.cdp('Runtime.enable')
    await main.cdp('Debugger.enable')
    await main.cdp('Runtime.runIfWaitingForDebugger')
    await until(
      () => main.events.find((event) => event.method === 'Debugger.paused'),
      'entry pause'
    )
    const injection = await main.cdp('Runtime.evaluate', {
      expression:
        '(' +
        install.toString() +
        ')(' +
        JSON.stringify({
          root,
          desktop: true,
          stage,
          userData,
          project: business.project,
          auditFile
        }) +
        ');globalThis.__lesson56ObserverReady',
      returnByValue: true
    })
    assert.equal(
      injection.exceptionDetails,
      undefined,
      injection.exceptionDetails?.exception?.description
    )
    assert.equal(injection.result.value, true)
    await main.cdp('Debugger.resume')
    const page = await until(async () => {
      try {
        return (await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()).find(
          (item) => item.type === 'page' && item.url.includes('renderer')
        )
      } catch {
        return null
      }
    }, 'real renderer')
    client = await connect(page.webSocketDebuggerUrl)
    await client.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    evaluate = async (expression) => {
      const result = await client.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (result.exceptionDetails)
        throw Error(result.exceptionDetails.exception?.description ?? 'Renderer observation error')
      return result.result.value
    }
    const click = async (expression) => {
      await evaluate('(' + expression + ').click()')
      await delay(80)
    }
    const audit = () => evaluate('window.electron.ipcRenderer.invoke("lesson56:observation")')
    const idle = () =>
      until(
        () =>
          evaluate(
            '!!document.getElementById("chat-input")&&!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成]")'
          ),
        'idle'
      )
    await idle()
    if (stage === 'create') {
      const loaded = await evaluate('window.api.loadConversation()')
      assert.ok(loaded.ok)
      assert.equal(loaded.snapshot.activeConversationId, 'lesson56-fixture')
      assert.equal(loaded.snapshot.conversations[0].toolRuns.length, 10)
      await click(
        '[...document.querySelectorAll(".workspace-status button")].find(n=>n.textContent.includes("选择工作区"))'
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
        'History restore and scope/permission selection are passive'
      )
      await evaluate(
        '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,' +
          JSON.stringify(business.prompt) +
          ');n.dispatchEvent(new Event("input",{bubbles:true}));})()'
      )
      await delay(100)
      await evaluate('document.querySelector(".composer").requestSubmit()')
      await until(
        async () => (await audit()).ipc.some((item) => item.channel === 'agent:start'),
        'explicit Agent accepted'
      )
      await until(
        () =>
          evaluate(
            '!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成]")'
          ),
        'single explicit real task completed',
        600000
      )
      await click('document.querySelector(".chat-header .quiet-button")')
      await until(
        () =>
          evaluate('document.querySelector(".save-status").textContent.includes("已同步到本地")'),
        'original records saved'
      )
      const snapshot = await evaluate('window.api.loadConversation()')
      assert.ok(snapshot.ok)
      stored = snapshot.snapshot
      const conversation = stored.conversations.find(
        (item) => item.id === stored.activeConversationId
      )
      const rawRun = conversation.toolRuns.find(
        (run) => run.userId === conversation.messages.at(-2).id
      )
      const observed = await audit()
      await fs.writeFile(
        path.join(evidence, 'create-audit.json'),
        JSON.stringify(observed, null, 2)
      )
      await fs.writeFile(
        path.join(evidence, 'conversation-public-snapshot.json'),
        JSON.stringify(
          {
            ...stored,
            conversations: stored.conversations.map((item) => ({
              ...item,
              toolRuns: item.toolRuns.map((run) => ({
                ...run,
                items: run.items.filter((protocol) => protocol.type !== 'reasoning')
              }))
            }))
          },
          null,
          2
        )
      )
      assert.equal(
        conversation.messages.at(-1).status,
        'complete',
        conversation.messages.at(-1).content
      )
      assert.ok(rawRun)
      const pairs = protocolPairs(rawRun.items)
      await fs.writeFile(
        path.join(evidence, 'agent-tool-facts.json'),
        JSON.stringify(pairs, null, 2)
      )
      report.business = await validateBusiness(
        business,
        pairs,
        observed,
        observed.events
          .filter((event) => event.channel === 'agent:context')
          .map((event) => event.value)
      )
      report.uncovered.push(...report.business.uncovered)
      const screen = await client.cdp('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(path.join(evidence, 'create.png'), Buffer.from(screen.data, 'base64'))
      report.checks.push({
        name: 'real desktop summary publishes reduced input then actual protected task completes with two original tests',
        pass: true
      })
    } else {
      const observedAt = Date.now()
      await delay(5000)
      const loaded = await evaluate('window.api.loadConversation()')
      assert.ok(loaded.ok)
      assert.deepEqual(
        loaded.snapshot,
        stored,
        'Original saved records and tasks restored byte-equivalent as parsed data'
      )
      assert.equal(await evaluate('window.api.getPendingAgentUserInput()'), null)
      assert.equal(
        await evaluate('window.electron.ipcRenderer.invoke("execution:approval-get")'),
        null
      )
      assert.equal(
        (await evaluate('window.api.listTasks()')).some((task) =>
          ['running', 'waiting_input', 'waiting_approval'].includes(task.status)
        ),
        false
      )
      const observed = await audit()
      assert.equal(observed.requests.length, 0)
      assert.equal(observed.allFetches.length, 0)
      assert.equal(observed.spawns.length, 0)
      assert.equal(observed.ipc.filter((item) => item.channel === 'agent:start').length, 0)
      assert.deepEqual(observed.writeFailures, [])
      await business.protectedCheck()
      assert.deepEqual(
        await fs.readFile(path.join(business.project, 'business.ts')),
        await fs.readFile(path.join(evidence, 'business.before-reopen.bin'))
      )
      const independentTest = await business.externalTest('reopen-independent-test')
      if (report.business) assert.equal(independentTest.exitCode, 0)
      await fs.writeFile(
        path.join(evidence, 'reopen-audit.json'),
        JSON.stringify(observed, null, 2)
      )
      report.checks.push({
        name: 'full new-PID process reopen of saved task remains passive for at least five seconds',
        pass: true,
        observationMs: Date.now() - observedAt,
        pid: child.pid,
        independentTestExitCode: independentTest.exitCode,
        capabilityBoundary:
          'Fresh PID has new in-memory capability stores; version 9 restores records only. Public pending-input/approval/task APIs are checked. Private read-evidence and command-ticket maps are not directly reflected by this observer.',
        counts: {
          main: 0,
          summary: 0,
          title: 0,
          approval: 0,
          agent: 0,
          commands: 0,
          waitingInput: 0,
          waitingApproval: 0,
          runningTasks: 0
        }
      })
    }
  } catch (error) {
    try {
      if (evaluate) {
        await fs.writeFile(
          path.join(evidence, stage + '-diagnostic.txt'),
          await evaluate('document.body.innerText')
        )
        await fs.writeFile(
          auditFile,
          JSON.stringify(
            await evaluate('window.electron.ipcRenderer.invoke("lesson56:observation")'),
            null,
            2
          )
        )
      }
    } catch {
      /* Original error and already-written evidence survive observer failure. */
    }
    throw error
  } finally {
    if (stage === 'create' && stored)
      await fs.writeFile(
        path.join(evidence, 'business.before-reopen.bin'),
        await fs.readFile(path.join(business.project, 'business.ts'))
      )
    if (evaluate)
      try {
        await evaluate('window.electron.ipcRenderer.invoke("lesson56:quit")')
      } catch {
        /* A terminated renderer cannot accept quit. */
      }
    client?.socket.close()
    main?.socket.close()
    if (child.exitCode === null)
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    if (child.exitCode === null) {
      processResult.forcedKill = true
      child.kill()
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3000)])
    }
    processResult.exitCode = child.exitCode
    processResult.signalCode = child.signalCode
    await fs.writeFile(
      path.join(evidence, 'process-exits.json'),
      JSON.stringify(report.processes, null, 2)
    )
    await log.close()
  }
}
try {
  await loadRealConfiguration()
  before = await sourceIdentity(artifacts)
  await fs.writeFile(
    path.join(evidence, 'source-artifact-before.json'),
    JSON.stringify(before, null, 2)
  )
  business = await prepareBusiness(evidence, false)
  await fs.mkdir(userData, { recursive: true })
  // Restored default task directories must retain the host's conversation/workspace binding.
  // The independently selected business project remains the actual task workspace.
  const fixtureDirectory = path.join(evidence, 'task-root', 'lesson56-fixture', 'workspace')
  await fs.mkdir(fixtureDirectory, { recursive: true })
  const fixture = desktopHistory(fixtureDirectory)
  await fs.writeFile(path.join(userData, 'conversation.json'), JSON.stringify(fixture, null, 2))
  await fs.writeFile(path.join(evidence, 'history-fixture.json'), JSON.stringify(fixture, null, 2))
  try {
    await launch('create')
  } catch (error) {
    report.failures.push({ stage: 'create', message: error.message, stack: error.stack })
  }
  assert.equal(report.processes[0].forcedKill, false)
  assert.equal(report.processes[0].exitCode, 0)
  assert.ok(stored, 'At least one explicitly submitted task was actually saved before reopen')
  await launch('reopen')
  assert.notEqual(report.processes[0].pid, report.processes[1].pid)
  assert.ok(report.processes.every((item) => !item.forcedKill && item.exitCode === 0))
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
} finally {
  if (business)
    try {
      report.independentDisk = await captureDiskFacts(business)
    } catch (error) {
      report.failures.push({ message: error.message, stack: error.stack })
    }
  if (before)
    try {
      assert.deepEqual(await sourceIdentity(artifacts), before)
      report.checks.push({
        name: 'source and invoked artifacts unchanged during validation',
        pass: true
      })
    } catch (error) {
      report.failures.push({ message: error.message, stack: error.stack })
    }
  report.pass =
    report.failures.length === 0 &&
    !!report.business &&
    report.checks.some((check) => check.counts?.summary === 0)
  if (!report.business)
    report.uncovered.push(
      'No passing real summary-to-business continuation chain; preserved actual failure is not replaced by a synthetic pass.'
    )
  if (!report.checks.some((check) => check.counts?.summary === 0))
    report.uncovered.push(
      'Saved-task full-process reopen zero-request verification did not complete.'
    )
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      packaged,
      failures: report.failures.map((failure) => failure.message),
      uncovered: report.uncovered
    })
  )
  if (!report.pass) process.exitCode = 1
}
