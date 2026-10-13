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
const guardClose = process.argv.includes('--close-guard')
assert.ok(process.argv.slice(2).every((arg) => ['--packaged', '--close-guard'].includes(arg)))
assert.equal(process.platform, 'win32', 'This real desktop check requires Windows')
const uuid = randomUUID()
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson59',
  'desktop-' + (packaged ? 'packaged-' : 'development-') + (guardClose ? 'close-guard-' : '') + uuid
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
const artifacts = [
  ...(packaged
    ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar']
    : [
        'out/main/index.js',
        'out/main/terminal-host.js',
        'out/preload/index.js',
        'out/renderer/index.html'
      ]),
  'scripts/node-pty-cleanup/manifest.json',
  'tests/lesson59/desktop-check.mjs',
  'tests/lesson59/desktop-fixture.cjs'
]
const report = {
  pass: false,
  evidence,
  uuid,
  marker,
  packaged,
  guardClose,
  realTransport: false,
  syntheticTransport: true,
  actualElectron: true,
  actualPTY: true,
  actualDiskStorage: true,
  observerMovedToUtility: true,
  testOverridesUtilityForkArguments: false,
  nativeShells: [],
  utilityHosts: [],
  processes: [],
  checks: [],
  failures: [],
  uncovered: ['Real network model not invoked.', 'Non-Windows terminals are not supported.'],
  notCovered: [
    'JavaScript exit callbacks and process/thread retirement do not prove every HPCON and native pipe handle has been released. No native C++ instrumentation or rebuild is performed.',
    'Very short start/close cycles may create and retire shells/ConPTY hosts between bounded CIM observations; unobserved shell PIDs are recorded as null, with utility messages/actual exit observed separately.',
    'The main fixture cannot observe utility-internal node-pty/native module loading, conout Workers or process-list helpers. Empty legacy arrays are not acceptance evidence.'
  ],
  conptyHosts: {
    provider: 'read-only Win32_Process CIM',
    ownershipRule:
      'conhost.exe absent from pre-launch/pre-PTY baselines with ParentProcessId equal to an attributed terminal utility PID and CreationDate no earlier than that utility instance',
    baseline: [],
    baselineAvailable: false,
    appIdentity: null,
    observations: [],
    owned: [],
    unavailable: []
  }
}
let main, renderer, evaluate, child, log, beforeArtifacts
let windowDestroyed = false
const shellBySession = new Map()
const augmentAudit = (observed) => ({
  ...observed,
  terminals: observed.terminals.map((terminal) => ({
    ...terminal,
    pid: shellBySession.get(terminal.sessionId)?.pid ?? null
  }))
})
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function queryNativeProcesses(label) {
  const appPid = child?.pid ?? 0
  const command = `Get-CimInstance Win32_Process -Filter "Name = 'conhost.exe' OR Name = 'powershell.exe' OR Name = 'cmd.exe' OR Name = 'electron.exe' OR Name = 'zonecodex.exe' OR ProcessId = ${appPid}" | Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}, @{Name='parentPid';Expression={[int]$_.ParentProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='createdAtUTC';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`
  try {
    const queried = spawn(
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = '',
      stderr = ''
    queried.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    queried.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        queried.kill()
        reject(Error('Bounded read-only CIM query exceeded'))
      }, 10000)
      queried.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      queried.once('exit', (exitCode, signal) => {
        clearTimeout(timer)
        resolve({ exitCode, signal })
      })
    })
    assert.equal(
      result.exitCode,
      0,
      'Read-only native process query succeeds: ' + stderr.slice(0, 300)
    )
    const value = stdout.trim() ? JSON.parse(stdout) : []
    const records = Array.isArray(value) ? value : [value]
    report.conptyHosts.observations.push({
      label,
      atUTC: new Date().toISOString(),
      appPid,
      queryPid: queried.pid,
      records
    })
    return records
  } catch (error) {
    report.conptyHosts.unavailable.push({
      label,
      atUTC: new Date().toISOString(),
      message: error.message
    })
    return null
  }
}
async function observeNativeHosts(label, terminal) {
  const records = await queryNativeProcesses(label)
  if (!records) return []
  const hosts = report.conptyHosts
  const instance = records.find(
    (record) => record.pid === child?.pid && record.name !== 'conhost.exe'
  )
  if (instance) hosts.appIdentity ??= instance
  if (
    !hosts.baselineAvailable ||
    !hosts.appIdentity ||
    !Number.isFinite(Date.parse(hosts.appIdentity.createdAtUTC))
  )
    return []
  if (terminal) {
    const utility = records.find(
      (record) =>
        record.pid === terminal.hostPid &&
        record.parentPid === child.pid &&
        Date.parse(record.createdAtUTC) >= Date.parse(hosts.appIdentity.createdAtUTC) &&
        !hosts.baseline.some(
          (before) => before.pid === record.pid && before.createdAtUTC === record.createdAtUTC
        )
    )
    if (utility && !report.utilityHosts.some((before) => before.pid === utility.pid))
      report.utilityHosts.push({ ...utility, sessionId: terminal.sessionId })
    if (utility) {
      const shells = records.filter(
        (record) =>
          record.parentPid === utility.pid &&
          record.name.toLowerCase() === path.win32.basename(terminal.program).toLowerCase() &&
          Date.parse(record.createdAtUTC) >= Date.parse(utility.createdAtUTC) &&
          !hosts.baseline.some(
            (before) => before.pid === record.pid && before.createdAtUTC === record.createdAtUTC
          )
      )
      assert.ok(shells.length <= 1, 'At most one externally attributed shell per utility')
      if (shells[0] && !shellBySession.has(terminal.sessionId)) {
        const shell = { ...shells[0], sessionId: terminal.sessionId, hostPid: utility.pid }
        shellBySession.set(terminal.sessionId, shell)
        report.nativeShells.push(shell)
      }
    }
  }
  const candidates = records.filter(
    (record) =>
      record.name === 'conhost.exe' &&
      report.utilityHosts.some(
        (utility) =>
          record.parentPid === utility.pid &&
          Date.parse(record.createdAtUTC) >= Date.parse(utility.createdAtUTC)
      ) &&
      !hosts.baseline.some(
        (before) => before.pid === record.pid && before.createdAtUTC === record.createdAtUTC
      )
  )
  for (const candidate of candidates) {
    if (
      !hosts.owned.some(
        (before) => before.pid === candidate.pid && before.createdAtUTC === candidate.createdAtUTC
      )
    )
      hosts.owned.push({
        ...candidate,
        firstObservedAt: label,
        firstObservedAtUTC: new Date().toISOString(),
        retired: false
      })
  }
  return candidates
}
async function observeHostRetirement(label) {
  if (!report.conptyHosts.owned.some((host) => !host.retired)) return
  await until(
    async () => {
      const records = await queryNativeProcesses(label)
      if (!records) return true
      for (const host of report.conptyHosts.owned) {
        if (
          !host.retired &&
          !records.some(
            (record) => record.pid === host.pid && record.createdAtUTC === host.createdAtUTC
          )
        ) {
          host.retired = true
          host.retiredAt = label
          host.retiredAtUTC = new Date().toISOString()
          host.retiredBeforeAppExit = child?.exitCode === null
        }
      }
      return report.conptyHosts.owned.every((host) => host.retired)
    },
    'verified owned ConPTY host retirement: ' + label,
    15000,
    true
  )
}
async function identify() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'scripts/node-pty-cleanup/manifest.json'), 'utf8')
  )
  assert.equal(manifest.package, 'node-pty')
  assert.equal(manifest.version, '1.1.0')
  const entries = Object.entries(manifest.files)
  assert.ok(entries.length >= 5, 'Cleanup identity includes the full manifest file set')
  const cleanupFiles = entries.map(([name, identity]) => {
    assert.ok(
      !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'),
      'Patch identity remains under node-pty/lib'
    )
    assert.match(identity.patchedSha256, /^[0-9a-f]{64}$/)
    return 'node_modules/node-pty/lib/' + name.replaceAll('\\', '/')
  })
  const identities = Object.fromEntries(
    await Promise.all(
      [...artifacts, ...cleanupFiles].map(async (name) => [
        name,
        hash(await fs.readFile(path.join(root, name)))
      ])
    )
  )
  for (const [index, [, identity]] of entries.entries())
    assert.equal(
      identities[cleanupFiles[index]],
      identity.patchedSha256,
      'Loaded node-pty dependency matches hash-locked cleanup manifest'
    )
  if (packaged) {
    const { extractFile } = moduleRequire('@electron/asar')
    for (const name of cleanupFiles) {
      const internal = hash(
        extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))
      )
      assert.equal(
        internal,
        identities[name],
        'Packaged cleanup JS matches inspected dependency: ' + name
      )
      identities['app.asar:' + name] = internal
    }
    for (const name of ['out/main/index.js', 'out/main/terminal-host.js']) {
      const current = hash(await fs.readFile(path.join(root, name)))
      const internal = hash(
        extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))
      )
      assert.equal(
        internal,
        current,
        'Packaged main/terminal utility entries match current development artifacts'
      )
      identities[name] = current
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
  const hostBaseline = await queryNativeProcesses('before application launch')
  if (hostBaseline) {
    report.conptyHosts.baseline = hostBaseline
    report.conptyHosts.baselineAvailable = true
  }
  child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd]
  })
  child.on('error', (error) => report.failures.push({ message: error.message }))
  report.processes.push({ pid: child.pid, executable, args, exitCode: null, forcedKill: false })
  const beforePTY = await queryNativeProcesses('application created before any PTY')
  if (beforePTY) {
    report.conptyHosts.appIdentity = beforePTY.find((record) => record.pid === child.pid) ?? null
    report.conptyHosts.baseline.push(...beforePTY.filter((record) => record.name === 'conhost.exe'))
  }
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
  const audit = async () =>
    augmentAudit(await evaluate('window.electron.ipcRenderer.invoke("lesson59:observation")'))
  const terminalFor = (observed, sessionId) => {
    const terminal = observed.terminals.find((item) => item.sessionId === sessionId)
    assert.ok(terminal, 'Observed utility init belongs to the actual terminal session')
    return terminal
  }
  const lastSession = (observed) =>
    observed.ipc.findLast((item) => item.channel === 'terminal:start')?.args[0]
  const observeTerminal = async (sessionId, requireShell = true) => {
    const terminal = await until(async () => {
      const observed = await audit()
      const terminal = observed.terminals.find((item) => item.sessionId === sessionId)
      return terminal?.spawned && Number.isSafeInteger(terminal.hostPid) ? terminal : null
    }, 'real terminal utility spawn/init')
    assert.deepEqual(terminal.forkOptions.execArgv, [])
    assert.deepEqual(terminal.forkOptions.debuggerEnvironmentKeys, [])
    assert.equal(terminal.requests.filter((item) => item.message.type === 'init').length, 1)
    await observeNativeHosts('live terminal utility ' + terminal.hostPid, terminal)
    const observed = terminalFor(await audit(), sessionId)
    if (requireShell) {
      assert.ok(observed.ready && observed.nativeExit === null && observed.hostExit === null)
      assert.ok(alive(observed.hostPid), 'Actual utility PID is alive')
      assert.ok(
        Number.isSafeInteger(observed.pid) && alive(observed.pid),
        'CIM attributes the real shell to the current utility'
      )
    }
    return observed
  }
  const allHostsRetired = (observed) =>
    observed.terminals.length > 0 &&
    observed.terminals.every(
      (terminal) =>
        Number.isSafeInteger(terminal.hostPid) &&
        terminal.nativeExit !== null &&
        terminal.hostExit?.exitCode === 0 &&
        terminal.errors.length === 0 &&
        terminal.hostKillCalls === 0 &&
        !alive(terminal.hostPid) &&
        (terminal.pid === null || !alive(terminal.pid))
    )
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
    const observed = await audit()
    return observeTerminal(lastSession(observed))
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
  const echoFor = (shell, suffix = '') =>
    shell === 'powershell' ? echoMarker(suffix) : 'echo zonecodex-terminal-^59-' + uuid + suffix
  const retireShell = async (current, label) => {
    const retired = await until(async () => {
      const observed = await audit()
      const terminal = observed.terminals.find((item) => item.sessionId === current.sessionId)
      return terminal &&
        terminal.nativeExit !== null &&
        terminal.hostExit?.exitCode === 0 &&
        terminal.errors.length === 0 &&
        terminal.hostKillCalls === 0 &&
        !alive(terminal.hostPid) &&
        (terminal.pid === null || !alive(terminal.pid))
        ? observed
        : null
    }, label)
    await observeHostRetirement(label)
    return retired
  }
  const submit = async (prompt) => {
    await evaluate(
      '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,' +
        JSON.stringify(prompt) +
        ');n.dispatchEvent(new Event("input",{bubbles:true}));})()'
    )
    await delay(100)
    await evaluate('document.querySelector(".composer").requestSubmit()')
  }
  if (guardClose) {
    await idle()
    await open()
    const guarded = await start()
    await input(echoMarker('-guard-before'))
    await until(
      async () => (await audit()).terminals[0].output.includes(marker + '-guard-before'),
      'guard baseline echo'
    )
    await submit('请调用当前时间工具读取香港时间。')
    await until(
      async () => (await audit()).requests.length >= 2,
      'guard fixture actual time tool business'
    )
    await idle()
    await click('button[aria-label="关闭窗口"]')
    await until(
      () => evaluate('!!document.querySelector(".close-dialog[open]")'),
      'real unsaved-change close dialog'
    )
    await evaluate(
      '[...document.querySelectorAll(".close-dialog button")].find(n=>n.textContent==="继续编辑").click()'
    )
    await until(
      () => evaluate('!document.querySelector(".close-dialog[open]")'),
      'cancel close protection'
    )
    const cancelled = await audit()
    assert.ok(
      cancelled.ipc.some((item) => item.channel === 'window:finish-close' && item.args[1] === false)
    )
    assert.equal(cancelled.terminals[0].closeMessages, 0)
    assert.equal(cancelled.terminals[0].hostPid, guarded.hostPid)
    assert.equal(cancelled.terminals[0].sessionId, guarded.sessionId)
    assert.equal(cancelled.terminals[0].nativeExit, null)
    assert.equal(cancelled.terminals[0].hostExit, null)
    assert.ok(alive(guarded.hostPid))
    assert.ok(alive(guarded.pid))
    await input(echoMarker('-guard-after-cancel'))
    await until(
      async () => (await audit()).terminals[0].output.includes(marker + '-guard-after-cancel'),
      'same PTY echo after cancel close'
    )
    await screenshot('close-protection-cancel-terminal-alive')
    report.checks.push({
      name: 'real close protection cancellation preserves same PTY and subsequent real echo',
      pass: true,
      shellPid: guarded.pid
    })
    await click('button[aria-label="关闭窗口"]')
    await until(
      () => evaluate('!!document.querySelector(".close-dialog[open]")'),
      'confirmed close dialog'
    )
    await evaluate(
      '[...document.querySelectorAll(".close-dialog button")].find(n=>n.textContent==="保存并关闭").click();true'
    )
    renderer.socket.close()
    main.socket.close()
    windowDestroyed = true
    await until(
      () => child.exitCode !== null,
      'confirmed UI close normal application exit',
      30000,
      true
    )
    assert.equal(child.exitCode, 0)
    await observeHostRetirement('confirmed Save and close normal application exit')
    const normalAudit = augmentAudit(JSON.parse(await fs.readFile(auditFile, 'utf8')))
    assert.equal(normalAudit.observerMovedToUtility, true)
    assert.equal(normalAudit.testOverridesUtilityForkArguments, false)
    assert.ok(normalAudit.unobservedInternalPTY.length > 0)
    assert.ok(
      normalAudit.ipc.some(
        (item) => item.channel === 'window:finish-close' && item.args[1] === true
      )
    )
    assert.ok(allHostsRetired(normalAudit))
    assert.ok(normalAudit.quitEvents.some((event) => event.type === 'quit' && event.exitCode === 0))
    assert.deepEqual(
      Object.fromEntries(
        ['main', 'summary', 'title', 'approval'].map((category) => [
          category,
          normalAudit.requests.filter((request) => request.category === category).length
        ])
      ),
      { main: 2, summary: 0, title: 0, approval: 0 }
    )
    assert.equal(JSON.stringify(normalAudit.requests).includes(marker), false)
    const willQuit = normalAudit.quitEvents.filter((event) => event.type === 'will-quit')
    assert.ok(willQuit.length > 0 && willQuit.every((event) => event.unsettledTerminalHosts === 0))
    await noTerminalStorage(
      'confirmed-close stage PTY data absent from actual raw/checkpoint storage'
    )
    report.checks.push({
      name: 'confirmed Save and close reaches normal application quit with native exit messages, actual utility exit and attributed shell retirement',
      pass: true,
      appPid: child.pid,
      shellPid: guarded.pid,
      terminalHosts: normalAudit.terminals,
      internalPTYNotObserved: normalAudit.unobservedInternalPTY,
      quitEvents: normalAudit.quitEvents
    })
  } else {
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
      await click('#sidebar-toggle')
    const narrow = await evaluate(
      '(()=>{const p=document.querySelector("#terminal-panel");const t=document.querySelector("#sidebar-toggle");return {windowWidth:innerWidth,windowHeight:innerHeight,panelWidth:p.clientWidth,hostHeight:p.querySelector(".terminal-host").clientHeight,toggleWidth:t.clientWidth,size:p.querySelector(".terminal-toolbar span").textContent}})()'
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
    assert.equal(terminalOnly.terminals[0].closeMessages, 0)
    assert.equal(terminalOnly.terminals[0].hostPid, first.hostPid)
    assert.equal(terminalOnly.terminals[0].nativeExit, null)
    assert.equal(terminalOnly.terminals[0].hostExit, null)
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
    assert.equal(stopped.terminals[0].closeMessages, 0)
    assert.equal(stopped.terminals[0].hostPid, first.hostPid)
    assert.equal(stopped.terminals[0].nativeExit, null)
    assert.equal(stopped.terminals[0].hostExit, null)
    assert.ok(alive(first.hostPid))
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
    await retireShell(first, 'panel close native message/utility exit and shell retirement')
    assert.equal(await evaluate('!!document.querySelector("#terminal-panel")'), false)
    const quickShells = []
    for (let round = 0; round < 4; round++) {
      await open()
      await evaluate(
        '[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").click();document.querySelector("#terminal-panel-close").click()'
      )
      await until(async () => (await audit()).terminals.length >= round + 2, 'rapid start observed')
      const quickAudit = await audit()
      const quick = await observeTerminal(lastSession(quickAudit), false)
      const retired = await retireShell(
        quick,
        'rapid toggle native message/utility actual completion'
      )
      quickShells.push(terminalFor(retired, quick.sessionId))
      await until(
        () => evaluate('!document.querySelector("#terminal-panel")'),
        'rapid close panel completion'
      )
    }
    assert.ok(
      quickShells.some(
        (terminal) =>
          !terminal.outputBeforeClose.includes('PS ') && !terminal.outputBeforeClose.includes('>')
      ),
      'At least one rapid close occurs before the first shell prompt'
    )
    assert.ok(quickShells.every((terminal) => terminal.closeMessages === 1))
    await open()
    const repeated = await start()
    const repeatedResults = await evaluate(
      'Promise.all([window.api.closeTerminal(' +
        JSON.stringify(repeated.sessionId) +
        '),window.api.closeTerminal(' +
        JSON.stringify(repeated.sessionId) +
        ')])'
    )
    assert.deepEqual(repeatedResults, [{ ok: true }, { ok: true }])
    const afterRepeated = await retireShell(repeated, 'same-ID concurrent close completion')
    assert.equal(terminalFor(afterRepeated, repeated.sessionId).closeMessages, 1)
    await click('#terminal-panel-close')
    await until(
      () => evaluate('!document.querySelector("#terminal-panel")'),
      'closed same-ID panel removed'
    )
    report.checks.push({
      name: 'four rapid closes include before-prompt close; concurrent same-ID close confirms native message and actual utility completion with one host close request',
      pass: true,
      rapid: quickShells.map(
        ({ pid, hostPid, closeMessages, outputBeforeClose, nativeExit, hostExit }) => ({
          pid,
          shellPidObserved: pid !== null,
          hostPid,
          closeMessages,
          outputBeforeClose,
          nativeExit,
          hostExit
        })
      ),
      repeated: { pid: repeated.pid, sessionId: repeated.sessionId, results: repeatedResults }
    })
    const naturalShells = []
    for (const shell of ['powershell', 'cmd']) {
      const saved = await evaluate(
        'window.api.updateSettings({terminalShell:' + JSON.stringify(shell) + '})'
      )
      assert.equal(saved.terminalShell, shell)
      await open()
      const natural = await start()
      const suffix = '-natural-' + shell
      await input(echoFor(shell, suffix))
      await until(
        async () => terminalFor(await audit(), natural.sessionId).output.includes(marker + suffix),
        shell + ' actual echo before natural exit'
      )
      await until(
        () =>
          evaluate(
            '[...document.querySelectorAll(".xterm-rows > div")].some(n=>n.textContent.trim()===' +
              JSON.stringify(marker + suffix) +
              ')'
          ),
        shell + ' natural echo rendered independently'
      )
      await input('exit')
      const retired = await retireShell(
        natural,
        shell + ' natural native message/utility completion and attributed shell retirement'
      )
      const terminal = terminalFor(retired, natural.sessionId)
      assert.equal(terminal.closeMessages, 0)
      assert.equal(terminal.nativeExit.exitCode, 0)
      await until(
        () =>
          evaluate(
            'document.querySelector("#terminal-panel .terminal-toolbar").textContent.includes("已退出（0）")'
          ),
        shell + ' natural exit renderer status'
      )
      await screenshot('natural-exit-' + shell)
      naturalShells.push(terminal)
      await click('#terminal-panel-close')
      await until(
        () => evaluate('!document.querySelector("#terminal-panel")'),
        shell + ' exited panel closes'
      )
    }
    assert.equal(
      (await evaluate('window.api.updateSettings({terminalShell:"powershell"})')).terminalShell,
      'powershell'
    )
    report.checks.push({
      name: 'real PowerShell and cmd echo and natural exit retire shell and utility without a close request; renderer shows exit code zero',
      pass: true,
      shells: naturalShells.map(
        ({ pid, hostPid, program, closeMessages, nativeExit, hostExit }) => ({
          pid,
          hostPid,
          program,
          closeMessages,
          nativeExit,
          hostExit
        })
      )
    })
    const familyScript = path.join(evidence, 'owned-family.cjs')
    await fs.writeFile(
      familyScript,
      `const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const [token, mode = 'child'] = process.argv.slice(2)
if (token !== ${JSON.stringify(uuid)}) throw new Error('Wrong owned family token')
fs.writeFileSync(path.join(__dirname, 'owned-family-' + mode + '.json'), JSON.stringify({ pid: process.pid, ppid: process.ppid, token, mode }))
if (mode === 'child') spawn(process.execPath, [__filename, token, 'grandchild'], { stdio: 'inherit', windowsHide: true })
let number = 0
setInterval(() => process.stdout.write(${JSON.stringify(marker + '-family-')} + mode + '-' + (++number) + '\\n'), 100)
`
    )
    await open()
    const familyShell = await start()
    const psQuote = (value) => "'" + value.replaceAll("'", "''") + "'"
    await input(
      '& ' + psQuote(process.execPath) + ' ' + psQuote(familyScript) + ' ' + psQuote(uuid)
    )
    const family = await until(async () => {
      try {
        const records = await Promise.all(
          ['child', 'grandchild'].map(async (mode) =>
            JSON.parse(
              await fs.readFile(path.join(evidence, 'owned-family-' + mode + '.json'), 'utf8')
            )
          )
        )
        return records.every((record) => alive(record.pid)) ? records : null
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
        throw error
      }
    }, 'actual Node child and grandchild started under real shell')
    assert.ok(family.every((record) => record.token === uuid))
    assert.equal(family[0].ppid, familyShell.pid)
    assert.equal(family[1].ppid, family[0].pid)
    await until(
      async () =>
        terminalFor(await audit(), familyShell.sessionId).output.includes(
          marker + '-family-grandchild-'
        ),
      'continuous attached grandchild output'
    )
    await screenshot('attached-child-grandchild-output')
    await click('#terminal-panel-close')
    await retireShell(familyShell, 'shell and utility completion with attached descendants')
    await until(
      () => family.every((record) => !alive(record.pid)),
      'actual attached child and grandchild retired'
    )
    await until(
      () => evaluate('!document.querySelector("#terminal-panel")'),
      'descendant shell panel removed'
    )
    report.checks.push({
      name: 'closing real foreground continuous-output Node child and grandchild retires only observed owned process family',
      pass: true,
      shellPid: familyShell.pid,
      family,
      script: familyScript,
      scriptSHA256: hash(await fs.readFile(familyScript))
    })
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
    const uncertainAudit = await audit()
    const uncertain = await observeTerminal(lastSession(uncertainAudit))
    assert.ok(
      alive(uncertain.pid),
      'Real PTY remains alive after failed startup reply and first close'
    )
    assert.equal(uncertain.closeMessages, 0)
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
    await retireShell(uncertain, 'same-ID retry retires real uncertain utility and shell')
    assert.equal(terminalFor(afterFault, uncertain.sessionId).closeMessages, 1)
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
      async () => terminalFor(await audit(), last.sessionId).output.includes(marker + '-window'),
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
    const finalAudit = await until(
      async () => {
        const observed = augmentAudit(JSON.parse(await fs.readFile(auditFile, 'utf8')))
        return allHostsRetired(observed) ? observed : null
      },
      'window destruction actual utility/native exit message and shell retirement',
      30000,
      true
    )
    assert.ok(
      finalAudit.terminals.every(
        (terminal) =>
          terminal.closeMessages ===
          (naturalShells.some((item) => item.pid === terminal.pid) ? 0 : 1)
      )
    )
    assert.equal(finalAudit.observerMovedToUtility, true)
    assert.equal(finalAudit.testOverridesUtilityForkArguments, false)
    assert.ok(finalAudit.unobservedInternalPTY.length > 0)
    await observeHostRetirement('real BrowserWindow.destroy completion')
    assert.deepEqual(
      Object.fromEntries(
        ['main', 'summary', 'title', 'approval'].map((category) => [
          category,
          finalAudit.requests.filter((request) => request.category === category).length
        ])
      ),
      { main: 3, summary: 0, title: 0, approval: 0 },
      'Later shell selection, natural exit and cleanup do not create model requests'
    )
    assert.equal(finalAudit.ipc.filter((item) => item.channel === 'agent:start').length, 2)
    assert.equal(finalAudit.ipc.filter((item) => item.channel === 'agent:resume').length, 0)
    assert.equal(JSON.stringify(finalAudit.requests).includes(marker), false)
    report.checks.push({
      name: 'panel close, natural exit, repeated close, descendants and real BrowserWindow.destroy retire all utility hosts and externally attributed shell PIDs',
      pass: true,
      shells: finalAudit.terminals.map(
        ({ pid, hostPid, sessionId, closeMessages, nativeExit, hostExit }) => ({
          pid,
          hostPid,
          sessionId,
          closeMessages,
          nativeExit,
          hostExit
        })
      )
    })
    report.checks.push({
      name: 'every real terminal utility reports native exit and actual process exit; utility-internal Worker/helper/module observation remains uncovered',
      pass: true,
      terminalHosts: finalAudit.terminals,
      internalPTYNotObserved: finalAudit.unobservedInternalPTY
    })
  }
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
      attachConsoleFailures: (logged.match(/AttachConsole failed/g) ?? []).length,
      explanation:
        'Full application/forwarded utility stderr retained. Shell PID attribution, native exit messages and utility actual exits are observed; utility-internal Worker/helper/module loading is not directly observed. No AttachConsole failure is accepted.'
    }
  }
  if (report.pass) {
    try {
      assert.equal(child.exitCode, 0, 'Actual application exits normally')
      await observeHostRetirement('after normal application exit')
      assert.equal(
        report.processes[0].forcedKill,
        false,
        'Successful check needs no forced app termination'
      )
      assert.equal(
        report.nativeDiagnostics.attachConsoleFailures,
        0,
        'No AttachConsole failure in retained logs'
      )
      report.checks.push({
        name: 'normal application exit zero and zero AttachConsole stderr without forced termination',
        pass: true,
        appPid: child.pid,
        exitCode: child.exitCode,
        attachConsoleFailures: report.nativeDiagnostics.attachConsoleFailures
      })
      if (!guardClose) {
        const stage = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), '--close-guard', ...(packaged ? ['--packaged'] : [])],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let stdout = '',
          stderr = ''
        stage.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        stage.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        const stageExit = await new Promise((resolve, reject) => {
          stage.once('error', reject)
          stage.once('exit', (exitCode, signal) => resolve({ pid: stage.pid, exitCode, signal }))
        })
        await fs.writeFile(path.join(evidence, 'close-guard.stdout.log'), stdout)
        await fs.writeFile(path.join(evidence, 'close-guard.stderr.log'), stderr)
        const stageSummary = stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .filter((item) => item && 'pass' in item)
          .at(-1)
        report.closeGuard = { ...stageExit, ...(stageSummary ?? {}) }
        assert.equal(stageExit.exitCode, 0, 'Separate actual close-protection stage completes')
        assert.equal(stageExit.signal, null)
        assert.equal(stageSummary?.pass, true, 'Separate actual close-protection report passes')
        const stageReport = JSON.parse(
          await fs.readFile(path.join(stageSummary.evidence, 'results.json'), 'utf8')
        )
        assert.equal(stageReport.packaged, packaged)
        assert.equal(stageReport.guardClose, true)
        assert.equal(stageReport.pass, true)
        assert.notEqual(stageReport.uuid, uuid)
        report.checks.push({
          name: 'separate actual close-protection cancellation and Save and close stage passes with fresh UUID',
          pass: true,
          evidence: stageSummary.evidence,
          uuid: stageReport.uuid,
          checks: stageReport.checks.length
        })
      }
    } catch (error) {
      report.pass = false
      report.failures.push({ message: error.message, stack: error.stack })
    }
  }
  await fs.mkdir(evidence, { recursive: true })
  if (report.conptyHosts.owned.length === 0)
    report.notCovered.push(
      'No ConPTY conhost.exe instance could be attributed by the strict terminal utility PID and CreationDate rule; no arbitrary system conhost is treated as owned.'
    )
  if (report.conptyHosts.unavailable.length > 0)
    report.notCovered.push(
      'Read-only CIM observation was unavailable for some phases; corresponding ConPTY host ownership or retirement is not claimed.'
    )
  if (
    report.pass &&
    report.conptyHosts.owned.length > 0 &&
    report.conptyHosts.owned.every((host) => host.retired)
  )
    report.checks.push({
      name: 'externally attributed new ConPTY host PIDs retired; proof limited to observed process instances',
      pass: true,
      owned: report.conptyHosts.owned
    })
  await fs.writeFile(
    path.join(evidence, 'conpty-host-observations.json'),
    JSON.stringify(report.conptyHosts, null, 2)
  )
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      packaged,
      guardClose,
      failures: report.failures.map((item) => item.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
