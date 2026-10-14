import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, checksFor } from '../lesson57/runtime.mjs'

const evidence = path.join(root, '.ui-check/test-runs/lesson62', 'skills-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const userData = path.join(evidence, 'user-data')
await fs.mkdir(userData)
const handlers = new Map(),
  windows = new Map(),
  reads = [],
  opened = [],
  events = new EventEmitter()
const source = new EventEmitter()
source.mainFrame = {}
source.isDestroyed = () => false
const window = new EventEmitter()
window.id = 62
window.webContents = source
window.isDestroyed = () => false
windows.set(source, window)
const event = { sender: source, senderFrame: source.mainFrame }
globalThis.__lesson62skills = {
  BrowserWindow: { fromWebContents: (contents) => windows.get(contents) },
  ipcMain: {
    handle: (channel, handler) => {
      assert(!handlers.has(channel))
      handlers.set(channel, handler)
    }
  },
  ipcRenderer: {
    invoke: async (channel, ...args) => handlers.get(channel)(event, ...args),
    on: (channel, listener) => events.on(channel, listener),
    removeListener: (channel, listener) => events.removeListener(channel, listener)
  },
  shell: {
    openPath: async (filename) => {
      opened.push(filename)
      return ''
    }
  },
  reads
}
const outfile = path.join(evidence, 'skills.cjs')
const bundled = await build({
  stdin: {
    contents: [
      'src/shared/skills.ts',
      'src/main/skills/skill-reader.ts',
      'src/main/skills/skill-service.ts',
      'src/main/skills/skills-ipc.ts',
      'src/preload/skills-api.ts',
      'src/main/skills/windows-skill-objects.ts',
      'src/main/agent/skill-message.ts',
      'src/main/storage/conversation-store.ts'
    ]
      .map((filename) => `export * from ${JSON.stringify('./' + filename)};`)
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
      name: 'synthetic-electron-and-observed-real-filesystem',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|node:fs\/promises)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'electron'
              ? 'export const {BrowserWindow,ipcMain,ipcRenderer,shell}=globalThis.__lesson62skills;'
              : `const real=require('fs/promises'); export const {lstat,opendir,realpath,mkdir,readFile,writeFile,rename,rm}=real;
             export async function open(filename,flags){const handle=await real.open(filename,flags);
             const original=handle.read.bind(handle);handle.read=async (...args)=>{
             const result=await original(...args);globalThis.__lesson62skills.reads.push({filename,
             position:args[3],requested:args[2],bytes:result.bytesRead});
             await globalThis.__lesson62skills.afterRead?.(filename,args,result);return result};return handle}`,
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(bundled.metafile.inputs)
      .filter((name) => name !== '<stdin>' && !name.startsWith('fixture:'))
      .map(async (name) => [name, hash(await fs.readFile(path.resolve(root, name)))])
  )
)
const api = createRequire(import.meta.url)(outfile)
api.registerSkills(userData)
api.attachSkillsCleanup(window)
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile)),
  actualReaderAndService: true,
  actualBoundedFileReads: true,
  actualIPCAndPreload: true,
  syntheticElectron: true,
  realModel: false,
  realExplorer: false
})
const skillRoot = path.join(userData, 'skills')
const body = '# 审查\n读取真实代码并报告证据。\n'
const makeSource = (name = 'code-review', text = body) =>
  `---\nname: ${name}\ndescription: 阅读实际项目代码，给出审查问题。\n---\n\n${text}`
async function writeSkill(name, content) {
  const directory = path.join(skillRoot, name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'SKILL.md'), content)
}
async function pick(conversationId = 'conversation-62') {
  const list = await api.skillsAPI.listSkills(conversationId)
  assert.equal(list.status, 'ok', JSON.stringify(list))
  const descriptor = list.skills.find(
    (item) => item.status === 'available' && item.name === 'code-review'
  )
  assert(descriptor)
  const prepared = await api.skillsAPI.prepareSkill(
    conversationId,
    descriptor.skillId,
    list.generation
  )
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared))
  return { list, descriptor, selection: prepared.selection }
}
await suite.check(
  'startup and discovery never create a missing root or open Explorer',
  async () => {
    assert.deepEqual([...handlers.keys()].sort(), [
      'skills:discard-conversation',
      'skills:list',
      'skills:open-directory',
      'skills:prepare',
      'skills:release',
      'skills:release-conversation'
    ])
    const listed = await api.skillsAPI.listSkills('empty-conversation')
    assert.equal(listed.status, 'ok')
    assert.deepEqual(listed.skills, [])
    await assert.rejects(fs.lstat(skillRoot), { code: 'ENOENT' })
    assert.equal(opened.length, 0)
    assert.equal(reads.length, 0)
  }
)
await suite.check(
  'explicit open creates and opens only the fixed application directory',
  async () => {
    const result = await api.skillsAPI.openSkillsDirectory()
    assert.deepEqual(result, { status: 'opened', root: skillRoot })
    assert.deepEqual(opened, [skillRoot])
  }
)
await writeSkill('code-review', makeSource())
await suite.check(
  'discovery reads only bounded header bytes and isolates malformed entries',
  async () => {
    await writeSkill('bad-header', '---\nname: bad-header\ndescription: "quoted"\n---\nbody')
    await writeSkill(
      'invalid-body',
      Buffer.concat([Buffer.from(makeSource('invalid-body', '')), Buffer.from([255])])
    )
    const before = reads.length
    const listed = await api.skillsAPI.listSkills('metadata-conversation')
    assert.equal(listed.status, 'ok')
    assert.equal(listed.skills.length, 3)
    assert.equal(
      listed.skills.find((item) => item.directoryName === 'bad-header').status,
      'unavailable'
    )
    assert.equal(
      listed.skills.find((item) => item.directoryName === 'invalid-body').status,
      'available'
    )
    const headerBytes = Buffer.byteLength(makeSource().split('\n\n')[0] + '\n')
    const actual = reads
      .slice(before)
      .filter((read) => read.filename.endsWith(path.join('code-review', 'SKILL.md')))
    assert.equal(actual.length, headerBytes * 2)
    assert(actual.every((read) => read.requested === 1 && read.position < headerBytes))
    const bad = listed.skills.find((item) => item.directoryName === 'invalid-body')
    const selected = await api.skillsAPI.prepareSkill(
      'metadata-conversation',
      bad.skillId,
      listed.generation
    )
    assert.equal(selected.status, 'error')
    assert.match(selected.error, /UTF-8/)
  }
)
await suite.check(
  'strict frontmatter supports BOM/CRLF and rejects extensions duplicate fields names and limits',
  async () => {
    const good = '\ufeff' + makeSource().replaceAll('\n', '\r\n')
    await writeSkill('code-review', good)
    const { selection } = await pick('format-conversation')
    const snapshot = await api.freezePreparedSkill(
      62,
      'format-conversation',
      selection.selectionId,
      new AbortController().signal
    )
    assert.equal(snapshot.body, body.replaceAll('\n', '\r\n'))
    assert.equal(snapshot.sourceHash, hash(Buffer.from(good)))
    assert(api.validateSkillSnapshotHash(snapshot))
    const invalid = [
      makeSource().replace('description:', 'extra: nope\ndescription:'),
      makeSource().replace('description:', 'name: code-review\ndescription:'),
      makeSource().replace('name: code-review', 'name: wrong-name'),
      makeSource().replace(
        'description: 阅读实际项目代码，给出审查问题。',
        'description: |\n  nested'
      ),
      makeSource().replace(
        'description: 阅读实际项目代码，给出审查问题。',
        'description: ' + 'x'.repeat(501)
      ),
      makeSource('code-review', ''),
      makeSource('code-review', 'x'.repeat(12001)),
      '---\nname: code-review\ndescription: ' + 'x'.repeat(4096) + '\n---\nbody',
      Buffer.alloc(65537, 65),
      Buffer.from([255, 255])
    ]
    for (const content of invalid) {
      await writeSkill('code-review', content)
      await assert.rejects(api.readSkillSnapshot(skillRoot, 'code-review'))
    }
    for (const name of [
      'con',
      'aux',
      'nul',
      'com1',
      'lpt9',
      'Uppercase',
      'a--b',
      '../escape',
      'bad.name'
    ])
      assert.equal(api.isSkillName(name), false)
    await writeSkill('code-review', makeSource())
  }
)
await suite.check(
  'opaque selections bind window conversation and discovery generation',
  async () => {
    const chosen = await pick('owner-conversation')
    await assert.rejects(
      api.freezePreparedSkill(
        63,
        'owner-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      ),
      /属于/
    )
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'other-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      ),
      /属于/
    )
    assert.equal(api.releaseSkill(63, 'owner-conversation', chosen.selection.selectionId), false)
    const refresh = await api.skillsAPI.listSkills('owner-conversation')
    assert.equal(refresh.status, 'ok')
    const stale = await api.skillsAPI.prepareSkill(
      'owner-conversation',
      chosen.descriptor.skillId,
      chosen.list.generation
    )
    assert.equal(stale.status, 'error')
    const frozen = await api.freezePreparedSkill(
      62,
      'owner-conversation',
      chosen.selection.selectionId,
      new AbortController().signal
    )
    assert.equal(frozen.body, body)
    assert(api.releaseSkill(62, 'owner-conversation', chosen.selection.selectionId))
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'owner-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      )
    )
  }
)
await suite.check(
  'first freeze refuses changed deleted replaced source and pre-aborted requests',
  async () => {
    let chosen = await pick('changed-conversation')
    await writeSkill('code-review', makeSource('code-review', '# changed'))
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'changed-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      ),
      /变化/
    )
    await writeSkill('code-review', makeSource())
    chosen = await pick('deleted-conversation')
    const filename = path.join(skillRoot, 'code-review/SKILL.md')
    await fs.rename(filename, filename + '.previous')
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'deleted-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      )
    )
    await fs.writeFile(filename, makeSource())
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'deleted-conversation',
        chosen.selection.selectionId,
        new AbortController().signal
      ),
      /变化/
    )
    chosen = await pick('aborted-conversation')
    const controller = new AbortController()
    controller.abort()
    const count = reads.length
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        'aborted-conversation',
        chosen.selection.selectionId,
        controller.signal
      ),
      /取消/
    )
    assert.equal(reads.length, count)
  }
)
await suite.check(
  'selection replacement keeps old references until release and rejects late cancelled preparation',
  async () => {
    const selected = await pick('replacement-conversation')
    const next = await api.skillsAPI.prepareSkill(
      'replacement-conversation',
      selected.descriptor.skillId,
      selected.list.generation
    )
    assert.equal(next.status, 'prepared')
    assert(api.releaseSkill(62, 'replacement-conversation', selected.selection.selectionId))
    const frozen = await api.freezePreparedSkill(
      62,
      'replacement-conversation',
      next.selection.selectionId,
      new AbortController().signal
    )
    assert.equal(frozen.body, body)
    let fired = false
    globalThis.__lesson62skills.afterRead = () => {
      if (fired) return
      fired = true
      api.releaseConversationSkills(62, 'replacement-conversation')
    }
    try {
      const late = await api.skillsAPI.prepareSkill(
        'replacement-conversation',
        selected.descriptor.skillId,
        selected.list.generation
      )
      assert(fired)
      assert.equal(late.status, 'error')
      await assert.rejects(
        api.freezePreparedSkill(
          62,
          'replacement-conversation',
          next.selection.selectionId,
          new AbortController().signal
        )
      )
    } finally {
      delete globalThis.__lesson62skills.afterRead
    }
  }
)
await suite.check(
  'file mutation during actual fixed-handle reading never publishes a snapshot',
  async () => {
    let fired = false
    globalThis.__lesson62skills.afterRead = async (filename) => {
      if (fired || !filename.endsWith(path.join('code-review', 'SKILL.md'))) return
      fired = true
      await fs.writeFile(filename, makeSource('code-review', '# mutation during read'))
    }
    try {
      await assert.rejects(api.readSkillSnapshot(skillRoot, 'code-review'), /变化/)
      assert(fired)
    } finally {
      delete globalThis.__lesson62skills.afterRead
      await writeSkill('code-review', makeSource())
    }
  }
)
await suite.check(
  'ordinary object checks reject multi-hardlinks and directory junctions without following them',
  async () => {
    const filename = path.join(skillRoot, 'code-review/SKILL.md')
    const link = path.join(evidence, 'hard-linked.md')
    await fs.link(filename, link)
    await assert.rejects(api.readSkillSnapshot(skillRoot, 'code-review'), /硬链接/)
    await fs.unlink(link)
    const outside = path.join(evidence, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'SKILL.md'), makeSource('junction-skill'))
    await fs.symlink(outside, path.join(skillRoot, 'junction-skill'), 'junction')
    const proof = await api.checkWindowsSkillObjects([path.join(skillRoot, 'junction-skill')])
    if (process.platform === 'win32')
      assert.equal(proof.get(path.join(skillRoot, 'junction-skill')).ordinary, false)
    const count = reads.length
    await assert.rejects(api.readSkillSnapshot(skillRoot, 'junction-skill'), /链接|联接/)
    assert.equal(reads.length, count)
  }
)
await suite.check(
  'Windows attribute input preserves Unicode and literal shell characters as structured data',
  async () => {
    const directory = path.join(evidence, '中文引用 $() ` (literal)')
    await fs.mkdir(directory)
    const proof = await api.checkWindowsSkillObjects([directory])
    if (process.platform === 'win32') assert.equal(proof.get(directory).ordinary, true)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(api.checkWindowsSkillObjects([directory], cancelled.signal))
  }
)
await suite.check(
  'discovery enforces 64 entries and prepare/header/full-size remain bounded',
  async () => {
    const otherRoot = path.join(evidence, 'many-skills')
    await fs.mkdir(otherRoot)
    for (let index = 0; index < 65; index++) await fs.mkdir(path.join(otherRoot, 'entry-' + index))
    await assert.rejects(api.listSkillDirectories(otherRoot), /64/)
    const selected = await pick('bounded-conversation')
    const snapshot = await api.freezePreparedSkill(
      62,
      'bounded-conversation',
      selected.selection.selectionId,
      new AbortController().signal
    )
    assert(api.validateSkillSnapshotHash(snapshot))
    assert(reads.every((read) => read.requested <= 65537 && read.position <= 65537))
  }
)
await suite.check(
  'strict structure rejects extra paths authority getters symbols and inconsistent hashes',
  () => {
    const snapshot = api.createSkillSnapshot(
      { name: 'code-review', description: '审查' },
      body,
      'a'.repeat(64)
    )
    for (const property of ['path', 'tools', 'approval', 'script', 'root'])
      assert.equal(api.parseSkillSnapshot({ ...snapshot, [property]: 'injected' }), null)
    let getterReads = 0
    const accessor = Object.defineProperty({ ...snapshot }, 'body', {
      enumerable: true,
      get() {
        getterReads++
        return body
      }
    })
    assert.equal(api.parseSkillSnapshot(accessor), null)
    assert.equal(getterReads, 0)
    assert.equal(api.parseSkillSnapshot({ ...snapshot, [Symbol('authority')]: true }), null)
    assert.equal(
      api.parseSkillSnapshot(Object.assign(Object.create({ inherited: true }), snapshot)),
      null
    )
    assert.equal(api.validateSkillSnapshotHash({ ...snapshot, body: body + 'changed' }), false)
    assert.equal(api.parseSkillReference({ kind: 'selection', selectionId: '../escape' }), null)
    assert.equal(api.parseSkillReference({ kind: 'message', messageId: 'message', snapshot }), null)
  }
)
await suite.check(
  'accepted snapshots persist after release, bound without eviction, and retire only identical successful saves',
  () => {
    const snapshot = api.createSkillSnapshot(
      { name: 'code-review', description: '审查' },
      body,
      'b'.repeat(64)
    )
    for (let index = 0; index < 128; index++)
      api.rememberAcceptedSkill(72, 'accepted-conversation', 'message-' + index, snapshot)
    assert.throws(
      () => api.rememberAcceptedSkill(72, 'accepted-conversation', 'overflow', snapshot),
      /保存/
    )
    assert.deepEqual(api.getAcceptedSkill(72, 'accepted-conversation', 'message-0'), snapshot)
    const changed = api.createSkillSnapshot(
      { name: 'code-review', description: '审查' },
      body + 'changed',
      'b'.repeat(64)
    )
    assert.throws(
      () => api.rememberAcceptedSkill(72, 'accepted-conversation', 'message-0', changed),
      /不能替换/
    )
    assert.equal(api.getAcceptedSkill(73, 'accepted-conversation', 'message-0'), null)
    assert.equal(api.getAcceptedSkill(72, 'other-conversation', 'message-0'), null)
    api.releasePersistedSkills(72, [
      {
        conversationId: 'accepted-conversation',
        messageId: 'message-0',
        snapshotHash: 'c'.repeat(64)
      }
    ])
    assert(api.getAcceptedSkill(72, 'accepted-conversation', 'message-0'))
    const before = reads.length
    api.releasePersistedSkills(72, [
      {
        conversationId: 'accepted-conversation',
        messageId: 'message-0',
        snapshotHash: snapshot.snapshotHash
      }
    ])
    assert.equal(api.getAcceptedSkill(72, 'accepted-conversation', 'message-0'), null)
    assert.equal(reads.length, before)
    api.rememberAcceptedSkill(72, 'accepted-conversation', 'after-save', snapshot)
    const returned = api.getAcceptedSkill(72, 'accepted-conversation', 'after-save')
    returned.body = 'renderer mutation'
    assert.equal(api.getAcceptedSkill(72, 'accepted-conversation', 'after-save').body, body)
    api.releaseConversationSkills(72, 'accepted-conversation')
    assert(api.getAcceptedSkill(72, 'accepted-conversation', 'after-save'))
    api.discardConversationSkills(72, 'accepted-conversation')
    assert.equal(api.getAcceptedSkill(72, 'accepted-conversation', 'after-save'), null)
  }
)
await suite.check(
  'store write sequence rejects renderer-forged valid hashes, stripping, substitution and cross-message copies',
  async () => {
    const snapshot = api.createSkillSnapshot(
      { name: 'code-review', description: '保存来源' },
      body,
      'd'.repeat(64)
    )
    const directory = path.join(evidence, 'provenance-store')
    const store = api.createConversationStore(directory)
    const conv = {
      id: 'provenance-conversation',
      title: '来源验收',
      pinned: false,
      archived: false,
      defaultDirectory: evidence,
      agentMode: 'plan',
      toolRuns: [],
      workspace: null,
      tasks: [],
      messages: [
        {
          id: 'original-message',
          role: 'user',
          content: '审查',
          status: 'complete',
          mode: 'plan',
          skill: snapshot
        }
      ]
    }
    const library = { version: 9, activeConversationId: conv.id, conversations: [conv] }
    const guarded = (value) =>
      store.save(value, (checked, existing) =>
        api.assertConversationSkillSources(82, checked, existing)
      )
    assert.equal((await guarded(library)).ok, false)
    await assert.rejects(fs.stat(path.join(directory, 'conversation.json')), { code: 'ENOENT' })
    api.rememberAcceptedSkill(82, conv.id, 'original-message', snapshot)
    const strippedFresh = structuredClone(library)
    delete strippedFresh.conversations[0].messages[0].skill
    assert.equal((await guarded(strippedFresh)).ok, false)
    assert.equal((await guarded(library)).ok, true)
    const original = await fs.readFile(path.join(directory, 'conversation.json'))
    api.releasePersistedSkills(82, [
      {
        conversationId: conv.id,
        messageId: 'original-message',
        snapshotHash: snapshot.snapshotHash
      }
    ])
    assert.equal(api.getAcceptedSkill(82, conv.id, 'original-message'), null)
    const changed = structuredClone(library)
    changed.conversations[0].messages[0].skill = api.createSkillSnapshot(
      { name: 'code-review', description: '保存来源' },
      body + 'new',
      'e'.repeat(64)
    )
    const copied = structuredClone(library)
    copied.conversations[0].messages[0].id = 'forged-message'
    for (const invalid of [strippedFresh, changed, copied]) {
      assert.equal((await guarded(invalid)).ok, false)
      assert.deepEqual(await fs.readFile(path.join(directory, 'conversation.json')), original)
    }
    api.configureSavedSkillMessageLookup(async (conversationId, messageId) => {
      const loaded = await store.load()
      assert(loaded.ok)
      const source = loaded.snapshot.conversations
        .find((item) => item.id === conversationId)
        ?.messages.find((item) => item.id === messageId)
      if (!source) throw new Error('原消息不存在')
      return source.skill ?? null
    })
    assert.deepEqual(await api.readSkillMessage(82, conv.id, 'original-message'), snapshot)
    const truncated = structuredClone(library)
    truncated.conversations[0].messages = []
    assert.equal((await guarded(truncated)).ok, true)
    api.releasePersistedSkills(82, [])
    // The original saved source survives asynchronous history truncation for edit/retry.
    assert.deepEqual(await api.readSkillMessage(82, conv.id, 'original-message'), snapshot)
    const edited = structuredClone(library)
    edited.conversations[0].messages[0].id = 'edited-message'
    api.rememberAcceptedSkill(82, conv.id, 'edited-message', snapshot)
    assert.equal((await guarded(edited)).ok, true)
    assert.deepEqual((await store.load()).snapshot.conversations[0].messages[0].skill, snapshot)
  }
)
await suite.check(
  'saved-reference cache is independent of unsaved acceptance budget and preserves removed edit references',
  async () => {
    const snapshot = api.createSkillSnapshot(
      { name: 'code-review', description: '原引用缓存' },
      body,
      'f'.repeat(64)
    )
    api.configureSavedSkillMessageLookup(async () => snapshot)
    for (let index = 0; index < 150; index++)
      assert.deepEqual(
        await api.readSkillMessage(84, 'history-conversation', 'saved-' + index),
        snapshot
      )
    assert.equal(api.getAcceptedSkill(84, 'history-conversation', 'saved-149'), null)
    for (let index = 0; index < 128; index++)
      api.rememberAcceptedSkill(84, 'history-conversation', 'new-' + index, snapshot)
    api.releasePersistedSkills(84, [])
    assert.throws(
      () => api.rememberSavedSkillReference(84, 'history-conversation', 'one-more-edit', snapshot),
      /编辑引用过多/
    )
    assert(api.getSavedSkillReference(84, 'history-conversation', 'saved-149'))
    assert(api.getAcceptedSkill(84, 'history-conversation', 'new-0'))
    api.cleanupSkills(84)
  }
)
await suite.check(
  'explicit conversation discard retires unsaved capacity without clearing other owners or conversations',
  async () => {
    const snapshot = api.createSkillSnapshot(
      { name: 'code-review', description: '清空回收' },
      body,
      '1'.repeat(64)
    )
    for (let index = 0; index < 128; index++)
      api.rememberAcceptedSkill(
        62,
        index === 127 ? 'retained-conversation' : 'discarded-conversation',
        'message-' + index,
        snapshot
      )
    api.rememberAcceptedSkill(63, 'discarded-conversation', 'other-window-message', snapshot)
    assert.throws(
      () => api.rememberAcceptedSkill(62, 'discarded-conversation', 'over-budget', snapshot),
      /上限/
    )
    assert(await api.skillsAPI.releaseConversationSkills('discarded-conversation'))
    assert(api.getAcceptedSkill(62, 'discarded-conversation', 'message-0'))
    assert(await api.skillsAPI.discardConversationSkills('discarded-conversation'))
    assert.equal(api.getAcceptedSkill(62, 'discarded-conversation', 'message-0'), null)
    assert(api.getAcceptedSkill(62, 'retained-conversation', 'message-127'))
    assert(api.getAcceptedSkill(63, 'discarded-conversation', 'other-window-message'))
    api.rememberAcceptedSkill(62, 'new-conversation', 'after-clear', snapshot)
    assert(api.getAcceptedSkill(62, 'new-conversation', 'after-clear'))
  }
)
await suite.check(
  'IPC rejects unknown windows dead sources subframes and arbitrary path IDs before I/O',
  async () => {
    const count = reads.length
    for (const channel of handlers.keys()) {
      for (const bad of [
        { ...event, senderFrame: {} },
        { ...event, sender: { mainFrame: {} } }
      ])
        await assert.rejects(
          async () => handlers.get(channel)(bad, 'conversation', 'skill', 'generation'),
          /来源/
        )
    }
    for (const value of ['../escape', 'x'.repeat(81), {}, null])
      await assert.rejects(api.skillsAPI.listSkills(value), /标识/)
    assert.equal(reads.length, count)
  }
)
await suite.check(
  'acceptance listeners parse exact snapshots and cleanup invalidates selected materials',
  async () => {
    const selected = await pick('cleanup-conversation')
    const snapshot = await api.freezePreparedSkill(
      62,
      'cleanup-conversation',
      selected.selection.selectionId,
      new AbortController().signal
    )
    const accepted = []
    const unsubscribe = api.skillsAPI.onAgentSkillAccepted((value) => accepted.push(value))
    const valid = {
      requestId: 'request-62',
      conversationId: 'cleanup-conversation',
      messageId: 'message-62',
      snapshot
    }
    events.emit('agent:skill-accepted', {}, valid)
    events.emit('agent:skill-accepted', {}, { ...valid, path: 'injected' })
    assert.equal(accepted.length, 1)
    unsubscribe()
    events.emit('agent:skill-accepted', {}, valid)
    assert.equal(accepted.length, 1)
    api.rememberAcceptedSkill(62, valid.conversationId, valid.messageId, snapshot)
    source.emit('render-process-gone')
    assert.equal(api.getAcceptedSkill(62, valid.conversationId, valid.messageId), null)
    await assert.rejects(
      api.freezePreparedSkill(
        62,
        valid.conversationId,
        selected.selection.selectionId,
        new AbortController().signal
      )
    )
  }
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
await suite.finish({ actualBoundedReadOperations: reads.length, shellOpens: opened.length })
delete globalThis.__lesson62skills
