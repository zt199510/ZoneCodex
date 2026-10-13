import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  root,
  hash,
  createEvidence,
  diskIdentity,
  runProcess,
  delay,
  verifyProcessRetirement
} from './runtime.mjs'
import { createGitMaterials } from './materials.mjs'

assert.equal(process.platform, 'win32', 'Real lesson61 desktop validation requires Windows')
const packaged = process.argv.includes('--packaged')
const ordinary = process.argv.includes('--ordinary')
assert(process.argv.slice(2).every((argument) => ['--packaged', '--ordinary'].includes(argument)))
assert(!ordinary || packaged, 'Ordinary observation is a separate directory-package condition')
const evidence = await createEvidence(
  'desktop-' + (packaged ? 'packaged-' : 'development-') + (ordinary ? 'ordinary' : 'debug')
)
const require = createRequire(import.meta.url)
const { install } = require('./desktop-fixture.cjs')
const userData = path.join(evidence, 'user-data'),
  taskRoot = path.join(evidence, 'task-root')
const auditFile = path.join(evidence, 'main-audit.json')
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const report = {
  pass: false,
  evidence,
  packaged,
  ordinary,
  actualElectron: true,
  actualGit: true,
  actualPTY: !ordinary,
  actualDisk: true,
  realModelTransport: false,
  syntheticModelTransport: !ordinary,
  mainAudit: !ordinary,
  nativeDirectorySelection: ordinary
    ? 'Actual native dialog, controls scoped to owned app PID.'
    : 'Synthetic dialog result; actual button/IPC/reader/Git.',
  trustedRendererInput: true,
  checks: [],
  failures: [],
  process: null,
  notCovered: [
    'No real network model business.',
    'Complete OS-native handle reclamation and arbitrary command descendants are not proven.'
  ]
}
if (ordinary)
  report.notCovered.push(
    'Main IPC/model/spawn/utility counters are not observed in ordinary mode; debug evidence and identical artifacts are recorded separately.'
  )
const check = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail })
const deadline = Date.now() + 320000
let child, main, renderer, log, evaluate, screenshot
async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const result = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return result
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
    const promise = pending.get(value.id)
    if (!promise) return
    pending.delete(value.id)
    clearTimeout(promise.timer)
    value.error ? promise.reject(Error(JSON.stringify(value.error))) : promise.resolve(value.result)
  })
  return {
    socket,
    events,
    cdp: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++serial,
          timer = setTimeout(() => {
            pending.delete(id)
            reject(Error('Bounded inspector request: ' + method))
          }, 15000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function until(observe, label, milliseconds = 30000, allowExited = false) {
  for (const end = Math.min(Date.now() + milliseconds, deadline); Date.now() < end;) {
    if (!allowExited && child && child.exitCode !== null)
      throw Error('Owned app exited during ' + label)
    const value = await observe()
    if (value) return value
    await delay(100)
  }
  throw Error('Bounded observation exceeded: ' + label)
}
async function files(directory) {
  const result = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await files(filename)))
    else if (entry.isFile()) result.push(filename)
  }
  return result
}
async function identify() {
  const names = (await files(path.join(root, 'out'))).map((filename) =>
    path.relative(root, filename)
  )
  names.push(
    'tests/lesson61/desktop-check.mjs',
    'tests/lesson61/desktop-fixture.cjs',
    'tests/lesson61/materials.mjs',
    'tests/lesson61/native-directory.ps1',
    'scripts/node-pty-cleanup/manifest.json'
  )
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'scripts/node-pty-cleanup/manifest.json'), 'utf8')
  )
  for (const [name, identity] of Object.entries(manifest.files)) {
    const file = 'node_modules/node-pty/lib/' + name.replaceAll('\\', '/')
    assert.equal(hash(await fs.readFile(path.join(root, file))), identity.patchedSha256)
    names.push(file)
  }
  if (packaged)
    names.push('dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar')
  const identities = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name.replaceAll('\\', '/'),
        hash(await fs.readFile(path.join(root, name)))
      ])
    )
  )
  if (packaged) {
    const { extractFile } = require('@electron/asar')
    for (const [name, identity] of Object.entries(identities)) {
      if (
        !name.startsWith('out/main/') &&
        !name.startsWith('out/preload/') &&
        !name.startsWith('out/renderer/') &&
        !name.startsWith('node_modules/node-pty/lib/')
      )
        continue
      assert.equal(
        hash(
          extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))
        ),
        identity,
        'Package loads current artifact: ' + name
      )
    }
  }
  return identities
}

try {
  const materials = await createGitMaterials(evidence, { extended: false })
  await fs.mkdir(userData, { recursive: true })
  const conversation = (id, title, messages = []) => ({
    id,
    title,
    pinned: false,
    archived: false,
    defaultDirectory: path.join(taskRoot, id, 'workspace'),
    agentMode: 'execute',
    messages,
    toolRuns: [],
    workspace: null,
    tasks: []
  })
  const fixture = {
    version: 9,
    activeConversationId: 'lesson61-fixture',
    conversations: [
      conversation('lesson61-fixture', '第61课独立 Git 查看', [
        {
          id: 'fixture-user',
          role: 'user',
          mode: 'execute',
          content: '隔离历史记录。',
          status: 'complete'
        },
        {
          id: 'fixture-assistant',
          role: 'assistant',
          mode: 'execute',
          content:
            '[查看固定文件](/' +
            path.join(materials.main, 'dual.txt').replaceAll('\\', '/') +
            ':1)',
          status: 'complete'
        }
      ]),
      conversation('lesson61-passive', '第61课切换对照')
    ]
  }
  for (const value of fixture.conversations)
    await fs.mkdir(value.defaultDirectory, { recursive: true })
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
    path.join(evidence, 'synthetic-history.json'),
    JSON.stringify(fixture, null, 2)
  )
  const beforeArtifacts = await identify()
  await fs.writeFile(
    path.join(evidence, 'before-artifacts.json'),
    JSON.stringify(beforeArtifacts, null, 2)
  )
  const rendererPort = await port(),
    mainPort = ordinary ? null : await port()
  log = await fs.open(path.join(evidence, 'desktop.log'), 'w')
  const env = {
    ...process.env,
    APPDATA: path.join(evidence, 'roaming'),
    LOCALAPPDATA: path.join(evidence, 'local')
  }
  for (const key of Object.keys(env))
    if (/^NODE_OPTIONS$|^VSCODE_INSPECTOR_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^MODEL_/i.test(key))
      delete env[key]
  await fs.mkdir(env.APPDATA, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  const args = [
    ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
    '--user-data-dir=' + userData,
    ...(!ordinary ? ['--inspect-brk=127.0.0.1:' + mainPort] : []),
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + rendererPort,
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--in-process-gpu'
  ]
  child = spawn(executable, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd]
  })
  report.process = { pid: child.pid, executable, args, exitCode: null, forcedKill: false }
  console.log(JSON.stringify({ evidence, pid: child.pid, packaged, ordinary }))
  if (!ordinary) {
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
        JSON.stringify({
          root,
          userData,
          auditFile,
          directory: materials.main,
          git: materials.git
        }) +
        ');globalThis.__lesson61Ready',
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
  }
  const target = await until(async () => {
    try {
      return (await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()).find(
        (value) => value.type === 'page' && value.url.includes('renderer')
      )
    } catch {
      return null
    }
  }, 'renderer')
  renderer = await connect(target.webSocketDebuggerUrl)
  await renderer.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await renderer.cdp('Network.enable')
  evaluate = async (expression) => {
    const value = await renderer.cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (value.exceptionDetails)
      throw Error(value.exceptionDetails.exception?.description ?? 'Renderer observation failed')
    return value.result.value
  }
  const api = (name, ...values) =>
    evaluate('window.api[' + JSON.stringify(name) + '](...' + JSON.stringify(values) + ')')
  const invoke = (channel, ...values) =>
    evaluate(
      'window.electron.ipcRenderer.invoke(' +
        JSON.stringify(channel) +
        ',...' +
        JSON.stringify(values) +
        ')'
    )
  const audit = () => invoke('lesson61:observe')
  const configure = (value) => invoke('lesson61:configure', value)
  screenshot = async (label) => {
    const value = await renderer.cdp('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(evidence, label + '.png'), Buffer.from(value.data, 'base64'))
  }
  const click = async (selector) => {
    const point = await evaluate(
      '(()=>{const n=document.querySelector(' +
        JSON.stringify(selector) +
        ');if(!n||n.disabled)throw Error("Missing or disabled click target");n.scrollIntoView({block:"nearest",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const h=document.elementFromPoint(x,y);if(!h||!(h===n||n.contains(h)))throw Error("Target covered: "+' +
        JSON.stringify(selector) +
        ');return{x,y}})()'
    )
    await renderer.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1
    })
    await renderer.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1
    })
    await delay(80)
  }
  const key = async (name, code) => {
    await renderer.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: name,
      code,
      windowsVirtualKeyCode: name === 'Escape' ? 27 : 13
    })
    await renderer.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: name,
      code,
      windowsVirtualKeyCode: name === 'Escape' ? 27 : 13
    })
  }
  const panelText = () => evaluate('document.querySelector("#git-panel")?.innerText??""')
  const listReady = () =>
    until(
      () => evaluate('!!document.querySelector("#git-panel .git-change-list")'),
      'real Git list'
    )
  let nativeDialogSequence = 0
  const selectDirectory = async (directory) => {
    if (!ordinary) await configure({ directory })
    await click('#git-view-select')
    if (ordinary) {
      const dialogReport = 'native-dialog-' + ++nativeDialogSequence
      const result = await runProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(root, 'tests/lesson61/native-directory.ps1'),
          '-AppPid',
          String(child.pid),
          '-Directory',
          directory,
          '-OutputFile',
          path.join(evidence, dialogReport + '.json')
        ],
        { cwd: root },
        25000
      )
      await fs.writeFile(path.join(evidence, dialogReport + '.stdout.log'), result.stdout)
      await fs.writeFile(path.join(evidence, dialogReport + '.stderr.log'), result.stderr)
      assert.equal(result.exitCode, 0, result.stderr)
    }
    await until(
      () =>
        evaluate(
          'document.querySelector("#git-panel .git-view-scope span:nth-child(2)")?.title===' +
            JSON.stringify(directory) +
            '&&!!document.querySelector("#git-panel .git-change-list")'
        ),
      'selected directory real list'
    )
  }
  const read = async (group, filename, expected) => {
    await click(
      '.git-change-item[data-group=' +
        JSON.stringify(group) +
        '][data-path=' +
        JSON.stringify(filename) +
        ']'
    )
    await until(
      () =>
        evaluate(
          'document.querySelector("#git-panel .git-diff-code")?.textContent?.includes(' +
            JSON.stringify(expected) +
            ')'
        ),
      'real detail ' + group + ':' + filename
    )
    return evaluate('document.querySelector("#git-panel .git-diff-code").textContent')
  }
  await until(
    () =>
      evaluate(
        '!!document.querySelector("#git-panel-toggle")&&!document.querySelector(".startup-error")'
      ),
    'Git entry'
  )
  const permissionsBefore = await api('getExecutionPermissions')
  const auditBefore = ordinary ? null : await audit()
  await click('#git-panel-toggle')
  await until(() => evaluate('!!document.querySelector("#git-panel")'), 'open panel')
  assert((await panelText()).includes('选择本地仓库'))
  if (!ordinary) {
    const value = await audit()
    assert.equal(value.requests.length, 0)
    assert.equal(value.gitProcesses.length, 0)
    assert.equal(value.directoryReplies.length, 0)
  }
  check('actual entry opens empty independent panel without selection/query/model', {
    mainAudit: !ordinary
  })
  await selectDirectory(materials.main)
  const staged = await read('staged', 'dual.txt', '+INDEX B'),
    unstaged = await read('unstaged', 'dual.txt', '+WORKTREE C')
  assert(staged.includes('-HEAD A') && !staged.includes('WORKTREE C'))
  assert(unstaged.includes('-INDEX B') && !unstaged.includes('HEAD A'))
  await screenshot('dual-state-diff')
  check('trusted clicks show actual staged HEAD→index and unstaged index→worktree independently', {
    staged,
    unstaged
  })
  const untracked = await read('untracked', 'untracked.txt', materials.expected.untracked.trim())
  assert.equal(untracked, materials.expected.untracked.trimEnd())
  const deleted = await read('unstaged', 'deleted.txt', '-deleted HEAD baseline')
  const renamed = await read('staged', 'rename new 中文.txt', 'rename from rename-old.txt')
  check('trusted clicks display actual new content/deletion/rename', {
    untracked,
    deleted,
    renamed
  })
  await click('.git-change-item[data-group="staged"][data-path="dual.txt"]')
  await click('.git-change-item[data-group="unstaged"][data-path="dual.txt"]')
  await until(() => panelText().then((value) => value.includes('WORKTREE C')), 'rapid latest item')
  assert((await panelText()).includes('index → 工作树'))
  await click('#git-view-refresh')
  await listReady()
  assert.equal(await evaluate('!!document.querySelector("#git-panel .git-diff-code")'), false)
  check('real rapid item selection keeps latest identity and manual refresh clears detail')
  const beforeSwitch = ordinary ? null : await audit()
  await click('.conversation-item[title="第61课切换对照"]')
  assert((await panelText()).includes(materials.main))
  await click('.conversation-item[title="第61课独立 Git 查看"]')
  if (!ordinary) assert.equal((await audit()).gitProcesses.length, beforeSwitch.gitProcesses.length)
  await click('.sidebar-settings')
  assert.deepEqual(
    await evaluate(
      '(()=>{const p=document.querySelector("#git-panel"),w=p.closest(".workspace-shell");return{hidden:w.hidden,inert:w.inert,focus:!!document.activeElement?.closest("#git-panel")}})()'
    ),
    { hidden: true, inert: true, focus: false }
  )
  await click('.settings-back')
  if (!ordinary) assert.equal((await audit()).gitProcesses.length, beforeSwitch.gitProcesses.length)
  check(
    'session switching preserves independent repository; settings hides/inerts Git and does not auto query'
  )
  await click('.markdown-file-reference')
  await until(
    () =>
      evaluate(
        '!!document.querySelector(".file-view-panel")&&!document.querySelector("#git-panel")'
      ),
    'shared secondary file surface'
  )
  await click('#git-panel-toggle')
  await until(
    () =>
      evaluate(
        '!!document.querySelector("#git-panel")&&!document.querySelector(".file-view-panel")'
      ),
    'Git replaces file surface'
  )
  assert((await panelText()).includes('选择本地仓库'))
  check('real FileView/Git switching closes prior surface and clears prior Git range', {
    filePreviewReadGrantNotCreatedByGit: true
  })
  await selectDirectory(materials.subtree)
  const scopePaths = await evaluate(
    '[...document.querySelectorAll("#git-panel .git-change-item")].map(n=>n.dataset.path)'
  )
  assert(scopePaths.every((filename) => filename.startsWith('subtree/')))
  await read('unstaged', 'subtree/inside.txt', 'inside WORKTREE')
  await screenshot('subtree-scope')
  await selectDirectory(materials.empty)
  await read('staged', 'empty-staged.txt', '+staged before first commit')
  assert((await panelText()).includes('空树 → index'))
  await selectDirectory(materials.linked)
  assert((await panelText()).includes('linked worktree'))
  await read('unstaged', 'dual.txt', '+linked WORKTREE')
  check('real directory changes cover selected subtree, empty HEAD and linked worktree', {
    scopePaths
  })
  await selectDirectory(materials.main)
  await renderer.cdp('Emulation.setDeviceMetricsOverride', {
    width: 780,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  })
  const narrow = await evaluate(
    '(()=>{const p=document.querySelector("#git-panel").getBoundingClientRect();return{left:p.left,right:p.right,width:innerWidth}})()'
  )
  assert(narrow.left >= 0 && narrow.right <= narrow.width + 1)
  await screenshot('narrow-git')
  await renderer.cdp('Emulation.clearDeviceMetricsOverride')
  await click('#git-panel-close')
  await until(
    () =>
      evaluate(
        '!document.querySelector("#git-panel")&&document.activeElement?.id==="git-panel-toggle"'
      ),
    'close focus'
  )
  await click('#git-panel-toggle')
  assert((await panelText()).includes('选择本地仓库'))
  await key('Escape', 'Escape')
  await until(
    () =>
      evaluate(
        '!document.querySelector("#git-panel")&&document.activeElement?.id==="git-panel-toggle"'
      ),
    'keyboard close/focus'
  )
  check('narrow real viewport and mouse/Escape close restore focus; reopening requires selection', {
    narrow
  })
  if (!ordinary) {
    const passive = await audit()
    assert.equal(passive.requests.length, auditBefore.requests.length)
    assert.equal(
      passive.ipc.filter(
        (item) =>
          item.channel === 'agent:start' ||
          item.channel === 'workspace:select' ||
          item.channel === 'project:select'
      ).length,
      0
    )
    assert.deepEqual(await api('getExecutionPermissions'), permissionsBefore)
    check(
      'all passive Git actions create zero main/summary/title/reviewer requests, Agent starts or workspace/project grants'
    )
    await click('#terminal-panel-toggle')
    await until(
      () => evaluate('!!document.querySelector("#terminal-panel .xterm")'),
      'terminal mounted'
    )
    await click('#terminal-panel .terminal-toolbar button:first-of-type')
    await until(
      async () => (await audit()).utilityHosts.find((host) => host.ready),
      'actual terminal ready'
    )
    const terminal = (await audit()).utilityHosts[0],
      terminalMarker = 'lesson61-PTY-' + path.basename(evidence)
    const echo = async (suffix) => {
      await click('#terminal-panel .xterm-screen')
      await renderer.cdp('Input.insertText', {
        text: 'Write-Output "' + terminalMarker + '-' + suffix + '"'
      })
      await key('Enter', 'Enter')
      await until(
        async () => (await audit()).utilityHosts[0].output.includes(terminalMarker + '-' + suffix),
        'real echo ' + suffix
      )
    }
    await echo('before-git')
    await click('#git-panel-toggle')
    await selectDirectory(materials.main)
    await click('#git-view-refresh')
    await listReady()
    await echo('with-git')
    await click('#git-panel-close')
    await echo('after-git')
    assert.equal((await audit()).utilityHosts[0].sessionId, terminal.sessionId)
    assert.equal((await audit()).utilityHosts[0].exitedAtUTC, null)
    check('actual PTY echo continues in same session across Git selection/refresh/close', {
      sessionId: terminal.sessionId,
      utilityPid: terminal.pid
    })
    await configure({ scenario: 'running' })
    await click('#chat-input')
    await renderer.cdp('Input.insertText', { text: '第61课合成运行背景' })
    await click('button[aria-label="发送消息"]')
    await until(
      async () => (await audit()).requests.find((value) => value.waitingForCancellation),
      'synthetic Agent running'
    )
    const busyBefore = await audit(),
      busyPermissions = await api('getExecutionPermissions')
    await click('#git-panel-toggle')
    await selectDirectory(materials.main)
    await click('#git-view-refresh')
    await listReady()
    await read('unstaged', 'dual.txt', '+WORKTREE C')
    const busyAfter = await audit()
    assert.equal(busyAfter.requests.length, busyBefore.requests.length)
    assert.deepEqual(await api('getExecutionPermissions'), busyPermissions)
    assert.equal(busyAfter.utilityHosts[0].sessionId, terminal.sessionId)
    await screenshot('git-agent-running-terminal')
    await click('button[aria-label="停止生成"]')
    await until(
      async () => (await audit()).requests.find((value) => value.cancelled),
      'actual Agent cancellation'
    )
    await echo('after-stop')
    check(
      'synthetic model running background permits actual Git reads; permissions/request count/task cancellation and same PTY remain independent',
      { syntheticModelTransport: true, newGitModelRequests: 0 }
    )
    await until(
      () => evaluate('!document.querySelector(\'button[aria-label="停止生成"]\')'),
      'Agent owner cancellation settled'
    )
    const sendScenario = async (name) => {
      await configure({ scenario: name })
      await click('#chat-input')
      await renderer.cdp('Input.insertText', { text: '第61课合成' + name + '背景' })
      await click('button[aria-label="发送消息"]')
    }
    await sendScenario('approval')
    await until(
      () => evaluate('!!document.querySelector(".execution-approval[open]")'),
      'real manual approval dialog for synthetic out-of-root file request'
    )
    const approvalBefore = await audit()
    assert.equal(await evaluate('document.querySelector("#git-view-select").disabled'), true)
    const blocked = await evaluate('window.api.selectGitDirectory(crypto.randomUUID())')
    assert.equal(blocked.status, 'error')
    assert.equal((await audit()).directoryReplies.length, approvalBefore.directoryReplies.length)
    const scope = approvalBefore.ipc
      .filter((item) => item.channel === 'git:select' && item.result?.status === 'ready')
      .at(-1).result.view
    const modalList = await api('refreshGitView', {
      requestId: 'approval-read-list',
      viewId: scope.viewId
    })
    assert.equal(modalList.status, 'ready')
    const modalItem = modalList.items.find(
      (item) => item.path === 'dual.txt' && item.group === 'unstaged'
    )
    const modalDetail = await api('readGitItem', {
      requestId: 'approval-read-detail',
      viewId: scope.viewId,
      revision: modalList.revision,
      itemId: modalItem.itemId
    })
    assert.equal(modalDetail.status, 'ready')
    assert.equal((await audit()).requests.length, approvalBefore.requests.length)
    await screenshot('git-existing-scope-approval')
    await click('.execution-approval-cancel')
    await until(
      () => evaluate('!document.querySelector(\'button[aria-label="停止生成"]\')'),
      'approval operation rejection owner completes'
    )
    const rejectedTarget = path.resolve(userData, '..', 'isolated-approval.txt')
    await assert.rejects(fs.access(rejectedTarget), { code: 'ENOENT' })
    await click('#git-view-refresh')
    await listReady()
    check(
      'approval modal disables new native chooser in UI and main while existing scope is readable through legal API',
      {
        syntheticModelTransport: true,
        realManualApproval: true,
        rejectedTargetAbsent: rejectedTarget,
        modalReadUsedAPI: true,
        outsideModalMouseReadNotClaimed: true,
        newGitModelRequests: 0
      }
    )
    await click('.composer-mode .permissions-trigger')
    await click('.agent-mode-popover [data-mode="plan"]')
    await sendScenario('question')
    await until(
      () => evaluate('!!document.querySelector(".plan-question-card")'),
      'real question card with synthetic model'
    )
    const questionBefore = await audit()
    assert.equal(await evaluate('document.querySelector("#git-view-select").disabled'), true)
    const blockedQuestion = await evaluate('window.api.selectGitDirectory(crypto.randomUUID())')
    assert.equal(blockedQuestion.status, 'error')
    await click('#git-view-refresh')
    await listReady()
    await read('unstaged', 'dual.txt', '+WORKTREE C')
    assert.equal((await audit()).requests.length, questionBefore.requests.length)
    await screenshot('git-existing-scope-question')
    await click('.plan-question-actions button[type="button"]')
    await until(
      () => evaluate('!document.querySelector(".plan-question-card")'),
      'question owner stopped'
    )
    check(
      'question wait blocks new directory in UI/main and permits actual existing-scope refresh/detail without new model calls',
      { syntheticModelTransport: true, newGitModelRequests: 0 }
    )
    await click('#git-panel-close')
    await click('#terminal-panel-close')
    await until(async () => (await audit()).utilityHosts[0].exitedAtUTC, 'terminal close')
    const hosts = (await audit()).utilityHosts
    assert(
      hosts.every((host) => Number.isInteger(host.nativeExit?.exitCode) && host.exitCode === 0)
    )
    const allGit = (await audit()).gitProcesses
    assert(allGit.length > 0 && allGit.every((process) => process.closedAtUTC))
    const retirementObservations = await verifyProcessRetirement([
      ...allGit.map((process) => ({
        pid: process.pid,
        executable: process.program,
        closedAtUTC: process.closedAtUTC
      })),
      ...hosts.map((host) => ({ pid: host.pid, closedAtUTC: host.exitedAtUTC }))
    ])
    check(
      'actual owned Git children close and utility confirms public PTY exit then process retirement',
      {
        gitChildren: allGit.length,
        utilityHosts: hosts,
        retirementObservations,
        nativeInternalHandlesDirectlyObserved: false
      }
    )
  } else {
    report.rendererNetworkEvents = renderer.events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => ({ url: event.params.request.url, type: event.params.type }))
    assert(report.rendererNetworkEvents.every((event) => !/^https?:/i.test(event.url)))
    check(
      'ordinary package completes actual native-dialog Git UI flow with no renderer HTTP traffic',
      { mainCountersObserved: false }
    )
  }
  const afterMaterial = await diskIdentity(materials.directory)
  assert.deepEqual(afterMaterial, materials.before)
  await fs.writeFile(
    path.join(evidence, 'after-material-identities.json'),
    JSON.stringify(afterMaterial, null, 2)
  )
  for (const filename of (await files(userData)).filter((name) =>
    /conversation\.json$|[\\/]task-checkpoints[\\/]/.test(name)
  )) {
    const content = await fs.readFile(filename, 'utf8')
    for (const marker of [
      'WORKTREE C',
      'INDEX B',
      'untracked has no Git baseline',
      'gitViewId',
      'gitRevision'
    ])
      assert.equal(content.includes(marker), false, 'Git view content absent from ' + filename)
  }
  check(
    'real desktop reads leave each fixture disk identity unchanged and Git contents absent from conversation/checkpoint storage',
    { identities: Object.keys(afterMaterial).length }
  )
  assert.deepEqual(await identify(), beforeArtifacts)
  check(
    'loaded development/package main/preload/renderer/helper/native-maintenance artifact identities remain unchanged'
  )
  await screenshot('final-git-closed')
  if (!ordinary) await evaluate('void window.electron.ipcRenderer.invoke("lesson61:quit");true')
  else await click('button[aria-label="关闭窗口"]')
  main?.socket.close()
  renderer?.socket.close()
  await until(() => child.exitCode !== null, 'normal owned app exit', 20000, true)
  assert.equal(child.exitCode, 0)
  report.process.exitCode = child.exitCode
  check('owned app exits normally through production cleanup without forced rescue')
  report.pass = true
} catch (error) {
  report.failures.push({ error: error.stack ?? String(error) })
  console.error(error)
  try {
    await screenshot?.('failed-state')
  } catch {
    /* Preserve the failure even if the renderer is unavailable. */
  }
} finally {
  if (child && child.exitCode === null) {
    try {
      if (!ordinary && evaluate)
        await evaluate('void window.electron.ipcRenderer.invoke("lesson61:quit");true')
      main?.socket.close()
      renderer?.socket.close()
      await until(() => child.exitCode !== null, 'failure cleanup', 10000, true)
    } catch {
      report.process.forcedKill = true
      // Rescue only the explicitly owned test app tree, never another app/user process.
      await runProcess(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { cwd: root },
        10000
      )
      await until(() => child.exitCode !== null, 'owned rescue process exit', 5000, true).catch(
        () => {}
      )
    }
  }
  main?.socket.close()
  renderer?.socket.close()
  await log?.close()
  if (child) report.process.exitCode = child.exitCode
  if (report.process?.forcedKill) report.pass = false
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      checks: report.checks.length,
      packaged,
      ordinary
    })
  )
  if (!report.pass) process.exitCode = 1
}
