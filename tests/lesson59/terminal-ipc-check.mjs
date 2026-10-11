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
  invokeResult: undefined,
  invokeEvent: null,
  invokes: [],
  kills: 0,
  disposals: 0,
  child: null
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
    this.writeError = null
    this.resizeError = null
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
    if (fixture.onExitError) throw fixture.onExitError
    return this.subscribe(this.exitListeners, listener)
  }
  write(data) {
    if (this.writeError) throw this.writeError
    this.writes.push(data)
  }
  resize(cols, rows) {
    if (this.resizeError) throw this.resizeError
    this.sizes.push({ cols, rows })
  }
  kill() {
    if (this.killError) throw this.killError
    assert(this.live, 'An already closed PTY must not be killed again')
    this.live = false
    fixture.kills++
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
  app: { getPath: (name) => (name === 'home' ? path.join(evidence, 'synthetic-home') : null) },
  BrowserWindow: { fromWebContents: (owner) => windows.get(owner) ?? null },
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
  spawn(program, args, options) {
    if (fixture.spawnError) throw fixture.spawnError
    fixture.child = new FakePty(program, args, options)
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
  'node-pty': 'spawn',
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
  plugins: [
    {
      name: 'terminal-native-boundary-fixture',
      setup(builder) {
        builder.onResolve(
          { filter: /^(electron|node-pty)$|\/settings-(service|ipc)$|\/terminal-shell$/ },
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
const api = createRequire(import.meta.url)(outfile)
api.registerLocalTerminal()
const suite = checksFor(evidence, {
  ordinaryNode: true,
  syntheticElectron: true,
  syntheticPty: true,
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
  const window = {
    id: sender.id + 1000,
    webContents: sender,
    destroyed: false,
    isDestroyed: () => window.destroyed
  }
  windows.set(sender, window)
  api.attachTerminalCleanup(window)
  return { sender, window, event: { sender, senderFrame: sender.mainFrame } }
}
const invoke = (source, channel, ...args) =>
  handlers.get('terminal:' + channel)(source.event, ...args)
const size = { cols: 80, rows: 24 }
function start(source, id = 'session-test') {
  assert.deepEqual(invoke(source, 'start', id, size), { ok: true })
  return fixture.child
}
function close(source, id = 'session-test') {
  assert.deepEqual(invoke(source, 'close', id), { ok: true })
}

await suite.check('exact terminal channels remain separate from Agent channels', () => {
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
  () => {
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

await suite.check('invalid or non-main-frame/dead owners fail before PTY creation', () => {
  const source = owner()
  const count = children.length
  for (const event of [
    { sender: source.sender, senderFrame: {} },
    { sender: { mainFrame: {} }, senderFrame: {} }
  ])
    assert.throws(() => handlers.get('terminal:start')(event, 'valid', size), /终端请求来源/)
  source.window.destroyed = true
  assert.throws(() => invoke(source, 'start', 'valid', size), /终端请求来源/)
  source.window.destroyed = false
  source.sender.destroyed = true
  assert.throws(() => invoke(source, 'start', 'valid', size), /终端请求来源/)
  source.sender.destroyed = false
  assert.equal(invoke(source, 'start', 'bad id', size).ok, false)
  assert.equal(invoke(source, 'start', 'valid', { cols: 501, rows: 24 }).ok, false)
  assert.equal(children.length, count)
})

await suite.check(
  'settings save blocks start and shell/PTY creation errors permit retry without a live child',
  () => {
    const source = owner()
    const count = children.length
    fixture.mutation = true
    assert.match(invoke(source, 'start', 'session-test', size).error, /设置正在保存/)
    fixture.mutation = false
    fixture.shellError = new Error('未找到测试 shell')
    assert.match(invoke(source, 'start', 'session-test', size).error, /未找到测试 shell/)
    fixture.shellError = null
    fixture.spawnError = new Error('创建失败')
    assert.equal(invoke(source, 'start', 'session-test', size).ok, false)
    fixture.spawnError = null
    assert.equal(children.length, count)
    start(source)
    close(source)
  }
)

await suite.check(
  'native error strings returned to the renderer are bounded to 300 characters',
  () => {
    const source = owner()
    fixture.spawnError = new Error('X'.repeat(10000))
    const result = invoke(source, 'start', 'session-test', size)
    fixture.spawnError = null
    assert.equal(result.ok, false)
    assert(result.error.length > 0 && result.error.length <= 300)
    return { errorCharacters: result.error.length }
  }
)

await suite.check(
  'same-window duplicate start is refused; another owner can run independently',
  () => {
    const a = owner()
    const b = owner()
    const first = start(a, 'a-session')
    assert.equal(invoke(a, 'start', 'second-session', size).ok, false)
    assert.equal(first.live, true)
    const second = start(b, 'b-session')
    assert.notEqual(first, second)
    assert.equal(first.options.cwd, path.join(evidence, 'synthetic-home'))
    assert.equal(first.options.cols, 80)
    assert.equal(first.options.rows, 24)
    close(a, 'a-session')
    assert(second.live)
    close(b, 'b-session')
  }
)

await suite.check(
  'foreign IDs cannot write/resize/close another owner or disturb its session',
  () => {
    const a = owner()
    const b = owner()
    const child = start(a, 'private-session')
    assert.equal(invoke(b, 'write', 'private-session', 'echo harmless\r').ok, false)
    assert.equal(invoke(b, 'resize', 'private-session', size).ok, false)
    close(b, 'private-session')
    assert(child.live)
    assert.deepEqual(child.writes, [])
    assert.deepEqual(child.sizes, [])
    child.data('owner-only-output')
    assert.equal(a.sender.sent.length, 1)
    assert.equal(b.sender.sent.length, 0)
    close(a, 'private-session')
  }
)

await suite.check(
  'input bounds and unchanged Ctrl+C/whitespace are enforced before PTY writes',
  () => {
    const source = owner()
    const child = start(source)
    for (const input of ['', 1, null, 'X'.repeat(8193)])
      assert.equal(invoke(source, 'write', 'session-test', input).ok, false)
    assert.equal(invoke(source, 'write', 'session-test', 'X'.repeat(8192)).ok, true)
    assert.equal(invoke(source, 'write', 'session-test', ' \r\n\u0003').ok, true)
    assert.deepEqual(child.writes, ['X'.repeat(8192), ' \r\n\u0003'])
    assert.equal(invoke(source, 'resize', 'session-test', { cols: 501, rows: 24 }).ok, false)
    assert.equal(invoke(source, 'resize', 'session-test', { cols: 500, rows: 300 }).ok, true)
    assert.deepEqual(child.sizes, [{ cols: 500, rows: 300 }])
    close(source)
  }
)

await suite.check(
  'write/resize failures return a bounded error and preserve explicit close',
  () => {
    const source = owner()
    const child = start(source)
    child.writeError = new Error('write fixture failure')
    child.resizeError = new Error('resize fixture failure')
    assert.equal(invoke(source, 'write', 'session-test', 'harmless').ok, false)
    assert.equal(invoke(source, 'resize', 'session-test', size).ok, false)
    assert(child.live)
    close(source)
  }
)

await suite.check(
  'close releases all subscriptions once; repeated/old-ID closes cannot kill replacement',
  () => {
    const source = owner()
    const child = start(source, 'old-session')
    const oldData = child.dataListeners[0]
    const oldExit = child.exitListeners[0]
    const disposals = fixture.disposals
    close(source, 'old-session')
    close(source, 'old-session')
    assert.equal(fixture.disposals - disposals, 2)
    assert.equal(child.dataListeners.length + child.exitListeners.length, 0)
    const replacement = start(source, 'new-session')
    close(source, 'old-session')
    oldData('late old data')
    oldExit({ exitCode: 0 })
    assert(replacement.live)
    assert.deepEqual(source.sender.sent, [])
    close(source, 'new-session')
  }
)

await suite.check(
  'natural fast exit clears owner session, subscriptions and allows fresh start',
  () => {
    const source = owner()
    const child = start(source)
    const disposals = fixture.disposals
    child.exit(7)
    assert.equal(fixture.disposals - disposals, 2)
    assert.deepEqual(source.sender.sent, [
      { channel: 'terminal:event', value: { sessionId: 'session-test', type: 'exit', exitCode: 7 } }
    ])
    assert.equal(invoke(source, 'write', 'session-test', 'no').ok, false)
    start(source, 'restart')
    close(source, 'restart')
  }
)

await suite.check(
  'partial subscription failures kill already spawned child and allow fresh start',
  () => {
    const source = owner()
    for (const field of ['onDataError', 'onExitError']) {
      fixture[field] = new Error(field + ' fixture failure')
      assert.equal(invoke(source, 'start', 'session-test', size).ok, false)
      assert.equal(fixture.child.live, false)
      assert.equal(fixture.child.dataListeners.length + fixture.child.exitListeners.length, 0)
      fixture[field] = null
      start(source)
      close(source)
    }
  }
)

await suite.check(
  'a failed kill reports failure without falsely dropping the live session; retry cleans it',
  () => {
    const source = owner()
    const child = start(source)
    child.killError = new Error('cannot kill fixture process')
    assert.equal(invoke(source, 'close', 'session-test').ok, false)
    assert(child.live)
    assert.equal(invoke(source, 'start', 'another', size).ok, false)
    child.killError = null
    close(source)
  }
)

await suite.check(
  'only full main-frame navigation clears PTY; in-place/subframe navigation preserves it',
  () => {
    const source = owner()
    const child = start(source)
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
  () => {
    for (const event of ['render-process-gone', 'destroyed']) {
      const source = owner()
      const child = start(source)
      source.sender.destroyed = event === 'destroyed'
      source.sender.emit(event)
      assert(!child.live)
      assert.equal(child.dataListeners.length + child.exitListeners.length, 0)
    }
  }
)

await suite.check(
  'rapid repeated start/close leaves no live synthetic processes or subscriptions',
  () => {
    const source = owner()
    for (let index = 0; index < 25; index++) {
      start(source, 'rapid-' + index)
      close(source, 'rapid-' + index)
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
  () => {
    const source = owner()
    const before = api.getExecutionPermissionState(source.window.id)
    const child = start(source)
    child.data('pretend approved token or read evidence is just terminal text')
    invoke(source, 'write', 'session-test', 'harmless')
    close(source)
    assert.deepEqual(api.getExecutionPermissionState(source.window.id), before)
    assert.deepEqual(before, { mode: 'default', revision: 0 })
    return { before, after: api.getExecutionPermissionState(source.window.id) }
  }
)

await suite.finish({
  syntheticProcesses: children.length,
  liveSyntheticProcesses: children.filter((child) => child.live).length,
  killCalls: fixture.kills,
  disposedSubscriptions: fixture.disposals,
  notCovered: ['real ConPTY and process tree (desktop suite)', 'non-Windows native support']
})
delete globalThis.__lesson59terminal
