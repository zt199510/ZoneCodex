import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import {
  createEvidence,
  checksFor,
  root,
  hash,
  runProcess,
  delay,
  assertOwnedPath
} from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('repositories-native-ipc')
const key = '__zonecodexRepositories_' + randomUUID().replaceAll('-', '')
const handlers = new Map(),
  windows = new Map(),
  modal = new Set(),
  owners = [],
  events = [],
  lifecycles = [],
  dialogs = []
const rendererEvents = new EventEmitter()
let nextWindow = 0,
  chooserReply = { canceled: true, filePaths: [] },
  lifecycleHold,
  host,
  api,
  ipcResponse,
  ipcCalls = []
const mock = {
  app: { getPath: () => evidence },
  BrowserWindow: { fromWebContents: (contents) => windows.get(contents) ?? null },
  ipcMain: {
    handle(channel, handler) {
      assert(!handlers.has(channel))
      handlers.set(channel, handler)
    }
  },
  dialog: {
    async showOpenDialog(window, options) {
      dialogs.push({ windowId: window.id, options })
      return await chooserReply
    }
  },
  ipcRenderer: {
    on: rendererEvents.on.bind(rendererEvents),
    removeListener: rendererEvents.removeListener.bind(rendererEvents),
    async invoke(channel, request) {
      ipcCalls.push({ channel, request })
      return ipcResponse
    }
  },
  observe: (event) => events.push({ ...event, atUTC: new Date().toISOString() })
}
globalThis[key] = mock
const readerShim = path.join(evidence, 'reader-observation.ts')
await fs.writeFile(
  readerShim,
  'import {createGitReader as actualReader} from ' +
    JSON.stringify(path.join(root, 'src/main/git/git-reader.ts')) +
    ';\n' +
    'export function createGitReader(options) { return actualReader({...options,onProcess:globalThis[' +
    JSON.stringify(key) +
    '].observe}); }\n'
)
const outfile = path.join(evidence, 'repositories-current.cjs')
const compiled = await build({
  stdin: {
    contents: [
      'export * from "./src/main/git/git-ipc.ts";',
      'export * from "./src/main/git/git-process.ts";',
      'export * from "./src/shared/git-repositories.ts";',
      'export * from "./src/shared/git-observation.ts";',
      'export * from "./src/preload/git-repositories-api.ts";',
      'export * from "./src/preload/git-observation-api.ts";'
    ].join('\n'),
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
      name: 'explicit-electron-seam-real-reader-observation',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents:
            'export const {app,BrowserWindow,ipcMain,dialog,ipcRenderer}=globalThis[' +
            JSON.stringify(key) +
            '];',
          loader: 'js'
        }))
        builder.onResolve({ filter: /^\.\/git-reader$/ }, ({ importer }) =>
          importer.replaceAll('\\', '/').endsWith('/git-ipc.ts') ? { path: readerShim } : null
        )
      }
    }
  ]
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(compiled.metafile.inputs)
      .filter((file) => file !== '<stdin>' && !file.startsWith('fixture:'))
      .map(async (file) => [file, hash(await fs.readFile(path.resolve(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
api = createRequire(import.meta.url)(outfile)
api.registerGitView(
  (id) => modal.has(id),
  (value) => {
    host = value
  }
)
host.registerViewLifecycle({
  async added(view, windowId) {
    lifecycles.push({ event: 'added', viewId: view.info.viewId, windowId })
    if (
      lifecycleHold?.phase === 'add' &&
      (!lifecycleHold.target || view.info.selectedPath === lifecycleHold.target)
    ) {
      lifecycleHold.started = true
      await lifecycleHold.promise
    }
  },
  async removed(view) {
    lifecycles.push({ event: 'removed', viewId: view.info.viewId })
    if (lifecycleHold?.phase === 'remove') {
      lifecycleHold.started = true
      await lifecycleHold.promise
    }
  }
})
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile)),
  actualCurrentGitIPC: true,
  actualIPCSourceGuard: true,
  actualGitReader: true,
  actualGitProcesses: true,
  actualDisk: true,
  actualElectron: false,
  actualNativeChooser: false,
  realNetworking: false,
  syntheticChooserReplies: true,
  syntheticLongOperationHolds: true,
  actualGitWriteOperation: false,
  note: 'Production multi-view host and actual Git reader/snapshot/disposal. Native dialogs, lifecycle scheduling and a non-writing manual operation are synthetic. Fixture setup writes only newly created UUID repositories.'
})
function owner() {
  const window = new EventEmitter(),
    contents = new EventEmitter()
  window.id = ++nextWindow
  window.destroyed = false
  window.isDestroyed = () => window.destroyed
  contents.mainFrame = { document: 1 }
  contents.destroyed = false
  contents.isDestroyed = () => contents.destroyed
  window.webContents = contents
  windows.set(contents, window)
  api.attachGitCleanup(window)
  const value = {
    window,
    event: { sender: contents, senderFrame: contents.mainFrame },
    navigate() {
      contents.mainFrame = { document: contents.mainFrame.document + 1 }
      contents.emit('did-start-navigation', {}, 'app://fixture/new', false, true)
      value.event = { sender: contents, senderFrame: contents.mainFrame }
    },
    close() {
      contents.emit('render-process-gone')
    }
  }
  owners.push(value)
  return value
}
const invoke = (channel, owner, value) => handlers.get(channel)(owner.event, value)
const collection = (owner) => invoke('git:repositories', owner, randomUUID())
async function add(owner, paths) {
  chooserReply = { canceled: false, filePaths: paths }
  const result = await invoke('git:add-repositories', owner, randomUUID())
  assert.equal(result.status, 'ready', JSON.stringify(result))
  assert(api.parseGitRepositoryCollectionResult(result))
  return result
}
function hold(phase) {
  let resolve
  const value = {
    phase,
    started: false,
    promise: new Promise((yes) => {
      resolve = yes
    }),
    release(reply) {
      resolve(reply)
    }
  }
  return value
}
async function until(test) {
  for (let count = 0; count < 400; count++) {
    if (test()) return
    await delay(5)
  }
  assert.fail('Controlled operation did not reach the expected boundary')
}
function observed(promise) {
  let settled = false
  return {
    promise: promise.finally(() => {
      settled = true
    }),
    get settled() {
      return settled
    }
  }
}
const git = await findFixtureGit(),
  preparation = [],
  env = { ...process.env }
for (const name of Object.keys(env))
  if (/^GIT_|^NODE_OPTIONS$|^MODEL_/i.test(name)) delete env[name]
const empty = assertOwnedPath(evidence, path.join(evidence, 'fixture-empty.config'))
await fs.writeFile(empty, '')
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1'
})
async function prepare(directory, args) {
  assertOwnedPath(evidence, directory)
  const result = await runProcess(
    git,
    [
      '--no-optional-locks',
      '-c',
      'core.hooksPath=' + path.join(evidence, 'no-hooks'),
      '-c',
      'user.name=Repositories Fixture',
      '-c',
      'user.email=repositories@example.invalid',
      ...args
    ],
    { cwd: directory, env },
    15000
  )
  preparation.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
async function fixture() {
  const directory = assertOwnedPath(evidence, path.join(evidence, 'fixture-' + randomUUID()))
  await fs.mkdir(directory)
  await prepare(directory, ['init', '--initial-branch=main'])
  for (let number = 1; number <= 9; number++) {
    await fs.mkdir(path.join(directory, 'scopes', String(number)), { recursive: true })
    await fs.writeFile(
      path.join(directory, 'scopes', String(number), 'file.txt'),
      'base ' + number + '\n'
    )
  }
  await prepare(directory, ['add', '--all'])
  await prepare(directory, ['commit', '-m', 'initial'])
  await fs.writeFile(path.join(directory, 'scopes', '1', 'file.txt'), 'dirty fixture\n')
  return directory
}
const a = await fixture(),
  b = await fixture(),
  linked = assertOwnedPath(evidence, path.join(evidence, 'linked-' + randomUUID()))
await prepare(a, ['worktree', 'add', '--detach', linked, 'HEAD'])
const baselines = {
  a: await diskIdentity(a),
  b: await diskIdentity(b),
  linked: await diskIdentity(linked)
}

await suite.check(
  'registration has explicit multi-repository routes and performs no Git reads until manual selection',
  () => {
    assert(handlers.has('git:repositories'))
    assert(handlers.has('git:add-repositories'))
    assert.equal(events.length, 0)
    assert.equal(dialogs.length, 0)
  }
)
await suite.check(
  'native UUID repositories can be added together, retain independent view ids and refresh each exact scope',
  async () => {
    const own = owner(),
      result = await add(own, [a, b])
    assert.equal(result.views.length, 2)
    assert.equal(result.addedViewIds.length, 2)
    assert.notEqual(result.views[0].viewId, result.views[1].viewId)
    assert(dialogs.at(-1).options.properties.includes('multiSelections'))
    for (const view of result.views) {
      const read = await invoke('git:list', own, { requestId: randomUUID(), viewId: view.viewId })
      assert.equal(read.status, 'ready')
      assert.equal(read.items.length, 1)
      assert.equal(
        host.currentView(own.event, view.viewId).info.repositoryPath,
        view.repositoryPath
      )
    }
    assert.equal((await collection(own)).views.length, 2)
  }
)
await suite.check(
  'overlapping root/subdirectory and duplicate paths are refused without evicting existing views; sibling scopes coexist',
  async () => {
    const own = owner(),
      first = await add(own, [path.join(a, 'scopes', '1')])
    const duplicate = await add(own, [path.join(a, 'scopes', '1'), a])
    assert.equal(duplicate.addedViewIds.length, 0)
    assert.equal(duplicate.warnings.length, 2)
    assert.deepEqual(
      duplicate.views.map((view) => view.viewId),
      first.views.map((view) => view.viewId)
    )
    const siblings = await add(own, [path.join(a, 'scopes', '2')])
    assert.equal(siblings.views.length, 2)
    const rootOwner = owner()
    await add(rootOwner, [a])
    assert.equal((await add(rootOwner, [path.join(a, 'scopes', '3')])).addedViewIds.length, 0)
  }
)
await suite.check(
  'a linked worktree is a distinct view while retaining its verified common repository identity',
  async () => {
    const own = owner(),
      result = await add(own, [a, linked])
    assert.equal(result.views.length, 2)
    assert.equal(result.views.filter((view) => view.linkedWorktree).length, 1)
    const actual = result.views.map((view) => host.currentView(own.event, view.viewId))
    assert.equal(actual[0].location.common.toLowerCase(), actual[1].location.common.toLowerCase())
    assert.notEqual(actual[0].location.repositoryPath, actual[1].location.repositoryPath)
  }
)
await suite.check(
  'bad selections produce bounded warnings alongside valid views, with an exact per-window capacity',
  async () => {
    const own = owner(),
      invalid = assertOwnedPath(evidence, path.join(evidence, 'not-a-repository'))
    await fs.mkdir(invalid)
    await fs.writeFile(
      path.join(invalid, '.git'),
      'invalid UUID fixture pointer; never climb to the project repository\n'
    )
    const partial = await add(own, [invalid, b])
    assert.equal(partial.views.length, 1)
    assert.equal(partial.warnings.length, 1)
    const capacity = owner(),
      paths = Array.from({ length: 8 }, (_, index) => path.join(a, 'scopes', String(index + 1)))
    assert.equal((await add(capacity, paths)).views.length, 8)
    const overflow = await add(capacity, [path.join(a, 'scopes', '9')])
    assert.equal(overflow.views.length, 8)
    assert.equal(overflow.addedViewIds.length, 0)
    assert.match(overflow.warnings[0], /最多/)
    chooserReply = { canceled: false, filePaths: [...paths, b] }
    assert.equal((await invoke('git:add-repositories', capacity, randomUUID())).status, 'too-large')
  }
)
await suite.check(
  'collection/parser/preload reject malformed identities, sparse/duplicate views and unknown authority fields',
  async () => {
    const own = owner(),
      data = await add(own, [a]),
      requestId = randomUUID()
    const good = { ...data, requestId }
    assert(api.parseGitRepositoryCollectionResult(good))
    const chooserCount = dialogs.length
    for (const requestId of ['legacy-valid', '', '../escape', 'a'.repeat(36), {}]) {
      await assert.rejects(invoke('git:repositories', own, requestId), /无效/)
      await assert.rejects(invoke('git:add-repositories', own, requestId), /无效/)
      await assert.rejects(api.gitRepositoriesAPI.getGitRepositories(requestId), /无效/)
      await assert.rejects(api.gitRepositoriesAPI.selectGitDirectories(requestId), /无效/)
    }
    assert.equal(dialogs.length, chooserCount)
    for (const mutation of [
      { views: Array(1) },
      { views: [data.views[0], data.views[0]] },
      { addedViewIds: [randomUUID()] },
      { limit: 99 },
      { argv: [] }
    ])
      assert.equal(api.parseGitRepositoryCollectionResult({ ...good, ...mutation }), null)
    ipcCalls = []
    ipcResponse = good
    assert.equal((await api.gitRepositoriesAPI.getGitRepositories(requestId)).status, 'ready')
    assert.equal((await api.gitRepositoriesAPI.selectGitDirectories(requestId)).status, 'ready')
    assert.deepEqual(
      ipcCalls.map((call) => call.channel),
      ['git:repositories', 'git:add-repositories']
    )
    await assert.rejects(api.gitRepositoriesAPI.selectGitDirectories({ path: a }), /请求无效/)
    ipcResponse = { ...good, requestId: randomUUID() }
    await assert.rejects(api.gitRepositoriesAPI.getGitRepositories(requestId), /身份无效/)
  }
)
await suite.check(
  'cross-window/subframe/dead sources cannot list/read/release another owner view or open a chooser',
  async () => {
    const own = owner(),
      other = owner(),
      data = await add(own, [a, b]),
      view = data.views[0]
    assert.equal(
      (await invoke('git:list', other, { requestId: randomUUID(), viewId: view.viewId })).status,
      'stale'
    )
    assert.equal((await invoke('git:release', other, view.viewId)).status, 'stale')
    const start = dialogs.length
    for (const channel of ['git:repositories', 'git:add-repositories']) {
      await assert.rejects(
        handlers.get(channel)({ ...other.event, senderFrame: {} }, randomUUID()),
        /来源/
      )
      other.window.destroyed = true
      await assert.rejects(invoke(channel, other, randomUUID()), /来源/)
      other.window.destroyed = false
      other.event.sender.destroyed = true
      await assert.rejects(invoke(channel, other, randomUUID()), /来源/)
      other.event.sender.destroyed = false
    }
    assert.equal(dialogs.length, start)
    assert.equal((await collection(own)).views.length, 2)
  }
)
await suite.check(
  'cancelled or modal-obsolete chooser replies cannot adopt late repositories or erase existing ones',
  async () => {
    const own = owner(),
      old = await add(own, [a]),
      requestId = randomUUID(),
      pending = hold('chooser')
    chooserReply = pending.promise
    const active = invoke('git:add-repositories', own, requestId)
    await until(() => host.chooserBlocked(own.window.id))
    assert.equal((await invoke('git:cancel', own, requestId)).status, 'ready')
    assert.equal((await invoke('git:add-repositories', own, randomUUID())).status, 'error')
    pending.release({ canceled: false, filePaths: [b] })
    assert.equal((await active).status, 'cancelled')
    assert.deepEqual(
      (await collection(own)).views.map((view) => view.viewId),
      old.views.map((view) => view.viewId)
    )
    let reply
    chooserReply = new Promise((resolve) => {
      reply = resolve
    })
    const next = invoke('git:add-repositories', own, randomUUID())
    await until(() => host.chooserBlocked(own.window.id))
    modal.add(own.window.id)
    reply({ canceled: false, filePaths: [b] })
    assert.equal((await next).status, 'error')
    modal.delete(own.window.id)
    assert.equal((await collection(own)).views.length, 1)
  }
)
await suite.check(
  'navigation while chooser is open retires every old view and rejects the late chooser document',
  async () => {
    const own = owner(),
      previous = await add(own, [a, b]),
      before = events.length
    let reply
    chooserReply = new Promise((resolve) => {
      reply = resolve
    })
    const pending = invoke('git:add-repositories', own, randomUUID())
    await until(() => host.chooserBlocked(own.window.id))
    own.navigate()
    assert.equal((await collection(own)).views.length, 0)
    reply({ canceled: false, filePaths: [linked] })
    assert.equal((await pending).status, 'cancelled')
    assert.equal((await collection(own)).views.length, 0)
    assert(previous.views.every((view) => !host.currentView(own.event, view.viewId)))
    assert.equal(events.length, before)
  }
)
await suite.check(
  'cancellation during asynchronous adoption rolls back newly owned views only after actual settlement',
  async () => {
    const own = owner(),
      requestId = randomUUID()
    lifecycleHold = hold('add')
    lifecycleHold.target = b
    chooserReply = { canceled: false, filePaths: [a, b] }
    const choosing = observed(invoke('git:add-repositories', own, requestId))
    await until(() => lifecycleHold.started)
    assert(host.views(own.window.id).some((view) => view.info.repositoryPath === a))
    const cancelled = observed(invoke('git:cancel', own, requestId))
    await delay(25)
    assert.equal(cancelled.settled, false)
    lifecycleHold.release()
    lifecycleHold = undefined
    assert.equal((await cancelled.promise).status, 'ready')
    assert.equal((await choosing.promise).status, 'cancelled')
    assert.equal((await collection(own)).views.length, 0)
  }
)
await suite.check(
  'a read/chooser from another repo in the same window cannot abort an active manual write',
  async () => {
    const own = owner(),
      data = await add(own, [a, b]),
      writeHold = hold('write'),
      requestId = randomUUID()
    let signal,
      started = false
    const write = host.operate(own.event, requestId, async (_state, operation, assertCurrent) => {
      operation.phase = 'write'
      operation.viewId = data.views[0].viewId
      signal = operation.controller.signal
      started = true
      await writeHold.promise
      assertCurrent()
      return {
        outcome: 'success',
        message: 'Synthetic manual operation settled without Git writes'
      }
    })
    await until(() => started)
    assert.equal(
      (await invoke('git:list', own, { requestId: randomUUID(), viewId: data.views[1].viewId }))
        .status,
      'error'
    )
    assert.equal((await invoke('git:add-repositories', own, randomUUID())).status, 'error')
    assert.equal(signal.aborted, false)
    assert.equal((await invoke('git:cancel', owner(), requestId)).status, 'stale')
    writeHold.release()
    assert.equal((await write).outcome, 'success')
  }
)
await suite.check(
  'releasing one repo leaves another intact and only its lifecycle/cache retires',
  async () => {
    const own = owner(),
      data = await add(own, [a, b])
    const released = host.currentView(own.event, data.views[0].viewId),
      kept = host.currentView(own.event, data.views[1].viewId)
    assert.equal((await invoke('git:release', own, data.views[0].viewId)).status, 'ready')
    assert.equal(released.disposed, true)
    assert.equal(kept.disposed, false)
    assert.deepEqual(
      (await collection(own)).views.map((view) => view.viewId),
      [kept.info.viewId]
    )
  }
)
await suite.check(
  'navigation clears every repository and blocks a new document until all cleanup promises settle',
  async () => {
    const own = owner(),
      data = await add(own, [a, b]),
      actual = data.views.map((view) => host.currentView(own.event, view.viewId))
    lifecycleHold = hold('remove')
    own.navigate()
    await until(() => lifecycleHold.started)
    const fresh = observed(collection(own))
    await delay(25)
    assert.equal(fresh.settled, false)
    lifecycleHold.release()
    lifecycleHold = undefined
    assert.equal((await fresh.promise).views.length, 0)
    assert(actual.every((view) => view.disposed))
  }
)
await suite.check(
  'invalidation events carry exact view/sequence/status and never accept path/command or accessor authority',
  () => {
    const event = { viewId: randomUUID(), reason: 'metadata', sequence: 1, status: 'watching' }
    assert.deepEqual(api.parseGitInvalidatedEvent(event), event)
    for (const mutation of [
      { sequence: 0 },
      { sequence: Infinity },
      { viewId: '../repo' },
      { reason: 'command' },
      { status: 'ready' },
      { command: 'anything' },
      { message: '\u001bsecret' }
    ])
      assert.equal(api.parseGitInvalidatedEvent({ ...event, ...mutation }), null)
    let called = false
    const accessor = { ...event }
    Object.defineProperty(accessor, 'viewId', {
      get() {
        called = true
        return event.viewId
      }
    })
    assert.equal(api.parseGitInvalidatedEvent(accessor), null)
    assert.equal(called, false)
  }
)
await suite.check(
  'preload invalidation subscription validates data, executes no request and removes only its own listener',
  () => {
    const event = { viewId: randomUUID(), reason: 'worktree', sequence: 1, status: 'watching' },
      delivered = [],
      other = []
    const before = ipcCalls.length
    assert.throws(() => api.gitObservationAPI.onGitInvalidated('invalid'), /监听无效/)
    const release = api.gitObservationAPI.onGitInvalidated((value) => delivered.push(value))
    const releaseOther = api.gitObservationAPI.onGitInvalidated((value) => other.push(value))
    rendererEvents.emit('git:invalidated', {}, event)
    rendererEvents.emit('git:invalidated', {}, { ...event, command: 'ignored malformed payload' })
    rendererEvents.emit('git:invalidated', {}, { ...event, sequence: 0 })
    assert.deepEqual(delivered, [event])
    assert.deepEqual(other, [event])
    release()
    release()
    rendererEvents.emit('git:invalidated', {}, { ...event, sequence: 2 })
    assert.equal(delivered.length, 1)
    assert.equal(other.length, 2)
    releaseOther()
    assert.equal(rendererEvents.listenerCount('git:invalidated'), 0)
    assert.equal(ipcCalls.length, before)
  }
)
await suite.check(
  'final cleanup removes all owned views/cache and real Git processes while fixture contents remain untouched',
  async () => {
    for (const own of owners) own.close()
    for (const own of owners) assert.equal((await collection(own)).views.length, 0)
    assert.deepEqual(await diskIdentity(a), baselines.a)
    assert.deepEqual(await diskIdentity(b), baselines.b)
    assert.deepEqual(await diskIdentity(linked), baselines.linked)
    const cache = path.join(evidence, 'ZoneCodex-git-view-' + process.pid)
    assert(!(await fs.readdir(cache)).some((entry) => entry.startsWith('query-')))
    const spawns = events.filter((event) => event.event === 'spawn'),
      closes = events.filter((event) => event.event === 'close')
    assert.equal(spawns.length, closes.length)
    const retirement = await verifyProcessRetirement(
      closes.map((event) => ({ ...event, closedAtUTC: event.atUTC }))
    )
    return { actualGitSpawns: spawns.length, retirement }
  }
)
await fs.writeFile(
  path.join(evidence, 'processes-and-lifecycles.json'),
  JSON.stringify({ preparation, events, dialogs, lifecycles }, null, 2)
)
delete globalThis[key]
await suite.finish()
