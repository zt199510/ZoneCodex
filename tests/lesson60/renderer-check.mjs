import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createEvidence, checksFor, hash, root } from './runtime.mjs'

const { load, microtasks } = createRequire(import.meta.url)('../lesson55/shared/harness.cjs')
const evidence = await createEvidence('renderer')
const { check, finish } = checksFor(evidence, {
  classification: 'synthetic React hook and JSX adapter, compiling actual current renderer sources',
  realDOM: false,
  realModelTransport: false,
  realWindowsProcess: false
})
const sourceFiles = [
  'src/renderer/src/features/chat/useChatRequest.ts',
  'src/renderer/src/features/chat/ChatInput.tsx',
  'src/renderer/src/features/chat/ChatComposer.tsx',
  'src/renderer/src/features/chat/ChatWorkspace.tsx',
  'src/renderer/src/features/conversation/useConversation.ts',
  'src/renderer/src/features/conversation/useConversationTasks.ts',
  'src/renderer/src/features/execution/useExecutionPermissions.ts',
  'src/renderer/src/features/execution/permissionPresentation.ts',
  'src/renderer/src/features/execution/ComposerPermissions.tsx',
  'src/renderer/src/features/execution/ExecutionApproval.tsx',
  'src/renderer/src/features/project/WorkspaceStatus.tsx'
]
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(
    Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
      )
    ),
    null,
    2
  )
)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Effects run after a render, re-run only for changed dependencies, and clean
// up on disposal. This adapter observes real hook callbacks without a DOM.
function hooks() {
  const slots = [],
    effects = []
  let index = 0
  const changed = (previous, next) =>
    !previous ||
    !next ||
    previous.length !== next.length ||
    previous.some((value, i) => !Object.is(value, next[i]))
  const effect = (action, deps) => {
    const key = index++
    if (!slots[key] || changed(slots[key].deps, deps)) {
      const old = slots[key]
      slots[key] = { deps, cleanup: old?.cleanup }
      effects.push(() => {
        old?.cleanup?.()
        slots[key].cleanup = action()
      })
    }
  }
  const react = {
    useState(initial) {
      const key = index++
      slots[key] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [
        slots[key].value,
        (next) => {
          slots[key].value = typeof next === 'function' ? next(slots[key].value) : next
        }
      ]
    },
    useRef(initial) {
      const key = index++
      slots[key] ??= { current: initial }
      return slots[key]
    },
    useCallback(callback, deps) {
      const key = index++
      if (!slots[key] || changed(slots[key].deps, deps)) slots[key] = { value: callback, deps }
      return slots[key].value
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useId() {
      const key = index++
      slots[key] ??= { value: 'lesson60-' + key }
      return slots[key].value
    }
  }
  return {
    react,
    render(action) {
      index = 0
      const result = action()
      while (effects.length) effects.shift()()
      return result
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.()
    }
  }
}

const jsx = (type, props) => ({ type, props: props ?? {} })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
globalThis.React = {
  Fragment: 'fragment',
  createElement(type, props, ...children) {
    return jsx(type, { ...props, children: children.length === 1 ? children[0] : children })
  }
}
const anchored = { useAnchoredPosition: () => () => {} }
const marker = (name) => Object.assign(() => null, { displayName: name })
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}
const find = (tree, predicate) => nodes(tree).find(predicate)
function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree && typeof tree === 'object') return textOf(tree.props?.children)
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''
}
async function componentFixture(file, name, extra = {}) {
  const harness = hooks()
  const module = await load(file, {
    react: harness.react,
    'react/jsx-runtime': jsxRuntime,
    '../../components/ui/useAnchoredPosition': anchored,
    ...extra
  })
  return {
    render: (props) => harness.render(() => module[name](props)),
    dispose: () => harness.dispose()
  }
}

async function permissionFixture({ initial = { mode: 'default', revision: 0 }, set, read } = {}) {
  const harness = hooks()
  let state = initial,
    operation = 'idle',
    canChange = true
  const calls = { read: 0, set: [], start: 0, resume: 0, summary: 0, title: 0, approval: 0 }
  globalThis.window = {
    api: {
      async getExecutionPermissions() {
        calls.read++
        if (read) return read(calls.read, state)
        return state
      },
      async setExecutionPermissions(mode) {
        calls.set.push(mode)
        state = { mode, revision: state.revision + 1 }
        if (set) return set(mode, state)
        return state
      }
    }
  }
  const module = await load('src/renderer/src/features/execution/useExecutionPermissions.ts', {
    react: harness.react
  })
  const operations = {
    begin(next) {
      if (operation !== 'idle') return false
      operation = next
      return true
    },
    finish(next) {
      if (operation === next) operation = 'idle'
    }
  }
  const mayChange = () => canChange && operation === 'idle'
  const render = () => harness.render(() => module.useExecutionPermissions(operations, mayChange))
  render()
  await microtasks()
  return {
    render,
    calls,
    get operation() {
      return operation
    },
    busy(value) {
      canChange = !value
    },
    dispose() {
      harness.dispose()
      delete globalThis.window
    }
  }
}

const execution = {
  mode: 'default',
  revision: 0,
  cwd: 'C:\\lesson60-synthetic',
  scopeId: 'a'.repeat(64)
}
const questions = [
  {
    id: 'choice',
    header: '方案',
    question: '选择哪种方案？',
    options: [
      { label: '甲', description: '第一种方案' },
      { label: '乙', description: '第二种方案' }
    ]
  }
]
async function requestFixture({ resolve, getPermissions = () => execution } = {}) {
  const harness = hooks(),
    listeners = new Map(),
    starts = [],
    cancels = []
  let operation = 'idle'
  let conversation = {
    id: randomUUID(),
    title: '状态合成验收',
    pinned: false,
    archived: false,
    defaultDirectory: execution.cwd,
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks: []
  }
  const calls = {
    resolve: 0,
    resume: 0,
    input: [],
    metadata: [],
    title: 0,
    summary: 0,
    approval: 0
  }
  const api = {
    getPendingAgentUserInput: async () => null,
    getResumableAgentTask: async (id) => {
      calls.metadata.push(id)
      return null
    },
    resolveAgentExecution: async (context) => {
      calls.resolve++
      return resolve ? resolve(context, calls.resolve) : execution
    },
    startAgentRequest(id, prompt, history, context, taskId) {
      const result = deferred()
      starts.push({ id, prompt, history, context, taskId, result })
      return result.promise
    },
    resumeAgentRequest() {
      calls.resume++
      throw new Error('unexpected automatic resume')
    },
    cancelAgentRequest(id) {
      const result = deferred()
      cancels.push({ id, result })
      return result.promise
    },
    respondToAgentUserInput: async (response) => {
      calls.input.push(response)
      return true
    }
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
    api[method] = (listener) => {
      listeners.set(method, listener)
      return () => listeners.delete(method)
    }
  globalThis.window = { api }
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
      begin(next) {
        if (operation !== 'idle') return false
        operation = next
        return true
      },
      finish(next) {
        if (operation === next) operation = 'idle'
      },
      isIdle: () => operation === 'idle'
    },
    projectSelection: null,
    workspace: null,
    getPermissions,
    observeExecution: () => {}
  }
  const render = () => {
    options.messages = conversation.messages
    options.toolRuns = conversation.toolRuns
    return harness.render(() => module.useChatRequest(options))
  }
  const emit = (method, value) => listeners.get(method)?.(value)
  function task(status, owner = starts.at(-1), overrides = {}) {
    return {
      taskId: owner.taskId,
      requestId: owner.id,
      conversationId: conversation.id,
      kind: 'agent',
      status,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: ['completed', 'cancelled', 'failed', 'timed_out', 'interrupted'].includes(status)
        ? new Date().toISOString()
        : null,
      result: null,
      error: null,
      ...overrides
    }
  }
  function question(inputId = randomUUID()) {
    const owner = starts.at(-1),
      callId = 'question-' + inputId
    emit('onAgentToolEvent', {
      requestId: owner.id,
      phase: 'start',
      callId,
      name: 'request_user_input',
      arguments: JSON.stringify({ questions })
    })
    const request = {
      requestId: owner.id,
      conversationId: conversation.id,
      inputId,
      callId,
      questions
    }
    emit('onAgentUserInputChange', request)
    return request
  }
  return {
    render,
    starts,
    cancels,
    calls,
    emit,
    task,
    question,
    get conversation() {
      return conversation
    },
    get operation() {
      return operation
    },
    switchConversation() {
      conversation = { ...conversation, id: randomUUID(), tasks: [], messages: [], toolRuns: [] }
      options.conversationId = conversation.id
    },
    removeTasks() {
      conversation = { ...conversation, tasks: [] }
    },
    complete(result, owner = starts.at(-1)) {
      owner.result.resolve(
        result ?? {
          status: 'done',
          answer: '业务回复',
          trace: [],
          items: [
            { role: 'user', content: owner.prompt },
            {
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: '业务回复' }]
            }
          ]
        }
      )
    },
    dispose() {
      harness.dispose()
      delete globalThis.window
    }
  }
}

await check(
  'permission same-value and busy selections are side-effect-free; actual changes retain revisions',
  async () => {
    const fixture = await permissionFixture()
    try {
      assert.equal(await fixture.render().select('default'), true)
      assert.equal(fixture.calls.set.length, 0)
      fixture.busy(true)
      assert.equal(await fixture.render().select('full-access'), false)
      fixture.busy(false)
      assert.equal(await fixture.render().select('full-access'), true)
      assert.deepEqual(fixture.render().state, { mode: 'full-access', revision: 1 })
      assert.equal(await fixture.render().select('default'), true)
      assert.deepEqual(fixture.render().state, { mode: 'default', revision: 2 })
      assert.equal(
        fixture.calls.start +
          fixture.calls.resume +
          fixture.calls.summary +
          fixture.calls.title +
          fixture.calls.approval,
        0
      )
      return { mode: fixture.render().state, changes: fixture.calls.set, modelRequests: 0 }
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'accepted permission change with failed reply becomes unknown until actual readback settles',
  async () => {
    const readback = deferred()
    const fixture = await permissionFixture({
      set: () => {
        throw new Error('accepted but reply failed')
      },
      read: (count, state) => (count === 1 ? state : readback.promise)
    })
    try {
      const selected = fixture.render().select('full-access')
      await microtasks()
      assert.equal(fixture.render().state, null)
      assert.equal(fixture.render().getState(), null)
      assert.equal(fixture.render().loading, true)
      assert.equal(fixture.operation, 'selecting')
      readback.resolve({ mode: 'full-access', revision: 1 })
      assert.equal(await selected, false)
      assert.deepEqual(fixture.render().state, { mode: 'full-access', revision: 1 })
      assert.equal(fixture.operation, 'idle')
      assert.match(fixture.render().error, /reply failed/)
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'persistent permission readback failure blocks actual request before resolve/start or message mutation',
  async () => {
    const permission = await permissionFixture({
      set: () => {
        throw new Error('reply lost')
      },
      read: (count, state) => (count === 1 ? state : Promise.reject(new Error('readback failed')))
    })
    await permission.render().select('full-access')
    const controller = permission.render()
    assert.equal(controller.state, null)
    assert.equal(controller.loading, false)
    permission.dispose()
    const request = await requestFixture({ getPermissions: controller.getState })
    try {
      const before = JSON.stringify(request.conversation)
      assert.equal(request.render().send('未知权限不得发送', 'execute'), false)
      await microtasks()
      assert.equal(request.calls.resolve, 0)
      assert.equal(request.starts.length, 0)
      assert.equal(JSON.stringify(request.conversation), before)
      assert.match(request.render().error, /权限设置尚未就绪/)
    } finally {
      request.dispose()
    }
  }
)

await check(
  'older observed permission revisions and responses after unmount cannot replace current known state',
  async () => {
    const fixture = await permissionFixture()
    try {
      assert.equal(await fixture.render().select('full-access'), true)
      fixture.render().observe({ ...execution, mode: 'default', revision: 0 })
      assert.deepEqual(fixture.render().getState(), { mode: 'full-access', revision: 1 })
      fixture.dispose()
      fixture.render().observe({ ...execution, mode: 'default', revision: 9 })
      assert.deepEqual(fixture.render().getState(), { mode: 'full-access', revision: 1 })
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'initial permission read failure remains unknown and cannot select an assumed default mode',
  async () => {
    const fixture = await permissionFixture({
      read: () => Promise.reject(new Error('initial read failed'))
    })
    try {
      assert.equal(fixture.render().state, null)
      assert.equal(fixture.render().loading, false)
      assert.match(fixture.render().error, /读取权限设置失败/)
      assert.equal(await fixture.render().select('default'), false)
      assert.equal(fixture.calls.set.length, 0)
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'running stop exposes only local stopping; duplicate stops do not invent task/message terminal state',
  async () => {
    const fixture = await requestFixture()
    try {
      assert.equal(fixture.render().send('运行中停止', 'execute'), true)
      await microtasks()
      fixture.emit('onTaskState', fixture.task('running'))
      const stopped = fixture.render().stop()
      assert.equal(fixture.render().stopping, true)
      await fixture.render().stop()
      assert.equal(fixture.cancels.length, 1)
      assert.equal(fixture.operation, 'generating')
      assert.equal(fixture.conversation.tasks[0].status, 'running')
      assert(fixture.conversation.messages.every((message) => message.status === 'pending'))
      fixture.cancels[0].result.resolve(true)
      await stopped
      assert.equal(fixture.render().stopping, true)
      fixture.emit('onTaskState', fixture.task('cancelled'))
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await microtasks()
      assert.equal(fixture.render().stopping, false)
      assert.equal(fixture.operation, 'idle')
      assert.equal(fixture.conversation.tasks[0].status, 'cancelled')
      assert(fixture.conversation.messages.every((message) => message.status === 'cancelled'))
      assert.equal(JSON.stringify(fixture.conversation).includes('stopping'), false)
      return {
        cancellationIPC: 1,
        beforeOwnerStatus: 'running',
        afterOwnerStatus: 'cancelled',
        persistedStopping: false
      }
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'failed stop restores stop availability, retains running owner state, and permits a new cancel attempt',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('停止发送失败', 'execute')
      await microtasks()
      fixture.emit('onTaskState', fixture.task('running'))
      const stopped = fixture.render().stop()
      fixture.cancels[0].result.reject(new Error('cancel transport failed'))
      await stopped
      assert.equal(fixture.render().stopping, false)
      assert.equal(fixture.operation, 'generating')
      assert.equal(fixture.conversation.tasks[0].status, 'running')
      assert(fixture.conversation.messages.every((message) => message.status === 'pending'))
      assert.match(fixture.render().error, /可重试停止/)
      const retry = fixture.render().stop()
      assert.equal(fixture.cancels.length, 2)
      fixture.cancels[1].result.resolve(true)
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await retry
      await microtasks()
      assert.equal(fixture.render().stopping, false)
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'unaccepted boolean false cancellation restores stop availability without inventing a terminal result',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('停止未获接受', 'execute')
      await microtasks()
      fixture.emit('onTaskState', fixture.task('running'))
      const stopped = fixture.render().stop()
      assert.equal(fixture.render().stopping, true)
      fixture.cancels[0].result.resolve(false)
      await stopped
      assert.equal(fixture.render().stopping, false)
      assert.equal(fixture.operation, 'generating')
      assert.equal(fixture.conversation.tasks[0].status, 'running')
      assert(fixture.conversation.messages.every((message) => message.status === 'pending'))
      assert.match(fixture.render().error, /停止请求未获接受/)
      const retry = fixture.render().stop()
      assert.equal(fixture.cancels.length, 2)
      fixture.cancels[1].result.resolve(true)
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await retry
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'resolving stop prevents late start; an old resolver finally cannot clear a new stopping request',
  async () => {
    const oldResolve = deferred()
    const fixture = await requestFixture({
      resolve: (_context, count) => (count === 1 ? oldResolve.promise : execution)
    })
    try {
      fixture.render().send('解析时停止', 'execute')
      await fixture.render().stop()
      assert.equal(fixture.operation, 'idle')
      assert.equal(fixture.starts.length, 0)
      assert.equal(fixture.cancels.length, 0)
      assert(fixture.conversation.messages.every((message) => message.status === 'cancelled'))
      fixture.render().send('新的运行', 'execute')
      await microtasks()
      const newStop = fixture.render().stop()
      oldResolve.resolve(execution)
      await microtasks()
      assert.equal(fixture.starts.length, 1)
      assert.equal(fixture.render().stopping, true)
      assert.equal(fixture.operation, 'generating')
      fixture.cancels[0].result.resolve(true)
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await newStop
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'owner completion while cancel is pending and its late failure cannot clear the next request stopping',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('第一条任务', 'execute')
      await microtasks()
      fixture.emit('onTaskState', fixture.task('running'))
      const oldStop = fixture.render().stop()
      fixture.emit('onTaskState', fixture.task('completed'))
      fixture.complete()
      await microtasks()
      assert.equal(fixture.conversation.tasks[0].status, 'completed')
      assert.equal(fixture.conversation.messages[1].status, 'complete')
      assert.equal(fixture.operation, 'idle')
      assert.equal(fixture.render().send('第二条任务', 'execute'), true)
      await microtasks()
      assert.equal(
        fixture.starts.length,
        2,
        fixture.render().error ?? 'second request did not start'
      )
      const newStop = fixture.render().stop()
      fixture.cancels[0].result.reject(new Error('old cancellation reply failed'))
      await oldStop
      assert.equal(fixture.render().stopping, true)
      assert.equal(fixture.render().error, null)
      assert.equal(fixture.operation, 'generating')
      fixture.cancels[1].result.resolve(true)
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await newStop
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'late boolean false from an old cancellation cannot clear a new owner stopping or show an old error',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('旧运行', 'execute')
      await microtasks()
      const oldStop = fixture.render().stop()
      fixture.complete()
      await microtasks()
      assert.equal(fixture.render().send('新运行', 'execute'), true)
      await microtasks()
      assert.equal(fixture.starts.length, 2)
      const newStop = fixture.render().stop()
      fixture.cancels[0].result.resolve(false)
      await oldStop
      assert.equal(fixture.render().stopping, true)
      assert.equal(fixture.render().error, null)
      assert.equal(fixture.operation, 'generating')
      fixture.cancels[1].result.resolve(true)
      fixture.complete({ status: 'cancelled', trace: [], items: [] })
      await newStop
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'cleared plan question cannot reopen with the same inputId or submit a retired answer',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('计划问答', 'plan')
      await microtasks()
      const question = fixture.question()
      assert.equal(fixture.render().pendingPlanQuestion?.request.inputId, question.inputId)
      fixture.emit('onAgentUserInputChange', null)
      fixture.emit('onAgentUserInputChange', question)
      assert.equal(fixture.render().pendingPlanQuestion, null)
      const response = {
        requestId: question.requestId,
        inputId: question.inputId,
        answers: [{ id: 'choice', answer: '甲' }]
      }
      assert.equal(await fixture.render().respondToPlanQuestion(response), false)
      assert.equal(fixture.calls.input.length, 0)
      fixture.complete()
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'plan-question stop blocks delayed questions and answers; cancel failure does not revive cleared old input',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('问答停止', 'plan')
      await microtasks()
      const question = fixture.question()
      const stopped = fixture.render().stop()
      fixture.emit('onAgentUserInputChange', null)
      fixture.emit('onAgentUserInputChange', question)
      assert.equal(fixture.render().pendingPlanQuestion, null)
      const response = {
        requestId: question.requestId,
        inputId: question.inputId,
        answers: [{ id: 'choice', answer: '乙' }]
      }
      assert.equal(await fixture.render().respondToPlanQuestion(response), false)
      fixture.cancels[0].result.reject(new Error('cancel failed'))
      await stopped
      fixture.emit('onAgentUserInputChange', question)
      assert.equal(fixture.render().pendingPlanQuestion, null)
      assert.equal(fixture.calls.input.length, 0)
      fixture.complete()
      await microtasks()
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'actual request task subscription preserves owner terminal records and rejects removed/foreign late tasks',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render().send('任务事件', 'execute')
      await microtasks()
      fixture.emit('onTaskState', fixture.task('running'))
      fixture.emit(
        'onTaskState',
        fixture.task('completed', undefined, { result: 'owner completed' })
      )
      const terminal = JSON.stringify(fixture.conversation.tasks)
      fixture.emit('onTaskState', fixture.task('running'))
      fixture.emit('onTaskState', fixture.task('waiting_approval'))
      assert.equal(JSON.stringify(fixture.conversation.tasks), terminal)
      fixture.complete()
      await microtasks()
      fixture.removeTasks()
      fixture.emit('onTaskState', fixture.task('running'))
      fixture.emit('onTaskState', fixture.task('running', undefined, { taskId: randomUUID() }))
      fixture.emit(
        'onTaskState',
        fixture.task('running', undefined, { conversationId: randomUUID() })
      )
      assert.deepEqual(fixture.conversation.tasks, [])
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'passive chat switching only discovers metadata; actual reconciliation marks missing nonterminal tasks interrupted',
  async () => {
    const fixture = await requestFixture()
    try {
      fixture.render()
      await microtasks()
      fixture.switchConversation()
      fixture.render()
      await microtasks()
      assert.equal(fixture.calls.metadata.length, 2)
      assert.equal(
        fixture.calls.resolve +
          fixture.starts.length +
          fixture.calls.resume +
          fixture.calls.summary +
          fixture.calls.title +
          fixture.calls.approval,
        0
      )
      const tasks = await load('src/renderer/src/features/conversation/useConversationTasks.ts', {
        react: hooks().react
      })
      const owner = { taskId: randomUUID(), id: randomUUID() }
      const running = fixture.task('waiting_input', owner)
      const cancelled = fixture.task('cancelled', { taskId: randomUUID(), id: randomUUID() })
      const reconciled = tasks.reconcileConversationTasks(
        { ...fixture.conversation, tasks: [running, cancelled] },
        []
      )
      assert.equal(reconciled.tasks[0].status, 'interrupted')
      assert(reconciled.tasks[0].finishedAt)
      assert.deepEqual(reconciled.tasks[1], cancelled)
      for (const status of ['completed', 'cancelled', 'failed', 'timed_out', 'interrupted']) {
        const terminal = { ...cancelled, status }
        const previous = { ...fixture.conversation, tasks: [terminal] }
        assert.equal(
          tasks.applyConversationTaskEvent(previous, { ...terminal, status: 'running' }, null),
          previous
        )
      }
      return {
        metadataReads: 2,
        modelRequests: 0,
        missingLiveOwner: 'interrupted',
        terminalStatusesRetained: 5
      }
    } finally {
      fixture.dispose()
    }
  }
)

async function approvalFixture() {
  const listeners = new Map(),
    replies = [],
    initial = deferred(),
    pendingChanges = []
  let cancelRequests = 0
  globalThis.window = {
    api: {
      getPendingExecutionApproval: () => initial.promise,
      onExecutionApprovalChange: (listener) => {
        listeners.set('approval', listener)
        return () => listeners.delete('approval')
      },
      respondToExecutionApproval(id, approved) {
        const result = deferred()
        replies.push({ id, approved, result })
        return result.promise
      },
      cancelAgentRequest: async () => {
        cancelRequests++
      }
    }
  }
  const view = await componentFixture(
    'src/renderer/src/features/execution/ExecutionApproval.tsx',
    'ExecutionApproval'
  )
  const props = {
    anchorRef: { current: null },
    onPendingChange: (value) => pendingChanges.push(value)
  }
  return {
    render: () => view.render(props),
    initial,
    replies,
    pendingChanges,
    emit: (approval) => listeners.get('approval')?.(approval),
    get cancelRequests() {
      return cancelRequests
    },
    dispose() {
      view.dispose()
      delete globalThis.window
    }
  }
}
const approval = (id = randomUUID()) => ({
  approvalId: id,
  kind: 'edit',
  path: 'C:\\fixture\\target.txt'
})

await check(
  'actual approval rejection button and Escape both respond false without cancelling the Agent',
  async () => {
    const fixture = await approvalFixture()
    try {
      fixture.render()
      fixture.emit(approval('first'))
      const button = find(
        fixture.render(),
        (node) => node.props.className === 'execution-approval-cancel'
      )
      assert.equal(textOf(button), '拒绝本次操作')
      button.props.onClick({ detail: 1 })
      button.props.onClick({ detail: 1 })
      assert.deepEqual(
        fixture.replies.map(({ id, approved }) => ({ id, approved })),
        [{ id: 'first', approved: false }]
      )
      fixture.replies[0].result.resolve(true)
      await microtasks()
      fixture.emit(approval('second'))
      const dialog = find(fixture.render(), (node) => node.type === 'dialog')
      let prevented = false
      dialog.props.onCancel({
        preventDefault: () => {
          prevented = true
        }
      })
      assert.equal(prevented, true)
      assert.deepEqual(
        fixture.replies.map(({ id, approved }) => ({ id, approved })),
        [
          { id: 'first', approved: false },
          { id: 'second', approved: false }
        ]
      )
      fixture.replies[1].result.resolve(true)
      await microtasks()
      assert.equal(fixture.cancelRequests, 0)
      assert.equal(
        find(fixture.render(), (node) => node.props.className === 'execution-approval-cancel'),
        undefined
      )
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'late initial approval read, old response and retired approval event cannot replace new pending approval',
  async () => {
    const fixture = await approvalFixture()
    try {
      fixture.render()
      await microtasks()
      fixture.emit(approval('old'))
      find(
        fixture.render(),
        (node) => node.props.className === 'execution-approval-cancel'
      ).props.onClick({ detail: 1 })
      fixture.emit(approval('new'))
      fixture.initial.resolve(approval('initial-stale'))
      fixture.replies[0].result.resolve(true)
      await microtasks()
      assert.equal(
        find(fixture.render(), (node) => node.props.className === 'execution-approval-cancel').props
          .disabled,
        false
      )
      fixture.emit(approval('old'))
      find(
        fixture.render(),
        (node) => node.props.className === 'execution-approval-confirm'
      ).props.onClick({ detail: 1 })
      assert.deepEqual(
        fixture.replies.map(({ id, approved }) => ({ id, approved })),
        [
          { id: 'old', approved: false },
          { id: 'new', approved: true }
        ]
      )
      fixture.replies[1].result.resolve(true)
      await microtasks()
      fixture.emit(approval('new'))
      assert.equal(
        find(fixture.render(), (node) => node.props.className === 'execution-approval-confirm'),
        undefined
      )
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'approval response failure retains actual pending approval and restores retry; never defaults to approval',
  async () => {
    const fixture = await approvalFixture()
    try {
      fixture.render()
      fixture.emit(approval('retry'))
      find(
        fixture.render(),
        (node) => node.props.className === 'execution-approval-cancel'
      ).props.onClick({ detail: 1 })
      fixture.replies[0].result.reject(new Error('response failed'))
      await microtasks()
      const tree = fixture.render()
      assert.match(textOf(tree), /提交失败，请重试/)
      const button = find(tree, (node) => node.props.className === 'execution-approval-cancel')
      assert.equal(button.props.disabled, false)
      button.props.onClick({ detail: 1 })
      assert.deepEqual(
        fixture.replies.map(({ id, approved }) => ({ id, approved })),
        [
          { id: 'retry', approved: false },
          { id: 'retry', approved: false }
        ]
      )
      fixture.replies[1].result.resolve(true)
      await microtasks()
      assert.equal(fixture.cancelRequests, 0)
    } finally {
      fixture.dispose()
    }
  }
)

await check(
  'actual conversation controller forwards request-local stopping and disables answers and unknown-permission sends',
  async () => {
    const harness = hooks()
    let operation = 'generating',
      stopped = 0
    const request = {
      stopping: true,
      toolActivity: {},
      pendingPlanQuestion: { request: { inputId: 'current' } },
      stop: async () => {
        stopped++
      }
    }
    const permissions = { state: execution, loading: false, error: null }
    const module = await load('src/renderer/src/features/conversation/useConversation.ts', {
      react: harness.react,
      './useOperation': {
        useOperation: () => ({
          operation,
          isIdle: () => operation === 'idle',
          getOperation: () => operation
        })
      },
      './useConversationStorage': { useConversationStorage: () => ({ ready: true, error: null }) },
      './useConversationTasks': { useConversationTasks: () => {} },
      './useConversationTitle': {
        useConversationTitle: () => ({
          invalidate: () => {},
          invalidateAll: () => {},
          markRenamed: () => {},
          start: () => {}
        })
      },
      '../project/useWorkspace': { useWorkspace: () => ({ runtime: null, error: null }) },
      '../project/useProjectSelection': {
        useProjectSelection: () => ({
          projectSelection: null,
          pendingSelection: null,
          projectError: null
        })
      },
      '../project/useImageSelection': { useImageSelection: () => ({ busy: false, error: null }) },
      '../review/useConversationReview': {
        useConversationReview: () => ({ commandReview: {}, changePreview: {} })
      },
      '../execution/useExecutionPermissions': { useExecutionPermissions: () => permissions },
      '../chat/useChatRequest': { useChatRequest: () => request }
    })
    const render = () => harness.render(() => module.useConversation())
    try {
      assert.equal(render().stopping, true)
      assert.equal(render().canRespondToPlanQuestion, false)
      assert.equal(render().pendingPlanQuestion, request.pendingPlanQuestion)
      await render().stop()
      assert.equal(stopped, 1)
      request.stopping = false
      assert.equal(render().canRespondToPlanQuestion, true)
      operation = 'idle'
      assert.equal(render().canRespondToPlanQuestion, false)
      assert.equal(render().canSend, true)
      permissions.state = null
      assert.equal(render().canSend, false)
      assert.equal(render().send('权限未知'), false)
      permissions.state = execution
      render().setClosePending(true)
      operation = 'generating'
      assert.equal(render().canRespondToPlanQuestion, false)
    } finally {
      harness.dispose()
    }
  }
)

const workspace = {
  saved: null,
  runtime: null,
  instructionState: 'absent',
  instruction: null,
  canSelect: true,
  selecting: false,
  error: null
}
await check(
  'actual status renderer separates stopping, approval, question, command proposal and unrelated UI operations',
  async () => {
    const view = await componentFixture(
      'src/renderer/src/features/project/WorkspaceStatus.tsx',
      'WorkspaceStatus'
    )
    try {
      const defaults = {
        selection: null,
        workspace,
        permissions: execution,
        operation: 'idle',
        stopping: false,
        waitingApproval: false,
        waitingInput: false,
        commandProposalOpen: false
      }
      for (const [changes, expected] of [
        [
          { operation: 'generating', stopping: true, waitingApproval: true, waitingInput: true },
          '正在停止'
        ],
        [{ operation: 'generating', waitingApproval: true }, '等待批准'],
        [{ operation: 'generating', waitingInput: true }, '等待回答'],
        [{ commandProposalOpen: true }, '查看命令提案'],
        [{ operation: 'generating' }, '运行中'],
        [{ operation: 'saving' }, '保存中'],
        [{ operation: 'idle' }, '空闲']
      ]) {
        const tree = view.render({ ...defaults, ...changes })
        assert(textOf(tree).includes('状态：' + expected), expected)
      }
      assert.match(textOf(view.render({ ...defaults, permissions: null })), /权限：权限未就绪/)
    } finally {
      view.dispose()
    }
  }
)

await check(
  'actual chat workspace wires broker and question independently; command proposal is not broker approval',
  async () => {
    const messageList = marker('MessageList'),
      composer = marker('ChatComposer')
    const deps = {
      './MessageList': { MessageList: messageList },
      './ChatComposer': { ChatComposer: composer }
    }
    for (const [file, name] of [
      ['../../components/layout/ChatHeader', 'ChatHeader'],
      ['./ClearConversationDialog', 'ClearConversationDialog'],
      ['./EmptyState', 'EmptyState'],
      ['./NewChatHero', 'NewChatHero'],
      ['../conversation/CloseGuard', 'CloseGuard'],
      ['../review/ChangePreviewPanel', 'ChangePreviewPanel'],
      ['../review/CommandReviewPanel', 'CommandReviewPanel'],
      ['../review/CommitReceipt', 'CommitReceipt'],
      ['../project/ImagePreview', 'ImagePreview']
    ])
      deps[file] = { [name]: marker(name) }
    const chatWorkspace = {
      executionApprovalPending: false,
      composerRegionRef: { current: null },
      draft: '',
      previewTriggerRef: { current: null },
      commandTriggerRef: { current: null }
    }
    deps['./useChatWorkspace'] = { useChatWorkspace: () => chatWorkspace }
    const view = await componentFixture(
      'src/renderer/src/features/chat/ChatWorkspace.tsx',
      'ChatWorkspace',
      deps
    )
    try {
      const conversation = {
        activeConversationId: 'view',
        images: null,
        storage: { error: null, dirty: false },
        messages: [{ id: 'message' }],
        operation: 'generating',
        stopping: true,
        pendingPlanQuestion: { request: { inputId: 'input' } },
        commandReview: { proposal: { id: 'proposal' } },
        workspace,
        executionPermissions: { state: execution },
        changePreview: { state: { status: 'idle' } },
        canRespondToPlanQuestion: false
      }
      const workspaceProps = {
        conversation,
        onOpenFile: () => {},
        summary: {
          workspaceRef: { current: null },
          triggerRef: { current: null },
          enabled: false,
          visible: false,
          mode: 'overlay',
          toggle: () => {}
        },
        sources: [],
        onShowAllSources: () => {}
      }
      const tree = view.render(workspaceProps)
      const props = find(tree, (node) => node.type === composer).props
      assert.equal(props.conversation, conversation)
      assert.equal(props.conversation.stopping, true)
      assert.equal(props.executionApprovalPending, false)
      assert.equal(
        find(tree, (node) => node.type.displayName === 'CommandReviewPanel').props.proposal,
        conversation.commandReview.proposal
      )
      assert.equal(find(tree, (node) => node.type === messageList).props.planQuestionDisabled, true)
      chatWorkspace.executionApprovalPending = true
      assert.equal(
        find(view.render(workspaceProps), (node) => node.type === composer).props
          .executionApprovalPending,
        true
      )
    } finally {
      view.dispose()
    }
  }
)

await check(
  'actual composer stop callback and input presentation are wired; local stopping disables duplicate UI cancellation',
  async () => {
    const input = marker('ChatInput'),
      deps = { './ChatInput': { ChatInput: input } }
    for (const [file, name] of [
      ['../execution/ExecutionApproval', 'ExecutionApproval'],
      ['../execution/ComposerPermissions', 'ComposerPermissions'],
      ['../project/ComposerAttachments', 'ComposerAttachments'],
      ['../project/AttachmentCards', 'AttachmentCards'],
      ['../project/ImageAttachment', 'ImageAttachment'],
      ['./ComposerMode', 'ComposerPlanIndicator']
    ])
      deps[file] = { [name]: marker(name) }
    const composer = await componentFixture(
      'src/renderer/src/features/chat/ChatComposer.tsx',
      'ChatComposer',
      deps
    )
    const view = await componentFixture(
      'src/renderer/src/features/chat/ChatInput.tsx',
      'ChatInput',
      { '../../components/ui/Icon': { Icon: marker('Icon') } }
    )
    try {
      let stopped = 0
      const conversation = {
        workspace: { runtime: null },
        skills: { busy: false },
        messages: [],
        storage: { paused: false, dirty: false },
        operation: 'generating',
        stopping: true,
        canSend: false,
        activeConversationId: 'view',
        stop: async () => {
          stopped++
        },
        executionPermissions: { state: execution, loading: false }
      }
      const tree = composer.render({
        conversation,
        draft: '',
        onChange: () => {},
        onSend: () => false,
        executionApprovalPending: false,
        onPendingChange: () => {},
        anchorRef: { current: null }
      })
      const props = find(tree, (node) => node.type === input).props
      assert.equal(props.stopping, true)
      assert.equal(props.isSending, true)
      props.onStop()
      assert.equal(stopped, 1)
      const rendered = view.render(props)
      const button = find(rendered, (node) => node.props['aria-label'] === '正在停止')
      assert.equal(button.props.disabled, true)
      assert.match(
        find(rendered, (node) => node.type === 'textarea').props.placeholder,
        /等待任务结束/
      )
      const ready = view.render({ ...props, stopping: false })
      assert.equal(
        find(ready, (node) => node.props['aria-label'] === '停止生成').props.disabled,
        false
      )
    } finally {
      composer.dispose()
      view.dispose()
    }
  }
)

await check(
  'actual permission menu exposes unknown state rather than claiming default and retains the three mode values',
  async () => {
    const view = await componentFixture(
      'src/renderer/src/features/execution/ComposerPermissions.tsx',
      'ComposerPermissions'
    )
    try {
      let selections = 0
      const props = {
        disabled: true,
        conversationId: 'view',
        permissions: {
          state: null,
          loading: false,
          select: async () => {
            selections++
            return true
          }
        }
      }
      const tree = view.render(props)
      const trigger = find(tree, (node) => node.props.className === 'permissions-trigger')
      assert.equal(trigger.props['data-mode'], 'unknown')
      assert.equal(trigger.props['aria-label'], '权限：权限未知')
      assert.equal(trigger.props.disabled, true)
      const options = nodes(tree).filter((node) => node.props.role === 'menuitemradio')
      assert.deepEqual(
        options.map((node) => node.props['data-mode']),
        ['default', 'auto-approve', 'full-access']
      )
      assert(options.every((node) => node.props['aria-checked'] === false))
      options[2].props.onClick()
      await microtasks()
      assert.equal(selections, 0)
      assert.match(textOf(tree), /当前可写范围/)
      assert.match(textOf(tree), /审核失败仍需确认/)
      assert.match(textOf(tree), /运行环境的校验仍然生效/)
      assert.equal(textOf(tree).includes('不受限制'), false)
    } finally {
      view.dispose()
    }
  }
)

await finish({
  sourceFiles,
  sourceIdentity: 'source-identity.json',
  limits: [
    'Controlled synthetic IPC and hook/JSX adapter are not proof of real DOM focus, live Electron or native process cleanup.',
    'Task states in this suite are synthetic owner events; actual main lifecycle and desktop/CLI evidence are separate.'
  ]
})
delete globalThis.React
