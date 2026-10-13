import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('process')
const children = []
const waiting = []
const spawns = []
const tick = () => new Promise((resolve) => setImmediate(resolve))
globalThis.__lesson61process = {
  spawn(executable, args, options) {
    const child = waiting.shift()
    assert(child, 'Unexpected process launch outside controlled fixture')
    spawns.push({ executable, args, options, pid: child.pid })
    return child
  }
}
const outfile = path.join(evidence, 'current-process.cjs')
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['src/main/git/git-process.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'controlled-child-process-only',
      setup(builder) {
        builder.onResolve({ filter: /^node:child_process$/ }, () => ({
          path: 'child-process',
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const {spawn}=globalThis.__lesson61process;',
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(bundle.metafile.inputs)
      .filter((file) => !file.startsWith('fixture:'))
      .map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
await fs.writeFile(path.join(evidence, 'metafile.json'), JSON.stringify(bundle.metafile, null, 2))
const api = createRequire(import.meta.url)(outfile)
const suite = checksFor(evidence, {
  actualCurrentGitProcessRunner: true,
  syntheticChildProcess: true,
  realTimers: true,
  realChildProcesses: false,
  actualElectron: false,
  nativeGit: false,
  realTransport: false,
  realModel: false,
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile))
})
const base = {
  executable: path.join(evidence, 'synthetic-git.exe'),
  args: ['--no-optional-locks', 'status', '--porcelain=v2', '-z'],
  cwd: evidence,
  env: { SystemRoot: 'C:\\Windows', GIT_TERMINAL_PROMPT: '0' }
}
function mockChild({ killThrows = false, killResult = true } = {}) {
  const child = new EventEmitter()
  child.pid = 61000 + children.length
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = (input) => {
    child.input = input
  }
  child.killCalls = 0
  child.closed = false
  child.kill = () => {
    child.killCalls++
    if (killThrows) throw new Error('synthetic EPERM kill failure')
    return killResult
  }
  child.close = (code = 0) => {
    if (child.closed) return
    child.closed = true
    child.emit('close', code, null)
  }
  children.push(child)
  return child
}
function start(overrides = {}, childOptions = {}) {
  const child = mockChild(childOptions)
  const events = []
  waiting.push(child)
  let settled = false
  const task = api.runGitProcess({
    ...base,
    ...overrides,
    onProcess: overrides.onProcess ?? ((event) => events.push(event))
  })
  const result = task.then(
    (value) => {
      settled = true
      return { ok: true, value }
    },
    (error) => {
      settled = true
      return { ok: false, error }
    }
  )
  child.emit('spawn')
  return {
    child,
    result,
    events,
    get settled() {
      return settled
    }
  }
}
async function expectError(execution, status, pattern) {
  const outcome = await execution.result
  assert.equal(outcome.ok, false)
  assert(outcome.error instanceof api.GitReadError)
  assert.equal(outcome.error.status, status)
  assert.match(outcome.error.message, pattern)
  return outcome.error
}
async function check(name, action) {
  await suite.check(name, async () => {
    try {
      return await action()
    } finally {
      for (const child of children) child.close()
      await tick()
    }
  })
}

await check(
  'pre-aborted signal refuses process creation rather than issuing an unowned kill',
  async () => {
    const controller = new AbortController()
    controller.abort()
    const before = spawns.length
    await assert.rejects(
      api.runGitProcess({ ...base, signal: controller.signal }),
      (error) => error instanceof api.GitReadError && error.status === 'cancelled'
    )
    assert.equal(spawns.length, before)
  }
)

await check(
  'runner fixes shell false hidden window and pipe streams and resolves only on actual close',
  async () => {
    const input = Buffer.from('scope/a b.txt\0')
    const execution = start({ input })
    const spawn = spawns.at(-1)
    assert.equal(spawn.executable, base.executable)
    assert.deepEqual(spawn.args, base.args)
    assert.deepEqual(spawn.options, {
      cwd: base.cwd,
      env: base.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    assert.equal(execution.child.input, input)
    execution.child.stdout.emit('data', Buffer.from('first\0'))
    execution.child.stdout.emit('data', Buffer.from('second\0'))
    await tick()
    assert(!execution.settled)
    execution.child.close()
    const outcome = await execution.result
    assert.equal(outcome.ok, true)
    assert(outcome.value.equals(Buffer.from('first\0second\0')))
    assert.deepEqual(
      execution.events.map(({ event }) => event),
      ['spawn', 'close']
    )
  }
)

await check(
  'successful kill request and false kill return both remain pending until owned actual close',
  async () => {
    for (const killResult of [true, false]) {
      const controller = new AbortController()
      const execution = start({ signal: controller.signal }, { killResult })
      controller.abort()
      await tick()
      assert.equal(execution.child.killCalls, 1)
      assert(!execution.settled)
      assert.deepEqual(
        execution.events.map(({ event }) => event),
        ['spawn']
      )
      execution.child.close(null)
      await expectError(execution, 'cancelled', /已取消/)
      assert.deepEqual(
        execution.events.map(({ event }) => event),
        ['spawn', 'close']
      )
    }
  }
)

await check(
  'kill throwing cannot escape abort callback or falsely settle before actual close',
  async () => {
    const controller = new AbortController()
    const execution = start({ signal: controller.signal }, { killThrows: true })
    assert.doesNotThrow(() => controller.abort())
    await tick()
    assert.equal(execution.child.killCalls, 1)
    assert(!execution.settled)
    execution.child.close(null)
    await expectError(execution, 'error', /终止请求失败.*实际退出确认/)
    assert.deepEqual(
      execution.events.map(({ event }) => event),
      ['spawn', 'close']
    )
  }
)

await check(
  'kill throwing still reaches explicit two-second unconfirmed outcome and late close cannot turn it into success',
  async () => {
    const controller = new AbortController()
    const execution = start({ signal: controller.signal }, { killThrows: true })
    const started = Date.now()
    controller.abort()
    await tick()
    assert(!execution.settled)
    const error = await expectError(execution, 'error', /退出未确认.*保留查询缓存/)
    const elapsedMs = Date.now() - started
    assert(elapsedMs >= 1800 && elapsedMs < 8000, 'unconfirmed timer elapsed: ' + elapsedMs)
    assert.equal(execution.child.closed, false)
    assert.deepEqual(
      execution.events.map(({ event }) => event),
      ['spawn', 'unconfirmed']
    )
    execution.child.close()
    const late = await execution.result
    assert.equal(late.ok, false)
    assert.equal(late.error, error)
    assert.deepEqual(
      execution.events.map(({ event }) => event),
      ['spawn', 'unconfirmed', 'close']
    )
    return { elapsedMs, closeBeforeUnconfirmed: false, terminationRequested: true }
  }
)

await check(
  'stdout and stderr overflow request termination and reject after actual close without accepting partial content',
  async () => {
    for (const stream of ['stdout', 'stderr']) {
      const execution = start({ stdoutBytes: 4, stderrBytes: 4 })
      execution.child[stream].emit('data', Buffer.from('1234'))
      assert.equal(execution.child.killCalls, 0)
      execution.child[stream].emit('data', Buffer.from('5'))
      assert.equal(execution.child.killCalls, 1)
      await tick()
      assert(!execution.settled)
      execution.child.close()
      await expectError(execution, 'too-large', /超过.*上限/)
    }
  }
)

await check(
  'deadline requests termination but still requires close and clears its owned timer afterward',
  async () => {
    const execution = start({ timeoutMs: 25 })
    while (!execution.child.killCalls) await new Promise((resolve) => setTimeout(resolve, 5))
    assert(!execution.settled)
    execution.child.close()
    await expectError(execution, 'error', /读取超过.*已请求终止/)
    const kills = execution.child.killCalls
    await new Promise((resolve) => setTimeout(resolve, 35))
    assert.equal(execution.child.killCalls, kills)
    assert.deepEqual(
      execution.events.map(({ event }) => event),
      ['spawn', 'close']
    )
  }
)

await check(
  'spawn failure and early stdin failure remain explicit outcomes and never leak an uncaught stream error',
  async () => {
    const execution = start()
    execution.child.emit('error', new Error('synthetic executable missing'))
    assert.doesNotThrow(() => execution.child.stdin.emit('error', new Error('synthetic EPIPE')))
    await tick()
    assert(!execution.settled)
    execution.child.close(-1)
    await expectError(execution, 'unavailable', /程序不可用.*executable missing/)
  }
)

await check(
  'diagnostic callback failures are caught while actual close still settles an explicit error',
  async () => {
    const execution = start({
      onProcess() {
        throw new Error('synthetic diagnostic failure')
      }
    })
    await tick()
    assert(!execution.settled)
    assert.doesNotThrow(() => execution.child.close())
    await expectError(execution, 'error', /诊断回调失败/)
  }
)

await check(
  'fixed accepted codes distinguish successful read from bounded sanitized error text',
  async () => {
    const accepted = start({ acceptedCodes: [0, 1] })
    accepted.child.close(1)
    assert.equal((await accepted.result).ok, true)
    const rejected = start()
    rejected.child.stderr.emit('data', Buffer.from('unsafe\u001b\u0001\n' + 'x'.repeat(700)))
    rejected.child.close(128)
    const error = await expectError(rejected, 'error', /^unsafe/)
    assert(error.message.length <= 600)
    assert(!/\p{Cc}/u.test(error.message))
  }
)

await suite.finish({
  syntheticSpawnCount: spawns.length,
  actualCloseMeaning:
    'Mock child close is emitted separately from kill/abort; no native process was spawned. The unconfirmed timeout is the current runner real timer.'
})
delete globalThis.__lesson61process
