import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('protocol')
const invokes = []
const windows = new Map()
let reply
globalThis.__lesson61protocol = {
  BrowserWindow: { fromWebContents: (owner) => windows.get(owner) ?? null },
  ipcRenderer: {
    async invoke(channel, ...args) {
      invokes.push({ channel, args })
      return reply
    }
  }
}
const outfile = path.join(evidence, 'current-protocol.cjs')
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      'src/shared/git-view.ts',
      'src/preload/git-api.ts',
      'src/main/ipc-source.ts',
      'src/main/git/git-status.ts',
      'src/main/git/git-snapshot.ts'
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
      name: 'synthetic-electron-protocol-only',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const {BrowserWindow,ipcRenderer}=globalThis.__lesson61protocol;',
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
const api = createRequire(import.meta.url)(outfile)
const suite = checksFor(evidence, {
  realCurrentSharedPreloadAndSourceGuard: true,
  actualCurrentStatusAndIndexParsers: true,
  syntheticElectron: true,
  actualGitIPCHandlers: false,
  nativeGit: false,
  actualElectron: false,
  realTransport: false,
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile))
})
const listRequest = { requestId: 'request-list', viewId: 'git-view' }
const itemRequest = { ...listRequest, revision: 'revision-1', itemId: 'item-1' }
const item = {
  itemId: itemRequest.itemId,
  group: 'staged',
  change: 'modified',
  path: 'same-file.txt',
  previousPath: null,
  previewable: true,
  reason: null
}
const selection = {
  requestId: 'request-select',
  status: 'ready',
  view: {
    viewId: 'git-view',
    selectedPath: evidence,
    repositoryPath: evidence,
    scopePath: '',
    gitVersion: 'git version 2.51.0.windows.1',
    head: 'present',
    linkedWorktree: false
  }
}
const list = {
  ...listRequest,
  status: 'ready',
  revision: 'revision-1',
  items: [item],
  warnings: []
}
function detail(text = '--- a/same-file.txt\n+++ b/same-file.txt\n-old\n+新内容\n', extra = {}) {
  return {
    ...itemRequest,
    status: 'ready',
    item,
    format: 'diff',
    baseline: 'head-index',
    text,
    bytes: new TextEncoder().encode(text).byteLength,
    lineCount: text.split(/\r\n|\n|\r/).length,
    ...extra
  }
}

await suite.check('frozen Git viewer limits leave Agent capacity and protocols independent', () => {
  assert.deepEqual(api.gitViewLimits, {
    statusBytes: 1048576,
    items: 2000,
    itemBytes: 262144,
    itemLines: 4000,
    stderrBytes: 16384,
    metadataBytes: 16777216,
    readMs: 10000,
    activeReads: 1
  })
  assert.equal(invokes.length, 0)
})

await suite.check(
  'exact request keys reject arbitrary paths, commands, refs, context and authority before IPC',
  async () => {
    const count = invokes.length
    for (const field of [
      'path',
      'cwd',
      'ref',
      'argv',
      'command',
      'conversationId',
      'workspaceId',
      'executionId',
      'approval',
      'commandTicket'
    ]) {
      assert.equal(api.parseGitListRequest({ ...listRequest, [field]: 'injected' }), null)
      assert.equal(api.parseGitItemRequest({ ...itemRequest, [field]: 'injected' }), null)
      await assert.rejects(
        api.gitAPI.refreshGitView({ ...listRequest, [field]: 'injected' }),
        /请求无效/
      )
      await assert.rejects(
        api.gitAPI.readGitItem({ ...itemRequest, [field]: 'injected' }),
        /请求无效/
      )
    }
    assert.equal(invokes.length, count)
  }
)

await suite.check(
  'malformed identifiers and descriptor/prototype tricks are rejected without executing getters',
  async () => {
    const count = invokes.length
    for (const id of ['', 'bad id', '../outside', 'a'.repeat(81), {}, null]) {
      assert(!api.isGitViewId(id))
      await assert.rejects(api.gitAPI.selectGitDirectory(id))
      await assert.rejects(api.gitAPI.cancelGitRead(id))
      await assert.rejects(api.gitAPI.releaseGitView(id))
    }
    let reads = 0
    const getter = { ...listRequest }
    Object.defineProperty(getter, 'requestId', {
      enumerable: true,
      get: () => {
        reads++
        return 'request-list'
      }
    })
    assert.equal(api.parseGitListRequest(getter), null)
    assert.equal(reads, 0)
    assert.equal(
      api.parseGitListRequest(Object.assign(Object.create({ inherited: true }), listRequest)),
      null
    )
    assert.equal(api.parseGitListRequest({ ...listRequest, [Symbol('hidden')]: true }), null)
    assert(api.parseGitListRequest(Object.assign(Object.create(null), listRequest)))
    assert.equal(invokes.length, count)
  }
)

await suite.check(
  'five bridge methods invoke only fixed Git channels with canonical narrow arguments',
  async () => {
    const count = invokes.length
    assert.deepEqual(Object.keys(api.gitAPI).sort(), [
      'cancelGitRead',
      'readGitItem',
      'refreshGitView',
      'releaseGitView',
      'selectGitDirectory'
    ])
    reply = selection
    assert.deepEqual(await api.gitAPI.selectGitDirectory(selection.requestId), selection)
    reply = list
    assert.deepEqual(await api.gitAPI.refreshGitView(listRequest), list)
    reply = detail()
    assert.deepEqual(await api.gitAPI.readGitItem(itemRequest), reply)
    reply = { status: 'ready' }
    await api.gitAPI.cancelGitRead(listRequest.requestId)
    await api.gitAPI.releaseGitView(listRequest.viewId)
    assert.deepEqual(invokes.slice(count), [
      { channel: 'git:select', args: [selection.requestId] },
      { channel: 'git:list', args: [listRequest] },
      { channel: 'git:read', args: [itemRequest] },
      { channel: 'git:cancel', args: [listRequest.requestId] },
      { channel: 'git:release', args: [listRequest.viewId] }
    ])
  }
)

await suite.check(
  'preload refuses old request, view, revision and item responses including cancelled or failed ones',
  async () => {
    reply = { ...selection, requestId: 'older-selector' }
    await assert.rejects(api.gitAPI.selectGitDirectory(selection.requestId), /结果无效/)
    for (const field of ['requestId', 'viewId']) {
      reply = { ...list, [field]: 'older' }
      await assert.rejects(api.gitAPI.refreshGitView(listRequest), /结果无效/)
      reply = { ...listRequest, status: 'cancelled', [field]: 'older' }
      await assert.rejects(api.gitAPI.refreshGitView(listRequest), /结果无效/)
    }
    for (const field of ['requestId', 'viewId', 'revision', 'itemId']) {
      reply = { ...itemRequest, status: 'stale', error: '请刷新', [field]: 'older' }
      await assert.rejects(api.gitAPI.readGitItem(itemRequest), /结果无效/)
    }
  }
)

await suite.check(
  'same path staged and unstaged remain distinct list items; duplicate opaque IDs are invalid',
  () => {
    const unstaged = { ...item, itemId: 'item-2', group: 'unstaged' }
    const parsed = api.parseGitListResult({ ...list, items: [item, unstaged] })
    assert.deepEqual(
      parsed.items.map((entry) => [entry.itemId, entry.group, entry.path]),
      [
        ['item-1', 'staged', 'same-file.txt'],
        ['item-2', 'unstaged', 'same-file.txt']
      ]
    )
    assert.equal(
      api.parseGitListResult({ ...list, items: [item, { ...unstaged, itemId: 'item-1' }] }),
      null
    )
  }
)

await suite.check(
  'display paths preserve rename and difficult filenames while no result path becomes a request capability',
  () => {
    for (const name of [
      '中文 文件.txt',
      'line\nname.txt',
      '-leading.txt',
      ':(glob)*.txt',
      'quote".txt'
    ]) {
      const renamed = { ...item, change: 'renamed', path: name, previousPath: 'old ' + name }
      assert.deepEqual(api.parseGitChangeItem(renamed), renamed)
      assert.equal(api.parseGitItemRequest({ ...itemRequest, path: name }), null)
    }
    assert.equal(api.parseGitChangeItem({ ...item, path: 'nul\0name' }), null)
    assert.equal(api.parseGitChangeItem({ ...item, previousPath: 'nul\0name' }), null)
  }
)

await suite.check(
  'complete lists stop at 2000 items and malformed or extra result fields cannot become a complete list',
  () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({
      ...item,
      itemId: 'bounded-' + index
    }))
    assert.equal(api.parseGitListResult({ ...list, items }).items.length, 2000)
    assert.equal(
      api.parseGitListResult({ ...list, items: [...items, { ...item, itemId: 'overflow' }] }),
      null
    )
    for (const extra of [
      { complete: false },
      { truncated: true },
      { commandOutput: 'raw' },
      { raw: [] }
    ])
      assert.equal(api.parseGitListResult({ ...list, ...extra }), null)
    assert.equal(api.parseGitListResult({ ...list, warnings: ['x'.repeat(501)] }), null)
  }
)

await suite.check(
  'item source is tied to group and format, including unborn HEAD and untracked content without a baseline',
  () => {
    assert(api.parseGitItemResult(detail()))
    assert(api.parseGitItemResult(detail('', { baseline: 'empty-index' })))
    assert(
      api.parseGitItemResult(
        detail('index→worktree', {
          item: { ...item, group: 'unstaged' },
          baseline: 'index-worktree'
        })
      )
    )
    assert(
      api.parseGitItemResult(
        detail('new text', {
          item: { ...item, group: 'untracked', change: 'added' },
          format: 'content',
          baseline: 'untracked'
        })
      )
    )
    for (const extra of [
      { format: 'content' },
      { baseline: 'index-worktree' },
      { baseline: 'untracked' },
      { item: { ...item, itemId: 'other' } }
    ])
      assert.equal(api.parseGitItemResult(detail('bad baseline', extra)), null)
  }
)

await suite.check(
  'UTF-8 byte and real line boundaries reject mislabeled, multibyte or partial over-limit content',
  () => {
    assert(api.parseGitItemResult(detail('x'.repeat(262144))))
    assert.equal(api.parseGitItemResult(detail('x'.repeat(262145))), null)
    assert.equal(api.parseGitItemResult(detail('中'.repeat(87382))), null)
    assert(api.parseGitItemResult(detail('\n'.repeat(3999))))
    assert.equal(api.parseGitItemResult(detail('\n'.repeat(4000))), null)
    assert.equal(api.parseGitItemResult(detail('中', { bytes: 1 })), null)
    assert.equal(api.parseGitItemResult(detail('a\r\nb', { lineCount: 3 })), null)
    assert.equal(api.parseGitItemResult(detail('text', { truncated: true })), null)
    for (const text of ['binary\0data', '\x1b[31mcolor', '\x7f'])
      assert.equal(api.parseGitItemResult(detail(text)), null)
  }
)

await suite.check(
  'unsupported special items and binary previews carry a reason and cannot be advertised as ready text',
  () => {
    const unsupported = {
      ...item,
      change: 'unmerged',
      previewable: false,
      reason: '冲突项首版不预览'
    }
    assert(api.parseGitChangeItem(unsupported))
    assert.equal(api.parseGitChangeItem({ ...unsupported, reason: null }), null)
    assert.equal(api.parseGitChangeItem({ ...item, reason: 'hidden unsupported' }), null)
    assert.equal(api.parseGitItemResult(detail('fake ready', { item: unsupported })), null)
    assert(api.parseGitItemResult({ ...itemRequest, status: 'unsupported', error: '二进制不预览' }))
  }
)

await suite.check(
  'bounded failures and cancellation preserve exact request identities and never include stale content',
  () => {
    for (const status of [
      'stale',
      'not-repository',
      'unavailable',
      'unsupported',
      'too-large',
      'error'
    ]) {
      assert(
        api.parseGitSelectionResult({
          requestId: selection.requestId,
          status,
          error: 'x'.repeat(500)
        })
      )
      assert(api.parseGitListResult({ ...listRequest, status, error: '明确失败' }))
      assert(api.parseGitItemResult({ ...itemRequest, status, error: '明确失败' }))
      assert.equal(api.parseGitItemResult({ ...itemRequest, status, error: 'x'.repeat(501) }), null)
    }
    assert(api.parseGitSelectionResult({ requestId: selection.requestId, status: 'cancelled' }))
    assert(api.parseGitListResult({ ...listRequest, status: 'cancelled' }))
    assert(api.parseGitItemResult({ ...itemRequest, status: 'cancelled' }))
    assert.equal(
      api.parseGitItemResult({
        ...itemRequest,
        status: 'stale',
        error: '刷新',
        text: 'old content'
      }),
      null
    )
  }
)

await suite.check(
  'control outcomes distinguish confirmed cleanup, stale identity and error rather than accepting booleans or kill-only flags',
  async () => {
    for (const value of [
      { status: 'ready' },
      { status: 'stale' },
      { status: 'error', error: '尚未确认退出' }
    ]) {
      reply = value
      assert.deepEqual(await api.gitAPI.cancelGitRead('request-cancel'), value)
      assert.deepEqual(await api.gitAPI.releaseGitView('view-release'), value)
    }
    for (const value of [
      true,
      false,
      { status: 'ready', killed: true },
      { status: 'cancelled' },
      { status: 'error' }
    ]) {
      assert.equal(api.parseGitControlResult(value), null)
      reply = value
      await assert.rejects(api.gitAPI.cancelGitRead('request-cancel'), /结果无效/)
    }
  }
)

await suite.check(
  'real common source guard rejects subframes, detached owners and dead window/document sources',
  () => {
    const sender = { mainFrame: {}, dead: false, isDestroyed: () => sender.dead }
    const window = { dead: false, isDestroyed: () => window.dead }
    windows.set(sender, window)
    const event = { sender, senderFrame: sender.mainFrame }
    const strict = { windowMustBeLive: true, senderMustBeLive: true }
    assert.equal(api.getIpcWindow(event, 'Git 来源无效', strict), window)
    assert.throws(
      () => api.getIpcWindow({ ...event, senderFrame: {} }, 'Git 来源无效', strict),
      /来源无效/
    )
    assert.throws(
      () => api.getIpcWindow({ sender: {}, senderFrame: {} }, 'Git 来源无效', strict),
      /来源无效/
    )
    window.dead = true
    assert.throws(() => api.getIpcWindow(event, 'Git 来源无效', strict), /来源无效/)
    window.dead = false
    sender.dead = true
    assert.throws(() => api.getIpcWindow(event, 'Git 来源无效', strict), /来源无效/)
  }
)

const oid = 'a'.repeat(40)
function ordinaryStatus(name, xy = 'MM', modes = ['100644', '100644', '100644']) {
  return `1 ${xy} N... ${modes.join(' ')} ${oid} ${oid} ${name}\0`
}
function renameStatus(name, previous, xy = 'R.') {
  return `2 ${xy} N... 100644 100644 100644 ${oid} ${oid} R100 ${name}\0${previous}\0`
}
function indexFixture({
  version = 2,
  hashFormat = 'sha1',
  entries = [],
  extensions = [],
  entryCount = entries.length
} = {}) {
  const hashBytes = hashFormat === 'sha1' ? 20 : 32
  const header = Buffer.alloc(12)
  header.write('DIRC')
  header.writeUInt32BE(version, 4)
  header.writeUInt32BE(entryCount, 8)
  const encoded = entries.map(({ name, mode = 0o100644, stage = 0, extended }) => {
    const pathname = Buffer.isBuffer(name) ? name : Buffer.from(name)
    const fixed = 42 + hashBytes
    const pathOffset = fixed + (extended === undefined ? 0 : 2)
    const entry = Buffer.alloc(Math.ceil((pathOffset + pathname.length + 1) / 8) * 8)
    entry.writeUInt32BE(mode, 24)
    entry.writeUInt16BE(
      Math.min(pathname.length, 0xfff) | (stage << 12) | (extended === undefined ? 0 : 0x4000),
      40 + hashBytes
    )
    if (extended !== undefined) entry.writeUInt16BE(extended, fixed)
    pathname.copy(entry, pathOffset)
    return entry
  })
  const encodedExtensions = extensions.map(
    ({ signature, bytes = Buffer.alloc(0), length = bytes.length }) => {
      const extension = Buffer.alloc(8)
      extension.write(signature, 0, 4, 'ascii')
      extension.writeUInt32BE(length, 4)
      return Buffer.concat([extension, bytes])
    }
  )
  const data = Buffer.concat([header, ...encoded, ...encodedExtensions])
  return Buffer.concat([data, createHash(hashFormat).update(data).digest()])
}

await suite.check(
  'actual NUL status parser preserves rename double paths and dual staged unstaged state',
  () => {
    const previous = 'scope/old 名.txt'
    const renamed = 'scope/new 名.txt'
    const bytes = Buffer.from(
      renameStatus(renamed, previous, 'RM') + ordinaryStatus('scope/both.txt')
    )
    const parsed = api.parseGitStatus(bytes, 'scope')
    assert.equal(parsed.length, 4)
    assert.deepEqual(
      parsed.map(({ group, change, path, previousPath }) => ({
        group,
        change,
        path,
        previousPath
      })),
      [
        { group: 'staged', change: 'renamed', path: renamed, previousPath: previous },
        { group: 'unstaged', change: 'modified', path: renamed, previousPath: null },
        { group: 'staged', change: 'modified', path: 'scope/both.txt', previousPath: null },
        { group: 'unstaged', change: 'modified', path: 'scope/both.txt', previousPath: null }
      ]
    )
    assert.equal(new Set(parsed.map(({ itemId }) => itemId)).size, parsed.length)
    assert(parsed.every(({ itemId }) => api.isGitViewId(itemId)))
    assert(parsed.every(({ previewable }) => previewable))
  }
)

await suite.check(
  'actual status parser treats spaces newlines leading dash brackets and BOM as literal filenames',
  () => {
    const names = [
      'scope/a b.txt',
      'scope/line\nbreak.txt',
      'scope/-option.txt',
      'scope/[ab]*?.txt',
      'scope/\ufeffBOM.txt'
    ]
    const parsed = api.parseGitStatus(
      Buffer.from(names.map((name) => '? ' + name + '\0').join('')),
      'scope'
    )
    assert.deepEqual(
      parsed.map(({ path }) => path),
      names
    )
    assert.equal(parsed[1].previewable, false)
    assert.match(parsed[1].reason, /控制字符/)
    assert(parsed.filter((_, index) => index !== 1).every(({ previewable }) => previewable))
    for (const name of [
      '../escape',
      '/absolute',
      'scope/../escape',
      'scope/.git/config',
      'scope/:magic.txt',
      'scope/\\escape',
      'outside/file.txt'
    ])
      assert.throws(() => api.parseGitStatus(Buffer.from('? ' + name + '\0'), 'scope'), /路径|范围/)
    assert.throws(() => api.parseGitStatus(Buffer.from('? :(glob)*\0'), ''), /路径|范围/)
  }
)

await suite.check(
  'actual status parser bounds records and marks cross-scope rename conflict submodule and symlink unsupported',
  () => {
    const crossing = api.parseGitStatus(
      Buffer.from(renameStatus('scope/new.txt', 'outside/old.txt')),
      'scope'
    )
    assert.equal(crossing[0].previousPath, 'outside/old.txt')
    assert.equal(crossing[0].previewable, false)
    assert.match(crossing[0].reason, /跨查看范围/)
    for (const mode of ['120000', '160000']) {
      const special = api.parseGitStatus(
        Buffer.from(ordinaryStatus('scope/special', '.M', ['100644', mode, mode])),
        'scope'
      )
      assert.equal(special[0].previewable, false)
      assert.match(special[0].reason, /符号链接或子模块/)
    }
    const conflict = api.parseGitStatus(
      Buffer.from(
        `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} scope/conflict.txt\0`
      ),
      'scope'
    )
    assert.equal(conflict[0].change, 'unmerged')
    assert.equal(conflict[0].previewable, false)
    for (const bytes of [
      Buffer.from('? partial'),
      Buffer.from('unknown\0'),
      Buffer.from('1 M.\0'),
      Buffer.from(renameStatus('scope/a', '').slice(0, -1))
    ])
      assert.throws(() => api.parseGitStatus(bytes, 'scope'), /协议|记录|路径/)
    assert.equal(
      api.parseGitStatus(
        Buffer.from(Array.from({ length: 2000 }, (_, i) => '? scope/f' + i + '\0').join('')),
        'scope'
      ).length,
      2000
    )
    assert.throws(
      () =>
        api.parseGitStatus(
          Buffer.from(Array.from({ length: 2001 }, (_, i) => '? scope/f' + i + '\0').join('')),
          'scope'
        ),
      /2000/
    )
    assert.throws(() => api.parseGitStatus(Buffer.alloc(1048577), ''), /1 MiB/)
  }
)

await suite.check(
  'actual strict UTF8 decoding preserves BOM bytes and rejects invalid filenames or content without replacement characters',
  () => {
    for (const bytes of [
      Buffer.from('\ufeff中文\r\n'),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a\n\t b')
    ]) {
      const text = api.decodeGitText(bytes)
      assert(Buffer.from(text).equals(bytes))
    }
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xe4, 0xb8]),
      Buffer.from([0xed, 0xa0, 0x80])
    ]) {
      assert.throws(() => api.decodeGitText(bytes), /非 UTF-8/)
      assert.throws(
        () =>
          api.parseGitStatus(Buffer.concat([Buffer.from('? scope/'), bytes, Buffer.from('\0')])),
        /非 UTF-8/
      )
      assert.throws(
        () =>
          api.parseIndex(
            indexFixture({ entries: [{ name: Buffer.concat([Buffer.from('scope/'), bytes]) }] }),
            'sha1'
          ),
        /非 UTF-8/
      )
    }
  }
)

await suite.check(
  'actual index v2 v3 SHA1 SHA256 grammar preserves stage mode literal names and optional uppercase extensions',
  () => {
    const entries = [
      { name: 'scope/a b.txt', mode: 0o100755, stage: 0 },
      { name: 'scope/line\nbreak.txt', stage: 1 },
      { name: '-option.txt', stage: 2 },
      { name: '\ufeffBOM.txt', stage: 3 }
    ]
    for (const version of [2, 3])
      for (const hashFormat of ['sha1', 'sha256']) {
        const bytes = indexFixture({
          version,
          hashFormat,
          entries,
          extensions: [{ signature: 'TREE', bytes: Buffer.from('opaque-data') }]
        })
        assert.deepEqual(
          api.parseIndex(bytes, hashFormat),
          entries.map(({ name, mode = 0o100644, stage }) => ({
            path: name,
            mode: mode.toString(8),
            stage
          }))
        )
      }
    assert.deepEqual(
      api.parseIndex(
        indexFixture({ version: 3, entries: [{ name: 'scope/intent.txt', extended: 0x2000 }] }),
        'sha1'
      ),
      [{ path: 'scope/intent.txt', mode: '100644', stage: 0 }]
    )
  }
)

await suite.check(
  'actual index parser structurally rejects split sparse unsupported versions malformed extents checksum and escaping paths',
  () => {
    for (const signature of ['link', 'sdir', 'mandatory'])
      assert.throws(
        () =>
          api.parseIndex(
            indexFixture({ extensions: [{ signature: signature.slice(0, 4) }] }),
            'sha1'
          ),
        /split\/sparse|必需/
      )
    assert.throws(
      () =>
        api.parseIndex(indexFixture({ entries: [{ name: 'scope/dir', mode: 0o40000 }] }), 'sha1'),
      /sparse/
    )
    assert.throws(
      () =>
        api.parseIndex(
          indexFixture({ version: 3, entries: [{ name: 'scope/skip.txt', extended: 0x4000 }] }),
          'sha1'
        ),
      /sparse\/skip/
    )
    assert.throws(
      () =>
        api.parseIndex(
          indexFixture({ version: 2, entries: [{ name: 'scope/extended.txt', extended: 0x2000 }] }),
          'sha1'
        ),
      /扩展/
    )
    for (const version of [0, 1, 4, 999])
      assert.throws(() => api.parseIndex(indexFixture({ version }), 'sha1'), /v2\/v3/)
    assert.throws(() => api.parseIndex(indexFixture({ entryCount: 1 }), 'sha1'), /项不完整/)
    assert.throws(() => api.parseIndex(indexFixture({ entryCount: 100001 }), 'sha1'), /读取上限/)
    assert.throws(
      () =>
        api.parseIndex(indexFixture({ extensions: [{ signature: 'TREE', length: 100 }] }), 'sha1'),
      /扩展越界/
    )
    const corrupted = indexFixture({ entries: [{ name: 'scope/a.txt' }] })
    corrupted[corrupted.length - 1] ^= 1
    assert.throws(() => api.parseIndex(corrupted, 'sha1'), /校验/)
    for (const name of [
      '../escape',
      '.git/config',
      'C:/absolute',
      'scope/../escape',
      '/absolute',
      'scope/\\escape'
    ])
      assert.throws(() => api.parseIndex(indexFixture({ entries: [{ name }] }), 'sha1'), /路径/)
  }
)

await suite.finish({
  invokedChannels: [...new Set(invokes.map((entry) => entry.channel))].sort(),
  syntheticInvokeCount: invokes.length
})
delete globalThis.__lesson61protocol
