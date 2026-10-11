import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { root, createEvidence } from './runtime.mjs'

const require = createRequire(import.meta.url)
const { load, microtasks } = require('../lesson55/shared/harness.cjs')
const evidence = await createEvidence('adapters')
const identities = {}
for (const file of [
  'src/shared/agent.ts',
  'src/shared/agent-context.ts',
  'src/shared/api.ts',
  'src/preload/agent-api.ts',
  'src/cli/output.ts',
  'src/cli/host-contract.ts',
  'src/renderer/src/features/chat/agent-request.ts',
  'src/renderer/src/features/chat/useChatRequest.ts',
  'src/renderer/src/features/chat/MessageActivity.tsx',
  'src/shared/conversation-library.ts',
  'tests/lesson56/adapters.mjs'
]) {
  const bytes = await fs.readFile(path.join(root, file))
  identities[file] = createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(path.join(evidence, file.replaceAll('/', '__') + '.snapshot'), bytes)
}
const checks = []
async function check(name, action) {
  try {
    await action()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, error: error.stack ?? String(error) })
  }
}
const api = await load('src/shared/agent.ts')
const output = await load('src/cli/output.ts')
const display = await load('src/renderer/src/features/chat/agent-request.ts')
const library = await load('src/shared/conversation-library.ts')
const state = {
  requestId: 'adapter-request',
  phase: 'measured',
  reason: 'near_limit',
  rawHistoryItems: 24,
  rawHistoryCharacters: 90000,
  rawTurnItems: 20,
  rawTurnCharacters: 7000,
  workingItems: 44,
  workingCharacters: 97001,
  limitCharacters: 128000,
  triggerCharacters: 96000,
  rawTurnLimitItems: 160,
  instructionsCharacters: 1000,
  toolSchemaCharacters: 4000,
  imageCount: 0,
  imageBytes: 0,
  summaryRequests: 0,
  sourceGroups: 2,
  beforeCharacters: 97001,
  afterCharacters: 97001
}
const invalid = [
  null,
  [],
  {},
  { ...state, requestId: '../foreign' },
  { ...state, phase: 'authorized' },
  { ...state, reason: 'PRIVATE_SUMMARY' },
  { ...state, summary: 'PRIVATE_SUMMARY' },
  { ...state, encrypted_content: 'PRIVATE_REASONING' },
  { ...state, workingCharacters: -1 },
  { ...state, workingItems: 0.5 },
  { ...state, imageBytes: Number.MAX_SAFE_INTEGER },
  { ...state, summaryRequests: 13 },
  { ...state, sourceGroups: 1001 },
  { ...state, limitCharacters: 200000 },
  { ...state, triggerCharacters: 64000 },
  { ...state, rawTurnLimitItems: 300 },
  Object.assign(Object.create({ inherited: true }), state),
  Object.defineProperty({ ...state }, 'reason', {
    get() {
      throw Error('getter must not run')
    }
  }),
  Object.defineProperty({ ...state }, 'requestId', {
    get() {
      throw Error('getter must not run')
    }
  }),
  Object.defineProperty({ ...state }, 'secret', { enumerable: false, value: 'PRIVATE_SECRET' }),
  { ...state, [Symbol('private')]: 'PRIVATE_SYMBOL' },
  new Proxy(
    {},
    {
      getPrototypeOf() {
        throw Error('malformed proxy')
      }
    }
  )
]
const missing = { ...state }
delete missing.rawHistoryCharacters
invalid.push(missing)

await check(
  'strict context public event accepts only immutable-budget bounded data records',
  () => {
    assert.deepEqual(api.parseAgentContextEvent(state), state)
    const nullPrototype = Object.assign(Object.create(null), state)
    assert.deepEqual(api.parseAgentContextEvent(nullPrototype), state)
    for (const value of invalid) assert.equal(api.parseAgentContextEvent(value), null)
    const copy = api.parseAgentContextEvent(state)
    copy.workingCharacters = 7
    assert.equal(state.workingCharacters, 97001)
  }
)

await check(
  'preload independently rejects unknown fields and detaches its context listener',
  async () => {
    const ipc = new EventEmitter()
    let invokes = 0
    ipc.invoke = async () => {
      invokes++
      throw Error('unexpected invocation')
    }
    const { agentAPI } = await load('src/preload/agent-api.ts', { electron: { ipcRenderer: ipc } })
    const values = []
    const off = agentAPI.onAgentContextEvent((value) => values.push(value))
    for (const value of invalid) ipc.emit('agent:context', {}, value)
    ipc.emit('agent:context', {}, state)
    assert.deepEqual(values, [state])
    assert.equal(invokes, 0)
    off()
    assert.equal(ipc.listenerCount('agent:context'), 0)
    ipc.emit('agent:context', {}, state)
    assert.equal(values.length, 1)
  }
)

await check(
  'CLI context projection explicitly drops private outer data and rejects invalid inner events',
  () => {
    const projected = output.projectEvent({
      type: 'context',
      event: state,
      items: ['PRIVATE_PROTOCOL'],
      headers: 'PRIVATE_KEY'
    })
    assert.deepEqual(projected, { type: 'context', ...state })
    assert.equal(JSON.stringify(projected).includes('PRIVATE_'), false)
    for (const value of invalid)
      assert.throws(
        () => output.projectEvent({ type: 'context', event: value }),
        output.CLIOutputError
      )
  }
)

function capture() {
  const value = { text: '' }
  value.stream = new Writable({
    write(bytes, _encoding, done) {
      value.text += bytes
      done()
    }
  })
  return value
}
function finalResult() {
  return {
    requestId: state.requestId,
    conversationId: 'adapter-conversation',
    task: { state: 'completed', result: '业务回答' },
    answer: '业务回答',
    effects: { approved: false, started: false },
    toolResults: [],
    elapsedMs: 1,
    exitCode: 0
  }
}
await check(
  'healthy JSONL emits bounded context, ignores foreign/late events, and has one terminal',
  async () => {
    const stdout = capture(),
      stderr = capture(),
      failures = []
    const writer = new output.CLIOutput('jsonl', stdout.stream, stderr.stream, (error) =>
      failures.push(error)
    )
    try {
      writer.event({ type: 'context', event: state })
      writer.event({ type: 'context', event: { ...state, requestId: 'foreign-request' } })
      writer.terminal(finalResult())
      writer.terminal(finalResult())
      writer.event({ type: 'context', event: { ...state, phase: 'compacted' } })
      await writer.flush()
      const rows = stdout.text.trim().split('\n').map(JSON.parse)
      assert.deepEqual(
        rows.map((row) => row.type),
        ['context', 'result']
      )
      assert.deepEqual(rows[0], { type: 'context', ...state })
      assert.equal(stderr.text, '')
      assert.equal(failures.length, 0)
    } finally {
      writer.dispose()
      stdout.stream.destroy()
      stderr.stream.destroy()
    }
  }
)
await check(
  'CLI text gives project characters plus compaction start/success/failure on diagnostic channel',
  async () => {
    const stdout = capture(),
      stderr = capture()
    const writer = new output.CLIOutput('text', stdout.stream, stderr.stream, () => {})
    try {
      for (const event of [
        state,
        { ...state, phase: 'compacting' },
        {
          ...state,
          phase: 'compacted',
          reason: 'summary_ready',
          workingCharacters: 10000,
          afterCharacters: 10000
        },
        { ...state, phase: 'failed', reason: 'invalid_summary' }
      ])
        writer.event({ type: 'context', event })
      writer.terminal(finalResult())
      await writer.flush()
      assert.equal(stdout.text, '业务回答\n')
      for (const text of [
        '接近容量',
        '正在整理',
        '整理完成 97001 → 10000 字符',
        '整理失败',
        '工作 97001/128000 字符',
        '原历史',
        '原当轮',
        '另计指令'
      ])
        assert.ok(stderr.text.includes(text), text)
      assert.equal(stderr.text.includes('token'), false)
      assert.equal(stderr.text.includes('PRIVATE_'), false)
    } finally {
      writer.dispose()
      stdout.stream.destroy()
      stderr.stream.destroy()
    }
  }
)

function hooks() {
  const slots = []
  let index = 0
  const cleanups = []
  return {
    reset() {
      index = 0
    },
    react: {
      useState(initial) {
        const key = index++
        slots[key] ??= { value: typeof initial === 'function' ? initial() : initial }
        return [
          slots[key].value,
          (update) => {
            slots[key].value = typeof update === 'function' ? update(slots[key].value) : update
          }
        ]
      },
      useRef(initial) {
        const key = index++
        slots[key] ??= { current: initial }
        return slots[key]
      },
      useEffect(action) {
        const key = index++
        if (!slots[key]) {
          slots[key] = true
          cleanups.push(action())
        }
      }
    },
    dispose() {
      for (const cleanup of cleanups) cleanup?.()
    }
  }
}
async function rendererFixture() {
  const harness = hooks(),
    listeners = new Map()
  const execution = {
    mode: 'default',
    revision: 0,
    cwd: 'C:\\adapter-fixture',
    scopeId: 'a'.repeat(64)
  }
  let busy = false,
    requestId,
    prompt,
    resolveResult,
    resolveCancel,
    starts = 0
  let conversation = {
    id: 'adapter-conversation',
    title: '隔离合同',
    pinned: false,
    archived: false,
    defaultDirectory: execution.cwd,
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks: []
  }
  const app = {
    getPendingAgentUserInput: async () => null,
    resolveAgentExecution: async () => execution,
    startAgentRequest: (id, text) => {
      starts++
      requestId = id
      prompt = text
      return new Promise((resolve) => {
        resolveResult = resolve
      })
    },
    cancelAgentRequest: () =>
      new Promise((resolve) => {
        resolveCancel = resolve
      })
  }
  for (const method of [
    'onAgentUserInputChange',
    'onAgentRetryEvent',
    'onAgentContextEvent',
    'onAgentMessageEvent',
    'onAgentProgress',
    'onAgentToolEvent',
    'onTaskState'
  ])
    app[method] = (listener) => {
      listeners.set(method, listener)
      return () => listeners.delete(method)
    }
  globalThis.window = { api: app }
  const module = await load('src/renderer/src/features/chat/useChatRequest.ts', {
    react: harness.react
  })
  const options = {
    conversationId: conversation.id,
    messages: [],
    toolRuns: [],
    updateMessages: (_id, update) => {
      conversation.messages = update(conversation.messages)
    },
    updateConversation: (_id, update) => {
      conversation = update(conversation)
    },
    operations: {
      begin() {
        if (busy) return false
        busy = true
        return true
      },
      finish() {
        busy = false
      },
      isIdle() {
        return !busy
      }
    },
    projectSelection: null,
    workspace: null,
    getPermissions: () => execution,
    observeExecution: () => {}
  }
  const render = () => {
    harness.reset()
    options.messages = conversation.messages
    options.toolRuns = conversation.toolRuns
    return module.useChatRequest(options)
  }
  return {
    render,
    emit(value) {
      listeners.get('onAgentContextEvent')?.(value)
    },
    event(overrides = {}) {
      return { ...state, requestId, ...overrides }
    },
    done() {
      resolveResult({
        status: 'done',
        answer: '业务回答',
        trace: ['原工具事实'],
        items: [
          { role: 'user', content: prompt },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '业务回答' }]
          }
        ]
      })
    },
    cancelDone() {
      resolveCancel(true)
      resolveResult({ status: 'cancelled', trace: ['用户停止'], items: [] })
    },
    get conversation() {
      return conversation
    },
    get starts() {
      return starts
    },
    dispose() {
      harness.dispose()
      delete globalThis.window
    }
  }
}
await check(
  'renderer accepts own live event and rejects malformed/foreign context before touching records',
  async () => {
    const fixture = await rendererFixture()
    try {
      const request = fixture.render()
      assert.equal(request.send('固定业务', 'execute'), true)
      await microtasks()
      const before = JSON.stringify(fixture.conversation)
      fixture.emit(fixture.event())
      const received = fixture.render().toolActivity
      assert.ok(JSON.stringify(received).includes('97001/128000 字符'))
      fixture.emit(fixture.event({ requestId: 'foreign-request', workingCharacters: 11 }))
      fixture.emit(fixture.event({ summary: 'PRIVATE_SUMMARY' }))
      assert.deepEqual(fixture.render().toolActivity, received)
      assert.equal(JSON.stringify(fixture.conversation), before)
      fixture.done()
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'renderer retires context on stop synchronously before cancellation settles and rejects late success',
  async () => {
    const fixture = await rendererFixture()
    try {
      assert.equal(fixture.render().send('停止业务', 'execute'), true)
      await microtasks()
      fixture.emit(fixture.event({ phase: 'compacting' }))
      const request = fixture.render(),
        before = structuredClone(request.toolActivity)
      const stopped = request.stop()
      fixture.emit(fixture.event({ phase: 'compacted', afterCharacters: 1, workingCharacters: 1 }))
      assert.deepEqual(fixture.render().toolActivity, before)
      fixture.cancelDone()
      await stopped
      await microtasks()
      const terminal = structuredClone(fixture.render().toolActivity)
      fixture.emit(fixture.event({ phase: 'compacted', afterCharacters: 1, workingCharacters: 1 }))
      assert.deepEqual(fixture.render().toolActivity, terminal)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'request-local context never enters saved version 9 records and clear does not restart an Agent',
  async () => {
    const fixture = await rendererFixture()
    try {
      assert.equal(fixture.render().send('保存业务', 'execute'), true)
      await microtasks()
      const old = fixture.event({
        phase: 'compacted',
        reason: 'summary_ready',
        afterCharacters: 9000,
        workingCharacters: 9000
      })
      fixture.emit(old)
      fixture.done()
      await microtasks()
      const request = fixture.render()
      assert.ok(JSON.stringify(request.toolActivity).includes('整理完成'))
      assert.equal(JSON.stringify(fixture.conversation).includes('上下文'), false)
      const saved = {
        version: 9,
        activeConversationId: fixture.conversation.id,
        conversations: [fixture.conversation]
      }
      assert.deepEqual(library.parseLibrary(saved), saved)
      assert.equal(library.parseLibrary({ ...saved, contextState: old }), null)
      request.clearActivity()
      assert.deepEqual(fixture.render().toolActivity, {})
      assert.equal(fixture.starts, 1)
      assert.equal(fixture.render().send('新的明确请求', 'execute'), true)
      await microtasks()
      const current = structuredClone(fixture.render().toolActivity)
      fixture.emit(old)
      assert.deepEqual(fixture.render().toolActivity, current)
      fixture.done()
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'display updates capacity without losing original activity and preserves latest success across measurements',
  () => {
    const compacted = display.contextActivityEntries(
      {
        ...state,
        phase: 'compacted',
        reason: 'summary_ready',
        afterCharacters: 9000,
        workingCharacters: 9000
      },
      ['原工具事实']
    )
    const measured = display.contextActivityEntries(
      { ...state, workingCharacters: 12000, reason: 'idle' },
      compacted
    )
    assert.ok(measured.includes('原工具事实'))
    assert.ok(measured.some((line) => line.includes('整理完成 · 97001 → 9000 字符')))
    assert.equal(measured.filter((line) => line.startsWith('上下文占用：')).length, 1)
    const failed = display.contextActivityEntries(
      { ...state, phase: 'failed', reason: 'invalid_summary' },
      measured
    )
    assert.ok(failed.some((line) => line.includes('整理失败')))
    assert.equal(
      failed.some((line) => line.includes('整理完成')),
      false
    )
  }
)

const report = {
  layer:
    'Public shared/preload/CLI modules and actual renderer hook with synthetic React lifecycle and host IPC',
  synthetic: true,
  networkRequests: 0,
  modelRequests: 0,
  agentToolCalls: 0,
  identities,
  checks,
  passed: checks.filter((row) => row.pass).length,
  failed: checks.filter((row) => !row.pass).length,
  limitations: [
    'Renderer lifecycle and IPC are synthetic; actual Electron UI, Windows writer/native process, and real model business checks are separate.'
  ]
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
for (const row of checks.filter((item) => !item.pass)) console.error(row.name + ': ' + row.error)
console.log(JSON.stringify({ evidence, passed: report.passed, failed: report.failed }))
process.exitCode = report.failed ? 1 : 0
