import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  root,
  hash,
  runProcess,
  delay,
  diskIdentity,
  verifyProcessRetirement
} from '../lesson61/runtime.mjs'

assert.equal(process.platform, 'win32')
const packaged = process.argv.includes('--packaged')
const ordinary = process.argv.includes('--ordinary')
assert(process.argv.slice(2).every((arg) => ['--packaged', '--ordinary'].includes(arg)))
assert(
  !ordinary || packaged,
  'Ordinary native chooser validation uses the Windows directory package'
)
const evidence = path.join(
  root,
  '.ui-check/git-codex-parity/completion-52fbcd9f-8614-4890-9386-9dc727281863/materials',
  (ordinary ? 'o-' : packaged ? 'p-' : 'd-') + randomUUID()
)
await fs.mkdir(evidence, { recursive: true })
const require = createRequire(import.meta.url)
const { install } = require('./desktop-fixture.cjs')
const userData = path.join(evidence, 'app'),
  taskRoot = path.join(evidence, 'tasks')
const auditFile = path.join(evidence, 'main-audit.json'),
  candidateAuditFile = path.join(evidence, 'candidate-audit.json'),
  completionAuditFile = path.join(evidence, 'completion-audit.json')
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const report = {
  implementationUUID: '52fbcd9f-8614-4890-9386-9dc727281863',
  pass: false,
  evidence,
  packaged,
  ordinary,
  actualElectron: true,
  actualGit: true,
  actualPTY: !ordinary,
  actualDisk: true,
  actualAgentLifecycle: !ordinary,
  actualFilesystemWatchers: !ordinary,
  trustedRendererInput: true,
  syntheticModelTransport: !ordinary,
  realModelTransport: false,
  mainCountersObserved: !ordinary,
  nativeDirectorySelection: ordinary
    ? 'Actual native chooser, scoped to this owned app PID.'
    : 'Synthetic native chooser replies; actual click, IPC and disk.',
  checks: [],
  failures: [],
  process: null,
  notCovered: [
    'Real remote/model business is not exercised by desktop tests.',
    'OS internal PTY handles and arbitrary command descendants are not proven.'
  ]
}
if (ordinary)
  report.notCovered.push(
    'Main IPC/model/Git process/utility counters are not observed in ordinary mode; debug evidence is recorded separately.'
  )
const check = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail })
const deadline = Date.now() + 420000
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
    'tests/git-workbench/desktop-check.mjs',
    'tests/git-workbench/desktop-fixture.cjs',
    'tests/lesson61/desktop-fixture.cjs',
    'tests/lesson61/materials.mjs',
    'tests/lesson61/native-directory.ps1',
    'scripts/node-pty-cleanup/manifest.json'
  )
  names.push(
    ...(await files(path.join(root, 'src'))).map((filename) => path.relative(root, filename))
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
  const materials = {
    main: path.join(evidence, 'repo'),
    second: path.join(evidence, 'repo-secondary'),
    third: path.join(evidence, 'repo-third'),
    git: path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/cmd/git.exe')
  }
  const targets = path.join(evidence, 'targets')
  await fs.mkdir(materials.main)
  await fs.mkdir(materials.second)
  await fs.mkdir(materials.third)
  await fs.mkdir(targets)
  await fs.mkdir(userData)
  const blankConfig = path.join(evidence, 'empty.config')
  await fs.writeFile(blankConfig, '')
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: blankConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1'
  }
  const gitFixture = async (args, directory = materials.main) => {
    const relative = path.relative(evidence, path.resolve(directory))
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Fixture Git writes remain in this UUID material directory'
    )
    const result = await runProcess(
      materials.git,
      [
        '--no-optional-locks',
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=Desktop Fixture',
        '-c',
        'user.email=desktop@example.invalid',
        ...args
      ],
      { cwd: directory, env: gitEnvironment },
      15000
    )
    ;(report.fixtureGit ??= []).push({ directory, args, ...result })
    assert.equal(result.exitCode, 0, result.stderr)
    return result.stdout.trimEnd()
  }
  const baseline =
    Array.from({ length: 24 }, (_, index) => 'baseline line ' + (index + 1)).join('\n') + '\n'
  const edited = baseline
    .replace('baseline line 2\n', 'DESKTOP_GIT_DELTA line 2\n')
    .replace('baseline line 23\n', 'DESKTOP_GIT_DELTA line 23\n')
  await gitFixture(['init', '--initial-branch=main'])
  await gitFixture(['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(materials.main, 'a.txt'), baseline)
  await fs.writeFile(path.join(materials.main, 'other.txt'), 'other baseline\n')
  await gitFixture(['add', '--all'])
  await gitFixture(['commit', '-m', 'desktop baseline'])
  const initialHEAD = await gitFixture(['rev-parse', 'HEAD'])
  const originalConfig = await fs.readFile(path.join(materials.main, '.git/config'))
  const secondaryConfigs = {}
  for (const [directory, marker] of [
    [materials.second, 'SECONDARY'],
    [materials.third, 'THIRD']
  ]) {
    await gitFixture(['init', '--initial-branch=main'], directory)
    await gitFixture(['config', 'core.autocrlf', 'false'], directory)
    await fs.writeFile(path.join(directory, 'shared.txt'), marker + '_baseline\n')
    await gitFixture(['add', '--all'], directory)
    await gitFixture(['commit', '-m', 'desktop secondary baseline'], directory)
    secondaryConfigs[directory] = await fs.readFile(path.join(directory, '.git/config'))
    await fs.writeFile(path.join(directory, 'shared.txt'), 'DESKTOP_GIT_' + marker + '_DELTA\n')
  }
  await fs.writeFile(path.join(materials.main, 'a.txt'), edited)
  await fs.writeFile(
    path.join(materials.main, 'other.txt'),
    'DESKTOP_GIT_OTHER unchanged by one-file operations\n'
  )
  await fs.writeFile(path.join(materials.main, 'new.txt'), 'DESKTOP_GIT_UNTRACKED\n')
  const beforeMaterial = await diskIdentity(materials.main)
  await fs.writeFile(
    path.join(evidence, 'before-material-identities.json'),
    JSON.stringify(beforeMaterial, null, 2)
  )
  const conversation = (id, title) => ({
    id,
    title,
    pinned: false,
    archived: false,
    defaultDirectory: path.join(taskRoot, id, 'workspace'),
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks: []
  })
  const fixture = {
    version: 9,
    activeConversationId: 'workbench-fixture',
    conversations: [
      conversation('workbench-fixture', 'Git 工作台隔离验收'),
      conversation('workbench-passive', '独立聊天对照')
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
          git: materials.git,
          candidateAuditFile,
          completionAuditFile
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
  await renderer.cdp('Runtime.evaluate', {
    expression: `
    window.__desktopVisibleAll = selector => [...document.querySelectorAll(selector)].filter(n =>
      !n.closest('[hidden]') && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden');
    window.__desktopVisible = selector => window.__desktopVisibleAll(selector)[0] || null;
    true`,
    returnByValue: true
  })
  await renderer.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await renderer.cdp('Network.enable')
  evaluate = async (expression, includeHidden = false) => {
    const value = await renderer.cdp('Runtime.evaluate', {
      expression: includeHidden
        ? expression
        : expression
            .replaceAll('document.querySelectorAll(', 'window.__desktopVisibleAll(')
            .replaceAll('document.querySelector(', 'window.__desktopVisible('),
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
    const point = await until(
      () =>
        evaluate(
          '(()=>{const n=document.querySelector(' +
            JSON.stringify(selector) +
            ');if(!n||n.disabled)return false;n.scrollIntoView({block:"nearest",inline:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const h=document.elementFromPoint(x,y);if(!h||!(h===n||n.contains(h)))throw Error("Target covered: "+' +
            JSON.stringify(selector) +
            ');return{x,y}})()'
        ),
      'enabled trusted click ' + selector
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
  const panelText = () => evaluate('document.querySelector("#git-panel")?.innerText ?? ""')
  const candidates = () => invoke('workbench:observe-candidates')
  const completion = () => invoke('workbench:observe-completion')
  const idle = async () => {
    await until(
      () =>
        evaluate(
          '!!document.querySelector("#git-workbench-source:not(:disabled)") && !!document.querySelector("#git-view-refresh:not(:disabled)")'
        ),
      'Git workbench idle'
    )
    await delay(120)
  }
  const pointClick = async (point) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await renderer.cdp('Input.dispatchMouseEvent', {
        type,
        ...point,
        button: 'left',
        clickCount: 1
      })
    await delay(80)
  }
  const clickText = async (selector, text) => {
    const point = await until(
      () =>
        evaluate(
          '(() => { const nodes = [...document.querySelectorAll(' +
            JSON.stringify(selector) +
            ')]; const n = nodes.find(n => n.innerText.trim() === ' +
            JSON.stringify(text) +
            '); if (!n || n.disabled) return false; n.scrollIntoView({block:"nearest",inline:"nearest"}); const r=n.getBoundingClientRect(), x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y); if(!h || !(h===n||n.contains(h))) throw Error("Text target is covered"); return {x,y}; })()'
        ),
      'enabled trusted text click ' + text
    )
    await pointClick(point)
  }
  const press = async (name, code, virtualKey, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp'])
      await renderer.cdp('Input.dispatchKeyEvent', {
        type,
        key: name,
        code,
        windowsVirtualKeyCode: virtualKey,
        modifiers
      })
  }
  const fill = async (selector, value) => {
    await click(selector)
    await press('a', 'KeyA', 65, 2)
    await renderer.cdp('Input.insertText', { text: value })
  }
  const selectValue = async (selector, value) => {
    const option = await evaluate(
      '(() => { const n=document.querySelector(' +
        JSON.stringify(selector) +
        '); if(!n) throw Error("Select absent"); const index=[...n.options].findIndex(o => o.value === ' +
        JSON.stringify(value) +
        ' || o.text.trim() === ' +
        JSON.stringify(value) +
        '); return {index,value:n.options[index]?.value}; })()'
    )
    assert(option.index >= 0, 'Select option exists: ' + value)
    for (let attempt = 1; attempt <= 3; attempt++) {
      await click(selector)
      await press('Home', 'Home', 36)
      for (let index = 0; index < option.index; index++) await press('ArrowDown', 'ArrowDown', 40)
      await press('Enter', 'Enter', 13)
      const deadline = Date.now() + 1600
      let actual
      do {
        await delay(140)
        actual = await evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.value')
        if (actual === option.value) break
      } while (Date.now() < deadline)
      ;(report.selectAttempts ??= []).push({ selector, requested: option.value, actual, attempt })
      if (actual === option.value) return
    }
    throw Error('Trusted select did not choose ' + value + ' in ' + selector)
  }
  let nativeDialogSequence = 0
  const selectDirectory = async (directory) => {
    if (!ordinary) await configure({ directory })
    await click('#git-view-select')
    if (ordinary) {
      const outputFile = path.join(evidence, 'native-dialog-' + ++nativeDialogSequence + '.json')
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
          outputFile
        ],
        { cwd: root },
        30000
      )
      await fs.writeFile(outputFile + '.stdout.log', result.stdout)
      await fs.writeFile(outputFile + '.stderr.log', result.stderr)
      assert.equal(result.exitCode, 0, result.stderr)
      assert.equal(result.forcedKill, false)
      const nativeResult = JSON.parse(
        (await fs.readFile(outputFile, 'utf8')).replace(/^\uFEFF/, '')
      )
      assert.equal(nativeResult.pass, true)
      assert.equal(nativeResult.actualNativeDialog, true)
      assert.equal(nativeResult.targetAppPid, child.pid)
      assert.equal(nativeResult.directory, directory)
      ;(report.nativeDialogs ??= []).push(nativeResult)
    }
    await idle()
    await until(
      () => panelText().then((text) => text.includes(directory)),
      'selected Git directory'
    )
  }
  const selectRepo = async (directory) => {
    const value = await evaluate(
      '[...document.querySelector(\'select[aria-label="选择 Git 仓库"]\').options].find(o => o.text.trim() === ' +
        JSON.stringify(path.basename(directory)) +
        ')?.value'
    )
    assert(value, 'Repository option exists: ' + directory)
    await selectValue('select[aria-label="选择 Git 仓库"]', value)
    await idle()
    await until(
      () => panelText().then((text) => text.includes(directory)),
      'selected repository ' + directory
    )
  }
  const allRepos = async (source = 'uncommitted') => {
    await selectValue('select[aria-label="选择 Git 仓库"]', 'all')
    await until(
      () =>
        evaluate(
          '!!document.querySelector(\'select[aria-label="全部仓库差异来源"]:not(:disabled)\') && document.querySelectorAll(".git-workbench-repository-group").length === 3'
        ),
      'all repo aggregate ready'
    )
    await selectValue('select[aria-label="全部仓库差异来源"]', source)
    await until(
      () =>
        evaluate(
          '!!document.querySelector(\'select[aria-label="全部仓库差异来源"]:not(:disabled)\') && !document.querySelector(".git-workbench-aggregate").innerText.includes("等待刷新仓库改动")'
        ),
      'all repo aggregate source ' + source
    )
  }
  const source = async (value) => {
    await idle()
    await selectValue('#git-workbench-source', value)
    await idle()
    await until(
      () =>
        evaluate('document.querySelector("#git-workbench-source")?.value').then(
          (actual) => actual === value
        ),
      'review source ' + value
    )
  }
  const read = async (filename, marker) => {
    await until(
      () =>
        evaluate(
          '!!document.querySelector(' +
            JSON.stringify('.git-change-item[data-path="' + filename + '"]') +
            ')'
        ),
      'Git file ' + filename
    )
    await click('.git-change-item[data-path="' + filename + '"]')
    await until(
      () =>
        evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\')?.innerText ?? ""').then(
          (text) => text.includes(marker)
        ),
      'actual Git diff ' + marker
    )
  }
  const fileAction = async (label) => {
    await clickText('.git-workbench-file-header button', label)
    await idle()
  }
  const manual = async (label) => {
    if (
      !(await evaluate(
        'document.querySelector(\'summary[aria-label="Git 操作"]\')?.parentElement.open'
      ))
    )
      await click('summary[aria-label="Git 操作"]')
    await clickText('.git-workbench-menu-body button', label)
    await until(
      () =>
        evaluate(
          '!!document.querySelector(' + JSON.stringify('dialog[aria-label="' + label + '"]') + ')'
        ),
      'manual dialog ' + label
    )
  }
  const submit = async (label) => {
    await click('dialog[aria-label="' + label + '"] button[type="submit"]')
    await until(
      () =>
        evaluate(
          '!document.querySelector(' + JSON.stringify('dialog[aria-label="' + label + '"]') + ')'
        ),
      'completed manual dialog ' + label
    )
    await idle()
  }
  await until(() => evaluate('!!document.querySelector("#git-panel-toggle")'), 'desktop shell')
  if (ordinary) {
    await click('#git-panel-toggle')
    await until(() => evaluate('!!document.querySelector("#git-panel")'), 'ordinary Git panel')
    await selectDirectory(materials.main)
    await source('unstaged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await screenshot('ordinary-real-native-selected-diff')
    await fileAction('暂存文件')
    assert.equal(await gitFixture(['diff', '--cached', '--name-only']), 'a.txt')
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    await source('staged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await fileAction('取消暂存文件')
    assert.equal(await gitFixture(['diff', '--cached', '--name-only']), '')
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    assert.equal(await gitFixture(['rev-parse', 'HEAD']), initialHEAD)
    assert.deepEqual(await fs.readFile(path.join(materials.main, '.git/config')), originalConfig)
    assert.equal(
      await fs.readFile(path.join(materials.main, 'other.txt'), 'utf8'),
      'DESKTOP_GIT_OTHER unchanged by one-file operations\n'
    )
    check(
      'ordinary Windows package uses actual native chooser then actual file stage/unstage buttons with disk/index/HEAD verification',
      { mainCountersObserved: false, actualModel: false, actualNativeChooser: true }
    )
    report.rendererNetworkEvents = renderer.events
      .filter((event) => event.method === 'Network.requestWillBeSent')
      .map((event) => ({ url: event.params.request.url, type: event.params.type }))
    assert(report.rendererNetworkEvents.every((event) => !/^https?:/i.test(event.url)))
    check('ordinary renderer has no observed HTTP traffic; main request counts are not claimed', {
      mainCountersObserved: false
    })
    await screenshot('ordinary-real-stage-unstage-complete')
    await click('#git-panel-close')
    await until(() => evaluate('!document.querySelector("#git-panel")'), 'ordinary panel close')
    await fs.writeFile(
      path.join(evidence, 'after-material-identities.json'),
      JSON.stringify(await diskIdentity(materials.main), null, 2)
    )
  } else {
    const auditBefore = await audit()
    const permissionsBefore = await api('getExecutionPermissions')
    await click('#git-panel-toggle')
    await until(() => evaluate('!!document.querySelector("#git-panel")'), 'Git panel')
    assert.equal((await audit()).requests.length, auditBefore.requests.length)
    assert.equal((await audit()).gitProcesses.length, auditBefore.gitProcesses.length)
    await selectDirectory(materials.main)
    await source('unstaged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await fill('input[aria-label="筛选改动文件"]', 'a.txt')
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll(".git-change-item")].map(n=>n.dataset.path)'),
      ['a.txt']
    )
    await fill('input[aria-label="筛选改动文件"]', '')
    await fill('input[aria-label="在差异中查找"]', 'DESKTOP_GIT_DELTA')
    await until(
      () =>
        evaluate(
          'document.querySelector(\'[aria-label="Git 差异内容"]\')?.querySelectorAll("mark").length > 0'
        ),
      'diff search highlighting'
    )
    await click('summary[aria-label="差异选项"]')
    await selectValue('select[aria-label="差异布局"]', 'split')
    await click('summary[aria-label="差异选项"]')
    assert.equal(
      await evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\').dataset.diffMode'),
      'split'
    )
    await screenshot('real-split-search')
    await fileAction('暂存文件')
    assert.equal(await gitFixture(['diff', '--cached', '--name-only']), 'a.txt')
    assert.equal(
      await fs.readFile(path.join(materials.main, 'other.txt'), 'utf8'),
      'DESKTOP_GIT_OTHER unchanged by one-file operations\n'
    )
    await source('staged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await fileAction('取消暂存文件')
    assert.equal(await gitFixture(['diff', '--cached', '--name-only']), '')
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    check(
      'actual buttons/filter/search/split and single file stage/unstage preserve newer working tree and unrelated file'
    )
    await source('unstaged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await clickText('.git-workbench-file-header button', '撤销文件')
    await clickText('dialog[aria-label="撤销改动确认"] button', '取消')
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    await clickText('.git-workbench-file-header button', '撤销文件')
    await clickText('dialog[aria-label="撤销改动确认"] button', '确认撤销')
    await until(
      async () => (await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8')) === baseline,
      'actual disk revert'
    )
    await idle()
    check('revert dialog cancellation keeps bytes; explicit confirm restores only selected file')
    await fs.writeFile(path.join(materials.main, 'a.txt'), edited)
    await click('#git-view-refresh')
    await idle()
    await source('unstaged')
    await read('a.txt', 'DESKTOP_GIT_DELTA')
    await click('.git-workbench-hunk button[title="暂存此差异块"]')
    await idle()
    const stagedHunk = await gitFixture(['diff', '--cached', '--', 'a.txt'])
    assert(stagedHunk.includes('DESKTOP_GIT_DELTA line 2'))
    assert(!stagedHunk.includes('DESKTOP_GIT_DELTA line 23'))
    await source('staged')
    await read('a.txt', 'DESKTOP_GIT_DELTA line 2')
    await manual('提交改动')
    const headBeforeGeneration = await gitFixture(['rev-parse', 'HEAD'])
    await clickText('dialog[aria-label="提交改动"] button', '生成提交说明')
    await until(
      () =>
        evaluate('document.querySelector(\'dialog[aria-label="提交改动"] textarea\')?.value').then(
          (text) => text?.includes('桌面生成候选')
        ),
      'editable generated candidate'
    )
    assert.equal(await gitFixture(['rev-parse', 'HEAD']), headBeforeGeneration)
    assert.equal((await candidates()).length, 1)
    assert.equal((await audit()).requests.length, auditBefore.requests.length)
    await fill(
      'dialog[aria-label="提交改动"] textarea',
      '桌面手工确认提交\n\n编辑过候选内容后明确提交。'
    )
    await clickText('dialog[aria-label="提交改动"] summary', '提交作者（仓库未配置时填写）')
    await fill('dialog[aria-label="提交改动"] details input:not([type])', 'Manual Desktop')
    await fill(
      'dialog[aria-label="提交改动"] input[type="email"]',
      'manual-desktop@example.invalid'
    )
    await screenshot('editable-candidate-manual-confirm')
    await submit('提交改动')
    assert.equal(
      await gitFixture(['show', '-s', '--format=%B', 'HEAD']),
      '桌面手工确认提交\n\n编辑过候选内容后明确提交。'
    )
    assert((await gitFixture(['show', 'HEAD:a.txt'])).includes('DESKTOP_GIT_DELTA line 2'))
    assert(!(await gitFixture(['show', 'HEAD:a.txt'])).includes('DESKTOP_GIT_DELTA line 23'))
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    assert.notEqual(await gitFixture(['rev-parse', 'HEAD']), initialHEAD)
    check(
      'actual opaque hunk staging and explicit isolated model candidate remain editable; only final manual confirm commits staged hunk',
      { syntheticCandidateRequests: 1, actualModel: false }
    )
    await source('uncommitted')
    await manual('提交改动')
    await fill('dialog[aria-label="提交改动"] textarea', '手工包含未暂存改动')
    await click('dialog[aria-label="提交改动"] input[type="checkbox"]')
    await clickText('dialog[aria-label="提交改动"] summary', '提交作者（仓库未配置时填写）')
    await fill('dialog[aria-label="提交改动"] details input:not([type])', 'Manual Desktop')
    await fill(
      'dialog[aria-label="提交改动"] input[type="email"]',
      'manual-desktop@example.invalid'
    )
    await submit('提交改动')
    assert.equal(await gitFixture(['status', '--porcelain']), '')
    assert.equal(await gitFixture(['show', 'HEAD:new.txt']), 'DESKTOP_GIT_UNTRACKED')
    check(
      'actual include-unstaged manual commit records current bounded files and clears the fixture index/worktree'
    )
    await manual('创建并切换分支')
    await fill('dialog[aria-label="创建并切换分支"] input', 'codex/desktop-branch')
    await submit('创建并切换分支')
    assert.equal(await gitFixture(['branch', '--show-current']), 'codex/desktop-branch')
    await manual('切换分支')
    await selectValue('dialog[aria-label="切换分支"] select', 'main')
    await submit('切换分支')
    assert.equal(await gitFixture(['branch', '--show-current']), 'main')
    check('actual create-and-switch and clean checkout dialogs update explicit local branch')
    await manual('创建工作树')
    await fill('dialog[aria-label="创建工作树"] input', 'desktop-tree')
    await configure({ directory: targets })
    await submit('创建工作树')
    const ownedTree = path.join(targets, 'desktop-tree')
    assert.equal(await gitFixture(['branch', '--show-current'], ownedTree), 'codex/desktop-tree')
    assert.equal(await gitFixture(['status', '--porcelain'], ownedTree), '')
    assert.equal(await gitFixture(['branch', '--show-current']), 'main')
    await manual('删除工作树')
    const worktreeOption = await evaluate(
      '[...document.querySelector(\'dialog[aria-label="删除工作树"] select\').options].find(o => o.text.includes("desktop-tree"))?.value'
    )
    assert(worktreeOption)
    await selectValue('dialog[aria-label="删除工作树"] select', worktreeOption)
    await submit('删除工作树')
    assert.equal(await fs.stat(ownedTree).catch(() => null), null)
    assert.equal(
      await gitFixture(['rev-parse', 'codex/desktop-tree']),
      await gitFixture(['rev-parse', 'HEAD'])
    )
    check(
      'actual owned worktree create/remove dialogs register a clean linked tree then remove only owned material while preserving its branch'
    )
    await invoke('workbench:configure-completion', {
      directories: [materials.second, materials.third]
    })
    await clickText('.git-repositories-selector button', '添加仓库')
    await idle()
    const collection = await api('getGitRepositories', randomUUID())
    assert.equal(collection.status, 'ready')
    assert.equal(collection.views.length, 3)
    assert.deepEqual(
      collection.views.map((view) => view.repositoryPath).sort(),
      [materials.main, materials.second, materials.third].sort()
    )
    assert.equal((await completion()).multiDirectoryReplies.length, 1)
    await selectRepo(materials.second)
    await source('unstaged')
    await read('shared.txt', 'DESKTOP_GIT_SECONDARY_DELTA')
    await click('input[aria-label="标记文件已查看"]')
    await selectRepo(materials.third)
    await read('shared.txt', 'DESKTOP_GIT_THIRD_DELTA')
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="标记文件已查看"]\').checked'),
      false
    )
    await selectRepo(materials.second)
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="标记文件已查看"]\').checked'),
      true
    )
    assert.equal(
      await evaluate('document.querySelector(".git-workbench-file-header strong").title'),
      'shared.txt'
    )
    await allRepos()
    assert.deepEqual(
      await evaluate(
        '[...document.querySelectorAll(".git-workbench-repository-group")].map(n=>n.querySelector(".git-workbench-scope").title).sort()'
      ),
      [materials.main, materials.second, materials.third].sort()
    )
    await screenshot('all-repositories-scope-isolation')
    await fs.writeFile(
      path.join(materials.second, 'aggregate-new.txt'),
      'DESKTOP_GIT_AGGREGATE_NEW\n'
    )
    await until(
      () =>
        evaluate(
          '[...document.querySelectorAll(".git-workbench-repository-group")].some(n=>n.innerText.includes("aggregate-new.txt"))'
        ),
      'automatic aggregate new-file refresh'
    )
    check(
      'trusted multi-directory addition retains three independent scopes; same-path Viewed is isolated and All repos automatically refreshes external files',
      {
        selectedViews: collection.views.map((view) => ({
          viewId: view.viewId,
          repositoryPath: view.repositoryPath
        }))
      }
    )
    await selectRepo(materials.main)
    await source('unstaged')
    const automaticBefore = await audit()
    await fs.writeFile(path.join(materials.main, 'other.txt'), 'DESKTOP_GIT_AUTO_FIRST\n')
    await read('other.txt', 'DESKTOP_GIT_AUTO_FIRST')
    await click('input[aria-label="标记文件已查看"]')
    await manual('提交改动')
    const retainedDraft = 'DESKTOP_GIT_DRAFT_KEEP\n\n未经手工提交，草稿保留。'
    await fill('dialog[aria-label="提交改动"] textarea', retainedDraft)
    await fs.writeFile(path.join(materials.main, 'other.txt'), 'DESKTOP_GIT_AUTO_SECOND\n')
    await until(
      () => panelText().then((text) => text.includes('当前操作结束后刷新')),
      'external invalidation paused behind manual draft'
    )
    await delay(600)
    assert.equal(
      await evaluate('document.querySelector(\'dialog[aria-label="提交改动"] textarea\').value'),
      retainedDraft
    )
    assert.equal(
      await evaluate('document.querySelector(".git-workbench-file-header strong").title'),
      'other.txt'
    )
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="标记文件已查看"]\').checked'),
      true
    )
    await screenshot('external-change-preserves-manual-draft')
    await clickText('dialog[aria-label="提交改动"] button', '取消')
    await idle()
    await until(
      () =>
        evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\')?.innerText ?? ""').then(
          (text) => text.includes('DESKTOP_GIT_AUTO_SECOND')
        ),
      'automatic selected diff refresh after modal closes'
    )
    assert.equal(
      await evaluate('document.querySelector(".git-workbench-file-header strong").title'),
      'other.txt'
    )
    assert.equal(
      await evaluate('document.querySelector(\'input[aria-label="标记文件已查看"]\').checked'),
      true
    )
    assert.equal((await audit()).requests.length, automaticBefore.requests.length)
    assert.equal((await candidates()).length, 1)
    check(
      'actual fs.watch automatically updates selected diff while preserving Viewed; external refresh pauses behind an unchanged manual commit draft and adds zero model calls'
    )
    await click('.conversation-item[title="独立聊天对照"]')
    assert((await panelText()).includes(materials.main))
    await click('.conversation-item[title="Git 工作台隔离验收"]')
    await click('.sidebar-settings')
    assert.equal(
      await evaluate(
        'document.querySelector("#git-panel").closest(".workspace-shell").inert',
        true
      ),
      true
    )
    await click('.settings-back')
    const passive = await audit()
    assert.equal(passive.requests.length, auditBefore.requests.length)
    assert.equal(
      passive.ipc.filter((item) =>
        ['agent:start', 'workspace:select', 'project:select'].includes(item.channel)
      ).length,
      0
    )
    assert.deepEqual(await api('getExecutionPermissions'), permissionsBefore)
    assert.equal((await candidates()).length, 1)
    check(
      'all passive/manual Git local actions add zero Agent/main/summary/title/approval requests or grants; explicit candidate is recorded separately'
    )
    await click('#terminal-panel-toggle')
    await until(
      () => evaluate('!!document.querySelector("#terminal-panel .xterm")'),
      'terminal mounted'
    )
    await click('#terminal-panel .terminal-toolbar button:first-of-type')
    await until(
      async () => (await audit()).utilityHosts.find((host) => host.ready),
      'actual PTY ready'
    )
    const terminal = (await audit()).utilityHosts[0]
    const terminalMarker = 'workbench-PTY-' + path.basename(evidence)
    const echo = async (suffix) => {
      await click('#terminal-panel .xterm-screen')
      await renderer.cdp('Input.insertText', {
        text: 'Write-Output "' + terminalMarker + '-' + suffix + '"'
      })
      await press('Enter', 'Enter', 13)
      await until(
        async () => (await audit()).utilityHosts[0].output.includes(terminalMarker + '-' + suffix),
        'actual harmless PTY echo ' + suffix
      )
    }
    await echo('before-agent')
    await configure({ scenario: 'running' })
    await fill('#chat-input', 'Git 隔离验收的合成运行背景')
    await click('button[aria-label="发送消息"]')
    await until(
      async () => (await audit()).requests.find((item) => item.waitingForCancellation),
      'synthetic Agent running'
    )
    const busyBefore = await audit(),
      busyPermissions = await api('getExecutionPermissions')
    await fs.writeFile(
      path.join(materials.main, 'other.txt'),
      'DESKTOP_GIT_BUSY unrelated terminal host\n'
    )
    await fs.writeFile(path.join(materials.second, 'shared.txt'), 'DESKTOP_GIT_SECONDARY_TURN\n')
    await fs.writeFile(path.join(materials.third, 'shared.txt'), 'DESKTOP_GIT_THIRD_TURN\n')
    await until(
      () =>
        evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\')?.innerText ?? ""').then(
          (text) => text.includes('DESKTOP_GIT_BUSY')
        ),
      'automatic Git refresh during actual Agent lifecycle'
    )
    await idle()
    await source('unstaged')
    await read('other.txt', 'DESKTOP_GIT_BUSY')
    await fileAction('暂存文件')
    assert.equal(await gitFixture(['diff', '--cached', '--name-only']), 'other.txt')
    await source('staged')
    await read('other.txt', 'DESKTOP_GIT_BUSY')
    await fileAction('取消暂存文件')
    await echo('agent-running')
    assert.equal((await audit()).requests.length, busyBefore.requests.length)
    assert.deepEqual(await api('getExecutionPermissions'), busyPermissions)
    assert.equal((await audit()).utilityHosts[0].sessionId, terminal.sessionId)
    assert.equal((await audit()).utilityHosts[0].exitedAtUTC, null)
    await screenshot('git-agent-running-terminal')
    await click('button[aria-label="停止生成"]')
    await until(
      async () => (await audit()).requests.find((item) => item.cancelled),
      'Agent owner cancellation'
    )
    await until(
      () => evaluate('!document.querySelector(\'button[aria-label="停止生成"]\')'),
      'Agent stopped'
    )
    await echo('after-stop')
    check(
      'actual Git writes and harmless PTY echo continue during synthetic Agent running without extra model request, permission change or terminal session replacement',
      { sessionId: terminal.sessionId, syntheticModelTransport: true }
    )
    await source('last-turn')
    await read('other.txt', 'DESKTOP_GIT_BUSY')
    const mainTurnText = await evaluate(
      'document.querySelector(\'[aria-label="Git 差异内容"]\').innerText'
    )
    assert(mainTurnText.includes('DESKTOP_GIT_AUTO_SECOND'))
    assert(
      !(await evaluate(
        '[...document.querySelectorAll(".git-workbench-file-header button")].some(n=>/暂存文件|取消暂存文件|撤销文件/.test(n.innerText))'
      ))
    )
    await screenshot('last-turn-stopped-frozen-main')
    await selectRepo(materials.second)
    await source('last-turn')
    await read('shared.txt', 'DESKTOP_GIT_SECONDARY_TURN')
    const secondaryTurnText = await evaluate(
      'document.querySelector(\'[aria-label="Git 差异内容"]\').innerText'
    )
    assert(secondaryTurnText.includes('DESKTOP_GIT_SECONDARY_DELTA'))
    await selectRepo(materials.third)
    await source('last-turn')
    await read('shared.txt', 'DESKTOP_GIT_THIRD_TURN')
    await allRepos('last-turn')
    assert.equal(
      await evaluate('document.querySelectorAll(".git-workbench-repository-group").length'),
      3
    )
    assert(
      !(await evaluate(
        '[...document.querySelectorAll(".git-workbench-aggregate footer button")].some(n=>/暂存|撤销/.test(n.innerText))'
      ))
    )
    await screenshot('all-repositories-last-turn')
    await selectRepo(materials.main)
    await source('last-turn')
    await read('other.txt', 'DESKTOP_GIT_BUSY')
    const frozenAudit = await audit()
    await fs.writeFile(
      path.join(materials.main, 'other.txt'),
      'DESKTOP_GIT_AFTER_TURN external follow-up\n'
    )
    await fs.writeFile(
      path.join(materials.second, 'shared.txt'),
      'DESKTOP_GIT_SECONDARY_AFTER_TURN\n'
    )
    await until(
      async () =>
        (await audit()).ipc.filter((item) => item.channel === 'git:metadata').length >
        frozenAudit.ipc.filter((item) => item.channel === 'git:metadata').length,
      'actual invalidation refresh after frozen turn'
    )
    await idle()
    await until(
      () =>
        evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\')?.innerText ?? ""').then(
          (text) => text.includes('DESKTOP_GIT_BUSY')
        ),
      'Last Turn survives later external source refresh'
    )
    assert.equal(
      await evaluate('document.querySelector(\'[aria-label="Git 差异内容"]\').innerText'),
      mainTurnText
    )
    assert(!(await panelText()).includes('DESKTOP_GIT_AFTER_TURN'))
    assert.equal((await audit()).requests.length, busyBefore.requests.length)
    assert.equal((await candidates()).length, 1)
    assert.deepEqual(await api('getExecutionPermissions'), busyPermissions)
    const turnEvents = (await completion()).invalidations.filter(
      (item) => item.event.reason === 'turn'
    )
    assert(
      collection.views.every((view) => turnEvents.some((item) => item.event.viewId === view.viewId))
    )
    check(
      'actual Agent host start/stop captures all explicitly selected repositories; Last Turn is visible, read-only and frozen despite later source refresh without extra model calls',
      {
        actualAgentLifecycle: true,
        syntheticModelTransport: true,
        turnViewIds: [...new Set(turnEvents.map((item) => item.event.viewId))]
      }
    )
    await click('#git-panel-close')
    await until(
      () =>
        evaluate(
          '!document.querySelector("#git-panel") && document.activeElement?.id === "git-panel-toggle"'
        ),
      'Git close restores focus'
    )
    await click('#terminal-panel-close')
    await until(async () => (await audit()).utilityHosts[0].exitedAtUTC, 'terminal retirement')
    await until(
      async () => (await api('getGitRepositories', randomUUID())).views?.length === 0,
      'all selected Git view release after panel close'
    )
    const completionFinal = await completion()
    await until(async () => {
      for (const cacheRoot of completionFinal.cacheRoots) {
        const names = await fs
          .readdir(cacheRoot)
          .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
        if (names.some((name) => name.startsWith('query-'))) return false
        if (
          names.includes('turns') &&
          (await fs.readdir(path.join(cacheRoot, 'turns'))).some((name) =>
            name.startsWith('query-')
          )
        )
          return false
      }
      return true
    }, 'owned reader and Last Turn caches retired')
    check(
      'closing the repository panel retires every selected scope, watcher/capture cache and pending operation',
      { cacheRoots: completionFinal.cacheRoots }
    )
    const finalAudit = await audit()
    assert(
      finalAudit.gitProcesses.length &&
        finalAudit.gitProcesses.every((process) => process.closedAtUTC)
    )
    assert(
      finalAudit.utilityHosts.every(
        (host) => host.exitCode === 0 && Number.isInteger(host.nativeExit?.exitCode)
      )
    )
    const retired = await verifyProcessRetirement([
      ...finalAudit.gitProcesses.map((item) => ({
        pid: item.pid,
        executable: item.program,
        closedAtUTC: item.closedAtUTC
      })),
      ...finalAudit.utilityHosts.map((item) => ({ pid: item.pid, closedAtUTC: item.exitedAtUTC }))
    ])
    check(
      'actual Git children and terminal utility public exit/close are confirmed then OS process retirement is checked',
      {
        gitChildren: finalAudit.gitProcesses.length,
        utilityHosts: finalAudit.utilityHosts,
        retired,
        nativeHandlesObserved: false
      }
    )
    assert.deepEqual(await fs.readFile(path.join(materials.main, '.git/config')), originalConfig)
    assert.equal(await fs.readFile(path.join(materials.main, 'a.txt'), 'utf8'), edited)
    assert.equal(
      await fs.readFile(path.join(materials.main, 'new.txt'), 'utf8'),
      'DESKTOP_GIT_UNTRACKED\n'
    )
    for (const filename of (await files(userData)).filter((name) =>
      /conversation\.json$|[\\/]task-checkpoints[\\/]/.test(name)
    )) {
      const content = await fs.readFile(filename, 'utf8')
      for (const marker of [
        'DESKTOP_GIT_DELTA',
        'DESKTOP_GIT_OTHER',
        'DESKTOP_GIT_UNTRACKED',
        'DESKTOP_GIT_BUSY',
        'DESKTOP_GIT_AUTO_',
        'DESKTOP_GIT_SECONDARY_',
        'DESKTOP_GIT_THIRD_',
        'DESKTOP_GIT_AGGREGATE_',
        'DESKTOP_GIT_AFTER_TURN',
        'DESKTOP_GIT_DRAFT_KEEP',
        terminalMarker,
        'gitViewId',
        'gitRevision'
      ])
        assert.equal(
          content.includes(marker),
          false,
          'Git/PTY content absent from conversation/checkpoint ' + filename
        )
    }
    await fs.writeFile(
      path.join(evidence, 'after-material-identities.json'),
      JSON.stringify(await diskIdentity(materials.main), null, 2)
    )
    report.mainAuditFile = auditFile
    report.candidateAuditFile = candidateAuditFile
    report.completionAuditFile = completionAuditFile
    check(
      'fixture Git changes are explicit while source config remains unchanged and Git/PTY content is absent from conversation/checkpoint'
    )
  }
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
