import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'zonecodex-panel-ipc-'))
)
const handlers = new Map()
const conversationId = randomUUID()
let revision = 1
let windowId = 1
const contents = new EventEmitter()
contents.isDestroyed = () => false
const fixture = {
  app: { getPath: () => directory },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  getIpcWindow: () => ({ id: windowId, isDestroyed: () => false, webContents: contents }),
  captureWorkspaceAccess: () => null,
  resolveExecutionContext: async () => ({
    info: { cwd: directory, scopeId: 'scope-' + revision, revision }
  }),
  executionStillCurrent: (_window, _context, execution) => execution.info.revision === revision,
  localPermission: () => 'allow'
}
globalThis.__workbenchIPCFixture = fixture
const stubs = {
  electron: 'app, ipcMain',
  'ipc-source': 'getIpcWindow',
  'workspace-access': 'captureWorkspaceAccess',
  'execution-context': 'resolveExecutionContext, executionStillCurrent, localPermission'
}
const output = path.join(directory, 'ipc.cjs')
await build({
  entryPoints: ['src/main/workbench/workbench-ipc.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  logLevel: 'silent',
  plugins: [
    {
      name: 'ipc-fixture',
      setup(builder) {
        builder.onResolve(
          { filter: /^electron$|\/ipc-source$|\/workspace-access$|\/execution-context$/ },
          ({ path: name }) => ({ path: name.split('/').at(-1), namespace: 'fixture' })
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
          contents: `export const { ${stubs[name]} } = globalThis.__workbenchIPCFixture`,
          loader: 'js'
        }))
      }
    }
  ]
})
const api = createRequire(import.meta.url)(output)
api.registerWorkbench()
api.attachWorkbenchCleanup({ id: 1, webContents: contents, on: () => {} })
const frame = {}
const event = { sender: { isDestroyed: () => false, mainFrame: frame }, senderFrame: frame }
const invoke = (name, ...args) => handlers.get('panel:' + name)(event, ...args)
const context = { conversationId }
const file = path.join(directory, 'sample.ts')
await fs.writeFile(file, 'original\r\n')
const doc = await invoke('read', context, 'sample.ts')
assert(doc.ok)
windowId = 2
assert.equal(
  (await invoke('write', context, doc.data.receipt, doc.data.fingerprint, 'foreign')).ok,
  false
)
windowId = 1
revision++
assert.equal(
  (await invoke('write', context, doc.data.receipt, doc.data.fingerprint, 'stale')).ok,
  false
)
assert.equal(await fs.readFile(file, 'utf8'), 'original\r\n')
const current = await invoke('read', context, 'sample.ts')
assert(current.ok)
const saved = await invoke(
  'write',
  context,
  current.data.receipt,
  current.data.fingerprint,
  'saved\n'
)
assert(saved.ok)
assert.equal(await fs.readFile(file, 'utf8'), 'saved\r\n')
await fs.writeFile(file, 'external')
const conflict = await invoke(
  'write',
  context,
  current.data.receipt,
  saved.data.fingerprint,
  'draft'
)
assert.equal(conflict.conflict, true)
assert.equal(await fs.readFile(file, 'utf8'), 'external')
contents.emit('zonecodex-main-navigation')
assert.equal(
  (await invoke('write', context, current.data.receipt, saved.data.fingerprint, 'stale receipt'))
    .ok,
  false
)
const id = randomUUID()
const state = {
  version: 1,
  layout: 'split',
  width: 600,
  selected: id,
  tabs: [
    {
      id,
      title: 'sample.ts',
      kind: 'file',
      file: { reference: { path: 'sample.ts' }, source: { kind: 'local' } }
    }
  ],
  closed: [],
  drafts: { [id]: { text: 'kept draft', baseline: 'saved', fingerprint: saved.data.fingerprint } },
  credential: 'must not persist'
}
assert((await invoke('save', conversationId, state)).ok)
const storedPath = path.join(directory, 'workbench', conversationId + '.json')
const stored = JSON.parse(await fs.readFile(storedPath, 'utf8'))
assert(!JSON.stringify(stored).includes('kept draft'))
assert(!JSON.stringify(stored).includes('must not persist'))
assert(stored.draftRevision)
assert.deepEqual((await invoke('load', conversationId)).data.drafts, state.drafts)
const draftPath = path.join(
  directory,
  'workbench',
  conversationId + '.' + stored.draftRevision + '.drafts.json'
)
await fs.rename(draftPath, draftPath + '.backup')
const broken = await invoke('load', conversationId)
assert.equal(broken.ok, false)
assert.equal(JSON.parse(await fs.readFile(storedPath, 'utf8')).draftRevision, stored.draftRevision)
await fs.rename(draftPath + '.backup', draftPath)
assert((await invoke('remove', conversationId)).ok)
await assert.rejects(fs.stat(storedPath), { code: 'ENOENT' })
await assert.rejects(fs.stat(draftPath), { code: 'ENOENT' })
console.log(
  JSON.stringify({
    pass: true,
    evidence: directory,
    checks: 7,
    syntheticElectron: true,
    actualDisk: true,
    checksInclude: [
      'owner isolation',
      'revoked scope',
      'manual save',
      'external conflict',
      'receipt lifetime',
      'independent draft restoration and broken-reference preservation',
      'deletion cleanup'
    ]
  })
)
