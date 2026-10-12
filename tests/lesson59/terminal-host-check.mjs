import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('terminal-host')
const children = []
const timers = new Map()
let now = 0
let timerSerial = 0
let sessionSerial = 0
let forkError
const flush = async () => {
  for (let round = 0; round < 12; round++) await Promise.resolve()
}
async function advance(milliseconds) {
  const end = now + milliseconds
  await flush()
  for (;;) {
    const next = [...timers.values()]
      .filter((timer) => timer.at <= end)
      .sort((a, b) => a.at - b.at)[0]
    if (!next) break
    now = next.at
    timers.delete(next.id)
    next.callback()
    await flush()
  }
  now = end
  await flush()
}
function observe(promise) {
  const state = { settled: false, value: undefined, error: undefined }
  Promise.resolve(promise).then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error })
  )
  return state
}
class UtilityChild extends EventEmitter {
  constructor(filename, args, options) {
    super()
    Object.assign(this, { filename, args, options, posts: [], live: true, killCalls: 0 })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    children.push(this)
  }
  postMessage(message) {
    if (this.postError) throw this.postError
    this.posts.push(message)
  }
  kill() {
    this.killCalls++
    if (this.killError) throw this.killError
    return this.killReturn ?? true
  }
  message(message) {
    this.emit('message', message)
  }
  exit(code = 0) {
    if (!this.live) return
    this.live = false
    this.emit('exit', code)
  }
}
globalThis.__lesson59host = {
  utilityProcess: {
    fork(filename, args, options) {
      if (forkError) throw forkError
      return new UtilityChild(filename, args, options)
    }
  },
  spawn() {
    throw new Error('Importing the terminal host must never spawn a native PTY')
  },
  setTimeout(callback, milliseconds) {
    const id = ++timerSerial
    timers.set(id, { id, callback, at: now + milliseconds })
    return { id, unref: () => undefined }
  },
  clearTimeout(timer) {
    timers.delete(timer?.id)
  }
}
const outfile = path.join(evidence, 'terminal-host-current-source.cjs')
const compiled = await build({
  absWorkingDir: root,
  stdin: {
    contents:
      'export * from "./src/main/terminal/terminal-process.ts"; export * from "./src/main/terminal/terminal-host.ts";',
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'silent',
  define: {
    setTimeout: 'globalThis.__lesson59host.setTimeout',
    clearTimeout: 'globalThis.__lesson59host.clearTimeout'
  },
  plugins: [
    {
      name: 'terminal-independent-host-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|node-pty)$/ }, ({ path: name }) => ({
          path: name,
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
          contents: `export const { ${name === 'electron' ? 'utilityProcess' : 'spawn'} } = globalThis.__lesson59host;`,
          loader: 'js'
        }))
      }
    }
  ]
})
const inputs = Object.keys(compiled.metafile.inputs).filter(
  (file) => file !== '<stdin>' && !file.startsWith('fixture:')
)
const sourceHashes = Object.fromEntries(
  await Promise.all(
    inputs.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
await fs.writeFile(path.join(evidence, 'metafile.json'), JSON.stringify(compiled.metafile, null, 2))
const api = createRequire(import.meta.url)(outfile)
const suite = checksFor(evidence, {
  ordinaryNode: true,
  realCurrentServiceAndHelperSource: true,
  syntheticElectronUtilityProcess: true,
  syntheticPty: true,
  virtualClock: true,
  nativePty: false,
  actualUtilityProcess: false,
  actualDebuggerWorkerGate: false,
  realTransport: false,
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile))
})
async function check(name, action) {
  await suite.check(name, async () => {
    const previous = children.length
    try {
      return await action()
    } finally {
      forkError = undefined
      for (const child of children.slice(previous)) child.exit(1)
      await advance(20000)
      assert.equal(timers.size, 0, 'Every owned service deadline must become settled')
    }
  })
}
const shell = { program: path.join(evidence, 'synthetic-powershell.exe'), args: ['-NoProfile'] }
const size = { cols: 80, rows: 24 }
function create({ spawn = true, ready = true } = {}) {
  const id = 'host-' + ++sessionSerial
  const process = api.createTerminalProcess(id, shell, evidence, size)
  const child = children.at(-1)
  const readyState = observe(process.ready)
  const exits = []
  const data = []
  process.onExit((event) => exits.push(event))
  process.onData((value) => data.push(value))
  if (spawn) child.emit('spawn')
  if (ready) child.message({ type: 'ready', sessionId: id })
  return { id, process, child, readyState, exits, data }
}
function reply(target, sequence, result = { ok: true }) {
  target.child.message({ type: 'result', sessionId: target.id, sequence, result })
}
function nativeExit(target, exitCode = 0) {
  target.child.message({ type: 'exit', sessionId: target.id, exitCode })
}

await check(
  'import and dependency closure have no Agent, authority, storage or native startup effects',
  async () => {
    assert.equal(children.length, 0)
    assert(
      !inputs.some((file) =>
        /(?:agent|model|execution|checkpoint|conversation|workspace-access)/.test(file)
      )
    )
    assert.deepEqual(Object.keys(api).sort(), [
      'createTerminalProcess',
      'installTerminalHost',
      'terminalHostEnvironment'
    ])
  }
)

await check(
  'debugger environment is removed case-insensitively without mutating parent or ordinary shell variables',
  async () => {
    const original = {
      NODE_OPTIONS: '--require private-debugger.js',
      vscode_inspector_options: '{"waitForDebugger":true}',
      Electron_Run_As_Node: '1',
      V8_INSPECTOR_PORT: '9229',
      v8_inspector_brk_port: '9230',
      Path: 'synthetic-path',
      SYSTEMROOT: 'synthetic-root',
      ZONECODEX_HOST_TEST: 'retained'
    }
    const before = { ...original }
    assert.deepEqual(api.terminalHostEnvironment(original), {
      Path: 'synthetic-path',
      SYSTEMROOT: 'synthetic-root',
      ZONECODEX_HOST_TEST: 'retained'
    })
    assert.deepEqual(original, before)
    const target = create({ spawn: false, ready: false })
    assert.deepEqual(target.child.options.execArgv, [])
    assert.equal(target.child.options.serviceName, 'ZoneCodex Terminal')
    assert.equal(target.child.options.cwd, evidence)
    assert.equal(target.child.options.stdio, 'pipe')
    assert.notEqual(target.child.options.env, process.env)
    assert(
      !Object.keys(target.child.options.env).some((key) =>
        /^(NODE_OPTIONS|VSCODE_INSPECTOR_OPTIONS|ELECTRON_RUN_AS_NODE|V8_INSPECTOR_(?:BRK_)?PORT)$/i.test(
          key
        )
      )
    )
  }
)

await check(
  'start returns immediately, stays pending for readiness and leaves another main callback runnable',
  async () => {
    const target = create({ ready: false })
    let independentMainCallback = 0
    await Promise.resolve().then(() => independentMainCallback++)
    assert.equal(independentMainCallback, 1)
    assert.equal(target.readyState.settled, false)
    assert.deepEqual(target.child.posts, [
      { type: 'init', sessionId: target.id, ...shell, cwd: evidence, size }
    ])
    target.child.message({ type: 'ready', sessionId: target.id })
    await target.process.ready
  }
)

await check(
  'non-ready input and resize never enter helper; close before spawn queues only after init',
  async () => {
    const target = create({ spawn: false, ready: false })
    await assert.rejects(target.process.write('echo harmless\r'), /尚未就绪/)
    await assert.rejects(target.process.resize(90, 30), /尚未就绪/)
    const close = observe(target.process.kill())
    assert.deepEqual(target.child.posts, [])
    target.child.emit('spawn')
    assert.deepEqual(
      target.child.posts.map((entry) => entry.type),
      ['init', 'close']
    )
    reply(target, target.child.posts.at(-1).sequence)
    await flush()
    assert(close.settled && !close.error)
    assert.deepEqual(target.exits, [])
    nativeExit(target)
    assert.deepEqual(target.exits, [])
    target.child.exit()
    assert.deepEqual(target.exits, [{ exitCode: 0 }])
  }
)

await check(
  'startup timeout requests host kill but retains exit ownership until actual utility exit',
  async () => {
    const target = create({ ready: false })
    await advance(7999)
    assert.equal(target.readyState.settled, false)
    await advance(1)
    assert.match(target.readyState.error.message, /启动超时/)
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(target.exits, [])
    target.child.message({ type: 'ready', sessionId: target.id })
    await assert.rejects(target.process.write('never written'), /尚未就绪/)
    assert.deepEqual(target.exits, [])
    target.child.exit(9)
    assert.match(target.exits[0].error, /启动超时/)
  }
)

await check(
  'a spawn arriving after startup timeout cannot resurrect init or native PTY work',
  async () => {
    const target = create({ spawn: false, ready: false })
    target.child.killReturn = false
    await advance(8000)
    assert.match(target.readyState.error.message, /启动超时/)
    assert.equal(target.child.killCalls, 1)
    target.child.emit('spawn')
    assert.deepEqual(target.child.posts, [])
    assert.equal(target.child.killCalls, 2)
    assert.deepEqual(target.exits, [])
    target.child.exit(1)
    assert.match(target.exits[0].error, /启动超时/)
  }
)

await check(
  'wrong owner, unsolicited, duplicate and expired replies cannot acknowledge another command',
  async () => {
    const target = create()
    await target.process.ready
    const first = observe(target.process.write('first\r'))
    const sequence = target.child.posts.at(-1).sequence
    target.child.message({
      type: 'result',
      sessionId: 'foreign-host',
      sequence,
      result: { ok: true }
    })
    reply(target, sequence + 100)
    reply(target, '1')
    await flush()
    assert.equal(first.settled, false)
    reply(target, sequence)
    await flush()
    assert(first.settled && !first.error)
    const second = observe(target.process.resize(100, 40))
    const next = target.child.posts.at(-1).sequence
    reply(target, sequence)
    await flush()
    assert.equal(second.settled, false)
    reply(target, next, { ok: false, error: 'X'.repeat(10000) })
    await flush()
    assert.equal(second.error.message.length, 300)
  }
)

await check(
  'command timeout settles only its request; late reply cannot settle a newer sequence',
  async () => {
    const target = create()
    const first = observe(target.process.write('timed out\r'))
    const sequence = target.child.posts.at(-1).sequence
    await advance(4999)
    assert.equal(first.settled, false)
    await advance(1)
    assert.match(first.error.message, /通信超时/)
    const second = observe(target.process.write('current\r'))
    const next = target.child.posts.at(-1).sequence
    reply(target, sequence)
    await flush()
    assert.equal(second.settled, false)
    reply(target, next)
    await flush()
    assert(second.settled && !second.error)
  }
)

await check(
  'pending command capacity remains bounded and recovers after an acknowledged request',
  async () => {
    const target = create()
    const pending = Array.from({ length: 32 }, () => observe(target.process.write('bounded\r')))
    const first = target.child.posts.find((entry) => entry.type === 'write')
    await assert.rejects(target.process.resize(90, 30), /通信忙/)
    reply(target, first.sequence)
    await flush()
    assert(pending[0].settled && !pending[0].error)
    const replacement = observe(target.process.resize(90, 30))
    reply(target, target.child.posts.at(-1).sequence)
    await flush()
    assert(replacement.settled && !replacement.error)
  }
)

await check(
  'close bypasses a full write queue once, shares its promise and still waits for actual utility exit',
  async () => {
    const target = create()
    const pending = Array.from({ length: 32 }, () =>
      observe(target.process.write('saturated input\r'))
    )
    await assert.rejects(target.process.write('overflow input\r'), /通信忙/)
    const request = target.process.kill()
    const close = observe(request)
    for (let duplicate = 0; duplicate < 64; duplicate++)
      assert.equal(target.process.kill(), request)
    const closeMessages = target.child.posts.filter((entry) => entry.type === 'close')
    assert.equal(closeMessages.length, 1)
    assert.equal(target.child.posts.filter((entry) => entry.type === 'write').length, 32)
    await assert.rejects(target.process.resize(90, 30), /正在关闭/)
    reply(target, closeMessages[0].sequence)
    await flush()
    assert(close.settled && !close.error)
    assert(pending.every((state) => !state.settled))
    assert.deepEqual(target.exits, [])
    nativeExit(target)
    assert.deepEqual(target.exits, [])
    target.child.exit()
    await flush()
    assert(pending.every((state) => state.settled && /已退出/.test(state.error.message)))
    assert.deepEqual(target.exits, [{ exitCode: 0 }])
  }
)

await check(
  'malformed result and postMessage failures reject bounded errors and do not corrupt future requests',
  async () => {
    const target = create()
    const malformed = observe(target.process.write('one\r'))
    reply(target, target.child.posts.at(-1).sequence, { ok: false })
    await flush()
    assert.match(malformed.error.message, /格式不正确/)
    target.child.postError = new Error('Y'.repeat(10000))
    await assert.rejects(target.process.write('two\r'), (error) => error.message.length === 300)
    target.child.postError = null
    const recovery = observe(target.process.write('three\r'))
    reply(target, target.child.posts.at(-1).sequence)
    await flush()
    assert(recovery.settled && !recovery.error)
  }
)

await check(
  'close shares pending request, rejects new input and requires actual child exit after native acknowledgment',
  async () => {
    const target = create()
    const first = target.process.kill()
    assert.equal(target.process.kill(), first)
    await assert.rejects(target.process.write('blocked\r'), /正在关闭/)
    await assert.rejects(target.process.resize(90, 30), /正在关闭/)
    assert.equal(target.child.posts.filter((entry) => entry.type === 'close').length, 1)
    reply(target, target.child.posts.at(-1).sequence)
    await first
    assert.deepEqual(target.exits, [])
    nativeExit(target, 7)
    assert.deepEqual(target.exits, [])
    target.child.exit(0)
    assert.deepEqual(target.exits, [{ exitCode: 7 }])
    await target.process.kill()
  }
)

await check(
  'native close failure permits a fresh sequence retry; old failed reply cannot complete retry',
  async () => {
    const target = create()
    const first = observe(target.process.kill())
    const old = target.child.posts.at(-1).sequence
    reply(target, old, { ok: false, error: 'native cleanup failed' })
    await flush()
    assert.match(first.error.message, /native cleanup failed/)
    assert.deepEqual(target.exits, [])
    const second = observe(target.process.kill())
    const current = target.child.posts.at(-1).sequence
    assert(current > old)
    reply(target, old)
    await flush()
    assert.equal(second.settled, false)
    reply(target, current)
    await flush()
    assert(second.settled && !second.error)
    nativeExit(target)
    target.child.exit()
    assert.deepEqual(target.exits, [{ exitCode: 0 }])
  }
)

await check(
  'repeated failed native closes share one host deadline and actual exit clears it immediately',
  async () => {
    const target = create()
    for (let retry = 0; retry < 20; retry++) {
      const close = observe(target.process.kill())
      reply(target, target.child.posts.at(-1).sequence, {
        ok: false,
        error: 'retryable native close failure'
      })
      await flush()
      assert.match(close.error.message, /retryable native close failure/)
      assert.equal(timers.size, 1, 'A close retry must reuse the original external deadline')
    }
    assert.equal(target.child.killCalls, 0)
    nativeExit(target)
    target.child.exit()
    assert.equal(timers.size, 0, 'Actual utility exit must immediately clear all owned deadlines')
    assert.deepEqual(target.exits, [{ exitCode: 0 }])
  }
)

await check(
  'close deadline and successful kill return cannot masquerade as confirmed utility exit',
  async () => {
    const target = create()
    const close = observe(target.process.kill())
    await advance(11999)
    assert.equal(target.child.killCalls, 0)
    assert.equal(close.settled, false)
    await advance(1)
    assert.equal(target.child.killCalls, 1)
    assert(close.error)
    assert.deepEqual(target.exits, [])
    target.child.exit(1)
    assert.match(target.exits[0].error, /关闭超时/)
  }
)

await check(
  'host kill false or exception retains ownership and communicates cleanup uncertainty',
  async () => {
    for (const mode of ['false', 'throw']) {
      const target = create({ ready: false })
      if (mode === 'false') target.child.killReturn = false
      else target.child.killError = new Error('synthetic termination failure')
      await advance(8000)
      assert.equal(target.child.killCalls, 1)
      assert.deepEqual(target.exits, [])
      target.child.exit(3)
      assert.match(target.exits[0].error, /启动超时/)
    }
  }
)

await check(
  'unexpected host exit rejects pending commands once and marks native cleanup unconfirmed',
  async () => {
    const target = create()
    const pending = observe(target.process.write('pending\r'))
    target.child.exit(23)
    await flush()
    assert.match(pending.error.message, /清理未确认/)
    assert.deepEqual(target.exits, [{ exitCode: 23, error: '终端宿主退出，PTY清理未确认' }])
    target.child.emit('exit', 0)
    target.child.message({ type: 'ready', sessionId: target.id })
    target.child.message({ type: 'data', sessionId: target.id, data: 'late' })
    assert.equal(target.exits.length, 1)
    assert.deepEqual(target.data, [])
    await assert.rejects(target.process.write('after exit'), /已退出/)
  }
)

await check(
  'main sends a retirement receipt only for its native exit message and receipt does not emit utility exit',
  async () => {
    const target = create()
    target.child.message({ type: 'exit', sessionId: 'foreign-host', exitCode: 0 })
    assert.equal(target.child.posts.filter((message) => message.type === 'retire').length, 0)
    nativeExit(target, 4)
    assert.deepEqual(target.child.posts.at(-1), { type: 'retire', sessionId: target.id })
    assert.deepEqual(target.exits, [])
    target.child.exit()
    assert.deepEqual(target.exits, [{ exitCode: 4 }])
  }
)

await check(
  'retirement receipt send failure requests termination and preserves actual-exit ownership',
  async () => {
    const target = create()
    target.child.postError = new Error('retirement receipt unavailable')
    nativeExit(target)
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(target.exits, [])
    target.child.exit(1)
    assert.match(target.exits[0].error, /retirement receipt unavailable/)
  }
)

await check(
  'a nonzero utility retirement cannot be reported as success merely because native cleanup was received',
  async () => {
    const target = create()
    nativeExit(target, 8)
    assert.deepEqual(target.child.posts.at(-1), { type: 'retire', sessionId: target.id })
    target.child.exit(1)
    assert.equal(target.exits[0].exitCode, 8)
    assert(
      target.exits[0].error,
      'Missing receipt or failed utility retirement must remain a failure'
    )
  }
)

await check(
  'host fatal error rejects readiness, preserves ownership and applies an external cleanup deadline',
  async () => {
    const target = create({ ready: false })
    target.child.emit('error', 'FatalError', 'synthetic', 'Z'.repeat(10000))
    await flush()
    assert(target.readyState.error.message.length < 300)
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(target.exits, [])
    target.child.exit(1)
    assert(target.exits[0].error)
  }
)

await check(
  'helper-reported error keeps its handle alive until native cleanup or the external host deadline',
  async () => {
    const target = create({ ready: false })
    target.child.message({ type: 'error', sessionId: target.id, error: 'listener failed' })
    await flush()
    assert.match(target.readyState.error.message, /listener failed/)
    target.child.message({ type: 'ready', sessionId: target.id })
    target.child.message({ type: 'data', sessionId: target.id, data: 'after failed startup' })
    assert.deepEqual(target.data, [])
    await advance(11999)
    assert.equal(target.child.killCalls, 0)
    await advance(1)
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(target.exits, [])
    target.child.exit(1)
    assert.match(target.exits[0].error, /listener failed/)
  }
)

await check(
  'stdout is drained, stderr logging is bounded and subscriptions can detach without touching a new host',
  async () => {
    const target = create()
    const data = []
    const disposable = target.process.onData((value) => data.push(value))
    assert.equal(target.child.stdout.listenerCount('data'), 1)
    assert.equal(target.child.stderr.listenerCount('data'), 1)
    const log = console.error
    const messages = []
    try {
      console.error = (...args) => messages.push(args.join(' '))
      target.child.stdout.emit('data', Buffer.alloc(10000))
      target.child.stderr.emit('data', Buffer.alloc(10000, 65))
      target.child.stderr.emit('data', Buffer.alloc(10000, 66))
    } finally {
      console.error = log
    }
    assert.equal(messages.length, 1)
    assert(messages[0].length < 4200)
    target.child.message({ type: 'data', sessionId: target.id, data: 'owner output' })
    disposable.dispose()
    target.child.message({ type: 'data', sessionId: target.id, data: 'detached output' })
    assert.deepEqual(data, ['owner output'])
    nativeExit(target)
    target.child.exit()
    const current = create()
    target.child.message({ type: 'data', sessionId: current.id, data: 'retired child' })
    assert.deepEqual(current.data, [])
  }
)

await check('synchronous fork failure leaves no owned child or timeout behind', async () => {
  const previous = children.length
  forkError = new Error('synthetic fork failure')
  assert.throws(() => api.createTerminalProcess('fork-fail', shell, evidence, size), /fork failure/)
  assert.equal(children.length, previous)
  assert.equal(timers.size, 0)
})

class NativeChild {
  constructor(options = {}) {
    Object.assign(
      this,
      {
        live: true,
        writes: [],
        sizes: [],
        dataListeners: [],
        exitListeners: [],
        disposals: 0,
        killCalls: 0
      },
      options
    )
  }
  subscription(list, listener) {
    list.push(listener)
    let disposed = false
    return {
      dispose: () => {
        assert(!disposed, 'Native subscriptions must be disposed exactly once')
        disposed = true
        this.disposals++
        list.splice(list.indexOf(listener), 1)
      }
    }
  }
  onExit(listener) {
    if (this.exitErrors > 0) {
      this.exitErrors--
      throw new Error('synthetic onExit failure')
    }
    const subscription = this.subscription(this.exitListeners, listener)
    if (this.exitDuringSubscribe) this.exit(7)
    return subscription
  }
  onData(listener) {
    if (this.dataError) throw this.dataError
    return this.subscription(this.dataListeners, listener)
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
    this.killCalls++
    if (this.killError) throw this.killError
    if (this.syncKill) this.exit(0)
  }
  data(value) {
    for (const listener of [...this.dataListeners]) listener(value)
  }
  exit(exitCode = 0) {
    if (!this.live) return
    this.live = false
    for (const listener of [...this.exitListeners]) listener({ exitCode })
  }
}
function helper(options = {}) {
  const port = new EventEmitter()
  port.posts = []
  port.postMessage = (message) => {
    if (port.failType === message.type) throw new Error('synthetic port failure')
    port.posts.push(message)
  }
  const target = { id: 'helper-' + ++sessionSerial, port, spawns: [], exits: [] }
  target.send = (value) => port.emit('message', { data: value })
  target.retire = (id = target.id) => target.send({ type: 'retire', sessionId: id })
  target.request = (type, sequence, fields = {}) =>
    target.send({ type, sessionId: target.id, sequence, ...fields })
  target.init = (fields = {}) =>
    target.send({ type: 'init', sessionId: target.id, ...shell, cwd: evidence, size, ...fields })
  api.installTerminalHost(
    port,
    {
      spawn(program, args, parameters) {
        if (options.spawnError) throw options.spawnError
        target.child = new NativeChild(options)
        target.spawns.push({ program, args, options: parameters })
        return target.child
      }
    },
    (code) => target.exits.push(code)
  )
  return target
}
const results = (target) => target.port.posts.filter((message) => message.type === 'result')

await check(
  'helper validates init and creates exactly one PTY using frozen dimensions and supplied home cwd',
  async () => {
    const target = helper()
    for (const malformed of [
      { program: 'relative.exe' },
      { program: shell.program + '\0' },
      { cwd: 'relative-directory' },
      { args: Array(17).fill('arg') },
      { args: ['\0'] },
      { size: { cols: 501, rows: 24 } }
    ])
      target.init(malformed)
    assert.deepEqual(target.spawns, [])
    target.init()
    target.init()
    assert.equal(target.spawns.length, 1)
    assert.equal(target.spawns[0].options.cwd, evidence)
    assert.equal(target.spawns[0].options.cols, 80)
    assert.equal(target.spawns[0].options.rows, 24)
    assert.deepEqual(
      target.port.posts.map((message) => message.type),
      ['ready']
    )
  }
)

await check(
  'helper preserves input bounds, Ctrl+C, dimensions and monotonic sequence rejection',
  async () => {
    const target = helper()
    target.init()
    target.request('write', 1, { data: ' \r\n\u0003' })
    target.request('write', 1, { data: 'replayed command' })
    target.request('write', 2, { data: 'X'.repeat(8193) })
    target.request('resize', 3, { size: { cols: 501, rows: 24 } })
    target.request('resize', 4, { size: { cols: 500, rows: 300 } })
    target.send({ type: 'write', sessionId: 'foreign-owner', sequence: 5, data: 'foreign command' })
    assert.deepEqual(target.child.writes, [' \r\n\u0003'])
    assert.deepEqual(target.child.sizes, [{ cols: 500, rows: 300 }])
    assert.equal(results(target).filter((message) => !message.result.ok).length, 3)
  }
)

await check(
  'helper close acknowledgment waits for native exit, suppresses closing output and disposes listeners once',
  async () => {
    const target = helper()
    target.init()
    target.child.data('before close')
    target.request('close', 1)
    target.request('close', 2)
    target.child.data('after close')
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(results(target), [])
    assert.deepEqual(target.exits, [])
    target.child.exit(5)
    assert.deepEqual(
      results(target).map((message) => [message.sequence, message.result]),
      [
        [1, { ok: true }],
        [2, { ok: true }]
      ]
    )
    assert.deepEqual(
      target.port.posts.filter((message) => message.type === 'data').map((message) => message.data),
      ['before close']
    )
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.disposals, 2)
    target.request('close', 3)
    target.child.exit()
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper natural exit retains shell exit code and exits only after disposing owned native listeners',
  async () => {
    const target = helper()
    target.init()
    target.child.exit(17)
    assert.deepEqual(target.port.posts.at(-1), { type: 'exit', sessionId: target.id, exitCode: 17 })
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.disposals, 2)
    assert.equal(target.child.killCalls, 0)
  }
)

await check(
  'helper startup native exception reports bounded failure and exits with no fabricated ready or cleanup',
  async () => {
    const target = helper({ spawnError: new Error('X'.repeat(10000)) })
    target.init()
    assert.deepEqual(target.exits, [1])
    assert.deepEqual(
      target.port.posts.map((message) => message.type),
      ['error']
    )
    assert.equal(target.port.posts[0].error.length, 300)
  }
)

await check(
  'helper onData startup failure retains native handle and waits for real cleanup exit',
  async () => {
    const target = helper({ dataError: new Error('synthetic onData failure') })
    target.init()
    assert.equal(target.child.killCalls, 1)
    assert(target.child.live)
    assert.deepEqual(target.exits, [])
    assert.deepEqual(
      target.port.posts.map((message) => message.type),
      ['error']
    )
    target.child.exit()
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.disposals, 1)
  }
)

await check(
  'helper failed exit subscription retries safely and native kill failure allows explicit close retry',
  async () => {
    const target = helper({ exitErrors: 2, killError: new Error('native kill failed') })
    target.init()
    assert(target.child.live)
    assert.deepEqual(target.exits, [])
    target.child.killError = null
    target.request('close', 1)
    assert.equal(target.child.exitListeners.length, 1)
    assert.deepEqual(results(target), [])
    target.child.exit()
    assert.deepEqual(
      results(target).map((message) => message.result),
      [{ ok: true }]
    )
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper close kill exception answers failure, retains handle and accepts fresh retry',
  async () => {
    const target = helper({ killError: new Error('X'.repeat(10000)) })
    target.init()
    target.request('close', 1)
    assert.equal(results(target)[0].result.error.length, 300)
    assert(target.child.live)
    assert.deepEqual(target.exits, [])
    target.child.killError = null
    target.request('close', 2)
    assert.equal(target.child.killCalls, 2)
    target.child.exit()
    assert.deepEqual(results(target).at(-1).result, { ok: true })
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper handles native exit during listener registration without ready, leak or duplicate cleanup',
  async () => {
    const target = helper({ exitDuringSubscribe: true })
    target.init()
    assert.deepEqual(
      target.port.posts.map((message) => message.type),
      ['exit']
    )
    assert.equal(target.child.disposals, 1)
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.killCalls, 0)
  }
)

await check(
  'helper failed output delivery invokes native cleanup and cannot exit merely because kill returned',
  async () => {
    const target = helper()
    target.init()
    target.port.failType = 'data'
    target.child.data('failed delivery')
    assert.equal(target.child.killCalls, 1)
    assert.deepEqual(target.exits, [])
    target.port.failType = null
    target.child.exit()
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper write and resize errors preserve the owned PTY and bounded independent close',
  async () => {
    const target = helper({
      writeError: new Error('write failed'),
      resizeError: new Error('resize failed'),
      syncKill: true
    })
    target.init()
    target.request('write', 1, { data: 'harmless' })
    target.request('resize', 2, { size })
    assert.deepEqual(
      results(target).map((message) => message.result.error),
      ['write failed', 'resize failed']
    )
    assert(target.child.live)
    target.request('close', 3)
    assert.deepEqual(results(target).at(-1).result, { ok: true })
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper retirement accepts only matching receipts after native exit and retains a bounded waiting period',
  async () => {
    const target = helper()
    target.init()
    target.retire()
    target.retire('foreign-helper')
    assert(target.child.live)
    assert.deepEqual(target.exits, [])
    assert.equal(target.child.killCalls, 0)
    target.child.exit(6)
    target.retire('foreign-helper')
    assert.deepEqual(target.exits, [])
    assert.equal(timers.size, 1)
    await advance(4999)
    assert.deepEqual(target.exits, [])
    target.retire()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.disposals, 2)
    assert.equal(timers.size, 0)
    target.retire()
    await advance(1)
    assert.deepEqual(target.exits, [0])
  }
)

await check(
  'helper exits unsuccessfully after five seconds without retirement receipt and clears its owned deadline',
  async () => {
    const target = helper()
    target.init()
    target.child.exit()
    assert.deepEqual(target.exits, [])
    await advance(4999)
    assert.deepEqual(target.exits, [])
    await advance(1)
    assert.deepEqual(target.exits, [1])
    assert.equal(target.child.disposals, 2)
    assert.equal(timers.size, 0)
    target.retire()
    assert.deepEqual(target.exits, [1])
  }
)

await check(
  'failed native exit delivery ends the helper with failure and never fabricates a successful retirement',
  async () => {
    const target = helper()
    target.init()
    target.port.failType = 'exit'
    target.child.exit()
    assert.deepEqual(target.exits, [1])
    assert.equal(target.child.disposals, 2)
    assert.equal(timers.size, 0)
    target.retire()
    assert.deepEqual(target.exits, [1])
  }
)

await check(
  'an immediate retirement receipt during native exit registration cannot leave an orphan deadline',
  async () => {
    const target = helper({ exitDuringSubscribe: true })
    const post = target.port.postMessage
    target.port.postMessage = (message) => {
      post(message)
      if (message.type === 'exit') target.retire()
    }
    target.init()
    assert.deepEqual(target.exits, [0])
    assert.equal(target.child.disposals, 1)
    assert.equal(timers.size, 0)
  }
)

await suite.finish({ utilityChildren: children.length, remainingDeadlines: timers.size })
delete globalThis.__lesson59host
