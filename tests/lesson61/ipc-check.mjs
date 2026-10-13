import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('ipc')
const handlers = new Map()
const windows = new Map()
const modal = new Set()
const log = []
const holds = new Set()
const queues = { open: [], refresh: [], read: [], dispose: [], dialog: [] }
let readerCreations = 0
let nextWindow = 0
let nextView = 0
let api
const tick = () => new Promise((resolve) => setImmediate(resolve))
function hold(kind) {
  let resolve, reject
  const deferred = {
    kind,
    started: false,
    aborted: false,
    settled: false,
    promise: new Promise((yes, no) => {
      resolve = yes
      reject = no
    }),
    close(error) {
      if (deferred.settled) return
      deferred.settled = true
      holds.delete(deferred)
      if (error) reject(error)
      else if (deferred.aborted) reject(new api.GitReadError('cancelled', '合成 owned read 已退出'))
      else resolve(deferred.value)
    },
    reply(value) {
      deferred.value = value
      deferred.close()
    },
    completeIgnoringAbort() {
      if (deferred.settled) return
      deferred.settled = true
      holds.delete(deferred)
      resolve(deferred.value)
    }
  }
  queues[kind].push(deferred)
  holds.add(deferred)
  return deferred
}
async function controlled(kind, value, signal, owner) {
  const entry = { kind, owner, signal, value }
  log.push(entry)
  const pending = queues[kind].shift()
  if (!pending) return value
  pending.started = true
  pending.value = value
  pending.entry = entry
  pending.aborted = !!signal?.aborted
  const abort = () => {
    pending.aborted = true
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await pending.promise
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
function makeView(selectedPath) {
  const viewId = 'view-' + ++nextView
  const item = {
    itemId: 'item-' + nextView,
    group: 'staged',
    change: 'modified',
    path: 'scope/file.txt',
    previousPath: null,
    previewable: true,
    reason: null
  }
  return {
    info: {
      viewId,
      selectedPath,
      repositoryPath: selectedPath,
      scopePath: '',
      gitVersion: 'git version 2.56.0.windows.1',
      head: 'present',
      linkedWorktree: false
    },
    snapshot: { revision: 'revision-' + nextView, items: [item] },
    disposed: false
  }
}
const reader = {
  async open(selectedPath, signal) {
    const view = makeView(selectedPath)
    return controlled('open', view, signal, selectedPath)
  },
  async refresh(view, signal) {
    return controlled(
      'refresh',
      { revision: view.snapshot.revision, items: view.snapshot.items, warnings: [] },
      signal,
      view.info.viewId
    )
  },
  async read(view, revision, itemId, signal) {
    const item = view.snapshot.items.find((item) => item.itemId === itemId)
    const text = '--- a/scope/file.txt\n+++ b/scope/file.txt\n-old\n+new\n'
    return controlled(
      'read',
      {
        item,
        format: 'diff',
        baseline: 'head-index',
        text,
        bytes: Buffer.byteLength(text),
        lineCount: text.split(/\r\n|\n|\r/).length
      },
      signal,
      view.info.viewId + '/' + revision
    )
  },
  async dispose(view) {
    const result = await controlled('dispose', undefined, undefined, view.info.viewId)
    view.disposed = true
    return result
  }
}
globalThis.__lesson61ipc = {
  app: { getPath: () => evidence },
  BrowserWindow: { fromWebContents: (owner) => windows.get(owner) ?? null },
  ipcMain: {
    handle(channel, callback) {
      assert(!handlers.has(channel), 'handler registered twice: ' + channel)
      handlers.set(channel, callback)
    }
  },
  dialog: {
    showOpenDialog(window, options) {
      return controlled('dialog', { canceled: false, filePaths: [evidence] }, undefined, {
        windowId: window.id,
        options
      })
    }
  },
  createGitReader() {
    readerCreations++
    return reader
  }
}
const outfile = path.join(evidence, 'current-ipc.cjs')
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents:
      'export * from "./src/main/git/git-ipc.ts"; export * from "./src/main/git/git-process.ts";',
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
      name: 'controlled-electron-and-reader',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture'
        }))
        builder.onResolve({ filter: /^\.\/git-reader$/ }, () => ({
          path: 'reader',
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'reader'
              ? 'export const {createGitReader}=globalThis.__lesson61ipc;'
              : 'export const {app,BrowserWindow,ipcMain,dialog}=globalThis.__lesson61ipc;',
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(bundle.metafile.inputs)
      .filter((file) => file !== '<stdin>' && !file.startsWith('fixture:'))
      .map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
await fs.writeFile(path.join(evidence, 'metafile.json'), JSON.stringify(bundle.metafile, null, 2))
api = createRequire(import.meta.url)(outfile)
api.registerGitView((id) => modal.has(id))
const suite = checksFor(evidence, {
  actualCurrentGitIPCHandlers: true,
  actualCurrentIPCSourceGuard: true,
  syntheticElectron: true,
  controlledReader: true,
  nativeGit: false,
  actualElectron: false,
  realNativeChooser: false,
  realChildProcesses: false,
  realTransport: false,
  realModel: false,
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile))
})
function owner() {
  const window = new EventEmitter()
  window.id = ++nextWindow
  window.destroyed = false
  window.isDestroyed = () => window.destroyed
  const contents = new EventEmitter()
  contents.mainFrame = { document: 1 }
  contents.destroyed = false
  contents.isDestroyed = () => contents.destroyed
  window.webContents = contents
  windows.set(contents, window)
  api.attachGitCleanup(window)
  return {
    window,
    event: { sender: contents, senderFrame: contents.mainFrame },
    newDocument() {
      contents.mainFrame = { document: contents.mainFrame.document + 1 }
      contents.emit('did-start-navigation', {}, 'app://new', false, true)
      return { sender: contents, senderFrame: contents.mainFrame }
    },
    clean() {
      contents.emit('render-process-gone')
    }
  }
}
function invoke(channel, event, value) {
  return handlers.get(channel)(event, value)
}
async function select(scope, requestId = 'select-' + scope.window.id) {
  const result = await invoke('git:select', scope.event, requestId)
  assert.equal(result.status, 'ready', JSON.stringify(result))
  return result.view
}
function listRequest(view, requestId) {
  return { requestId, viewId: view.viewId }
}
async function getItem(scope, view) {
  const result = await invoke('git:list', scope.event, listRequest(view, 'list-' + scope.window.id))
  assert.equal(result.status, 'ready')
  return {
    requestId: 'read-' + scope.window.id,
    viewId: view.viewId,
    revision: result.revision,
    itemId: result.items[0].itemId
  }
}
const calls = (kind) => log.filter((entry) => entry.kind === kind)
function observed(promise) {
  let settled = false
  const wrapped = promise.finally(() => {
    settled = true
  })
  return {
    promise: wrapped,
    get settled() {
      return settled
    }
  }
}

await suite.check(
  'import and registration expose exactly five handlers without starting reader or Agent work',
  () => {
    assert.deepEqual([...handlers.keys()].sort(), [
      'git:cancel',
      'git:list',
      'git:read',
      'git:release',
      'git:select'
    ])
    assert.equal(readerCreations, 0)
    assert.equal(log.length, 0)
  }
)

await suite.check(
  'all handlers reject detached dead or subframe sources before chooser or reader effects',
  async () => {
    const scope = owner()
    const requests = {
      'git:select': 'select-source',
      'git:list': { requestId: 'list-source', viewId: 'unknown-view' },
      'git:read': {
        requestId: 'read-source',
        viewId: 'unknown-view',
        revision: 'unknown-revision',
        itemId: 'unknown-item'
      },
      'git:cancel': 'cancel-source',
      'git:release': 'release-source'
    }
    const before = log.length
    for (const [channel, value] of Object.entries(requests)) {
      await assert.rejects(invoke(channel, { ...scope.event, senderFrame: {} }, value), /来源/)
      scope.window.destroyed = true
      await assert.rejects(invoke(channel, scope.event, value), /来源/)
      scope.window.destroyed = false
      scope.event.sender.destroyed = true
      await assert.rejects(invoke(channel, scope.event, value), /来源/)
      scope.event.sender.destroyed = false
      windows.delete(scope.event.sender)
      await assert.rejects(invoke(channel, scope.event, value), /来源/)
      windows.set(scope.event.sender, scope.window)
    }
    assert.equal(log.length, before)
    scope.clean()
  }
)

await suite.check(
  'malformed IDs and arbitrary path command ref authority fields reject before reader effects',
  async () => {
    const scope = owner()
    const before = log.length
    for (const id of ['', '../escape', 'bad id', 'x'.repeat(81), {}, null]) {
      await assert.rejects(invoke('git:select', scope.event, id), /标识/)
      await assert.rejects(invoke('git:cancel', scope.event, id), /标识/)
      await assert.rejects(invoke('git:release', scope.event, id), /标识/)
    }
    for (const field of [
      'path',
      'cwd',
      'argv',
      'command',
      'ref',
      'approval',
      'commandTicket',
      'conversationId'
    ]) {
      await assert.rejects(
        invoke('git:list', scope.event, { requestId: 'list', viewId: 'view', [field]: 'injected' }),
        /请求无效/
      )
      await assert.rejects(
        invoke('git:read', scope.event, {
          requestId: 'read',
          viewId: 'view',
          revision: 'revision',
          itemId: 'item',
          [field]: 'injected'
        }),
        /请求无效/
      )
    }
    assert.equal(log.length, before)
    scope.clean()
  }
)

await suite.check(
  'modal waits block new choices while owned list and item reads remain usable',
  async () => {
    const scope = owner()
    modal.add(scope.window.id)
    const dialogs = calls('dialog').length
    assert.equal((await invoke('git:select', scope.event, 'modal-first')).status, 'error')
    assert.equal(calls('dialog').length, dialogs)
    modal.delete(scope.window.id)
    const view = await select(scope)
    const item = await getItem(scope, view)
    modal.add(scope.window.id)
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'modal-refresh'))).status,
      'ready'
    )
    assert.equal((await invoke('git:read', scope.event, item)).status, 'ready')
    assert.equal((await invoke('git:select', scope.event, 'modal-second')).status, 'error')
    modal.delete(scope.window.id)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'modal entered during native chooser blocks late open and preserves existing scope',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const chooser = hold('dialog')
    const opens = calls('open').length
    const selection = invoke('git:select', scope.event, 'late-modal')
    await tick()
    assert(chooser.started)
    modal.add(scope.window.id)
    chooser.reply({ canceled: false, filePaths: [evidence] })
    assert.equal((await selection).status, 'error')
    assert.equal(calls('open').length, opens)
    modal.delete(scope.window.id)
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'old-preserved'))).status,
      'ready'
    )
    scope.clean()
    await tick()
  }
)

await suite.check(
  'cross-window view item and cancel IDs never select or abort another owner read',
  async () => {
    const first = owner(),
      second = owner()
    const view = await select(first)
    const item = await getItem(first, view)
    const blocked = hold('read')
    const pending = invoke('git:read', first.event, item)
    await tick()
    const count = log.length
    assert.equal(
      (await invoke('git:list', second.event, listRequest(view, 'cross-list'))).status,
      'stale'
    )
    assert.equal(
      (await invoke('git:read', second.event, { ...item, requestId: 'cross-read' })).status,
      'stale'
    )
    assert.equal((await invoke('git:release', second.event, view.viewId)).status, 'stale')
    assert.equal((await invoke('git:cancel', second.event, item.requestId)).status, 'stale')
    assert.equal((await invoke('git:cancel', first.event, 'wrong-request')).status, 'stale')
    assert(!blocked.aborted)
    assert.equal(log.length, count)
    blocked.close()
    assert.equal((await pending).status, 'ready')
    first.clean()
    second.clean()
    await tick()
  }
)

await suite.check(
  'cancel acknowledges owned read only after controlled actual close rather than abort request',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const blocked = hold('refresh')
    const pending = observed(invoke('git:list', scope.event, listRequest(view, 'cancel-owned')))
    await tick()
    const cancelling = observed(invoke('git:cancel', scope.event, 'cancel-owned'))
    await tick()
    assert(blocked.aborted)
    assert(!pending.settled)
    assert(!cancelling.settled)
    blocked.close()
    assert.equal((await pending.promise).status, 'cancelled')
    assert.equal((await cancelling.promise).status, 'ready')
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'after-close'))).status,
      'ready'
    )
    scope.clean()
    await tick()
  }
)

await suite.check(
  'release waits owned actual close before disposing and invalidates the released view',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const item = await getItem(scope, view)
    const blocked = hold('read')
    const pending = invoke('git:read', scope.event, item)
    await tick()
    const disposes = calls('dispose').length
    const releasing = observed(invoke('git:release', scope.event, view.viewId))
    await tick()
    assert(blocked.aborted)
    assert(!releasing.settled)
    assert.equal(calls('dispose').length, disposes)
    blocked.close()
    assert.equal((await pending).status, 'cancelled')
    assert.equal((await releasing.promise).status, 'ready')
    assert.equal(calls('dispose').length, disposes + 1)
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'released-list'))).status,
      'stale'
    )
    scope.clean()
  }
)

await suite.check(
  'old view revision and item preflight cannot cancel a current valid read or chooser',
  async () => {
    const scope = owner()
    const old = await select(scope)
    const view = await select(scope, 'new-scope')
    const item = await getItem(scope, view)
    const blocked = hold('read')
    const pending = invoke('git:read', scope.event, item)
    await tick()
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(old, 'old-view-list'))).status,
      'stale'
    )
    for (const patch of [
      { viewId: old.viewId },
      { revision: 'old-revision' },
      { itemId: 'old-item' }
    ])
      assert.equal(
        (await invoke('git:read', scope.event, { ...item, ...patch, requestId: 'old-preflight' }))
          .status,
        'stale'
      )
    assert.equal((await invoke('git:release', scope.event, old.viewId)).status, 'stale')
    assert(!blocked.aborted)
    blocked.close()
    assert.equal((await pending).status, 'ready')
    const chooser = hold('dialog')
    const choosing = invoke('git:select', scope.event, 'current-chooser')
    await tick()
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(old, 'old-during-chooser'))).status,
      'stale'
    )
    chooser.reply({ canceled: false, filePaths: [evidence] })
    assert.equal((await choosing).status, 'ready')
    scope.clean()
    await tick()
  }
)

await suite.check(
  'cancelled native chooser preserves old view and explicit cancel invalidates late choice without claiming OS close',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const cancelled = hold('dialog')
    const first = invoke('git:select', scope.event, 'native-cancelled')
    await tick()
    cancelled.reply({ canceled: true, filePaths: [] })
    assert.equal((await first).status, 'cancelled')
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'chooser-preserved'))).status,
      'ready'
    )
    const chooser = hold('dialog')
    const opens = calls('open').length
    const late = invoke('git:select', scope.event, 'cancel-chooser')
    await tick()
    assert.equal((await invoke('git:cancel', scope.event, 'cancel-chooser')).status, 'ready')
    assert(!chooser.settled)
    assert.equal((await invoke('git:select', scope.event, 'duplicate-chooser')).status, 'error')
    chooser.reply({ canceled: false, filePaths: [evidence] })
    assert.equal((await late).status, 'cancelled')
    assert.equal(calls('open').length, opens)
    assert.equal(
      (await invoke('git:list', scope.event, listRequest(view, 'late-preserved'))).status,
      'ready'
    )
    scope.clean()
    await tick()
  }
)

await suite.check(
  'release of previous scope does not abort replacement chooser or pending reader open',
  async () => {
    const scope = owner()
    const old = await select(scope)
    const chooser = hold('dialog')
    const opened = hold('open')
    const replacing = invoke('git:select', scope.event, 'replacement-open')
    await tick()
    assert.equal((await invoke('git:release', scope.event, old.viewId)).status, 'ready')
    chooser.reply({ canceled: false, filePaths: [evidence] })
    await tick()
    assert(opened.started)
    assert(!opened.aborted)
    assert.equal((await invoke('git:release', scope.event, old.viewId)).status, 'stale')
    assert(!opened.aborted)
    opened.close()
    const next = await replacing
    assert.equal(next.status, 'ready')
    assert.notEqual(next.view.viewId, old.viewId)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'read replacement waits previous owned close and concurrent replacements start only newest request',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const item = await getItem(scope, view)
    const blocked = hold('refresh')
    const old = invoke('git:list', scope.event, listRequest(view, 'old-active'))
    await tick()
    const reads = calls('read').length
    const refreshes = calls('refresh').length
    const middle = invoke('git:read', scope.event, { ...item, requestId: 'middle-replace' })
    const newest = invoke('git:list', scope.event, listRequest(view, 'newest-replace'))
    await tick()
    assert(blocked.aborted)
    assert.equal(calls('read').length, reads)
    assert.equal(calls('refresh').length, refreshes)
    blocked.close()
    assert.equal((await old).status, 'cancelled')
    assert.equal((await middle).status, 'cancelled')
    assert.equal((await newest).status, 'ready')
    assert.equal(calls('read').length, reads)
    assert.equal(calls('refresh').length, refreshes + 1)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'navigation invalidates old document but new document cannot overlap its still-owned read',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const blocked = hold('refresh')
    const old = invoke('git:list', scope.event, listRequest(view, 'navigation-old'))
    await tick()
    const opens = calls('open').length
    const disposes = calls('dispose').length
    const newEvent = scope.newDocument()
    const next = observed(invoke('git:select', newEvent, 'navigation-new'))
    await tick()
    assert(blocked.aborted)
    assert(!next.settled)
    assert.equal(calls('open').length, opens)
    assert.equal(calls('dispose').length, disposes)
    await assert.rejects(invoke('git:cancel', scope.event, 'navigation-old'), /来源/)
    assert.equal(
      (await invoke('git:list', newEvent, listRequest(view, 'old-document-view'))).status,
      'stale'
    )
    blocked.close()
    assert.equal((await old).status, 'cancelled')
    assert.equal((await next.promise).status, 'ready')
    assert.equal(calls('dispose').length, disposes + 1)
    assert.equal(calls('open').length, opens + 1)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'chooser reservation prevents a second chooser while first selection waits for owned read close',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const blocked = hold('refresh')
    const old = invoke('git:list', scope.event, listRequest(view, 'chooser-wait-old'))
    await tick()
    const dialogs = calls('dialog').length
    const choosing = invoke('git:select', scope.event, 'reserved-chooser')
    await tick()
    assert(blocked.aborted)
    assert.equal(calls('dialog').length, dialogs)
    const duplicate = await invoke('git:select', scope.event, 'duplicate-reservation')
    assert.equal(duplicate.status, 'error')
    assert.equal(calls('dialog').length, dialogs)
    blocked.close()
    assert.equal((await old).status, 'cancelled')
    assert.equal((await choosing).status, 'ready')
    assert.equal(calls('dialog').length, dialogs + 1)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'late reader-open result after navigation disposes only its own new scope and cannot revive old document',
  async () => {
    const scope = owner()
    const old = await select(scope)
    const opened = hold('open')
    const late = invoke('git:select', scope.event, 'late-open-after-navigation')
    await tick()
    assert(opened.started)
    const lateViewId = opened.value.info.viewId
    const disposes = calls('dispose').length
    const nextEvent = scope.newDocument()
    await tick()
    assert(opened.aborted)
    assert.equal(calls('dispose').length, disposes)
    opened.completeIgnoringAbort()
    assert.equal((await late).status, 'cancelled')
    await tick()
    assert.equal(calls('dispose').filter(({ owner }) => owner === lateViewId).length, 1)
    assert.equal(calls('dispose').filter(({ owner }) => owner === old.viewId).length, 1)
    assert.equal(
      (await invoke('git:list', nextEvent, listRequest(old, 'late-old-view'))).status,
      'stale'
    )
    const next = await invoke('git:select', nextEvent, 'late-new-document')
    assert.equal(next.status, 'ready')
    assert.notEqual(next.view.viewId, lateViewId)
    scope.clean()
    await tick()
  }
)

await suite.check(
  'in-place or subframe navigation preserves scope; renderer loss window close and sender destruction clear it',
  async () => {
    for (const cleanup of ['render-process-gone', 'closed', 'destroyed']) {
      const scope = owner()
      const view = await select(scope)
      const item = await getItem(scope, view)
      scope.window.webContents.emit('did-start-navigation', {}, 'app://same', true, true)
      scope.window.webContents.emit('did-start-navigation', {}, 'app://iframe', false, false)
      assert.equal((await invoke('git:read', scope.event, item)).status, 'ready')
      const disposes = calls('dispose').length
      if (cleanup === 'closed') scope.window.emit(cleanup)
      else scope.window.webContents.emit(cleanup)
      await tick()
      assert.equal(calls('dispose').length, disposes + 1)
      assert.equal(
        (await invoke('git:list', scope.event, listRequest(view, 'cleanup-' + cleanup))).status,
        'stale'
      )
    }
  }
)

await suite.check(
  'unconfirmed close returns explicit error and prevents new reads or new scope from reusing the owner slot',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const blocked = hold('refresh')
    const pending = invoke('git:list', scope.event, listRequest(view, 'unconfirmed-active'))
    await tick()
    const cancelling = invoke('git:cancel', scope.event, 'unconfirmed-active')
    await tick()
    blocked.close(new api.GitReadError('error', 'Git 进程退出未确认；保留查询缓存供诊断'))
    assert.equal((await pending).status, 'error')
    const control = await cancelling
    assert.equal(control.status, 'error')
    assert.match(control.error, /退出未确认/)
    const opens = calls('open').length
    const refreshes = calls('refresh').length
    const nextList = await invoke(
      'git:list',
      scope.event,
      listRequest(view, 'unconfirmed-next-list')
    )
    assert.equal(nextList.status, 'error')
    const next = await invoke('git:select', scope.event, 'unconfirmed-new-scope')
    assert.equal(next.status, 'error')
    assert.equal(calls('open').length, opens)
    assert.equal(calls('refresh').length, refreshes)
    assert.equal((await invoke('git:release', scope.event, view.viewId)).status, 'error')
  }
)

await suite.check(
  'navigation unconfirmed retirement keeps failed barrier and never begins next document read',
  async () => {
    const scope = owner()
    const view = await select(scope)
    const blocked = hold('refresh')
    const old = invoke('git:list', scope.event, listRequest(view, 'failed-retire-old'))
    await tick()
    const nextEvent = scope.newDocument()
    const opens = calls('open').length
    const oldError = console.error
    const diagnostics = []
    console.error = (...args) => diagnostics.push(args)
    try {
      const next = invoke('git:select', nextEvent, 'failed-retire-new')
      await tick()
      assert(blocked.aborted)
      blocked.close(new api.GitReadError('error', 'Git 进程退出未确认；保留查询缓存供诊断'))
      assert.equal((await old).status, 'error')
      assert.equal((await next).status, 'error')
      await tick()
      assert.equal(calls('open').length, opens)
      assert(diagnostics.some((args) => args.join(' ').includes('退出未确认')))
    } finally {
      console.error = oldError
    }
  }
)

for (const pending of holds) pending.close()
await tick()
await suite.finish({
  registeredChannels: [...handlers.keys()],
  readerCreations,
  controlledEffects: Object.fromEntries(
    Object.keys(queues).map((kind) => [kind, calls(kind).length])
  ),
  actualCloseMeaning:
    'Synthetic reader close is separately controlled after abort; this does not claim native child exit or native chooser close.'
})
