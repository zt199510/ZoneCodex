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
const { install } = moduleRequire('./startup-fixture.cjs')
const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((argument) => argument === '--packaged'))
assert.equal(process.platform, 'win32')
const uuid = randomUUID()
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson59',
  'terminal-startup-' + (packaged ? 'packaged-' : 'development-') + uuid
)
const executable = path.join(
  root,
  packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
)
const productEntry = path.join(
  root,
  packaged ? 'dist/win-unpacked/resources/app.asar/out/main/index.js' : 'out/main/index.js'
)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = Date.now() + 210000
const report = {
  pass: false,
  evidence,
  uuid,
  packaged,
  actualElectron: true,
  actualPTY: true,
  actualDisk: true,
  syntheticTransport: false,
  realTransport: false,
  modelTransport: 'none',
  testOverridesPTYWorkerForkArguments: false,
  cases: [],
  checks: [],
  failures: [],
  notCovered: [
    'Process retirement and normal quit do not prove every native HPCON/pipe handle has been reclaimed.',
    'No Agent or real model/reviewer request is permitted; these are independent terminal startup checks.',
    'The direct packaged normal launch has no main inspector/fixture: main IPC/network timing is not audited in that condition; package inspector conditions carry those assertions.'
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
async function filesUnder(directory) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const names = []
  for (const entry of entries) {
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) names.push(...(await filesUnder(name)))
    else if (entry.isFile()) names.push(name)
  }
  return names
}
async function identify() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'scripts/node-pty-cleanup/manifest.json'), 'utf8')
  )
  assert.equal(manifest.package, 'node-pty')
  assert.equal(manifest.version, '1.1.0')
  const entries = Object.entries(manifest.files)
  assert.ok(entries.length >= 5)
  const cleanup = entries.map(([name]) => 'node_modules/node-pty/lib/' + name.replaceAll('\\', '/'))
  const artifacts = packaged
    ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar']
    : [
        ...(await filesUnder(path.join(root, 'out/main')).then((names) =>
          names.map((name) => path.relative(root, name).replaceAll('\\', '/'))
        )),
        'out/preload/index.js',
        ...(await filesUnder(path.join(root, 'out/renderer')).then((names) =>
          names.map((name) => path.relative(root, name).replaceAll('\\', '/'))
        ))
      ]
  const names = [
    ...artifacts,
    ...cleanup,
    'scripts/node-pty-cleanup/manifest.json',
    'tests/lesson59/terminal-startup-check.mjs',
    'tests/lesson59/startup-fixture.cjs',
    'src/main/terminal/local-terminal.ts',
    'src/main/terminal/terminal-process.ts',
    'src/main/terminal/terminal-host.ts',
    'src/main/terminal/terminal-host-contract.ts',
    'electron.vite.config.ts'
  ]
  const identities = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  for (const [index, [, identity]] of entries.entries())
    assert.equal(identities[cleanup[index]], identity.patchedSha256)
  if (packaged) {
    const { extractFile } = moduleRequire('@electron/asar')
    for (const name of cleanup) {
      const identity = hash(
        extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))
      )
      assert.equal(identity, identities[name])
      identities['app.asar:' + name] = identity
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
    const promise = pending.get(value.id)
    if (!promise) return
    pending.delete(value.id)
    clearTimeout(promise.timer)
    value.error ? promise.reject(Error(JSON.stringify(value.error))) : promise.resolve(value.result)
  })
  return {
    socket,
    events,
    call: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++serial
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error('Bounded CDP request: ' + method))
        }, 8000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
  }
}
async function processes() {
  const ps = spawn(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe' OR Name = 'zonecodex.exe' OR Name = 'powershell.exe' OR Name = 'cmd.exe' OR Name = 'conhost.exe'\" | Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}, @{Name='parentPid';Expression={[int]$_.ParentProcessId}}, Name, @{Name='createdAtUTC';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stdout = '',
    stderr = ''
  ps.stdout.on('data', (value) => {
    stdout += value
  })
  ps.stderr.on('data', (value) => {
    stderr += value
  })
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ps.kill()
      reject(Error('Bounded read-only process query'))
    }, 10000)
    ps.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    ps.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  assert.equal(exitCode, 0, stderr.slice(0, 300))
  const records = stdout.trim() ? JSON.parse(stdout) : []
  return Array.isArray(records) ? records : [records]
}
const descendants = (records, pid) => {
  const owned = new Set([pid])
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size
    for (const record of records) if (owned.has(record.parentPid)) owned.add(record.pid)
  }
  return records.filter((record) => owned.has(record.pid) && record.pid !== pid)
}
await fs.mkdir(evidence, { recursive: true })
let beforeArtifacts
try {
  beforeArtifacts = await identify()
  await fs.writeFile(
    path.join(evidence, 'before-artifacts.json'),
    JSON.stringify(beforeArtifacts, null, 2)
  )
  const conditions = ['normal', 'inspect-brk', 'vscode-worker-debug']
  for (const condition of conditions) {
    const mainAudited = !packaged || condition !== 'normal'
    const caseUUID = randomUUID(),
      directory = path.join(evidence, condition + '-' + caseUUID),
      userData = path.join(directory, 'user-data'),
      auditFile = path.join(directory, 'main-audit.json'),
      bootstrap = path.join(directory, 'bootstrap.cjs')
    await fs.mkdir(userData, { recursive: true })
    const marker = 'terminal-startup-59-' + caseUUID
    await fs.writeFile(
      bootstrap,
      '(' +
        install.toString() +
        ')(' +
        JSON.stringify({ root, userData, auditFile, condition }) +
        ');require(' +
        JSON.stringify(productEntry) +
        ');\n'
    )
    const mainPort = await freePort(),
      rendererPort = await freePort()
    const args = [
      ...(packaged ? [] : [bootstrap]),
      '--user-data-dir=' + userData,
      ...(condition !== 'normal' ? ['--inspect-brk=127.0.0.1:' + mainPort] : []),
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + rendererPort,
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--in-process-gpu'
    ]
    const env = {
      ...process.env,
      APPDATA: path.join(directory, 'appdata'),
      LOCALAPPDATA: path.join(directory, 'localappdata')
    }
    for (const name of [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_RENDERER_URL',
      'NODE_OPTIONS',
      'V8_INSPECTOR_PORT',
      'V8_INSPECTOR_BRK_PORT',
      'MODEL_ENDPOINT',
      'MODEL_NAME',
      'MODEL_API_KEY'
    ])
      delete env[name]
    const baseline = await processes()
    const log = await fs.open(path.join(directory, 'desktop.log'), 'w')
    const child = spawn(executable, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd]
    })
    const result = {
      condition,
      mainAudited,
      uuid: caseUUID,
      directory,
      appPid: child.pid,
      args,
      pass: false,
      timings: {},
      forcedKill: false,
      processes: [],
      failures: []
    }
    report.cases.push(result)
    console.log(
      JSON.stringify({
        evidence,
        directory,
        condition,
        packaged,
        pid: child.pid,
        testOverridesPTYWorkerForkArguments: false
      })
    )
    let main, renderer, evaluate
    const until = async (observe, label, ms = 15000, allowExited = false) => {
      for (const end = Math.min(Date.now() + ms, deadline); Date.now() < end;) {
        if (!allowExited && child.exitCode !== null)
          throw Error('Owned application exited during ' + label)
        const value = await observe()
        if (value) return value
        await delay(100)
      }
      throw Error('Bounded observation: ' + label)
    }
    try {
      if (condition !== 'normal') {
        const target = await until(async () => {
          try {
            return (await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0]
          } catch {
            return null
          }
        }, 'main inspector')
        main = await connect(target.webSocketDebuggerUrl)
        await main.call('Runtime.enable')
        if (condition !== 'normal') {
          await main.call('Debugger.enable')
          await main.call('Runtime.runIfWaitingForDebugger')
          await until(
            () => main.events.some((event) => event.method === 'Debugger.paused'),
            'product entry pause'
          )
        }
        if (packaged) {
          const installed = await main.call('Runtime.evaluate', {
            expression:
              '(' +
              install.toString() +
              ')(' +
              JSON.stringify({ root, userData, auditFile, condition }) +
              ');globalThis.__terminalStartupReady',
            returnByValue: true
          })
          assert.equal(
            installed.exceptionDetails,
            undefined,
            installed.exceptionDetails?.exception?.description
          )
          assert.equal(installed.result.value, true)
        }
        if (condition === 'vscode-worker-debug') {
          // VS Code enables this independently of execArgv and NODE_OPTIONS.
          await main.call('NodeWorker.enable', { waitForDebuggerOnStart: true })
          result.workerAutoPauseEnabled = true
        }
        if (condition !== 'normal') {
          await main.call('Debugger.resume')
          await main.call('Debugger.disable')
        }
      }
      const page = await until(async () => {
        try {
          return (
            await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()
          ).find((item) => item.type === 'page' && item.url.includes('renderer'))
        } catch {
          return null
        }
      }, 'renderer')
      renderer = await connect(page.webSocketDebuggerUrl)
      await renderer.call('Network.enable')
      await renderer.call('Emulation.setFocusEmulationEnabled', { enabled: true })
      evaluate = async (expression) => {
        const value = await renderer.call('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true
        })
        if (value.exceptionDetails)
          throw Error(
            value.exceptionDetails.exception?.description ?? 'Renderer observation failed'
          )
        return value.result.value
      }
      const audit = () =>
        evaluate('window.electron.ipcRenderer.invoke("terminal-startup:observation")')
      const screenshot = async (name) => {
        const shot = await renderer.call('Page.captureScreenshot', { format: 'png' })
        await fs.writeFile(path.join(directory, name + '.png'), Buffer.from(shot.data, 'base64'))
      }
      const click = async (selector) => {
        const position = await evaluate(
          '(()=>{const n=document.querySelector(' +
            JSON.stringify(selector) +
            ');if(!n||n.disabled)throw Error("Missing/disabled target");n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!(n===hit||n.contains(hit)))throw Error("UI target blocked");return {x,y}})()'
        )
        await renderer.call('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...position,
          button: 'left',
          clickCount: 1
        })
        await renderer.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...position,
          button: 'left',
          clickCount: 1
        })
      }
      await until(
        () => evaluate('!!document.querySelector("#terminal-panel-toggle")'),
        'terminal entry'
      )
      await evaluate(
        '(()=>{window.__terminalStartupEvents=[];window.__terminalStartupUnsubscribe=window.api.onTerminalEvent(event=>window.__terminalStartupEvents.push({at:Date.now(),event}));return true})()'
      )
      const settings = await evaluate('window.api.getSettings()')
      assert.ok(
        settings.taskRoot.startsWith(directory),
        'Only the isolated user-data directory is used'
      )
      let started = Date.now()
      await click('#terminal-panel-toggle')
      await until(
        () =>
          evaluate(
            '!!document.querySelector("#terminal-panel .xterm")&&[...document.querySelectorAll("#terminal-panel button")].some(n=>n.textContent==="启动终端"&&!n.disabled)'
          ),
        'mounted terminal ready'
      )
      result.timings.panelReadyMs = Date.now() - started
      if (mainAudited)
        assert.equal(
          (await audit()).ipc.some((record) => record.channel === 'terminal:start'),
          false
        )
      else
        assert.equal(
          descendants(await processes(), child.pid).filter((record) =>
            ['powershell.exe', 'cmd.exe'].includes(record.Name.toLowerCase())
          ).length,
          0,
          'Passive panel mount creates no externally observed shell'
        )
      check(condition + ': panel mount is passive and enables actual startup button', {
        packaged,
        panelReadyMs: result.timings.panelReadyMs
      })
      await screenshot('panel-ready')
      await evaluate(
        '(()=>{[...document.querySelectorAll("#terminal-panel button")].find(n=>n.textContent==="启动终端").id="terminal-startup-start";return true})()'
      )
      started = Date.now()
      await click('#terminal-startup-start')
      await until(
        () =>
          evaluate(
            'document.querySelector("#terminal-panel .terminal-toolbar").innerText.includes("运行中")'
          ),
        'real terminal running'
      )
      result.timings.runningMs = Date.now() - started
      const startedAudit = mainAudited ? await audit() : null,
        start = startedAudit?.ipc.find((record) => record.channel === 'terminal:start')
      result.timings.mainHandlerReturnMs = start
        ? start.synchronousReturnAt - start.enteredAt
        : null
      result.timings.hostReadyMs = start ? start.returnedAt - start.enteredAt : null
      if (mainAudited) {
        assert.ok(start && start.result?.ok)
        assert.ok(
          result.timings.mainHandlerReturnMs < 1000,
          'Main returns an asynchronous host request promptly'
        )
        assert.ok(
          result.timings.hostReadyMs < 5000,
          'Independent PTY host confirms real startup promptly'
        )
      }
      assert.ok(result.timings.runningMs < 5000, 'Real startup click promptly reaches running UI')
      if (mainAudited)
        assert.ok(
          startedAudit.heartbeatAt >= start.synchronousReturnAt || startedAudit.heartbeat >= 1
        )
      check(
        condition + ': trusted startup click reaches running UI without test debugger filtering',
        {
          packaged,
          mainSpawnMs: result.timings.mainSpawnMs,
          runningMs: result.timings.runningMs,
          mainAudited,
          processExecArgv: startedAudit?.processExecArgv ?? null
        }
      )
      const live = await processes()
      result.processes = descendants(live, child.pid).filter(
        (record) =>
          !baseline.some(
            (old) => old.pid === record.pid && old.createdAtUTC === record.createdAtUTC
          )
      )
      const shells = result.processes.filter((record) =>
        ['powershell.exe', 'cmd.exe'].includes(record.Name.toLowerCase())
      )
      assert.equal(shells.length, 1, 'One externally attributed real local shell')
      result.shellPid = shells[0].pid
      assert.ok(alive(result.shellPid))
      const input = async (command) => {
        await evaluate('document.querySelector("#terminal-panel .xterm-helper-textarea").focus()')
        await renderer.call('Input.insertText', { text: command })
        await renderer.call('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
        await renderer.call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        })
      }
      await input(
        "[Console]::WriteLine(('terminal-startup-' + '59-" +
          caseUUID +
          "')); $e=[char]27; [Console]::WriteLine($e+'[30mANSI-BLACK'+$e+'[0m '+$e+'[31mANSI-RED'+$e+'[0m '+$e+'[32mANSI-GREEN'+$e+'[0m '+$e+'[37mANSI-WHITE'+$e+'[0m')"
      )
      await until(
        async () =>
          mainAudited
            ? (await audit()).terminalEvents
                .filter((item) => item.event.type === 'data')
                .map((item) => item.event.data)
                .join('')
                .includes(marker)
            : evaluate(
                'window.__terminalStartupEvents.filter(item=>item.event.type==="data").map(item=>item.event.data).join("").includes(' +
                  JSON.stringify(marker) +
                  ')'
              ),
        'actual harmless shell echo'
      )
      await until(
        () =>
          evaluate(
            'document.querySelector("#terminal-panel .xterm-rows").innerText.includes("ANSI-WHITE")'
          ),
        'rendered ANSI output'
      )
      assert.ok(alive(result.shellPid))
      const responseAt = Date.now()
      assert.ok(await evaluate('window.api.getSettings().then(()=>true)'))
      result.timings.responsiveSettingsMs = Date.now() - responseAt
      assert.ok(result.timings.responsiveSettingsMs < 3000)
      check(
        condition +
          ': real independent PowerShell executes harmless marker and ANSI output while actual main IPC remains responsive',
        {
          packaged,
          shellPid: result.shellPid,
          responsiveSettingsMs: result.timings.responsiveSettingsMs
        }
      )
      result.colors = await evaluate(
        '(()=>{const host=document.querySelector("#terminal-panel .terminal-host"),panel=document.querySelector("#terminal-panel"),rows=document.querySelector("#terminal-panel .xterm-rows"),viewport=document.querySelector("#terminal-panel .xterm-viewport");const styles=getComputedStyle(host);const color=name=>{const n=document.createElement("span");n.style.color=styles.getPropertyValue(name).trim();host.appendChild(n);const value=getComputedStyle(n).color;n.remove();return value};return {surface:color("--surface"),text:color("--text"),accent:color("--accent"),danger:color("--danger"),panelBackground:getComputedStyle(panel).backgroundColor,hostBackground:styles.backgroundColor,terminalBackground:getComputedStyle(viewport).backgroundColor,terminalForeground:getComputedStyle(rows).color,selectionExpected:getComputedStyle(host,"::selection").backgroundColor,ansi:[...rows.querySelectorAll("span")].filter(n=>/^ANSI-(BLACK|RED|GREEN|WHITE)$/.test(n.textContent.trim())).map(n=>({text:n.textContent.trim(),color:getComputedStyle(n).color}))}})()'
      )
      assert.equal(result.colors.panelBackground, result.colors.surface)
      assert.equal(result.colors.terminalBackground, result.colors.surface)
      assert.equal(result.colors.terminalForeground, result.colors.text)
      const ansi = (name) =>
        result.colors.ansi.findLast((sample) => sample.text === 'ANSI-' + name)?.color
      assert.equal(ansi('BLACK'), result.colors.text)
      assert.equal(ansi('RED'), result.colors.danger)
      assert.equal(ansi('GREEN'), result.colors.accent)
      assert.notEqual(ansi('WHITE'), result.colors.surface)
      assert.ok(ansi('WHITE'))
      await screenshot('light-theme-ansi')
      const selection = await evaluate(
        '(()=>{const rows=[...document.querySelectorAll("#terminal-panel .xterm-rows>div")],n=rows.findLast(n=>n.textContent.includes("ANSI-WHITE"));if(!n)throw Error("Missing output row");const r=n.getBoundingClientRect();return {x:r.left+4,y:r.top+r.height/2,end:r.left+Math.min(r.width-10,250)}})()'
      )
      await renderer.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: selection.x,
        y: selection.y,
        button: 'left',
        clickCount: 1
      })
      await renderer.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: selection.end,
        y: selection.y,
        button: 'left',
        buttons: 1
      })
      await renderer.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: selection.end,
        y: selection.y,
        button: 'left',
        clickCount: 1
      })
      await until(
        () =>
          evaluate('document.querySelectorAll("#terminal-panel .xterm-selection>div").length>0'),
        'actual terminal selection'
      )
      result.colors.selectionObserved = await evaluate(
        'getComputedStyle(document.querySelector("#terminal-panel .xterm-selection>div")).backgroundColor'
      )
      assert.equal(result.colors.selectionObserved, result.colors.selectionExpected)
      await screenshot('light-theme-selection')
      check(
        condition +
          ': actual xterm surface/text/selection match framework colors and ANSI samples remain visible on light background',
        { packaged, colors: result.colors }
      )
      started = Date.now()
      await click('#terminal-panel-close')
      await until(() => evaluate('!document.querySelector("#terminal-panel")'), 'real panel close')
      await until(() => !alive(result.shellPid), 'actual shell retirement')
      result.timings.closeMs = Date.now() - started
      if (mainAudited)
        assert.ok(
          (await audit()).ipc.some(
            (record) => record.channel === 'terminal:close' && record.result?.ok
          )
        )
      check(
        condition + ': trusted panel close removes UI and externally observed shell PID retires',
        { packaged, mainAudited, shellPid: result.shellPid, closeMs: result.timings.closeMs }
      )
      const final = mainAudited ? await audit() : null
      if (mainAudited) {
        assert.equal(final.networkRequests.length, 0)
        assert.equal(
          final.ipc.filter((record) =>
            ['agent:start', 'agent:resume', 'agent:resolve-execution'].includes(record.channel)
          ).length,
          0
        )
      }
      result.agentObservation = {
        mainIpcAudited: mainAudited,
        mainNetworkAudited: mainAudited,
        agentStartsResumesResolves: mainAudited ? 0 : null,
        mainNetworkRequests: mainAudited ? 0 : null,
        rendererRemoteRequests: renderer.events
          .filter(
            (event) =>
              event.method === 'Network.requestWillBeSent' &&
              /^https?:/.test(event.params.request.url)
          )
          .map((event) => event.params.request.url)
      }
      result.rendererTerminalEvents = await evaluate('window.__terminalStartupEvents')
      assert.equal(result.agentObservation.rendererRemoteRequests.length, 0)
      const stored = (await filesUnder(userData)).filter((name) =>
        /conversation\.json$|[\\/]task-checkpoints[\\/]/.test(name)
      )
      for (const name of stored)
        assert.equal((await fs.readFile(name, 'utf8')).includes(marker), false)
      result.storageInventory = {
        conversationFiles: stored
          .filter((name) => path.basename(name) === 'conversation.json')
          .map((name) => path.relative(userData, name)),
        checkpointFiles: stored
          .filter((name) => name.endsWith('.checkpoint.json'))
          .map((name) => path.relative(userData, name)),
        rawFiles: stored
          .filter((name) => /^raw-.*\.json$/.test(path.basename(name)))
          .map((name) => path.relative(userData, name))
      }
      assert.equal(result.storageInventory.checkpointFiles.length, 0)
      assert.equal(result.storageInventory.rawFiles.length, 0)
      check(
        condition +
          (mainAudited
            ? ': independent startup/use/close has zero audited Agent starts/resumes/resolves/network, no raw/checkpoint files created, and marker absent from any existing conversation files'
            : ': direct package normal UI/PTY has no renderer remote requests or raw/checkpoint files created; main Agent IPC/network is not audited'),
        {
          packaged,
          agentObservation: result.agentObservation,
          storageInventory: result.storageInventory
        }
      )
      await click('button[aria-label="关闭窗口"]')
      result.pass = true
    } catch (error) {
      result.failures.push({ message: error.message, stack: error.stack })
      if (evaluate) {
        try {
          await fs.writeFile(
            path.join(directory, 'failed-ui.txt'),
            await evaluate('document.body.innerText')
          )
          const shot = await renderer.call('Page.captureScreenshot', { format: 'png' })
          await fs.writeFile(path.join(directory, 'failed.png'), Buffer.from(shot.data, 'base64'))
        } catch {
          /* Retain initial failure when main control is blocked. */
        }
      }
    } finally {
      if (main)
        result.mainWorkerEvents = main.events.filter((event) =>
          event.method.startsWith('NodeWorker.')
        )
      if (child.exitCode === null && evaluate && !result.pass && mainAudited) {
        try {
          await evaluate('window.electron.ipcRenderer.invoke("terminal-startup:quit")')
        } catch {
          /* Bounded rescue follows only for this owned app. */
        }
      }
      main?.socket.close()
      renderer?.socket.close()
      if (child.exitCode === null)
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(15000)])
      if (child.exitCode === null) {
        result.forcedKill = true
        const rescue = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let output = ''
        rescue.stdout.on('data', (chunk) => {
          output += chunk
        })
        rescue.stderr.on('data', (chunk) => {
          output += chunk
        })
        await Promise.race([new Promise((resolve) => rescue.once('exit', resolve)), delay(5000)])
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1000)])
        result.rescueOutput = output
      }
      result.appExitCode = child.exitCode
      await log.close()
      const logged = await fs.readFile(path.join(directory, 'desktop.log'), 'utf8')
      result.attachConsoleFailures = (logged.match(/AttachConsole failed/g) ?? []).length
      try {
        result.audit = mainAudited ? JSON.parse(await fs.readFile(auditFile, 'utf8')) : null
      } catch (error) {
        result.failures.push({ message: error.message })
      }
      if (result.pass) {
        try {
          assert.equal(result.forcedKill, false)
          assert.equal(result.appExitCode, 0)
          assert.equal(result.attachConsoleFailures, 0)
          await until(
            () => result.processes.every((record) => !alive(record.pid)),
            'observed owned application descendants retire',
            10000,
            true
          )
          check(
            condition +
              ': real application exits zero with no forced kill, AttachConsole failure or surviving observed shell/ConPTY/app descendant',
            { packaged, appPid: child.pid, processes: result.processes }
          )
        } catch (error) {
          result.pass = false
          result.failures.push({ message: error.message, stack: error.stack })
        }
      }
      await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2))
      console.log(
        JSON.stringify({
          condition,
          pass: result.pass,
          directory,
          failures: result.failures.map((item) => item.message),
          timings: result.timings
        })
      )
    }
  }
  assert.equal(report.cases.length, conditions.length)
  assert.ok(
    report.cases.every((result) => result.pass),
    'All separately named real startup conditions must pass'
  )
  assert.deepEqual(await identify(), beforeArtifacts)
  check(
    'current executable/rendered artifacts and all hash-locked dependency files remain unchanged across normal, inspect-brk and VS Code worker-debug startup',
    { artifacts: beforeArtifacts }
  )
  report.pass = true
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
} finally {
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      uuid,
      packaged,
      checks: report.checks.length,
      failures: report.failures.map((item) => item.message)
    })
  )
  if (!report.pass) process.exitCode = 1
}
