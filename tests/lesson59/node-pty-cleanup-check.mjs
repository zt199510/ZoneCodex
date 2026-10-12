import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { prepareNodePtyCleanup } from '../../scripts/prepare-node-pty-cleanup.mjs'
import { patchStock } from '../../scripts/node-pty-cleanup/patch-stock.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const resources = join(root, 'scripts/node-pty-cleanup')
const require = createRequire(import.meta.url)
const { EventEmitter2 } = require('../../node_modules/node-pty/lib/eventEmitter2.js')
const sources = Object.fromEntries(
  await Promise.all(
    [
      'zonecodexWindowsCleanup.cjs',
      'windowsConoutConnection.cjs',
      'conpty_console_list_agent.cjs'
    ].map(async (name) => [name, await readFile(join(resources, name), 'utf8')])
  )
)
const manifest = JSON.parse(await readFile(join(resources, 'manifest.json'), 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const turn = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const cases = []
const test = async (name, run) => {
  await run()
  cases.push({ name, passed: true })
}
const unhandled = []
const onUnhandled = (error) => unhandled.push(String(error))
process.on('unhandledRejection', onUnhandled)

function load(source, dependencies, overrides = {}) {
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name in dependencies) return dependencies[name]
      throw new Error('Unexpected dependency: ' + name)
    },
    process,
    console,
    setTimeout,
    clearTimeout,
    __dirname: resources,
    ...overrides
  })
  return module.exports
}

function harness(options = {}) {
  const log = [],
    diagnostics = [],
    children = []
  class Socket extends EventEmitter {
    constructor(name) {
      super()
      this.name = name
      this.closed = false
      this.destroyed = false
    }
    destroy() {
      log.push(this.name + 'Destroy')
      this.destroyed = true
      if (this.stall) return
      this.closed = true
      this.emit('close')
    }
  }
  const inSocket = new Socket('in'),
    outSocket = new Socket('out')
  const worker = {
    ready: options.ready || Promise.resolve(),
    dispose: () => {
      log.push('workerDispose')
      return options.dispose ? options.dispose() : Promise.resolve()
    }
  }
  let cleanup
  const agent = {
    inSocket,
    outSocket,
    _useConpty: true,
    _useConptyDll: false,
    _conoutSocketWorker: worker,
    innerPid: 111,
    pty: 222,
    get exitCode() {
      return this._exitCode
    },
    _ptyNative: {
      kill: () => {
        log.push('nativeClose')
        if (options.native) return options.native(cleanup)
        cleanup.nativeExit(0)
      }
    }
  }
  const dependencies = {
    helperPath: 'helper',
    limits: {
      helper: 20,
      helperKill: 20,
      quiet: 2,
      flush: 8,
      resources: 20,
      complete: 180,
      ...options.limits
    },
    processKill: (pid, signal) => {
      if (signal === 0) {
        if (options.dead) throw Object.assign(new Error('missing'), { code: 'ESRCH' })
        return
      }
      log.push('kill:' + pid)
      if (options.processKill) options.processKill(pid)
    },
    fork: (_, __, forkOptions) => {
      assert.equal(forkOptions.windowsHide, true)
      options.onForkOptions?.(forkOptions)
      const child = new EventEmitter()
      child.pid = 333
      child.stderr = new EventEmitter()
      child.kill = () => {
        log.push('helperKill')
        if (!options.stallHelper) queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
      }
      children.push(child)
      log.push('helperFork')
      child.on('close', () => log.push('helperClose'))
      const startupArgv = Object.hasOwn(forkOptions, 'execArgv')
        ? forkOptions.execArgv
        : options.hiddenInheritedExecArgv || []
      if (!options.manualHelper && startupArgv.length === 0)
        queueMicrotask(() => {
          child.emit('message', {
            consoleProcessList: [111, 444, 333, process.pid, 444],
            ...options.reply
          })
          child.emit('close', 0, null)
        })
      return child
    }
  }
  const { WindowsCleanup } = load(
    sources['zonecodexWindowsCleanup.cjs'],
    { './eventEmitter2': { EventEmitter2 } },
    {
      console: { error: (value) => diagnostics.push(String(value)) },
      ...(options.runtimeProcess ? { process: options.runtimeProcess } : {})
    }
  )
  cleanup = new WindowsCleanup(agent, dependencies)
  const exits = []
  cleanup.onExit((code) => {
    log.push('publicExit')
    exits.push(code)
  })
  return { cleanup, agent, log, diagnostics, children, exits }
}

function fallbackHarness(options = {}) {
  let fixture
  fixture = harness({
    ...options,
    native: () => undefined,
    processKill: (pid) => {
      if (pid === fixture.agent.innerPid) fixture.cleanup.nativeExit(0)
    }
  })
  return fixture
}

await test('enumeration waits helper close; filters helper/parent and deduplicates snapshot', async () => {
  const h = fallbackHarness({ manualHelper: true })
  const first = h.cleanup.kill()
  assert.equal(h.cleanup.kill(), first)
  await turn()
  h.children[0].emit('message', { consoleProcessList: [111, 444, 333, process.pid, 444] })
  await turn()
  assert.deepEqual(h.log, ['helperFork'])
  h.children[0].emit('close', 0, null)
  await first
  assert.deepEqual(
    h.log.filter((value) => value.startsWith('kill:')),
    ['kill:444', 'kill:111']
  )
  assert.ok(h.log.indexOf('helperClose') < h.log.indexOf('kill:444'))
  assert.ok(h.log.indexOf('kill:444') < h.log.indexOf('nativeClose'))
  assert.ok(h.log.indexOf('nativeClose') < h.log.indexOf('kill:111'))
  assert.deepEqual(h.exits, [0])
  await h.cleanup.kill()
  assert.equal(h.log.filter((value) => value === 'nativeClose').length, 1)
})

await test('native exit during native close avoids unnecessary root force-kill', async () => {
  const h = harness()
  await h.cleanup.kill()
  assert.equal(h.log.includes('kill:111'), false)
  assert.ok(h.log.indexOf('kill:444') < h.log.indexOf('nativeClose'))
})

await test('root proven dead after native close skips fallback until actual native callback', async () => {
  const h = harness({ dead: true, native: () => undefined })
  const killed = h.cleanup.kill()
  await turn()
  assert.equal(h.log.includes('nativeClose'), true)
  assert.equal(h.log.includes('kill:111'), false)
  assert.deepEqual(h.exits, [])
  h.cleanup.nativeExit(0)
  await killed
  assert.deepEqual(h.exits, [0])
})

await test('natural exit closes native, both sockets and worker before public exit', async () => {
  const retirement = deferred()
  const h = harness({ dispose: () => retirement.promise })
  h.cleanup.nativeExit(7)
  await delay(6)
  assert.equal(h.log.includes('nativeClose'), true)
  assert.equal(h.agent.inSocket.closed, true)
  assert.equal(h.agent.outSocket.closed, true)
  assert.deepEqual(h.exits, [])
  retirement.resolve()
  await turn()
  assert.deepEqual(h.exits, [7])
  assert.equal(h.children.length, 0)
})

await test('output EOF alone cannot fake shell exit', async () => {
  const h = harness({ native: () => undefined })
  h.agent.outSocket.destroy()
  await turn()
  assert.deepEqual(h.exits, [])
  h.cleanup.nativeExit(9)
  await h.cleanup.killPromise
  assert.deepEqual(h.exits, [9])
})

await test('natural callback during pending helper does not retire before helper exit', async () => {
  const h = harness({ manualHelper: true })
  const killed = h.cleanup.kill()
  await turn()
  h.cleanup.nativeExit(0)
  await delay(5)
  assert.equal(h.log.includes('nativeClose'), false)
  assert.deepEqual(h.exits, [])
  h.children[0].emit('message', { consoleProcessList: [111] })
  h.children[0].emit('close', 0, null)
  await killed
  assert.ok(h.log.indexOf('helperClose') < h.log.indexOf('nativeClose'))
})

await test('live AttachConsole failure is bounded diagnostic and root fallback', async () => {
  const h = fallbackHarness({
    reply: { consoleProcessList: [], error: 'AttachConsole failed ' + 'x'.repeat(2000) }
  })
  await h.cleanup.kill()
  assert.deepEqual(
    h.log.filter((value) => value.startsWith('kill:')),
    ['kill:111']
  )
  assert.equal(h.diagnostics.length, 1)
  assert.ok(h.diagnostics[0].length < 350)
})

await test('only proven dead AttachConsole race is consumed', async () => {
  const h = harness({
    dead: true,
    reply: { consoleProcessList: [], error: 'AttachConsole failed' }
  })
  await h.cleanup.kill()
  assert.deepEqual(h.diagnostics, [])
  assert.deepEqual(
    h.log.filter((value) => value.startsWith('kill:')),
    []
  )
  const other = harness({ dead: true, reply: { consoleProcessList: [], error: 'query failed' } })
  await other.cleanup.kill()
  assert.equal(other.diagnostics.length, 1)
})

await test('successful helper reply still reports bounded stderr diagnostics', async () => {
  const h = harness({ manualHelper: true })
  const killed = h.cleanup.kill()
  await turn()
  h.children[0].stderr.emit('data', 'native warning ' + 'x'.repeat(5000))
  h.children[0].emit('message', { consoleProcessList: [111] })
  h.children[0].emit('close', 0, null)
  await killed
  assert.equal(h.diagnostics.length, 1)
  assert.ok(h.diagnostics[0].includes('Console helper stderr'))
  assert.ok(h.diagnostics[0].length < 350)
})

await test('spawn error without helper PID is owned and uses diagnostic fallback', async () => {
  const h = fallbackHarness({ manualHelper: true })
  const killed = h.cleanup.kill()
  await turn()
  h.children[0].pid = undefined
  h.children[0].emit('error', new Error('helper spawn failed'))
  await killed
  assert.deepEqual(
    h.log.filter((value) => value.startsWith('kill:')),
    ['kill:111']
  )
  assert.equal(h.diagnostics.length, 1)
})

await test('helper enumeration timeout confirms helper termination before fallback/native', async () => {
  const h = fallbackHarness({ manualHelper: true })
  await h.cleanup.kill()
  assert.ok(h.log.indexOf('helperKill') < h.log.indexOf('helperClose'))
  assert.ok(h.log.indexOf('helperClose') < h.log.indexOf('kill:111'))
  assert.ok(h.log.indexOf('nativeClose') < h.log.indexOf('kill:111'))
  assert.equal(h.diagnostics.length, 1)
})

await test('unconfirmed helper failure retains ownership and permits retry', async () => {
  const h = harness({ manualHelper: true, stallHelper: true })
  await assert.rejects(h.cleanup.kill(), /did not confirm retirement/)
  assert.equal(h.cleanup.completed, false)
  assert.equal(h.log.includes('nativeClose'), false)
  assert.ok(h.cleanup.helper)
  h.cleanup.nativeExit(0)
  h.children[0].emit('close', null, 'SIGTERM')
  await h.cleanup.kill()
  assert.equal(h.cleanup.completed, true)
  assert.equal(h.children.length, 1)
})

await test('late helper close after timeout still schedules natural retirement', async () => {
  const h = harness({ manualHelper: true, stallHelper: true })
  const first = h.cleanup.kill()
  await turn()
  h.cleanup.nativeExit(0)
  await assert.rejects(first, /did not confirm retirement/)
  h.children[0].emit('close', null, 'SIGTERM')
  await delay(8)
  assert.deepEqual(h.exits, [0])
})

await test('worker disposal failure then retry emits exit once and never repeats native close', async () => {
  let attempts = 0
  const h = harness({
    dispose: () =>
      ++attempts === 1 ? Promise.reject(new Error('worker refused terminate')) : Promise.resolve()
  })
  await assert.rejects(h.cleanup.kill(), /worker refused terminate/)
  assert.deepEqual(h.exits, [])
  await h.cleanup.kill()
  assert.deepEqual(h.exits, [0])
  assert.equal(attempts, 2)
  assert.equal(h.log.filter((value) => value === 'nativeClose').length, 1)
})

await test('worker retirement timeout waits real completion before retry may succeed', async () => {
  const retiring = deferred()
  const h = harness({ dispose: () => retiring.promise })
  await assert.rejects(h.cleanup.kill(), /worker retirement.*timed out/)
  assert.deepEqual(h.exits, [])
  retiring.resolve()
  await h.cleanup.kill()
  assert.deepEqual(h.exits, [0])
  assert.equal(h.log.filter((value) => value === 'nativeClose').length, 1)
})

await test('socket close timeout retains session and removes temporary listeners for retry', async () => {
  const h = harness()
  h.agent.inSocket.stall = true
  await assert.rejects(h.cleanup.kill(), /socket close timed out/)
  assert.deepEqual(h.exits, [])
  assert.equal(h.agent.inSocket.listenerCount('close'), 0)
  assert.equal(h.agent.inSocket.listenerCount('error'), 1)
  h.agent.inSocket.stall = false
  await h.cleanup.kill()
  assert.deepEqual(h.exits, [0])
})

await test('thrown unacknowledged native close permits explicit retry', async () => {
  let attempts = 0
  const h = harness({
    native: (cleanup) => {
      if (++attempts === 1) throw new Error('native rejected')
      cleanup.nativeExit(0)
    }
  })
  await assert.rejects(h.cleanup.kill(), /native rejected/)
  assert.deepEqual(h.exits, [])
  assert.equal(h.log.includes('kill:111'), false)
  await h.cleanup.kill()
  assert.deepEqual(h.exits, [0])
  assert.equal(attempts, 2)
})

await test('readiness rejection plus natural exit never reports successful cleanup', async () => {
  const ready = deferred()
  const h = harness({ ready: ready.promise })
  const killed = h.cleanup.kill()
  await turn()
  ready.reject(new Error('pipe worker failed readiness'))
  h.cleanup.nativeExit(0)
  await assert.rejects(killed, /failed readiness/)
  await delay(6)
  assert.deepEqual(h.exits, [])
  assert.equal(h.cleanup.completed, false)
  assert.equal(h.log.includes('nativeClose'), false)
})

await test('Conout ready uses numeric const enum and terminate waits actual worker exit; retry allowed', async () => {
  const instances = []
  let terminations = 0
  class Worker extends EventEmitter {
    constructor() {
      super()
      instances.push(this)
    }
    terminate() {
      return ++terminations === 1
        ? Promise.reject(new Error('terminate refused'))
        : Promise.resolve(1)
    }
  }
  const { ConoutConnection } = load(sources['windowsConoutConnection.cjs'], {
    worker_threads: { Worker },
    path: { join },
    './shared/conout': { getWorkerPipeName: (name) => name + '-worker' },
    './eventEmitter2': { EventEmitter2 }
  })
  const connection = new ConoutConnection('test', false)
  const instance = instances[0]
  instance.emit('message', 1)
  await connection.ready
  let connected
  connection.connectSocket({
    destroyed: false,
    connect: (name) => {
      connected = name
    }
  })
  assert.equal(connected, 'test-worker')
  await assert.rejects(connection.dispose(), /terminate refused/)
  let retired = false
  const retry = connection.dispose().then(() => {
    retired = true
  })
  await turn()
  assert.equal(retired, false)
  instance.emit('exit', 1)
  await retry
  assert.equal(retired, true)
  await connection.dispose()
  assert.equal(terminations, 2)
})

await test('console helper native exception is bounded structured IPC data', async () => {
  let answer, exitCode
  load(
    sources['conpty_console_list_agent.cjs'],
    {
      './utils': {
        loadNativeModule: () => {
          throw new Error('AttachConsole failed ' + 'x'.repeat(1000))
        }
      }
    },
    {
      process: {
        argv: ['node', 'helper', '111'],
        send: (value, callback) => {
          answer = value
          callback()
        },
        exit: (code) => {
          exitCode = code
        }
      },
      console: { error: () => assert.fail('Handled native failure must not print uncaught stack') }
    }
  )
  assert.equal(answer.consoleProcessList.length, 0)
  assert.ok(answer.error.startsWith('AttachConsole failed'))
  assert.ok(answer.error.length <= 300)
  assert.equal(exitCode, 0)
})

await test('WindowsTerminal kill executes before first output instead of deferring', async () => {
  const current = await readFile(join(root, 'node_modules/node-pty/lib/windowsTerminal.js'), 'utf8')
  const source =
    hash(current) === manifest.files['windowsTerminal.js'].originalSha256
      ? patchStock('windowsTerminal.js', current)
      : current
  let kills = 0
  class FakeAgent {
    constructor() {
      this.outSocket = new EventEmitter()
      this.inSocket = {}
      this.innerPid = 111
      this.onExit = () => undefined
    }
    kill() {
      kills++
      return Promise.resolve()
    }
  }
  function Terminal() {
    EventEmitter.call(this)
  }
  Object.setPrototypeOf(Terminal.prototype, EventEmitter.prototype)
  for (const name of ['_checkType', '_forwardEvents', '_close'])
    Terminal.prototype[name] = () => undefined
  Terminal.prototype._parseEnv = () => []
  const { WindowsTerminal } = load(source, {
    './terminal': { Terminal, DEFAULT_COLS: 80, DEFAULT_ROWS: 24 },
    './windowsPtyAgent': { WindowsPtyAgent: FakeAgent },
    './utils': { assign: Object.assign }
  })
  const terminal = new WindowsTerminal('cmd.exe', [], {})
  assert.equal(terminal._isReady, false)
  await terminal.kill()
  assert.equal(kills, 1)
  assert.equal(terminal._deferreds.length, 0)
})

await test('preparer original, patched, check, mixed, unknown bytes and version states', async () => {
  const project = await mkdtemp(join(tmpdir(), 'zonecodex-pty-cleanup-'))
  const lib = join(project, 'node_modules/node-pty/lib')
  await mkdir(lib, { recursive: true })
  try {
    await writeFile(
      join(project, 'node_modules/node-pty/package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0' })
    )
    const snapshot = join(resources, 'upstream')
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (entry.originalSha256 === null) continue
      const bytes = await readFile(join(snapshot, name + '.txt'))
      assert.equal(hash(bytes), entry.originalSha256)
      await writeFile(join(lib, name), bytes)
    }
    assert.equal(
      (await prepareNodePtyCleanup({ projectRoot: project, checkOnly: true })).changed,
      0
    )
    assert.equal((await prepareNodePtyCleanup({ projectRoot: project })).changed, 5)
    assert.equal((await prepareNodePtyCleanup({ projectRoot: project })).changed, 0)
    for (const [name, entry] of Object.entries(manifest.files))
      assert.equal(hash(await readFile(join(lib, name))), entry.patchedSha256)
    await writeFile(
      join(lib, 'windowsTerminal.js'),
      await readFile(join(snapshot, 'windowsTerminal.js.txt'))
    )
    assert.equal((await prepareNodePtyCleanup({ projectRoot: project })).changed, 1)
    const before = await readFile(join(lib, 'windowsPtyAgent.js'))
    await writeFile(join(lib, 'windowsTerminal.js'), 'unknown user bytes')
    await assert.rejects(prepareNodePtyCleanup({ projectRoot: project }), /Unknown node-pty bytes/)
    assert.equal(hash(await readFile(join(lib, 'windowsPtyAgent.js'))), hash(before))
    assert.equal(await readFile(join(lib, 'windowsTerminal.js'), 'utf8'), 'unknown user bytes')
    await writeFile(
      join(project, 'node_modules/node-pty/package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.2.0' })
    )
    await assert.rejects(
      prepareNodePtyCleanup({ projectRoot: project }),
      /Unsupported node-pty identity/
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

await test('Conout worker starts and retires without hidden inherited inspector pause', async () => {
  const runtimeProcess = { execArgv: [] }
  const hiddenInheritedExecArgv = ['--inspect-brk=19359']
  const instances = []
  class Worker extends EventEmitter {
    constructor(filename, options) {
      super()
      this.filename = filename
      this.options = options
      this.startupArgv = Object.hasOwn(options, 'execArgv')
        ? Array.from(options.execArgv)
        : hiddenInheritedExecArgv
      instances.push(this)
      // Electron's inspector inheritance can exist independently of process.execArgv.
      if (this.startupArgv.length === 0) queueMicrotask(() => this.emit('message', 1))
    }
    terminate() {
      queueMicrotask(() => this.emit('exit', 1))
      return Promise.resolve(1)
    }
  }
  const { ConoutConnection } = load(
    sources['windowsConoutConnection.cjs'],
    {
      worker_threads: { Worker },
      path: { join },
      './shared/conout': { getWorkerPipeName: (name) => name + '-worker' },
      './eventEmitter2': { EventEmitter2 }
    },
    { process: runtimeProcess }
  )
  const connection = new ConoutConnection('inspector-isolated', false)
  let ready = false
  connection.ready.then(() => {
    ready = true
  })
  await turn()
  const instance = instances[0]
  assert.deepEqual(runtimeProcess.execArgv, [])
  assert.deepEqual(instance.startupArgv, [])
  assert.equal(ready, true)
  assert.equal(Object.hasOwn(instance.options, 'execArgv'), true)
  assert.equal(instance.options.workerData.conoutPipeName, 'inspector-isolated')
  assert.equal(instance.filename, join(resources, 'worker/conoutSocketWorker.js'))
  await connection.dispose()
  assert.equal(connection._workerExited, true)
})

await test('console helper starts and closes without hidden inherited inspector pause', async () => {
  const runtimeProcess = { pid: process.pid, execArgv: [] }
  let forkOptions
  const h = harness({
    runtimeProcess,
    hiddenInheritedExecArgv: ['--inspect-brk=19360'],
    onForkOptions: (value) => {
      forkOptions = value
    }
  })
  await h.cleanup.kill()
  assert.deepEqual(runtimeProcess.execArgv, [])
  assert.equal(Object.hasOwn(forkOptions, 'execArgv'), true)
  assert.equal(Array.isArray(forkOptions.execArgv), true)
  assert.equal(forkOptions.execArgv.length, 0)
  assert.equal(h.log.includes('helperKill'), false)
  assert.deepEqual(h.diagnostics, [])
  assert.ok(h.log.indexOf('helperClose') < h.log.indexOf('kill:444'))
  assert.ok(h.log.indexOf('kill:444') < h.log.indexOf('nativeClose'))
  assert.deepEqual(h.exits, [0])
})

await test('preparer migrates exact previous patches and rejects unknown bytes before any write', async () => {
  const project = await mkdtemp(join(tmpdir(), 'zonecodex-pty-migration-'))
  const lib = join(project, 'node_modules/node-pty/lib')
  await mkdir(lib, { recursive: true })
  const previousEntries = Object.entries(manifest.files).filter(
    ([, entry]) => entry.previousPatchedSha256 !== undefined
  )
  const snapshots = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.keys(manifest.files).map(async (name) => [
          name,
          hash(await readFile(join(lib, name)))
        ])
      )
    )
  const writePrevious = async () => {
    for (const [name, entry] of previousEntries) {
      const bytes = await readFile(join(resources, 'previous', name + '.txt'))
      assert.equal(hash(bytes), entry.previousPatchedSha256)
      assert.notEqual(entry.previousPatchedSha256, entry.patchedSha256)
      await writeFile(join(lib, name), bytes)
    }
  }
  try {
    assert.deepEqual(
      previousEntries.map(([name]) => name),
      ['windowsConoutConnection.js', 'zonecodexWindowsCleanup.js']
    )
    await writeFile(
      join(project, 'node_modules/node-pty/package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0' })
    )
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (entry.originalSha256 === null) continue
      await writeFile(join(lib, name), await readFile(join(resources, 'upstream', name + '.txt')))
    }
    await prepareNodePtyCleanup({ projectRoot: project })
    await writePrevious()
    const beforeCheck = await snapshots()
    const checked = await prepareNodePtyCleanup({ projectRoot: project, checkOnly: true })
    assert.equal(checked.changed, 0)
    for (const [name] of previousEntries) assert.equal(checked.files[name], 'previous')
    assert.deepEqual(await snapshots(), beforeCheck)
    assert.equal((await prepareNodePtyCleanup({ projectRoot: project })).changed, 2)
    assert.equal((await prepareNodePtyCleanup({ projectRoot: project })).changed, 0)
    for (const [name, entry] of Object.entries(manifest.files))
      assert.equal(hash(await readFile(join(lib, name))), entry.patchedSha256)

    // A recoverable mix contains one original, one known previous, and three current files.
    await writeFile(
      join(lib, 'windowsTerminal.js'),
      await readFile(join(resources, 'upstream/windowsTerminal.js.txt'))
    )
    await writeFile(
      join(lib, 'windowsConoutConnection.js'),
      await readFile(join(resources, 'previous/windowsConoutConnection.js.txt'))
    )
    const mixed = await prepareNodePtyCleanup({ projectRoot: project })
    assert.equal(mixed.changed, 2)
    assert.equal(mixed.files['windowsTerminal.js'], 'original')
    assert.equal(mixed.files['windowsConoutConnection.js'], 'previous')
    assert.equal(mixed.files['zonecodexWindowsCleanup.js'], 'patched')

    // Unknown final bytes must reject a plan with an earlier migratable previous file.
    await writePrevious()
    await writeFile(join(lib, 'zonecodexWindowsCleanup.js'), 'unknown final file')
    const beforeReject = await snapshots()
    await assert.rejects(
      prepareNodePtyCleanup({ projectRoot: project }),
      /Unknown node-pty bytes; refusing to patch zonecodexWindowsCleanup.js/
    )
    assert.deepEqual(await snapshots(), beforeReject)

    // One-byte drift of a known previous patch is unknown in both modes.
    await writePrevious()
    const drifted = await readFile(join(lib, 'windowsConoutConnection.js'))
    drifted[0] ^= 1
    await writeFile(join(lib, 'windowsConoutConnection.js'), drifted)
    const beforeDrift = await snapshots()
    for (const checkOnly of [true, false])
      await assert.rejects(
        prepareNodePtyCleanup({ projectRoot: project, checkOnly }),
        /Unknown node-pty bytes; refusing to patch windowsConoutConnection.js/
      )
    assert.deepEqual(await snapshots(), beforeDrift)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
})

await turn()
assert.deepEqual(unhandled, [])
process.removeListener('unhandledRejection', onUnhandled)
console.log(
  JSON.stringify(
    { suite: 'lesson59-node-pty-cleanup', kind: 'synthetic', passed: cases.length, cases },
    null,
    2
  )
)
