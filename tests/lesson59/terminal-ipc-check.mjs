import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('terminal-ipc')
const handlers = new Map()
const windows = new Map()
const children = []
const renderer = new EventEmitter()
const fixture = {
  mutation: false,
  shell: 'powershell',
  shellError: null,
  spawnError: null,
  onDataError: null,
  onExitError: null,
  onExitFailures: 0,
  exitDuringSubscribe: false,
  deferReady: false,
  spawnKillMode: 'sync-exit',
  liveWindowsOverride: null,
  invokeResult: undefined,
  invokeEvent: null,
  invokes: [],
  kills: 0,
  disposals: 0,
  child: null
}
const pendingTimers = new Map()
let virtualNow = 0
let timerSequence = 0
const flush = async () => {
  for (let round = 0; round < 10; round++) await Promise.resolve()
}
async function advance(milliseconds) {
  const end = virtualNow + milliseconds
  await flush()
  for (;;) {
    const next = [...pendingTimers.values()]
      .filter((timer) => timer.at <= end)
      .sort((a, b) => a.at - b.at)[0]
    if (!next) break
    virtualNow = next.at
    pendingTimers.delete(next.id)
    next.callback()
    await flush()
  }
  virtualNow = end
  await flush()
}
function observe(promise) {
  const state = { settled: false, value: undefined }
  Promise.resolve(promise).then((value) => {
    state.settled = true
    state.value = value
  })
  return state
}
const app = new EventEmitter()
app.getPath = (name) => (name === 'home' ? path.join(evidence, 'synthetic-home') : null)
app.quitEvents = []
app.exitCodes = []
app.exit = (code) => app.exitCodes.push(code)
app.quit = () => {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  app.emit('before-quit', event)
  app.quitEvents.push({ defaultPrevented: event.defaultPrevented, at: virtualNow })
}

class FakePty {
  constructor(program, args, options) {
    this.program = program
    this.args = args
    this.options = options
    this.live = true
    this.dataListeners = []
    this.exitListeners = []
    this.writes = []
    this.sizes = []
    this.killError = null
    this.killMode = fixture.spawnKillMode
    this.killCalls = 0
    this.writeError = null
    this.resizeError = null
    this.ready = fixture.deferReady
      ? new Promise((resolve, reject) => {
          this.resolveReady = resolve
          this.rejectReady = reject
        })
      : Promise.resolve()
    children.push(this)
  }
  subscribe(list, listener) {
    list.push(listener)
    let disposed = false
    return {
      dispose() {
        assert(!disposed, 'Each live PTY subscription must be disposed exactly once')
        disposed = true
        fixture.disposals++
        list.splice(list.indexOf(listener), 1)
      }
    }
  }
  onData(listener) {
    if (fixture.onDataError) throw fixture.onDataError
    return this.subscribe(this.dataListeners, listener)
  }
  onExit(listener) {
    if (fixture.onExitError && fixture.onExitFailures > 0) {
      fixture.onExitFailures--
      throw fixture.onExitError
    }
    const subscription = this.subscribe(this.exitListeners, listener)
    if (fixture.exitDuringSubscribe) this.exit(7)
    return subscription
  }
  write(data) {
    if (this.writeError) throw this.writeError
    this.writes.push(data)
    return Promise.resolve()
  }
  resize(cols, rows) {
    if (this.resizeError) throw this.resizeError
    this.sizes.push({ cols, rows })
    return Promise.resolve()
  }
  kill() {
    this.killCalls++
    if (this.killError) throw this.killError
    assert(this.live, 'An already closed PTY must not be killed again')
    fixture.kills++
    if (this.killMode === 'sync-exit') this.exit(0)
    return Promise.resolve()
  }
  data(data) {
    for (const listener of [...this.dataListeners]) listener(data)
  }
  exit(exitCode) {
    this.live = false
    for (const listener of [...this.exitListeners]) listener({ exitCode })
  }
}

globalThis.__lesson59terminal = {
  app,
  setTimeout(callback, milliseconds) {
    const id = ++timerSequence
    pendingTimers.set(id, { id, callback, at: virtualNow + milliseconds })
    return { id, unref: () => undefined }
  },
  clearTimeout(timer) {
    pendingTimers.delete(timer?.id)
  },
  BrowserWindow: {
    fromWebContents: (owner) => windows.get(owner) ?? null,
    getAllWindows: () =>
      fixture.liveWindowsOverride ?? [...windows.values()].filter((window) => !window.destroyed)
  },
  ipcMain: {
    handle(name, handler) {
      assert(!handlers.has(name), 'Terminal IPC must be registered once')
      handlers.set(name, handler)
    }
  },
  ipcRenderer: {
    async invoke(name, ...args) {
      fixture.invokes.push({ name, args })
      if (fixture.invokeResult !== undefined) return fixture.invokeResult
      return handlers.get(name)(fixture.invokeEvent, ...args)
    },
    on: (...args) => renderer.on(...args),
    removeListener: (...args) => renderer.removeListener(...args)
  },
  createTerminalProcess(sessionId, shell, cwd, size) {
    if (fixture.spawnError) throw fixture.spawnError
    fixture.child = new FakePty(shell.program, shell.args, { cwd, ...size })
    fixture.child.sessionId = sessionId
    return fixture.child
  },
  getAppSettings: () => ({ terminalShell: fixture.shell, defaultPermissionMode: 'default' }),
  hasSettingsMutation: () => fixture.mutation,
  resolveTerminalShell(shell) {
    if (fixture.shellError) throw fixture.shellError
    return { program: shell + '.exe', args: shell === 'powershell' ? ['-NoProfile'] : ['/d'] }
  }
}
const stubs = {
  electron: 'app, BrowserWindow, ipcMain, ipcRenderer',
  'terminal-process': 'createTerminalProcess',
  'settings-service': 'getAppSettings',
  'settings-ipc': 'hasSettingsMutation',
  'terminal-shell': 'resolveTerminalShell'
}
const outfile = path.join(evidence, 'terminal-current-source.cjs')
const compiled = await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'src/main/terminal/local-terminal.ts',
      'src/preload/terminal-api.ts',
      'src/shared/terminal.ts',
      'src/main/execution/permission-state.ts'
    ]
      .map((file) => `export * from ${JSON.stringify('./' + file)};`)
      .join('\n'),
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'silent',
  define: {
    setTimeout: 'globalThis.__lesson59terminal.setTimeout',
    clearTimeout: 'globalThis.__lesson59terminal.clearTimeout'
  },
  plugins: [
    {
      name: 'terminal-native-boundary-fixture',
      setup(builder) {
        builder.onResolve(
          { filter: /^electron$|\/settings-(service|ipc)$|\/terminal-(shell|process)$/ },
          ({ path: name }) => ({ path: name.split('/').at(-1), namespace: 'fixture' })
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
          contents: `export const { ${stubs[name]} } = globalThis.__lesson59terminal;`,
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceHashes = {}
for (const file of Object.keys(compiled.metafile.inputs))
  if (!file.startsWith('fixture:') && file !== '<stdin>')
    sourceHashes[file] = hash(await fs.readFile(path.join(root, file)))
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
await fs.writeFile(path.join(evidence, 'metafile.json'), JSON.stringify(compiled.metafile, null, 2))
const require = createRequire(import.meta.url)
let api = require(outfile)
api.registerLocalTerminal()
const suite = checksFor(evidence, {
  ordinaryNode: true,
  syntheticElectron: true,
  syntheticTerminalProcess: true,
  syntheticPty: false,
  nativePty: false,
  syntheticTransport: false,
  realTransport: false,
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile))
})
let nextOwner = 100
function owner() {
  const sender = new EventEmitter()
  sender.id = nextOwner++
  sender.mainFrame = {}
  sender.destroyed = false
  sender.isDestroyed = () => sender.destroyed
  sender.sent = []
  sender.send = (channel, value) => sender.sent.push({ channel, value })
  const window = Object.assign(new EventEmitter(), {
    id: sender.id + 1000,
    webContents: sender,
    destroyed: false,
    isDestroyed: () => window.destroyed
  })
  windows.set(sender, window)
  api.attachTerminalCleanup(window)
  return { sender, window, event: { sender, senderFrame: sender.mainFrame } }
}
const invoke = (source, channel, ...args) =>
  handlers.get('terminal:' + channel)(source.event, ...args)
const size = { cols: 80, rows: 24 }
async function start(source, id = 'session-test') {
  assert.deepEqual(await invoke(source, 'start', id, size), { ok: true })
  return fixture.child
}
async function close(source, id = 'session-test') {
  assert.deepEqual(await invoke(source, 'close', id), { ok: true })
}

await suite.check('exact terminal channels remain separate from Agent channels', async () => {
  assert.deepEqual([...handlers.keys()].sort(), [
    'terminal:close',
    'terminal:resize',
    'terminal:start',
    'terminal:write'
  ])
  return { channels: [...handlers.keys()] }
})

await suite.check(
  'shared ID, dimensions and malformed result/event parsing retain frozen bounds',
  async () => {
    assert(api.isTerminalId('a'.repeat(80)))
    for (const id of ['', 'a'.repeat(81), 'bad id', 'bad_underscore', {}, null])
      assert(!api.isTerminalId(id))
    for (const dimensions of [
      { cols: 2, rows: 1 },
      { cols: 500, rows: 300 }
    ])
      assert(api.isTerminalSize(dimensions))
    for (const dimensions of [
      null,
      { cols: 1, rows: 1 },
      { cols: 501, rows: 1 },
      { cols: 2, rows: 0 },
      { cols: 2, rows: 301 },
      { cols: 2.5, rows: 1 },
      { cols: 2, rows: NaN }
    ])
      assert(!api.isTerminalSize(dimensions))
    assert.throws(() => api.parseTerminalResult({ ok: false }))
    assert.throws(() => api.parseTerminalResult(null))
    for (const event of [
      null,
      { sessionId: 'bad id', type: 'data', data: 'not delivered' },
      { sessionId: 'valid', type: 'data', data: 123 },
      { sessionId: 'valid', type: 'exit', exitCode: 0.1 }
    ])
      assert.equal(api.parseTerminalEvent(event), null)
  }
)

await suite.check('invalid or non-main-frame/dead owners fail before PTY creation', async () => {
  const source = owner()
  const count = children.length
  for (const event of [
    { sender: source.sender, senderFrame: {} },
    { sender: { mainFrame: {} }, senderFrame: {} }
  ])
    await assert.rejects(() => handlers.get('terminal:start')(event, 'valid', size), /终端请求来源/)
  source.window.destroyed = true
  await assert.rejects(() => invoke(source, 'start', 'valid', size), /终端请求来源/)
  source.window.destroyed = false
  source.sender.destroyed = true
  await assert.rejects(() => invoke(source, 'start', 'valid', size), /终端请求来源/)
  source.sender.destroyed = false
  assert.equal((await invoke(source, 'start', 'bad id', size)).ok, false)
  assert.equal((await invoke(source, 'start', 'valid', { cols: 501, rows: 24 })).ok, false)
  assert.equal(children.length, count)
})

await suite.check(
  'settings save blocks start and shell/PTY creation errors permit retry without a live child',
  async () => {
    const source = owner()
    const count = children.length
    fixture.mutation = true
    assert.match((await invoke(source, 'start', 'session-test', size)).error, /设置正在保存/)
    fixture.mutation = false
    fixture.shellError = new Error('未找到测试 shell')
    assert.match((await invoke(source, 'start', 'session-test', size)).error, /未找到测试 shell/)
    fixture.shellError = null
    fixture.spawnError = new Error('创建失败')
    assert.equal((await invoke(source, 'start', 'session-test', size)).ok, false)
    fixture.spawnError = null
    assert.equal(children.length, count)
    await start(source)
    await close(source)
  }
)

await suite.check(
  'native error strings returned to the renderer are bounded to 300 characters',
  async () => {
    const source = owner()
    fixture.spawnError = new Error('X'.repeat(10000))
    const result = await invoke(source, 'start', 'session-test', size)
    fixture.spawnError = null
    assert.equal(result.ok, false)
    assert(result.error.length > 0 && result.error.length <= 300)
    return { errorCharacters: result.error.length }
  }
)

await suite.check(
  'same-window duplicate start is refused; another owner can run independently',
  async () => {
    const a = owner()
    const b = owner()
    const first = await start(a, 'a-session')
    assert.equal((await invoke(a, 'start', 'second-session', size)).ok, false)
    assert.equal(first.live, true)
    const second = await start(b, 'b-session')
    assert.notEqual(first, second)
    assert.equal(first.options.cwd, path.join(evidence, 'synthetic-home'))
    assert.equal(first.options.cols, 80)
    assert.equal(first.options.rows, 24)
    await close(a, 'a-session')
    assert(second.live)
    await close(b, 'b-session')
  }
)

await suite.check(
  'a pending ready reserves the owner before settling and close can finish independently of startup',
  async () => {
    const source = owner()
    fixture.deferReady = true
    const pendingStart = invoke(source, 'start', 'pending-ready', size)
    const child = fixture.child
    fixture.deferReady = false
    const observedStart = observe(pendingStart)
    const count = children.length
    await flush()
    assert.equal(observedStart.settled, false)
    assert.equal(child.live, true)
    assert.equal((await invoke(source, 'start', 'duplicate-pending-ready', size)).ok, false)
    assert.equal(children.length, count, 'A pending startup must already occupy its owner slot')
    assert.deepEqual(await invoke(source, 'close', 'pending-ready'), { ok: true })
    assert.equal(child.killCalls, 1)
    assert.equal(child.live, false)
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    assert.equal(observedStart.settled, false, 'Close must not need the startup result to settle')
    child.resolveReady()
    assert.equal((await pendingStart).ok, false, 'A closed pending start must not become active')
    await start(source, 'after-pending-ready')
    await close(source, 'after-pending-ready')
    return { reservedBeforeReady: true, closeConfirmedWhileReadyPending: true }
  }
)

await suite.check(
  'an old host ready rejection after its actual exit cannot clean up the replacement host',
  async () => {
    const source = owner()
    fixture.deferReady = true
    const pendingOldStart = invoke(source, 'start', 'late-ready-old', size)
    const old = fixture.child
    fixture.deferReady = false
    const observedOld = observe(pendingOldStart)
    await flush()
    assert.equal(observedOld.settled, false)
    old.exit(7)
    assert.equal(old.live, false)
    assert.equal(old.exitListeners.length + old.dataListeners.length, 0)
    const replacement = await start(source, 'late-ready-new')
    assert.equal(replacement.live, true)
    assert.equal(replacement.killCalls, 0)
    old.rejectReady(new Error('Old host ready failed after its confirmed exit'))
    const failedOldStart = await pendingOldStart
    await flush()
    assert.equal(failedOldStart.ok, false)
    assert.match(failedOldStart.error, /Old host ready failed/)
    assert.equal(replacement.live, true, 'Old startup catch must not close the new owner session')
    assert.equal(replacement.killCalls, 0)
    assert.equal(replacement.exitListeners.length + replacement.dataListeners.length, 2)
    assert.equal((await invoke(source, 'write', 'late-ready-new', 'new host input')).ok, true)
    assert.deepEqual(replacement.writes, ['new host input'])
    await close(source, 'late-ready-old')
    assert.equal(replacement.live, true)
    assert.equal(replacement.killCalls, 0)
    await close(source, 'late-ready-new')
    return { oldReadyRejectedAfterExit: true, replacementPreserved: true }
  }
)

await suite.check(
  'foreign IDs cannot write/resize/close another owner or disturb its session',
  async () => {
    const a = owner()
    const b = owner()
    const child = await start(a, 'private-session')
    assert.equal((await invoke(b, 'write', 'private-session', 'echo harmless\r')).ok, false)
    assert.equal((await invoke(b, 'resize', 'private-session', size)).ok, false)
    await close(b, 'private-session')
    assert(child.live)
    assert.deepEqual(child.writes, [])
    assert.deepEqual(child.sizes, [])
    child.data('owner-only-output')
    assert.equal(a.sender.sent.length, 1)
    assert.equal(b.sender.sent.length, 0)
    await close(a, 'private-session')
  }
)

await suite.check(
  'input bounds and unchanged Ctrl+C/whitespace are enforced before PTY writes',
  async () => {
    const source = owner()
    const child = await start(source)
    for (const input of ['', 1, null, 'X'.repeat(8193)])
      assert.equal((await invoke(source, 'write', 'session-test', input)).ok, false)
    assert.equal((await invoke(source, 'write', 'session-test', 'X'.repeat(8192))).ok, true)
    assert.equal((await invoke(source, 'write', 'session-test', ' \r\n\u0003')).ok, true)
    assert.deepEqual(child.writes, ['X'.repeat(8192), ' \r\n\u0003'])
    assert.equal(
      (await invoke(source, 'resize', 'session-test', { cols: 501, rows: 24 })).ok,
      false
    )
    assert.equal(
      (await invoke(source, 'resize', 'session-test', { cols: 500, rows: 300 })).ok,
      true
    )
    assert.deepEqual(child.sizes, [{ cols: 500, rows: 300 }])
    await close(source)
  }
)

await suite.check(
  'write/resize failures return a bounded error and preserve explicit close',
  async () => {
    const source = owner()
    const child = await start(source)
    child.writeError = new Error('write fixture failure')
    child.resizeError = new Error('resize fixture failure')
    assert.equal((await invoke(source, 'write', 'session-test', 'harmless')).ok, false)
    assert.equal((await invoke(source, 'resize', 'session-test', size)).ok, false)
    assert(child.live)
    await close(source)
  }
)

await suite.check(
  'close releases all subscriptions once; repeated/old-ID closes cannot kill replacement',
  async () => {
    const source = owner()
    const child = await start(source, 'old-session')
    const oldData = child.dataListeners[0]
    const oldExit = child.exitListeners[0]
    const disposals = fixture.disposals
    await close(source, 'old-session')
    await close(source, 'old-session')
    assert.equal(fixture.disposals - disposals, 2)
    assert.equal(child.dataListeners.length + child.exitListeners.length, 0)
    const replacement = await start(source, 'new-session')
    await close(source, 'old-session')
    oldData('late old data')
    oldExit({ exitCode: 0 })
    assert(replacement.live)
    assert.deepEqual(source.sender.sent, [])
    await close(source, 'new-session')
  }
)

await suite.check(
  'natural fast exit clears owner session, subscriptions and allows fresh start',
  async () => {
    const source = owner()
    const child = await start(source)
    const disposals = fixture.disposals
    child.exit(7)
    assert.equal(fixture.disposals - disposals, 2)
    assert.deepEqual(source.sender.sent, [
      { channel: 'terminal:event', value: { sessionId: 'session-test', type: 'exit', exitCode: 7 } }
    ])
    assert.equal((await invoke(source, 'write', 'session-test', 'no')).ok, false)
    await start(source, 'restart')
    await close(source, 'restart')
  }
)

await suite.check(
  'partial subscription failures kill already spawned child and allow fresh start',
  async () => {
    const source = owner()
    for (const field of ['onDataError', 'onExitError']) {
      fixture[field] = new Error(field + ' fixture failure')
      if (field === 'onExitError') fixture.onExitFailures = 1
      assert.equal((await invoke(source, 'start', 'session-test', size)).ok, false)
      assert.equal(fixture.child.live, false)
      assert.equal(fixture.child.dataListeners.length + fixture.child.exitListeners.length, 0)
      fixture[field] = null
      await start(source)
      await close(source)
    }
  }
)

await suite.check(
  'a failed kill reports failure without falsely dropping the live session; retry cleans it',
  async () => {
    const source = owner()
    const child = await start(source)
    child.killError = new Error('cannot kill fixture process')
    assert.equal((await invoke(source, 'close', 'session-test')).ok, false)
    assert(child.live)
    assert.equal((await invoke(source, 'start', 'another', size)).ok, false)
    child.killError = null
    await close(source)
  }
)

await suite.check(
  'only full main-frame navigation clears PTY; in-place/subframe navigation preserves it',
  async () => {
    const source = owner()
    const child = await start(source)
    source.sender.emit('did-start-navigation', {}, 'fixture:page', true, true)
    source.sender.emit('did-start-navigation', {}, 'fixture:frame', false, false)
    assert(child.live)
    source.sender.emit('did-start-navigation', {}, 'fixture:page', false, true)
    assert(!child.live)
    assert.equal(child.dataListeners.length + child.exitListeners.length, 0)
  }
)

await suite.check(
  'renderer crash and webContents destruction each release PTY, without close veto coupling',
  async () => {
    for (const event of ['render-process-gone', 'destroyed']) {
      const source = owner()
      const child = await start(source)
      source.sender.destroyed = event === 'destroyed'
      source.sender.emit(event)
      assert(!child.live)
      assert.equal(child.dataListeners.length + child.exitListeners.length, 0)
    }
  }
)

await suite.check(
  'rapid repeated start/close leaves no live synthetic processes or subscriptions',
  async () => {
    const source = owner()
    for (let index = 0; index < 25; index++) {
      await start(source, 'rapid-' + index)
      await close(source, 'rapid-' + index)
    }
    assert.equal(children.filter((child) => child.live).length, 0)
    assert.equal(
      children.reduce(
        (count, child) => count + child.dataListeners.length + child.exitListeners.length,
        0
      ),
      0
    )
    return { cycles: 25, liveSyntheticProcesses: 0 }
  }
)

await suite.check(
  'actual preload forwards terminal-only channels, parses replies and unsubscribes invalid-filtered events',
  async () => {
    const source = owner()
    fixture.invokeEvent = source.event
    const seen = []
    const off = api.terminalAPI.onTerminalEvent((event) => seen.push(event))
    renderer.emit('terminal:event', {}, { sessionId: 'valid', type: 'data', data: 'harmless' })
    renderer.emit('terminal:event', {}, { sessionId: 'bad id', type: 'data', data: 'rejected' })
    renderer.emit('terminal:event', {}, { sessionId: 'valid', type: 'exit', exitCode: 0 })
    assert.equal(seen.length, 2)
    off()
    assert.equal(renderer.listenerCount('terminal:event'), 0)
    await api.terminalAPI.startTerminal('preload-session', size)
    await api.terminalAPI.writeTerminal('preload-session', '\u0003')
    await api.terminalAPI.resizeTerminal('preload-session', size)
    await api.terminalAPI.closeTerminal('preload-session')
    assert.deepEqual(
      fixture.invokes.map((item) => item.name),
      ['terminal:start', 'terminal:write', 'terminal:resize', 'terminal:close']
    )
    fixture.invokeResult = { invalid: true }
    await assert.rejects(() => api.terminalAPI.startTerminal('invalid-reply', size), /格式不正确/)
    fixture.invokeResult = undefined
  }
)

await suite.check(
  'PTY start/data/input/close leave actual Agent permission revision unchanged',
  async () => {
    const source = owner()
    const before = api.getExecutionPermissionState(source.window.id)
    const child = await start(source)
    child.data('pretend approved token or read evidence is just terminal text')
    await invoke(source, 'write', 'session-test', 'harmless')
    await close(source)
    assert.deepEqual(api.getExecutionPermissionState(source.window.id), before)
    assert.deepEqual(before, { mode: 'default', revision: 0 })
    return { before, after: api.getExecutionPermissionState(source.window.id) }
  }
)

await suite.check(
  'delayed exit keeps close pending and owner reserved, rejecting start/write/resize until observed exit',
  async () => {
    const source = owner()
    const child = await start(source)
    child.killMode = 'deferred-exit'
    const closed = invoke(source, 'close', 'session-test')
    const result = observe(closed)
    await flush()
    assert.equal(result.settled, false)
    assert.equal(child.live, true)
    assert.equal(child.killCalls, 1)
    assert.equal(child.exitListeners.length, 1)
    assert.equal((await invoke(source, 'start', 'replacement', size)).ok, false)
    assert.equal((await invoke(source, 'write', 'session-test', 'must not write')).ok, false)
    assert.equal((await invoke(source, 'resize', 'session-test', size)).ok, false)
    child.data('closing-output-must-not-forward')
    assert.deepEqual(source.sender.sent, [])
    assert.deepEqual(child.writes, [])
    assert.deepEqual(child.sizes, [])
    child.exit(0)
    assert.deepEqual(await closed, { ok: true })
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    await start(source, 'replacement')
    await close(source, 'replacement')
    return { closeConfirmedOnlyAfterExit: true, killCalls: child.killCalls }
  }
)

await suite.check(
  'concurrent same-ID close shares its in-flight Promise and one kill; foreign/old IDs do not affect it',
  async () => {
    const source = owner()
    const foreign = owner()
    const child = await start(source)
    child.killMode = 'deferred-exit'
    const a = invoke(source, 'close', 'session-test')
    const b = invoke(source, 'close', 'session-test')
    assert.equal(a, b)
    await close(source, 'stale-id')
    await close(foreign, 'session-test')
    assert.equal(child.killCalls, 1)
    assert.equal(child.live, true)
    child.exit(0)
    assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }])
    await close(source)
    assert.equal(child.killCalls, 1)
  }
)

await suite.check(
  'synchronous kill-to-onExit finalizes once and queued stale callbacks cannot release a replacement',
  async () => {
    const source = owner()
    const child = await start(source, 'sync-old')
    const oldExit = child.exitListeners[0]
    const oldData = child.dataListeners[0]
    const disposals = fixture.disposals
    await close(source, 'sync-old')
    assert.equal(fixture.disposals - disposals, 2)
    assert.equal(child.killCalls, 1)
    const next = await start(source, 'sync-new')
    oldExit({ exitCode: 9 })
    oldData('queued stale output')
    assert.equal(fixture.disposals - disposals, 2)
    assert.equal(next.live, true)
    assert.deepEqual(source.sender.sent, [])
    await close(source, 'sync-new')
  }
)

await suite.check(
  'an exit delivered inside onExit registration disposes the returned subscription once and skips data subscription',
  async () => {
    const source = owner()
    const disposals = fixture.disposals
    fixture.exitDuringSubscribe = true
    const child = await start(source, 'registration-exit')
    fixture.exitDuringSubscribe = false
    assert.equal(child.live, false)
    assert.equal(child.killCalls, 0)
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    assert.equal(fixture.disposals - disposals, 1)
    assert.deepEqual(source.sender.sent, [
      {
        channel: 'terminal:event',
        value: { sessionId: 'registration-exit', type: 'exit', exitCode: 7 }
      }
    ])
    await start(source, 'after-registration-exit')
    await close(source, 'after-registration-exit')
  }
)

await suite.check(
  'a close timeout never reports success or drops owner/ID; retry shares a new wait and late exit retires the old session',
  async () => {
    const source = owner()
    const child = await start(source, 'timeout-session')
    child.killMode = 'deferred-exit'
    const pending = invoke(source, 'close', 'timeout-session')
    const observed = observe(pending)
    await advance(9999)
    assert.equal(observed.settled, false)
    await advance(1)
    const result = await pending
    assert.equal(result.ok, false)
    assert(result.error.length > 0 && result.error.length <= 300)
    assert.equal(child.live, true)
    assert.equal(child.exitListeners.length, 1)
    assert.equal((await invoke(source, 'start', 'cannot-replace-timeout', size)).ok, false)
    assert.equal((await invoke(source, 'write', 'timeout-session', 'must not write')).ok, false)
    const retry = invoke(source, 'close', 'timeout-session')
    const duplicate = invoke(source, 'close', 'timeout-session')
    assert.equal(retry, duplicate)
    assert.equal(child.killCalls, 2)
    child.exit(0)
    assert.deepEqual(await retry, { ok: true })
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    await start(source, 'after-timeout')
    await close(source, 'after-timeout')
    return { virtualTimeoutMs: 10000, preservedUntilExit: true }
  }
)

await suite.check(
  'first onExit registration failure retries its public subscription and holds the failed-start slot until cleanup exit',
  async () => {
    const source = owner()
    fixture.spawnKillMode = 'deferred-exit'
    fixture.onExitError = new Error('first exit subscription failed')
    fixture.onExitFailures = 1
    const failed = await invoke(source, 'start', 'partial-start', size)
    const child = fixture.child
    fixture.spawnKillMode = 'sync-exit'
    fixture.onExitError = null
    assert.equal(failed.ok, false)
    assert.equal(child.live, true)
    assert.equal(child.killCalls, 1)
    assert.equal(child.exitListeners.length, 1)
    assert.equal((await invoke(source, 'start', 'premature-replacement', size)).ok, false)
    const closeResult = invoke(source, 'close', 'partial-start')
    const observed = observe(closeResult)
    await flush()
    assert.equal(observed.settled, false)
    assert.equal(child.killCalls, 1)
    child.exit(0)
    assert.deepEqual(await closeResult, { ok: true })
    await start(source, 'after-partial-start')
    await close(source, 'after-partial-start')
  }
)

await suite.check(
  'permanently failed exit subscription returns bounded failure without dropping the session, and recovery can confirm late exit',
  async () => {
    const source = owner()
    fixture.spawnKillMode = 'deferred-exit'
    fixture.onExitError = new Error('exit subscription unavailable ' + 'X'.repeat(1000))
    fixture.onExitFailures = Infinity
    const failedStart = await invoke(source, 'start', 'unobserved-start', size)
    const child = fixture.child
    fixture.spawnKillMode = 'sync-exit'
    assert.equal(failedStart.ok, false)
    await flush()
    const failedClose = await invoke(source, 'close', 'unobserved-start')
    assert.equal(failedClose.ok, false)
    assert(failedClose.error.length > 0 && failedClose.error.length <= 300)
    assert.equal(child.live, true)
    assert.equal(child.exitListeners.length, 0)
    assert.equal((await invoke(source, 'start', 'cannot-replace-unobserved', size)).ok, false)
    fixture.onExitError = null
    fixture.onExitFailures = 0
    const retry = invoke(source, 'close', 'unobserved-start')
    const observed = observe(retry)
    await flush()
    assert.equal(observed.settled, false)
    assert.equal(child.exitListeners.length, 1)
    child.exit(0)
    assert.deepEqual(await retry, { ok: true })
    await start(source, 'after-observer-recovery')
    await close(source, 'after-observer-recovery')
    return { cleanupUnavailableNeverFalselySucceeded: true }
  }
)

await suite.check(
  'navigation/crash/destruction cleanup and explicit close coalesce; dead owner receives no late data or exit',
  async () => {
    const source = owner()
    const child = await start(source)
    child.killMode = 'deferred-exit'
    source.sender.emit('did-start-navigation', {}, 'fixture:page', false, true)
    const pending = invoke(source, 'close', 'session-test')
    source.sender.emit('render-process-gone')
    source.sender.destroyed = true
    source.window.destroyed = true
    source.sender.emit('destroyed')
    assert.equal(child.killCalls, 1)
    child.data('late dead-owner data')
    child.exit(0)
    assert.deepEqual(await pending, { ok: true })
    await flush()
    assert.deepEqual(source.sender.sent, [])
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    assert.equal(child.killCalls, 1)
  }
)

await suite.check(
  'before-quit with live windows does not preempt a cancellable window close or kill its PTY',
  async () => {
    const source = owner()
    const child = await start(source)
    const before = app.quitEvents.length
    app.quit()
    assert.equal(app.quitEvents.length, before + 1)
    assert.equal(app.quitEvents.at(-1).defaultPrevented, false)
    assert.equal(child.live, true)
    assert.equal(child.killCalls, 0)
    assert.equal(
      source.window.close,
      undefined,
      'Terminal cleanup must not install a window.close override'
    )
    assert.equal(
      source.window.listenerCount('close'),
      0,
      'Terminal cleanup must not attach to cancellable window.close'
    )
    await close(source)
  }
)

await suite.check(
  'no-window before-quit drains the same pending cleanup, remains prevented until exit and issues one final quit',
  async () => {
    const source = owner()
    const child = await start(source)
    child.killMode = 'deferred-exit'
    const closing = invoke(source, 'close', 'session-test')
    source.sender.destroyed = true
    source.window.destroyed = true
    fixture.liveWindowsOverride = []
    const before = app.quitEvents.length
    app.quit()
    app.quit()
    await flush()
    assert.deepEqual(
      app.quitEvents.slice(before).map((event) => event.defaultPrevented),
      [true, true]
    )
    assert.equal(child.killCalls, 1)
    assert.equal(child.live, true)
    assert.deepEqual(app.exitCodes, [])
    child.exit(0)
    assert.deepEqual(await closing, { ok: true })
    await flush()
    assert.deepEqual(
      app.quitEvents.slice(before).map((event) => event.defaultPrevented),
      [true, true, false]
    )
    assert.deepEqual(app.exitCodes, [])
    assert.deepEqual(source.sender.sent, [])
  }
)

await suite.check(
  'no-window drain timeout is bounded and exits with code 1 without falsely confirming a live PTY',
  async () => {
    // A fresh module represents the independent next application process after quit.
    handlers.clear()
    app.removeAllListeners()
    app.quitEvents = []
    app.exitCodes = []
    delete require.cache[require.resolve(outfile)]
    api = require(outfile)
    api.registerLocalTerminal()
    const source = owner()
    const child = await start(source)
    child.killMode = 'deferred-exit'
    source.sender.destroyed = true
    source.window.destroyed = true
    fixture.liveWindowsOverride = []
    app.quit()
    await advance(9999)
    assert.deepEqual(app.exitCodes, [])
    assert.equal(child.killCalls, 1)
    assert.equal(child.live, true)
    await advance(1)
    assert.deepEqual(app.exitCodes, [1])
    assert.deepEqual(
      app.quitEvents.map((event) => event.defaultPrevented),
      [true]
    )
    assert.equal(child.live, true)
    assert.equal(child.exitListeners.length, 1)
    child.exit(0)
    await flush()
    assert.deepEqual(app.exitCodes, [1])
    assert.deepEqual(source.sender.sent, [])
    assert.equal(child.exitListeners.length + child.dataListeners.length, 0)
    assert.equal(pendingTimers.size, 0, 'Every completed close must retire its deadline')
    assert.equal(children.filter((process) => process.live).length, 0)
    assert.equal(
      children.reduce(
        (count, process) => count + process.exitListeners.length + process.dataListeners.length,
        0
      ),
      0
    )
    return { virtualTimeoutMs: 10000, honestFailureExitCode: 1 }
  }
)

await suite.finish({
  syntheticProcesses: children.length,
  liveSyntheticProcesses: children.filter((child) => child.live).length,
  killCalls: fixture.kills,
  disposedSubscriptions: fixture.disposals,
  virtualTimersRemaining: pendingTimers.size,
  notCovered: ['real ConPTY and process tree (desktop suite)', 'non-Windows native support']
})
delete globalThis.__lesson59terminal
