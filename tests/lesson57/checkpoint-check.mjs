import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createEvidence, compile, checksFor, fingerprint, message, call } from './runtime.mjs'

const evidence = await createEvidence('checkpoint-contract')
const { api, sourceHashes } = await compile(evidence, [
  'src/shared/task-checkpoint.ts',
  'src/main/storage/task-checkpoint-store.ts',
  'src/shared/agent-history.ts'
])
const counters = { unexpectedNetwork: 0 }
globalThis.fetch = () => {
  counters.unexpectedNetwork++
  throw new Error('Network denied')
}
const suite = checksFor(evidence, {
  ordinaryNode: true,
  realDisk: true,
  syntheticHistory: true,
  realTransport: false,
  sourceHashes
})
const scope = { kind: 'time', executionId: 'a'.repeat(64) }
const history = [
  { role: 'user', content: '原任务：核对固定业务。' },
  call('previous-call', 'get_current_time'),
  {
    type: 'function_call_output',
    call_id: 'previous-call',
    output: '{"ok":true,"pastObservation":"unchanged"}'
  },
  message('已有公开结论；不属于当前批准。'),
  { role: 'user', content: '仍需继续的中断轮。' },
  call('prefix-call', 'get_current_time'),
  { type: 'function_call_output', call_id: 'prefix-call', output: '{"ok":true}' }
]
async function fixture(label, extra = {}) {
  const directory = path.join(evidence, label + '-' + randomUUID())
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const bindings = { cwd: await api.captureTaskDirectoryBinding(cwd), workspace: null }
  const raw = extra.history ?? structuredClone(history)
  const checkpoint = api.createTaskCheckpoint({
    taskId: randomUUID(),
    conversationId: randomUUID(),
    mode: 'execute',
    prompt: '仍需继续的中断轮。',
    scope,
    bindings,
    history: raw,
    progress: 'interrupted',
    reason: 'host_exit',
    ...extra
  })
  const store = api.createTaskCheckpointStore(path.join(directory, 'checkpoints'))
  const saved = await store.save(checkpoint, raw)
  assert(saved.ok, JSON.stringify(saved))
  return {
    directory,
    cwd,
    bindings,
    checkpoint: saved.checkpoint,
    store,
    file: saved.file,
    history: raw
  }
}
async function mutate(item, update) {
  const checkpoint = JSON.parse(await fs.readFile(item.file, 'utf8'))
  update(checkpoint)
  await fs.writeFile(item.file, JSON.stringify(checkpoint))
  return checkpoint
}
async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code)
    return true
  })
}

await suite.check(
  'frozen version, schema unknown fields and authority-bearing fields are rejected',
  async () => {
    const item = await fixture('schema')
    assert(api.parseTaskCheckpoint(item.checkpoint))
    assert.equal(api.parseTaskCheckpoint({ ...item.checkpoint, schemaVersion: 2 }), null)
    for (const name of [
      'approval',
      'approvalMap',
      'readEvidence',
      'commandTicket',
      'windowId',
      'jobHandle',
      'pty',
      'apiKey',
      'hiddenReasoning',
      'imageDataURL',
      'httpBody'
    ]) {
      assert.equal(api.parseTaskCheckpoint({ ...item.checkpoint, [name]: 'forbidden' }), null, name)
    }
    for (const field of ['scope', 'bindings', 'raw']) {
      const value = structuredClone(item.checkpoint)
      value[field].permission = 'full-access'
      assert.equal(api.parseTaskCheckpoint(value), null, field)
    }
    const accessor = structuredClone(item.checkpoint)
    Object.defineProperty(accessor, 'mode', {
      enumerable: true,
      get() {
        throw new Error('getter must not run')
      }
    })
    assert.equal(api.parseTaskCheckpoint(accessor), null)
    assert.equal(
      api.parseTaskCheckpoint(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('proxy')
            }
          }
        )
      ),
      null
    )
    assert.equal(api.parseTaskCheckpoint({ ...item.checkpoint, prompt: 'X'.repeat(2001) }), null)
    assert.equal(api.parseTaskCheckpoint({ ...item.checkpoint, progress: 'running' }), null)
    assert.equal(
      api.parseTaskCheckpoint({ ...item.checkpoint, reason: 'unbounded-private-reason' }),
      null
    )
  }
)

await suite.check(
  'shared load preserves complete raw and creates fresh request UUIDs with bounded metadata',
  async () => {
    const item = await fixture('load')
    const a = await api.loadTaskCheckpoint(item.file)
    const b = await item.store.load(item.checkpoint.taskId)
    assert.deepEqual(a.history, item.history)
    assert.deepEqual(b.history, item.history)
    assert.match(a.requestId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
    assert.notEqual(a.requestId, b.requestId)
    assert.notEqual(a.requestId, item.checkpoint.taskId)
    assert.deepEqual(a.resume, {
      taskId: item.checkpoint.taskId,
      previousUpdatedAt: item.checkpoint.updatedAt,
      summaryStatus: 'absent'
    })
    assert.equal(a.summary, undefined)
    assert.deepEqual(await item.store.inspect(item.checkpoint.taskId), item.checkpoint)
    assert.deepEqual(
      await item.store.findByConversation(item.checkpoint.conversationId),
      item.checkpoint
    )
    return {
      requestIds: [a.requestId, b.requestId],
      rawFingerprint: fingerprint(a.history),
      taskId: item.checkpoint.taskId
    }
  }
)

await suite.check(
  'missing file and unsupported schema stop before starting any request',
  async () => {
    await rejectsCode(
      () => api.loadTaskCheckpoint(path.join(evidence, 'absent.json')),
      'CHECKPOINT_NOT_FOUND'
    )
    const item = await fixture('version')
    await mutate(item, (value) => {
      value.schemaVersion = 2
    })
    await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'CHECKPOINT_VERSION')
  }
)

await suite.check(
  'mode, scope capability, scope hash and project snapshot mismatches are explicit failures',
  async () => {
    const item = await fixture('intent')
    await rejectsCode(() => api.loadTaskCheckpoint(item.file, { mode: 'plan' }), 'MODE_MISMATCH')
    await rejectsCode(
      () => api.loadTaskCheckpoint(item.file, { scope: { kind: 'time' } }),
      'SCOPE_MISMATCH'
    )
    await rejectsCode(
      () =>
        api.loadTaskCheckpoint(item.file, {
          scope: { kind: 'project', snapshotId: 'different', executionId: 'b'.repeat(64) }
        }),
      'SCOPE_MISMATCH'
    )
    const rebound = await api.loadTaskCheckpoint(item.file, {
      scope: { kind: 'time', executionId: 'b'.repeat(64) }
    })
    assert.equal(rebound.scope.executionId, 'b'.repeat(64))
    assert.equal(rebound.history.length, item.history.length)
    const project = await fixture('project-scope', {
      scope: { kind: 'project', snapshotId: 'first-snapshot', executionId: 'a'.repeat(64) }
    })
    await rejectsCode(
      () =>
        api.loadTaskCheckpoint(project.file, {
          scope: { kind: 'project', snapshotId: 'changed-snapshot', executionId: 'b'.repeat(64) }
        }),
      'SCOPE_MISMATCH'
    )
    const sameProject = await api.loadTaskCheckpoint(project.file, {
      scope: { kind: 'project', snapshotId: 'first-snapshot', executionId: 'b'.repeat(64) }
    })
    assert.equal(sameProject.scope.snapshotId, 'first-snapshot')
    await mutate(item, (value) => {
      value.scopeFingerprint = '0'.repeat(64)
    })
    await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'SCOPE_MISMATCH')
  }
)

await suite.check(
  'directory path drift, directory replacement and workspace mismatch stop before raw hydration',
  async () => {
    const item = await fixture('directory')
    const other = path.join(item.directory, 'other')
    await fs.mkdir(other)
    await rejectsCode(() => api.loadTaskCheckpoint(item.file, { cwd: other }), 'DIRECTORY_DRIFT')
    await rejectsCode(
      () => api.loadTaskCheckpoint(item.file, { workspace: other }),
      'DIRECTORY_DRIFT'
    )
    await fs.rename(item.cwd, item.cwd + '-original')
    await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'DIRECTORY_MISSING')
    await fs.mkdir(item.cwd)
    await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'DIRECTORY_DRIFT')
  }
)

await suite.check(
  'missing raw, raw fingerprint change, dangling calls and malformed turns are refused',
  async () => {
    const missing = await fixture('missing-raw')
    const rawFile = path.resolve(path.dirname(missing.file), missing.checkpoint.raw.file)
    await fs.rename(rawFile, rawFile + '.preserved')
    await rejectsCode(() => api.loadTaskCheckpoint(missing.file), 'RAW_MISSING')
    const changed = await fixture('changed-raw')
    const changedFile = path.resolve(path.dirname(changed.file), changed.checkpoint.raw.file)
    await fs.writeFile(changedFile, JSON.stringify([...changed.history, message('tampered')]))
    await rejectsCode(() => api.loadTaskCheckpoint(changed.file), 'RAW_FINGERPRINT')
    for (const raw of [
      [...history, call('dangling', 'get_current_time')],
      [
        { role: 'user', content: 'ok' },
        { type: 'function_call_output', call_id: 'unseen', output: 'orphan' }
      ],
      [{ role: 'system', content: 'authority' }, message('bad')],
      [{ role: 'user', content: 'X'.repeat(2001) }, message('bad')]
    ])
      assert.equal(api.parseResumableHistory(raw, scope, 'execute'), null)
    assert.deepEqual(api.parseResumableHistory(history, scope, 'execute'), history)
  }
)

await suite.check(
  'persistent summary accepted only with matching complete raw source and content fingerprints',
  async () => {
    const summary = {
      sourceFingerprint: fingerprint(history),
      contentHash: fingerprint('历史低信任摘要'),
      content: '历史低信任摘要',
      workingItems: 5,
      workingCharacters: 300
    }
    const item = await fixture('summary-good', { summary })
    const loaded = await api.loadTaskCheckpoint(item.file)
    assert.equal(loaded.resume.summaryStatus, 'accepted')
    assert.deepEqual(loaded.summary, summary)
    assert.deepEqual(loaded.history, history)
    assert.equal(
      api.parseTaskCheckpoint({ ...item.checkpoint, summary: { ...summary, approval: true } }),
      null
    )
    assert.equal(
      api.parseTaskCheckpoint({
        ...item.checkpoint,
        summary: { ...summary, content: 'X'.repeat(20001) }
      }),
      null
    )
    assert.equal(
      api.parseTaskCheckpoint({
        ...item.checkpoint,
        summary: { ...summary, workingCharacters: 128001 }
      }),
      null
    )
  }
)

await suite.check(
  'bad summary hash, stale source and raw growth discard only summary and preserve all raw bytes',
  async () => {
    for (const field of ['contentHash', 'sourceFingerprint']) {
      const summary = {
        sourceFingerprint: fingerprint(history),
        contentHash: fingerprint('past'),
        content: 'past',
        workingItems: 5,
        workingCharacters: 300
      }
      const item = await fixture('summary-' + field.toLowerCase(), { summary })
      await mutate(item, (value) => {
        value.summary[field] = '0'.repeat(64)
      })
      const before = await fs.readFile(
        path.resolve(path.dirname(item.file), item.checkpoint.raw.file)
      )
      const loaded = await api.loadTaskCheckpoint(item.file)
      assert.equal(loaded.resume.summaryStatus, 'discarded')
      assert.equal(loaded.summary, undefined)
      assert.deepEqual(loaded.history, history)
      assert.deepEqual(
        await fs.readFile(path.resolve(path.dirname(item.file), item.checkpoint.raw.file)),
        before
      )
    }
    const summary = {
      sourceFingerprint: fingerprint(history),
      contentHash: fingerprint('past'),
      content: 'past',
      workingItems: 5,
      workingCharacters: 300
    }
    const grown = [
      ...history,
      message('公开续写'),
      { role: 'user', content: '下一轮任务' },
      message('新记录')
    ]
    const item = await fixture('summary-raw-growth', { history: grown, summary })
    const loaded = await api.loadTaskCheckpoint(item.file)
    assert.equal(loaded.resume.summaryStatus, 'discarded')
    assert.deepEqual(loaded.history, grown)
  }
)

await suite.check(
  'completed and abandoned records are inspectable but never silently resumed',
  async () => {
    for (const progress of ['completed', 'abandoned']) {
      const item = await fixture(progress, { progress, reason: progress })
      assert.equal((await item.store.inspect(item.checkpoint.taskId)).progress, progress)
      await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'NOT_RESUMABLE')
    }
  }
)

await suite.check(
  'invalid existing checkpoint remains byte-identical and save refuses overwriting it',
  async () => {
    const item = await fixture('bad-file')
    const bad = Buffer.from('{broken checkpoint\n')
    await fs.writeFile(item.file, bad)
    const result = await item.store.save(item.checkpoint, item.history)
    assert.equal(result.ok, false)
    assert.deepEqual(await fs.readFile(item.file), bad)
    await rejectsCode(() => api.loadTaskCheckpoint(item.file), 'CHECKPOINT_INVALID')
    return { saved: false, protectedBytes: bad.length }
  }
)

await suite.check(
  'raw unknown authority fields and image bytes are refused instead of sanitized or silently saved',
  async () => {
    const item = await fixture('raw-authority')
    for (const raw of [
      [...history.slice(0, -1), { ...history.at(-1), approval: { approved: true } }],
      [
        { role: 'user', content: 'inline original image data:image/png;base64,AAAA' },
        message('bad')
      ],
      [
        { role: 'user', content: 'public task' },
        { ...message('public'), httpBody: 'private response' }
      ]
    ])
      assert.throws(
        () =>
          api.createTaskCheckpoint({
            taskId: randomUUID(),
            mode: 'execute',
            prompt: 'public task',
            scope,
            bindings: item.bindings,
            history: raw,
            progress: 'resumable',
            reason: 'saved'
          }),
        (error) => error.code === 'RAW_INVALID'
      )
    const cp = structuredClone(item.checkpoint)
    cp.raw.file = '../outside.json'
    assert.equal(api.parseTaskCheckpoint(cp), null)
  }
)

await suite.check(
  'an unfinished raw intent mismatch and a completed raw gap cannot silently start a duplicate task',
  async () => {
    const mismatched = await fixture('intent-gap')
    await mutate(mismatched, (value) => {
      value.prompt = 'silently changed task intent'
    })
    await rejectsCode(() => api.loadTaskCheckpoint(mismatched.file), 'RAW_INVALID')
    const completedRaw = [...history, message('已完成明确原任务')]
    const completed = await fixture('completed-gap', {
      history: completedRaw,
      progress: 'resumable',
      reason: 'saved'
    })
    await rejectsCode(() => api.loadTaskCheckpoint(completed.file), 'NOT_RESUMABLE')
  }
)

await suite.check(
  'save keeps previous full raw prefix and identity, and cannot replace bindings with another directory',
  async () => {
    const item = await fixture('immutable-prefix')
    const oldPointer = await fs.readFile(item.file)
    const oldRaw = await fs.readFile(
      path.resolve(path.dirname(item.file), item.checkpoint.raw.file)
    )
    const candidates = [
      history.slice(0, 4),
      [{ ...history[0], content: 'silently rewritten' }, ...history.slice(1)]
    ]
    for (const raw of candidates) {
      const cp = api.createTaskCheckpoint({
        taskId: item.checkpoint.taskId,
        conversationId: item.checkpoint.conversationId,
        createdAt: item.checkpoint.createdAt,
        mode: 'execute',
        prompt: item.checkpoint.prompt,
        scope,
        bindings: item.bindings,
        history: raw,
        progress: 'resumable',
        reason: 'saved'
      })
      const result = await item.store.save(cp, raw)
      assert.equal(result.ok, false)
      assert.equal(result.code, 'RAW_INVALID')
      assert.deepEqual(await fs.readFile(item.file), oldPointer)
      assert.deepEqual(
        await fs.readFile(path.resolve(path.dirname(item.file), item.checkpoint.raw.file)),
        oldRaw
      )
    }
    const other = path.join(item.directory, 'other-root')
    await fs.mkdir(other)
    const cp = api.createTaskCheckpoint({
      taskId: item.checkpoint.taskId,
      createdAt: item.checkpoint.createdAt,
      mode: 'execute',
      prompt: item.checkpoint.prompt,
      scope,
      bindings: { cwd: await api.captureTaskDirectoryBinding(other), workspace: null },
      history,
      progress: 'resumable',
      reason: 'saved'
    })
    assert.equal((await item.store.save(cp, history)).ok, false)
    assert.deepEqual(await fs.readFile(item.file), oldPointer)
  }
)

await suite.finish({ counters })
assert.equal(counters.unexpectedNetwork, 0)
