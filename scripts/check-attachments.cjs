// Offline integration checks against production TS modules, isolated fixture files and Electron doubles.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const ts = require('typescript')
const originalLoad = Module._load
const handlers = new Map()
const owner = new EventEmitter()
owner.id = 42
owner.isDestroyed = () => false
owner.webContents = new EventEmitter()
owner.webContents.id = 142 // Deliberately different: grants and jobs must use BrowserWindow.id.
owner.webContents.isDestroyed = () => false
owner.webContents.mainFrame = {}
owner.webContents.send = () => undefined
const event = { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }
let pick
let pickerCalls = 0
const electron = {
  BrowserWindow: { fromWebContents: (sender) => (sender === owner.webContents ? owner : null) },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  dialog: {
    showOpenDialog: async (window, options) => {
      assert.equal(window, owner)
      assert(options.properties.includes('multiSelections'))
      assert(!options.properties.includes('openDirectory'))
      pickerCalls++
      return pick()
    }
  }
}
Module._load = function (request, parent, isMain) {
  return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain)
}
require.extensions['.ts'] = (module, filename) => {
  const source = require('node:fs').readFileSync(filename, 'utf8')
  module._compile(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    filename
  )
}
const {
  createAttachmentSnapshot,
  removeAttachment,
  createProjectExecutor
} = require('../src/main/tools/project-snapshot.ts')
const { runToolLoop } = require('../src/main/agent/tool-loop.ts')
const { executeTimeTool } = require('../src/main/tools/current-time.ts')
const { parseToolHistory, selectToolHistory } = require('../src/shared/agent-history.ts')
const { parseProjectSelectionResult } = require('../src/shared/project.ts')
const { parseLibrary } = require('../src/shared/conversation-library.ts')
const access = require('../src/main/agent/project-access.ts')
const agent = require('../src/main/agent/agent-ipc.ts')
const signal = new AbortController().signal
const final = (text) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text }]
    }
  ]
})
const call = (name, args, id) => ({
  status: 'completed',
  output: [{ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) }]
})

async function main() {
  const base = path.resolve(__dirname, 'fixtures')
  await fs.mkdir(base, { recursive: true })
  const directory = await fs.mkdtemp(path.join(base, 'attachments-'))
  try {
    await fs.mkdir(path.join(directory, 'a'))
    await fs.mkdir(path.join(directory, 'b'))
    const a = path.join(directory, 'a', 'same.ts')
    const b = path.join(directory, 'b', 'same.ts')
    await fs.writeFile(a, 'export const greet = "A"\n')
    await fs.writeFile(b, 'export const greet = "B"\n')
    const first = await createAttachmentSnapshot([a, b], signal)
    assert.equal(first.files.size, 2)
    assert.notEqual(first.selection.files[0].path, first.selection.files[1].path)
    assert(first.selection.files.every((file) => file.path.endsWith('/same.ts')))
    assert(!JSON.stringify(first.selection).includes(directory))
    assert(parseProjectSelectionResult({ status: 'selected', selection: first.selection }))
    const alias = first.selection.files[0].path
    const executor = createProjectExecutor(first)
    assert.equal(
      JSON.parse(await executor('read_project_file', { toString: () => '' }.toString(), signal))
        .error,
      'INVALID_ARGUMENTS'
    )
    assert.equal(
      JSON.parse(
        await executor(
          'read_project_file',
          JSON.stringify({ path: a, startLine: 1, endLine: 1 }),
          signal
        )
      ).error,
      'NOT_SELECTED'
    )
    await fs.writeFile(a, 'export const greet = "changed"\n')
    assert(first.files.get(alias)[0].includes('"A"'))
    const refreshed = await createAttachmentSnapshot([a], signal, first)
    assert.equal(refreshed.files.size, 2)
    assert(refreshed.files.get(alias)[0].includes('changed'))
    assert.notEqual(refreshed.selection.snapshotId, first.selection.snapshotId)
    const removed = removeAttachment(refreshed, alias)
    assert.equal(removed.files.size, 1)
    assert.equal(first.files.size, 2, 'old snapshots remain immutable')
    assert.equal(removeAttachment(removed, removed.selection.files[0].path), null)
    assert.throws(() => removeAttachment(first, '../other.txt'))
    const big = path.join(directory, 'large.txt')
    await fs.writeFile(big, Buffer.alloc(32769, 65))
    await assert.rejects(createAttachmentSnapshot([big], signal, first))
    assert.equal(first.files.size, 2)
    const invalid = path.join(directory, 'invalid.txt')
    await fs.writeFile(invalid, Buffer.from([0xff]))
    await assert.rejects(createAttachmentSnapshot([invalid], signal))
    await assert.rejects(createAttachmentSnapshot(['../outside.txt'], signal))
    const hard = path.join(directory, 'hard.ts')
    await fs.link(b, hard)
    await assert.rejects(createAttachmentSnapshot([hard], signal))
    await fs.unlink(hard)
    const linked = path.join(directory, 'linked')
    await fs.symlink(
      path.join(directory, 'a'),
      linked,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await assert.rejects(createAttachmentSnapshot([path.join(linked, 'same.ts')], signal))

    // One question can use time + search + read; no attachment scope must reject file tools.
    let round = 0
    const replies = [
      call('get_current_time', { timeZone: 'UTC' }, 't'),
      call('search_project_text', { query: 'greet' }, 's'),
      call('read_project_file', { path: alias, startLine: 1, endLine: 1 }, 'r'),
      final('完成')
    ]
    const scope = { kind: 'project', snapshotId: first.selection.snapshotId }
    const result = await runToolLoop(
      '查询时间和附件',
      async () => replies[round++],
      signal,
      [],
      undefined,
      [],
      async (name, args, currentSignal) =>
        name === 'get_current_time'
          ? executeTimeTool(name, args)
          : executor(name, args, currentSignal),
      scope
    )
    assert.equal(round, 4)
    assert(parseToolHistory(result.items, scope))
    assert.equal(parseToolHistory(result.items, { kind: 'time' }), null)
    let executed = false
    await assert.rejects(
      runToolLoop(
        'read',
        async () => replies[1],
        signal,
        [],
        undefined,
        [],
        async () => {
          executed = true
          return '{}'
        }
      )
    )
    assert.equal(executed, false)
    assert.equal((await runToolLoop('你好', async () => final('你好'), signal, [])).answer, '你好')
    const messages = [
      { id: 'u', role: 'user', content: '查询时间和附件', status: 'complete' },
      { id: 'a', role: 'assistant', content: '完成', status: 'complete' }
    ]
    const runs = [
      {
        requestId: 'q',
        userId: 'u',
        assistantId: 'a',
        mode: 'live',
        scope,
        trace: [],
        items: result.items
      }
    ]
    assert.equal(selectToolHistory(messages, runs, 'live', scope).length, result.items.length)
    assert.deepEqual(
      selectToolHistory(messages, runs, 'live', {
        kind: 'project',
        snapshotId: refreshed.selection.snapshotId
      }),
      []
    )
    assert(
      parseLibrary({
        version: 4,
        activeConversationId: 'c',
        conversations: [{ id: 'c', title: '附件', messages, toolRuns: runs }]
      })
    )

    const preparation = require('../src/main/agent/change-preparation-ipc.ts')
    agent.registerAgentPractice(preparation.hasChangePreparation)
    access.registerProjectAccess({
      isAgentJobActive: (id) => agent.hasAgentJob(id) || preparation.hasChangePreparation(id),
      onAccessChanged: preparation.cleanupChangePreparation,
      abortProjectJob: agent.abortProjectJob
    })
    pick = async () => ({ canceled: false, filePaths: [a] })
    let selected = await access.selectProjectFiles(owner, 'c')
    assert.equal(selected.status, 'selected')
    assert.equal(pickerCalls, 1, 'a single file picker without a directory step')
    assert.equal(access.captureProjectAccess(142, 'c', selected.selection.snapshotId), null)
    assert.equal(access.captureProjectAccess(42, 'other', selected.selection.snapshotId), null)
    assert(access.captureProjectAccess(42, 'c', selected.selection.snapshotId))
    const denied = await handlers.get('agent:start')(event, 'q-denied', '文件', 'live', [], {
      kind: 'project',
      snapshotId: selected.selection.snapshotId,
      conversationId: 'c',
      allowUpload: false
    })
    assert.equal(denied.status, 'error')
    const running = handlers.get('agent:start')(event, 'q-running', 'greet', 'mock', [], {
      kind: 'project',
      snapshotId: selected.selection.snapshotId,
      conversationId: 'c',
      allowUpload: false
    })
    assert(agent.hasAgentJob(42))
    assert.equal((await access.selectProjectFiles(owner, 'c')).status, 'error')
    const complete = await running
    assert.equal(complete.status, 'done', complete.error)
    assert(!agent.hasAgentJob(42))
    let release
    pick = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const picking = access.selectProjectFiles(owner, 'c')
    assert(access.hasProjectSelection(42))
    assert.equal(
      (await handlers.get('agent:start')(event, 'q-overlap', '你好', 'mock')).status,
      'error'
    )
    release({ canceled: true, filePaths: [] })
    assert.equal((await picking).status, 'cancelled')
    assert(
      access.captureProjectAccess(42, 'c', selected.selection.snapshotId),
      'cancel keeps old grant'
    )
    pick = async () => ({ canceled: false, filePaths: [b] })
    const appended = await access.selectProjectFiles(owner, 'c')
    assert.equal(appended.selection.files.length, 2)
    assert.equal(access.captureProjectAccess(42, 'c', selected.selection.snapshotId), null)
    selected = appended
    const change = handlers.get('project:remove')(
      event,
      'c',
      selected.selection.snapshotId,
      selected.selection.files[0].path
    )
    assert.equal(change.selection.files.length, 1)
    assert.equal(access.captureProjectAccess(42, 'c', selected.selection.snapshotId), null)
    pick = async () => ({ canceled: true, filePaths: [] })
    assert.equal((await access.selectProjectFiles(owner, 'c', true)).status, 'cancelled')
    assert(access.captureProjectAccess(42, 'c', change.selection.snapshotId))
    pick = async () => ({ canceled: false, filePaths: [a] })
    const replaced = await access.selectProjectFiles(owner, 'c', true)
    assert.equal(replaced.selection.files.length, 1, 'new draft excludes sent attachments')
    assert.equal(access.captureProjectAccess(42, 'c', change.selection.snapshotId), null)
    pick = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const late = access.selectProjectFiles(owner, 'c')
    access.cleanupProjectAccess(42)
    release({ canceled: false, filePaths: [a] })
    assert.equal((await late).status, 'cancelled')
    assert.equal(access.captureProjectAccess(42, 'c', change.selection.snapshotId), null)
    // Lesson 24: real bytes, production services, ownership and cancellation.
    const { prepareChange } = require('../src/main/tools/change-preparation.ts')
    const { parsePreparationRequest } = require('../src/shared/change-preparation.ts')
    const { createChangeProposalExecutor } = require('../src/main/tools/change-proposal.ts')
    const { createProjectMock } = require('../src/main/model/project-response.ts')
    const greet = path.join(directory, 'greet.ts')
    const original =
      'export function greet(name: string): string {\n  return \x60你好，' + '$' + '{name}\x60\n}\n'
    const candidate = original.replace('你好，', '欢迎，')
    await fs.writeFile(greet, original)
    const fixture = await createAttachmentSnapshot([greet], signal)
    const file = fixture.selection.files[0].path
    const before = await fs.readFile(greet)
    const mock = await runToolLoop(
      '模拟修改 greet',
      createProjectMock(fixture.selection),
      signal,
      [],
      () => {},
      [],
      createChangeProposalExecutor(fixture, 'c'),
      { kind: 'project', snapshotId: fixture.selection.snapshotId }
    )
    assert.equal(mock.answer, '已生成建议，未写入文件')
    assert.equal((await prepareChange(fixture, file, candidate, signal)).status, 'prepared')
    assert.deepEqual(await fs.readFile(greet), before)
    assert.equal((await prepareChange(fixture, file, original, signal)).status, 'no_change')
    assert.equal(
      (await prepareChange({ ...fixture, baselines: undefined }, file, candidate, signal)).status,
      'error'
    )
    assert.equal((await prepareChange(fixture, file, 'x'.repeat(2001), signal)).status, 'error')
    assert.equal((await prepareChange(fixture, file, '\uFEFFx', signal)).status, 'unsupported')
    for (const changed of [
      original.replace('你好', '您好'),
      original.replace(/\n/g, '\r\n'),
      '\uFEFF' + original
    ]) {
      await fs.writeFile(greet, changed)
      assert.equal((await prepareChange(fixture, file, candidate, signal)).status, 'conflict')
      assert.equal(await fs.readFile(greet, 'utf8'), changed)
    }
    for (const baseline of ['a\n', 'a\r\n', 'a', '\uFEFFa\r\n', 'a\nB\r\n', 'a\r']) {
      await fs.writeFile(greet, baseline)
      const snap = await createAttachmentSnapshot([greet], signal)
      const alias = snap.selection.files[0].path
      const result = await prepareChange(snap, alias, 'b\n', signal)
      if (baseline === 'a\nB\r\n' || baseline === 'a\r') assert.equal(result.status, 'unsupported')
      else {
        assert.equal(result.status, 'prepared')
        const expected =
          (baseline.startsWith('\uFEFF') ? '\uFEFF' : '') +
          (baseline.includes('\r\n') ? 'b\r\n' : 'b\n')
        assert.deepEqual(Buffer.from(result.candidateBytes), Buffer.from(expected))
        const empty = await prepareChange(snap, alias, '', signal)
        assert.equal(empty.candidateBytes.length, baseline.startsWith('\uFEFF') ? 3 : 0)
      }
      assert.equal(await fs.readFile(greet, 'utf8'), baseline)
    }
    await fs.unlink(greet)
    assert.equal((await prepareChange(fixture, file, candidate, signal)).status, 'conflict')
    await fs.writeFile(greet, original)
    const cancelled = new AbortController()
    const pendingRead = prepareChange(fixture, file, candidate, cancelled.signal)
    cancelled.abort()
    await assert.rejects(pendingRead)
    access.cleanupProjectAccess(42)
    pick = async () => ({ canceled: false, filePaths: [greet] })
    const granted = await access.selectProjectFiles(owner, 'c')
    preparation.registerChangePreparation(
      (id) => agent.hasAgentJob(id) || access.hasProjectSelection(id)
    )
    const req = {
      conversationId: 'c',
      snapshotId: granted.selection.snapshotId,
      path: granted.selection.files[0].path,
      proposedText: candidate,
      requestId: 'q',
      callId: 'call_project_mock_123',
      checkId: 'check-1'
    }
    assert(parsePreparationRequest(req))
    for (const invalid of [
      { ...req, extra: true },
      { ...req, path: greet },
      { ...req, proposedText: 'x'.repeat(2001) },
      Object.defineProperty({ ...req }, 'path', {
        get() {
          throw new Error('accessor must not run')
        }
      })
    ])
      assert.equal(parsePreparationRequest(invalid), null)
    const check = (value) => handlers.get('preparation:check')(event, value)
    const cancel = (id) => handlers.get('preparation:cancel')(event, id)
    assert.equal((await check({ ...req, conversationId: 'forged' })).status, 'error')
    await assert.rejects(handlers.get('preparation:check')({ ...event, senderFrame: {} }, req))
    const preparing = check(req)
    assert(preparation.hasChangePreparation(42))
    assert.equal((await access.selectProjectFiles(owner, 'c')).status, 'error')
    assert.equal(handlers.get('project:revoke')(event, req.snapshotId), false)
    assert.equal(
      (await handlers.get('agent:start')(event, 'blocked', '你好', 'mock')).status,
      'error'
    )
    assert.equal(cancel('wrong-check'), false)
    assert.equal(cancel(req.checkId), true)
    assert.equal((await preparing).status, 'error')
    assert(!preparation.hasChangePreparation(42))
    const ready = await check({ ...req, checkId: 'check-2' })
    assert.equal(ready.status, 'ready')
    assert(!JSON.stringify(ready).includes(directory))
    assert.equal(cancel('check-2'), true)
    assert.equal(cancel('check-2'), false)
    const invalidated = check({ ...req, checkId: 'check-3' })
    access.cleanupProjectAccess(42)
    assert.equal((await invalidated).status, 'error')
    assert.equal(cancel('check-3'), false)
    assert.deepEqual(await fs.readFile(greet), before)
    if (process.env.LESSON24_LIVE_CHECK === '1') {
      process.loadEnvFile(path.resolve(__dirname, '../.env.local'))
      pick = async () => ({ canceled: false, filePaths: [greet] })
      const liveGrant = await access.selectProjectFiles(owner, 'c')
      const result = await handlers.get('agent:start')(
        event,
        'lesson24-live',
        '请完整读取 greet.ts，把问候语你好改成欢迎，保留其他内容，通过 propose_file_change 提交修改建议。不要实际写入文件。',
        'live',
        [],
        {
          kind: 'project',
          snapshotId: liveGrant.selection.snapshotId,
          conversationId: 'c',
          allowUpload: true
        }
      )
      const proposalCall = result.items?.find(
        (item) => item.type === 'function_call' && item.name === 'propose_file_change'
      )
      const success =
        result.status === 'done' &&
        !!proposalCall &&
        result.items.some(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === proposalCall.call_id &&
            JSON.parse(item.output).status === 'proposal_ready'
        )
      assert(
        success,
        'Live model did not return a successful proposal: ' +
          result.status +
          ' ' +
          (result.error || '')
      )
      const args = JSON.parse(proposalCall.arguments)
      const prepared = await check({
        ...req,
        snapshotId: liveGrant.selection.snapshotId,
        path: args.path,
        proposedText: args.proposedText,
        checkId: 'live-check'
      })
      assert.equal(prepared.status, 'ready')
      assert.deepEqual(await fs.readFile(greet), before)
      preparation.cleanupChangePreparation(42)
      access.cleanupProjectAccess(42)
      console.log(
        'Live model passed: complete read → successful proposal → ready; source bytes unchanged.'
      )
    }
    console.log(
      'Lesson 24 passed: mock proposal chain, byte baselines, BOM/LF/CRLF/empty, conflicts, bounds, cancellation, ownership, mutual exclusion and invalidation; source bytes unchanged.'
    )
    console.log(
      'Attachments passed: direct picker, aliases, snapshots, bounds, links, mixed tools, history, ownership, consent, cancellation and cleanup.'
    )
  } finally {
    // Delete only this script's verified temporary fixture directory.
    assert(path.dirname(directory) === base && path.basename(directory).startsWith('attachments-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
