import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { root, compile, checksFor, hash, message, call } from '../lesson57/runtime.mjs'

const evidence = path.join(root, '.ui-check/test-runs/lesson62', 'storage-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const { api, sourceHashes } = await compile(evidence, [
  'src/shared/conversation.ts',
  'src/shared/conversation-library.ts',
  'src/shared/task-checkpoint.ts',
  'src/shared/agent-resume.ts',
  'src/main/storage/conversation-store.ts',
  'src/main/storage/task-checkpoint-store.ts',
  'src/main/skills/skill-reader.ts',
  'src/renderer/src/features/conversation/capacity.ts',
  'src/cli/agent-host.ts'
])
const suite = checksFor(evidence, {
  realDisk: true,
  ordinaryNode: true,
  actualCLIHostAPI: true,
  actualCLIEntryProcess: false,
  realModelTransport: false,
  syntheticTransport: true,
  sourceHashes
})
const counters = { main: 0, unexpectedNetwork: 0 }
globalThis.fetch = () => {
  counters.unexpectedNetwork++
  throw new Error('Unexpected network denied')
}
const skill = api.createSkillSnapshot(
  { name: 'code-review', description: 'Read actual code and report evidence.' },
  '# Frozen review method\nLESSON62_ORIGINAL_SKILL_A\nRead before making claims.',
  hash('the original full skill file bytes')
)
const user = (extra = {}) => ({
  id: randomUUID(),
  role: 'user',
  content: 'Inspect the fixed task.',
  status: 'complete',
  mode: 'plan',
  ...extra
})
function conversation(messages) {
  return {
    id: randomUUID(),
    title: 'Lesson62 isolated test',
    pinned: false,
    archived: false,
    defaultDirectory: evidence,
    agentMode: 'plan',
    messages,
    toolRuns: [],
    workspace: null,
    tasks: []
  }
}
function library(conversations) {
  return { version: 9, activeConversationId: conversations[0]?.id ?? null, conversations }
}
function textMessages(characters) {
  const result = []
  while (characters > 0) {
    const length = Math.min(100000, characters)
    result.push({
      id: randomUUID(),
      role: 'assistant',
      content: 'x'.repeat(length),
      status: 'complete',
      mode: 'plan'
    })
    characters -= length
  }
  return result
}
async function checkpointFixture(label, selectedSkill = skill) {
  const directory = path.join(evidence, label + '-' + randomUUID())
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const scope = { kind: 'time', executionId: 'a'.repeat(64) }
  const history = [{ role: 'user', content: 'Inspect the fixed task.' }]
  const input = {
    taskId: randomUUID(),
    conversationId: randomUUID(),
    mode: 'plan',
    prompt: history[0].content,
    scope,
    bindings: { cwd: await api.captureTaskDirectoryBinding(cwd), workspace: null },
    history,
    progress: 'interrupted',
    reason: 'host_exit',
    ...(selectedSkill ? { skill: selectedSkill } : {})
  }
  const checkpoint = api.createTaskCheckpoint(input)
  const file = path.join(directory, 'task.checkpoint.json')
  const saved = await api.saveTaskCheckpoint(file, checkpoint, history)
  assert.equal(saved.ok, true, JSON.stringify(saved))
  return { directory, cwd, input, checkpoint, file, history }
}

await suite.check(
  'v9 user skill snapshots survive strict parsing; other roles and malformed snapshots fail',
  async () => {
    const messages = [user({ skill }), user()]
    assert.deepEqual(api.parseMessages(messages), messages)
    assert.deepEqual(
      api.parseLibrary(library([conversation(messages)]))?.conversations[0].messages,
      messages
    )
    for (const role of ['assistant', 'system'])
      assert.equal(api.parseMessages([user({ role, skill })]), null)
    for (const invalid of [
      null,
      { ...skill, authority: 'full-access' },
      { ...skill, body: '' },
      { ...skill, body: 'x'.repeat(12001) },
      { ...skill, body: '\\'.repeat(12000) },
      { ...skill, snapshotHash: 'invalid' }
    ])
      assert.equal(api.parseMessages([user({ skill: invalid })]), null)
    assert.equal(api.parseMessages([user({ skill: undefined })]), null)
    return { version: 9, skillCharacters: JSON.stringify(skill).length }
  }
)

await suite.check(
  'complete snapshot JSON counts toward the existing 1M library budget and renderer reserve',
  async () => {
    const skillLength = JSON.stringify(skill).length
    const selected = user({ skill })
    const boundary = conversation([
      selected,
      ...textMessages(1000000 - skillLength - selected.content.length)
    ])
    assert(api.parseMessages(boundary.messages))
    assert(api.parseLibrary(library([boundary])))
    boundary.messages.push(...textMessages(1))
    assert.equal(api.parseMessages(boundary.messages), null)
    assert.equal(api.parseLibrary(library([boundary])), null)
    const cross = [
      conversation([selected]),
      conversation(textMessages(1000000 - selected.content.length))
    ]
    assert.equal(api.parseLibrary(library(cross)), null)
    const plain = conversation(textMessages(1000000 - 18000))
    const snapshot = library([plain])
    assert.equal(api.getCapacityError(snapshot, plain, false), null)
    assert(api.getCapacityError(snapshot, plain, false, skillLength))
    assert(api.getCapacityError(snapshot, plain, false, 20000))
    assert(api.getCapacityError(snapshot, plain, false, 20001))
    assert.equal(api.getMessageContentCharacters(selected), selected.content.length + skillLength)
  }
)

await suite.check(
  'conversation save/load rechecks the deterministic hash and preserves damaged or unsupported files',
  async () => {
    const directory = path.join(evidence, 'conversation-store')
    const store = api.createConversationStore(directory)
    const snapshot = library([conversation([user({ skill })])])
    assert.equal((await store.save(snapshot)).ok, true)
    assert.deepEqual((await store.load()).snapshot, snapshot)
    assert.equal(
      (
        await store.save(snapshot, async (checked, existing) => {
          assert.deepEqual(checked, snapshot)
          assert.deepEqual(existing, snapshot)
        })
      ).ok,
      true
    )
    const file = path.join(directory, 'conversation.json')
    const original = await fs.readFile(file)
    const invalid = structuredClone(snapshot)
    invalid.conversations[0].messages[0].skill.body += '\nChanged body.'
    assert.equal((await store.save(invalid)).ok, false)
    assert.deepEqual(await fs.readFile(file), original)
    const damaged = Buffer.from(JSON.stringify(invalid))
    await fs.writeFile(file, damaged)
    assert.equal((await store.load()).ok, false)
    assert.equal((await store.save(snapshot)).ok, false)
    assert.deepEqual(await fs.readFile(file), damaged)
    const unsupported = Buffer.from(JSON.stringify({ ...snapshot, version: 8 }))
    await fs.writeFile(file, unsupported)
    assert.equal((await store.load()).ok, false)
    assert.equal((await store.save(snapshot)).ok, false)
    assert.deepEqual(await fs.readFile(file), unsupported)
    return { damagedSHA256: hash(damaged), unsupportedSHA256: hash(unsupported) }
  }
)

await suite.check('async pre-save checks cannot overwrite a newly damaged library', async () => {
  const directory = path.join(evidence, 'async-store')
  const store = api.createConversationStore(directory)
  const snapshot = library([conversation([user({ skill })])])
  assert.equal((await store.save(snapshot)).ok, true)
  const file = path.join(directory, 'conversation.json')
  const damaged = Buffer.from('{invalid during awaited preparation')
  const result = await store.save(snapshot, () => fs.writeFile(file, damaged))
  assert.equal(result.ok, false)
  assert.deepEqual(await fs.readFile(file), damaged)
})

await suite.check(
  'v1 checkpoint preserves skill through readback, fresh scope and subsequent saves; omission is refused',
  async () => {
    const item = await checkpointFixture('checkpoint-roundtrip')
    const loaded = await api.loadTaskCheckpoint(item.file, {
      scope: { kind: 'time', executionId: 'b'.repeat(64) }
    })
    assert.deepEqual(loaded.checkpoint.skill, skill)
    assert.equal(loaded.scope.executionId, 'b'.repeat(64))
    const next = api.createTaskCheckpoint({
      ...item.input,
      createdAt: item.checkpoint.createdAt,
      scope: loaded.scope,
      skill: loaded.checkpoint.skill,
      reason: 'saved',
      progress: 'resumable'
    })
    assert.equal((await api.saveTaskCheckpoint(item.file, next, item.history)).ok, true)
    assert.deepEqual((await api.loadTaskCheckpoint(item.file)).checkpoint.skill, skill)
    const before = await fs.readFile(item.file)
    const omitted = structuredClone(next)
    delete omitted.skill
    assert.equal((await api.saveTaskCheckpoint(item.file, omitted, item.history)).ok, false)
    const changed = structuredClone(next)
    changed.skill = api.createSkillSnapshot(
      { name: 'different-method', description: 'Other task method.' },
      'Different body.',
      hash('different bytes')
    )
    assert.equal((await api.saveTaskCheckpoint(item.file, changed, item.history)).ok, false)
    assert.deepEqual(await fs.readFile(item.file), before)
    const plain = await checkpointFixture('checkpoint-plain', null)
    assert.equal((await api.loadTaskCheckpoint(plain.file)).checkpoint.skill, undefined)
  }
)

await suite.check(
  'hash, structure and size damage stops checkpoint loading and cannot be downgraded or overwritten',
  async () => {
    for (const [label, mutate] of [
      [
        'hash',
        (value) => {
          value.skill.body += '\nTampered.'
        }
      ],
      [
        'size',
        (value) => {
          value.skill.body = 'x'.repeat(12001)
        }
      ],
      [
        'unknown',
        (value) => {
          value.skill.permission = 'full-access'
        }
      ],
      [
        'broken',
        (value) => {
          value.skill = null
        }
      ]
    ]) {
      const item = await checkpointFixture('damaged-' + label)
      const value = structuredClone(item.checkpoint)
      mutate(value)
      const bytes = Buffer.from(JSON.stringify(value))
      await fs.writeFile(item.file, bytes)
      await assert.rejects(
        () => api.loadTaskCheckpoint(item.file),
        (error) => error.code === 'CHECKPOINT_INVALID'
      )
      assert.equal(
        (await api.saveTaskCheckpoint(item.file, item.checkpoint, item.history)).ok,
        false
      )
      assert.deepEqual(await fs.readFile(item.file), bytes)
    }
  }
)

await suite.check(
  'resume display exposes only a validated optional name; plain tasks stay valid',
  async () => {
    const display = {
      taskId: randomUUID(),
      mode: 'plan',
      updatedAt: new Date().toISOString(),
      prompt: 'Inspect the fixed task.',
      requiresWorkspace: false
    }
    assert.deepEqual(api.parseResumableAgentTask(display), display)
    assert.deepEqual(api.parseResumableAgentTask({ ...display, skillName: skill.name }), {
      ...display,
      skillName: skill.name
    })
    for (const invalid of ['', '../outside', 'CON', 'nul', 'x'.repeat(65)])
      assert.equal(api.parseResumableAgentTask({ ...display, skillName: invalid }), null)
    assert.equal(api.parseResumableAgentTask({ ...display, skill }), null)
  }
)

await suite.check(
  'actual ordinary Node CLI host resume uses original body after source deletion and retains it when saving',
  async () => {
    const item = await checkpointFixture('cli-host-resume')
    const source = path.join(item.directory, 'SKILL.md')
    await fs.writeFile(source, 'Different later source bytes.')
    await fs.unlink(source)
    const captured = []
    const originalEnvironment = {
      MODEL_ENDPOINT: process.env.MODEL_ENDPOINT,
      MODEL_NAME: process.env.MODEL_NAME,
      MODEL_API_KEY: process.env.MODEL_API_KEY
    }
    Object.assign(process.env, {
      MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
      MODEL_NAME: 'gpt-6.1-sol',
      MODEL_API_KEY: 'LESSON62_SYNTHETIC_ONLY'
    })
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://example.invalid/v1/responses') {
        counters.unexpectedNetwork++
        throw new Error('Network denied')
      }
      const body = JSON.parse(init.body)
      counters.main++
      captured.push(body)
      const output =
        captured.length === 1
          ? [call('lesson62-resume-time', 'get_current_time')]
          : [message('Synthetic resume finished.')]
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output }
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    try {
      const outcome = await api.runAgentTask({ resume: item.file })
      assert.equal(outcome.exitCode, 0, JSON.stringify(outcome))
      assert.equal(captured.length, 2)
      for (const request of captured) {
        assert(request.instructions.includes(JSON.stringify(skill.body)))
        assert(request.instructions.includes(skill.name))
        assert(!JSON.stringify(request.input).includes(skill.body))
      }
      const saved = JSON.parse(await fs.readFile(item.file, 'utf8'))
      assert.deepEqual(saved.skill, skill)
      assert.equal(saved.progress, 'completed')
      assert.notEqual(saved.scope.executionId, item.checkpoint.scope.executionId)
      assert(!/approval|readCredential|commandTicket/.test(JSON.stringify(saved)))
      await fs.writeFile(
        path.join(item.directory, 'captured-model-requests.json'),
        JSON.stringify(captured, null, 2)
      )
      return {
        mainRequests: captured.length,
        snapshotHash: saved.skill.snapshotHash,
        checkpointSHA256: hash(await fs.readFile(item.file)),
        originalSourceAbsent: true
      }
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      globalThis.fetch = () => {
        counters.unexpectedNetwork++
        throw new Error('Network denied')
      }
    }
  }
)

await suite.check(
  'ordinary CLI host tasks and plain checkpoint resume carry no historical skill',
  async () => {
    const captured = []
    const originalEnvironment = {
      MODEL_ENDPOINT: process.env.MODEL_ENDPOINT,
      MODEL_NAME: process.env.MODEL_NAME,
      MODEL_API_KEY: process.env.MODEL_API_KEY
    }
    Object.assign(process.env, {
      MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
      MODEL_NAME: 'gpt-6.1-sol',
      MODEL_API_KEY: 'LESSON62_SYNTHETIC_ONLY'
    })
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://example.invalid/v1/responses')
      captured.push(JSON.parse(init.body))
      counters.main++
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [message('Synthetic plain task complete.')]
            }
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    try {
      const plain = await checkpointFixture('cli-host-plain', null)
      const resumed = await api.runAgentTask({ resume: plain.file })
      assert.equal(resumed.exitCode, 0, JSON.stringify(resumed))
      assert.equal(JSON.parse(await fs.readFile(plain.file, 'utf8')).skill, undefined)
      const ordinary = await api.runAgentTask({
        mode: 'plan',
        prompt: 'A fresh ordinary task.',
        cwd: plain.cwd
      })
      assert.equal(ordinary.exitCode, 0, JSON.stringify(ordinary))
      assert.equal(captured.length, 2)
      for (const request of captured) {
        assert(!request.instructions.includes(skill.body))
        assert(!request.instructions.includes(skill.sourceHash))
        assert(!request.instructions.includes('LESSON62_ORIGINAL_SKILL_A'))
      }
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      globalThis.fetch = () => {
        counters.unexpectedNetwork++
        throw new Error('Network denied')
      }
    }
  }
)

await suite.check(
  'damaged skill checkpoint stops the CLI host before any model request',
  async () => {
    const item = await checkpointFixture('cli-host-damaged')
    const damaged = structuredClone(item.checkpoint)
    damaged.skill.snapshotHash = '0'.repeat(64)
    const bytes = Buffer.from(JSON.stringify(damaged))
    await fs.writeFile(item.file, bytes)
    const before = counters.unexpectedNetwork
    await assert.rejects(() => api.runAgentTask({ resume: item.file }), /CHECKPOINT_INVALID/)
    assert.equal(counters.unexpectedNetwork, before)
    assert.deepEqual(await fs.readFile(item.file), bytes)
  }
)

await suite.finish({
  counters,
  notCovered: ['actual CLI launcher', 'real network model', 'desktop interaction']
})
assert.equal(counters.unexpectedNetwork, 0)
