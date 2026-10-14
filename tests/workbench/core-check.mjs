import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const directory = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'zonecodex-workbench-'))
)
const output = path.join(directory, 'core.cjs')
await build({
  stdin: {
    contents:
      'export * from "./src/main/workbench/editor-files"; export * from "./src/shared/workbench"; export * from "./src/renderer/src/features/workbench/panel-model"; export * from "./src/main/window/main-navigation";',
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  logLevel: 'silent'
})
const api = createRequire(import.meta.url)(output)
let checks = 0
const check = async (name, action) => {
  await action()
  checks++
  console.log('PASS ' + name)
}
const ids = Array.from({ length: 4 }, randomUUID)
const tab = (index) => ({ id: ids[index], title: 'File ' + index, kind: 'files' })
await check(
  'close selects right then left; final close returns to chat; reopening restores position',
  () => {
    let state = {
      ...api.emptyPanelState(),
      tabs: ids.slice(0, 3).map((id, index) => ({ ...tab(index), id, kind: 'terminal' })),
      selected: ids[1],
      layout: 'split'
    }
    state = api.closePanelTab(state, ids[1])
    assert.equal(state.selected, ids[2])
    state = api.reopenPanelTab(state)
    assert.deepEqual(
      state.tabs.map((t) => t.id),
      ids.slice(0, 3)
    )
    state = api.closePanelTab(state, ids[1])
    state = api.closePanelTab(state, ids[2])
    assert.equal(state.selected, ids[0])
    state = api.closePanelTab(state, ids[0])
    assert.equal(state.layout, 'chat')
  }
)
await check('reordering and source-aware file reuse keep independent snapshots', () => {
  let state = api.emptyPanelState()
  const file = {
    ...tab(0),
    kind: 'file',
    file: { reference: { path: 'sample.ts' }, source: { kind: 'local' } }
  }
  state = api.addPanelTab(state, file)
  state = api.addPanelTab(state, { ...file, id: ids[1] })
  assert.equal(state.tabs.length, 1)
  state = api.addPanelTab(state, {
    ...file,
    id: ids[2],
    file: { ...file.file, source: { kind: 'snapshot', snapshotId: ids[3] } }
  })
  assert.equal(state.tabs.length, 2)
  state = api.movePanelTab(state, ids[2], ids[0])
  assert.equal(state.tabs[0].id, ids[2])
})
await check(
  'state validation strips extra authority fields and rejects credential URLs and invalid sources',
  () => {
    const state = {
      ...api.emptyPanelState(),
      accessToken: 'do-not-store',
      tabs: [{ ...tab(0), directoryGrant: 'do-not-store' }]
    }
    assert(!JSON.stringify(api.parsePanelState(state)).includes('do-not-store'))
    assert.equal(
      api.parsePanelState({
        ...state,
        tabs: [{ ...tab(0), kind: 'browser', url: 'https://user:secret@example.com' }]
      }),
      null
    )
    assert.equal(
      api.parsePanelState({
        ...state,
        tabs: [
          {
            ...tab(0),
            kind: 'file',
            file: {
              reference: { path: 'x' },
              source: { kind: 'snapshot', snapshotId: 'invalid space' }
            }
          }
        ]
      }),
      null
    )
    assert.equal(
      api.browserDestination('some search'),
      'https://www.bing.com/search?q=some%20search'
    )
  }
)
const file = path.join(directory, 'sample.ts')
const allow = () => {}
await check('manual save preserves UTF-8 BOM and Windows line endings', async () => {
  await fs.writeFile(file, '\uFEFFconst original = 1;\r\n')
  const doc = await api.readEditorDocument(directory, file, allow)
  await api.saveEditorDocument(directory, file, doc.fingerprint, 'const saved = 2;\n', allow)
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFconst saved = 2;\r\n')
})
await check('external modification conflict leaves external bytes unchanged', async () => {
  const doc = await api.readEditorDocument(directory, file, allow)
  await fs.writeFile(file, 'external version\n')
  await assert.rejects(
    api.saveEditorDocument(directory, file, doc.fingerprint, 'local draft', allow),
    /CONFLICT/
  )
  assert.equal(await fs.readFile(file, 'utf8'), 'external version\n')
})
await check(
  'revoked access, invalid UTF-8, binary text, oversized files and outside paths are refused',
  async () => {
    await assert.rejects(
      api.readEditorDocument(directory, file, () => {
        throw Error('revoked')
      }),
      /revoked/
    )
    await fs.writeFile(file, Buffer.from([0xff, 0xfe]))
    await assert.rejects(api.readEditorDocument(directory, file, allow))
    await fs.writeFile(file, Buffer.from([0, 1, 2]))
    await assert.rejects(api.readEditorDocument(directory, file, allow))
    await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, 65))
    await assert.rejects(api.readEditorDocument(directory, file, allow))
    await assert.rejects(
      api.readEditorDocument(
        directory,
        output.replace(path.basename(directory), 'other-directory'),
        allow
      )
    )
  }
)

await check(
  'embedded subframe loads preserve owners; full owner navigation invalidates resources',
  () => {
    const contents = new EventEmitter()
    let resets = 0
    api.attachMainNavigationSignal(contents)
    contents.on('zonecodex-main-navigation', () => resets++)
    contents.emit('did-start-loading')
    contents.emit('did-start-navigation', {}, 'about:blank', false, false)
    contents.emit('did-start-navigation', {}, 'file:///app#fragment', true, true)
    assert.equal(resets, 0)
    contents.emit('did-start-navigation', {}, 'file:///app', false, true)
    assert.equal(resets, 1)
  }
)

console.log(JSON.stringify({ pass: true, checks, evidence: directory }))
