import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { root, hash, checksFor } from '../lesson57/runtime.mjs'

const { load, microtasks } = createRequire(import.meta.url)('../lesson55/shared/harness.cjs')
const evidence = path.join(root, '.ui-check/test-runs/lesson62', 'renderer-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const { check, finish } = checksFor(evidence, {
  actualCurrentHooks: true,
  syntheticReact: true,
  syntheticIPC: true,
  realElectron: false,
  realDOM: false,
  modelTransport: false
})
const sourceFiles = [
  'src/renderer/src/features/skills/useSkills.ts',
  'src/renderer/src/features/skills/SkillsPage.tsx',
  'src/renderer/src/features/chat/ChatComposer.tsx',
  'src/renderer/src/features/chat/ChatWorkspace.tsx',
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/layout/Sidebar.tsx',
  'src/renderer/src/components/layout/SidebarRail.tsx',
  'src/renderer/src/components/layout/SidebarIcon.tsx',
  'src/renderer/src/assets/skills.css',
  'src/renderer/src/assets/sidebar.css',
  'src/renderer/src/features/chat/useChatRequest.ts',
  'src/renderer/src/features/chat/ChatInput.tsx',
  'src/renderer/src/features/conversation/useConversation.ts'
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
function hooks() {
  const slots = [],
    effects = []
  let index = 0
  const changed = (before, next) =>
    !before ||
    !next ||
    before.length !== next.length ||
    before.some((v, i) => !Object.is(v, next[i]))
  const effect = (action, deps) => {
    const key = index++
    if (!slots[key] || changed(slots[key].deps, deps)) {
      const previous = slots[key]
      slots[key] = { deps, cleanup: previous?.cleanup }
      effects.push(() => {
        previous?.cleanup?.()
        slots[key].cleanup = action()
      })
    }
  }
  return {
    react: {
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
      useCallback(action, deps) {
        const key = index++
        if (!slots[key] || changed(slots[key].deps, deps)) slots[key] = { value: action, deps }
        return slots[key].value
      },
      useMemo(action, deps) {
        const key = index++
        if (!slots[key] || changed(slots[key].deps, deps)) slots[key] = { value: action(), deps }
        return slots[key].value
      },
      useEffect: effect,
      useLayoutEffect: effect,
      useId() {
        const key = index++
        slots[key] ??= { value: 'skills-test-' + key }
        return slots[key].value
      }
    },
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
const descriptor = (id = 'skill-a', generation = 'generation-a') => ({
  skillId: id,
  generation,
  directoryName: 'code-review',
  status: 'available',
  name: 'code-review',
  description: '审查真实代码'
})
const selection = (id = 'selection-a') => ({
  selectionId: id,
  name: 'code-review',
  description: '审查真实代码',
  sourceHash: 'a'.repeat(64)
})
const list = (generation = 'generation-a') => ({
  status: 'ok',
  root: 'D:\\isolated\\skills',
  generation,
  skills: [descriptor('skill-' + generation, generation)]
})
const snapshot = (() => {
  const fields = {
    name: 'code-review',
    description: '审查真实代码',
    body: '# 审查\n读取实际代码并报告证据。',
    sourceHash: 'a'.repeat(64)
  }
  return {
    ...fields,
    snapshotHash: createHash('sha256').update(JSON.stringify(fields)).digest('hex')
  }
})()
async function skillsFixture(initialId = 'conversation-a') {
  const harness = hooks(),
    calls = [],
    lists = [],
    preparations = []
  const config = { id: initialId, allowed: true }
  const api = {
    listSkills(id) {
      calls.push(['list', id])
      const result = deferred()
      lists.push(result)
      return result.promise
    },
    prepareSkill(id, skillId, generation) {
      calls.push(['prepare', id, skillId, generation])
      const result = deferred()
      preparations.push(result)
      return result.promise
    },
    releaseSkill: async (id, selectionId) => {
      calls.push(['release', id, selectionId])
      return true
    },
    releaseConversationSkills: async (id) => {
      calls.push(['clear', id])
      return true
    },
    openSkillsDirectory: async () => {
      calls.push(['open'])
      return { status: 'opened', root: 'D:\\isolated\\skills' }
    }
  }
  globalThis.window = {
    api: new Proxy(api, {
      get(object, name) {
        assert(Object.hasOwn(object, name), 'Unexpected implicit API: ' + String(name))
        return object[name]
      }
    })
  }
  const module = await load('src/renderer/src/features/skills/useSkills.ts', {
    react: harness.react
  })
  const render = () =>
    harness.render(() =>
      module.useSkills({
        conversationId: config.id,
        canChange: () => config.allowed,
        ensureConversation: async () => {
          calls.push(['ensure'])
          config.id = 'created-conversation'
          return config.id
        }
      })
    )
  render()
  async function discover() {
    const action = render().refresh()
    await microtasks()
    lists.at(-1).resolve(list())
    assert.equal(await action, true)
    return render().items[0]
  }
  async function prepare(id = 'selection-a') {
    const item = await discover()
    const action = render().select(item)
    preparations.at(-1).resolve({ status: 'prepared', selection: selection(id) })
    assert.equal(await action, true)
    return render()
  }
  return {
    render,
    calls,
    lists,
    preparations,
    config,
    discover,
    prepare,
    dispose: () => harness.dispose()
  }
}

await check(
  'passive mount and conversation change do not discover prepare open or start a model',
  async () => {
    const f = await skillsFixture()
    assert.deepEqual(f.calls, [])
    f.config.id = 'conversation-b'
    f.render()
    await microtasks()
    assert.deepEqual(f.calls, [['clear', 'conversation-a']])
    assert.equal(f.render().pending, null)
    f.dispose()
  }
)
await check(
  'empty first conversation is created before discovery and selection stays bound to the returned id',
  async () => {
    const f = await skillsFixture(null)
    await f.prepare()
    assert.deepEqual(f.calls.slice(0, 2), [['ensure'], ['list', 'created-conversation']])
    assert.equal(f.render().pending.selectionId, 'selection-a')
    assert.equal(
      f.calls.some(([method]) => method === 'open'),
      false
    )
    f.dispose()
  }
)
await check(
  'bad entries and preparation errors stay visible without losing the original pending selection',
  async () => {
    const f = await skillsFixture()
    const chosen = await f.prepare()
    const item = f.render().items[0]
    const action = f.render().select(item)
    f.preparations.at(-1).resolve({ status: 'error', error: '源文件已删除，请重新选择。' })
    assert.equal(await action, false)
    assert.equal(f.render().pending.selectionId, chosen.pending.selectionId)
    assert.match(f.render().error, /删除/)
    assert.equal(f.render().busy, false)
    f.dispose()
  }
)
await check(
  'refresh releases pending selection and rejects a stale descriptor without another prepare',
  async () => {
    const f = await skillsFixture()
    await f.prepare()
    const oldItem = f.render().items[0]
    const action = f.render().refresh()
    await microtasks()
    f.lists.at(-1).resolve(list('generation-b'))
    await action
    assert(f.calls.some((call) => call[0] === 'release' && call[2] === 'selection-a'))
    assert.equal(f.render().pending, null)
    assert.equal(await f.render().select(oldItem), false)
    assert.equal(f.preparations.length, 1)
    f.dispose()
  }
)
await check(
  'a late preparation after switching conversation is released and cannot select in the new conversation',
  async () => {
    const f = await skillsFixture()
    const item = await f.discover()
    const action = f.render().select(item)
    f.config.id = 'conversation-b'
    f.render()
    f.preparations.at(-1).resolve({ status: 'prepared', selection: selection('late-selection') })
    assert.equal(await action, false)
    assert.equal(f.render().pending, null)
    assert(
      f.calls.some(
        (call) =>
          call[0] === 'release' && call[1] === 'conversation-a' && call[2] === 'late-selection'
      )
    )
    f.dispose()
  }
)
await check(
  'release retires same-conversation discovery and late errors cannot replace fresh state',
  async () => {
    const f = await skillsFixture()
    const first = f.render().refresh()
    const old = f.lists.at(-1)
    await f.render().release()
    const second = f.render().refresh()
    f.lists.at(-1).resolve(list('generation-b'))
    await second
    old.reject(new Error('obsolete list failure'))
    await first
    assert.equal(f.render().error, null)
    assert.equal(f.render().items[0].generation, 'generation-b')
    f.dispose()
  }
)
await check(
  'acceptance clears only the exact current pending id and an explicit removal releases it',
  async () => {
    const f = await skillsFixture()
    await f.prepare()
    f.render().markAccepted('foreign-selection')
    assert(f.render().pending)
    f.render().markAccepted('selection-a')
    assert.equal(f.render().pending, null)
    assert.equal(
      f.calls.some((call) => call[0] === 'release' && call[2] === 'selection-a'),
      false,
      'Main consumes accepted references; renderer must not double-release and misreport failure'
    )
    assert.equal(f.render().error, null)
    await f.prepare('selection-b')
    assert.equal(await f.render().remove(), true)
    assert.equal(f.render().pending, null)
    assert(f.calls.some((call) => call[0] === 'release' && call[2] === 'selection-b'))
    f.dispose()
  }
)

const execution = {
  mode: 'default',
  revision: 0,
  cwd: 'D:\\isolated\\project',
  scopeId: 'a'.repeat(64)
}
async function requestFixture({ heldExecution = false, resumable = null } = {}) {
  const harness = hooks(),
    listeners = new Map(),
    starts = [],
    calls = [],
    resolves = []
  let operation = 'idle'
  let conversation = {
    id: 'conversation-a',
    title: '新会话 1',
    pinned: false,
    archived: false,
    defaultDirectory: execution.cwd,
    agentMode: 'execute',
    messages: [],
    toolRuns: [],
    workspace: null,
    tasks: []
  }
  const api = {
    getPendingAgentUserInput: async () => null,
    getResumableAgentTask: async () => resumable,
    resolveAgentExecution(context) {
      calls.push(['resolve', context])
      if (!heldExecution) return Promise.resolve(execution)
      const value = deferred()
      resolves.push(value)
      return value.promise
    },
    startAgentRequest(id, prompt, history, context) {
      const result = deferred()
      starts.push({ id, prompt, history, context, result })
      return result.promise
    },
    resumeAgentRequest(id, checkpointTaskId, context) {
      const result = deferred()
      starts.push({ id, checkpointTaskId, context, result })
      return result.promise
    },
    cancelAgentRequest: async (id) => {
      calls.push(['cancel', id])
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
    'onTaskState',
    'onAgentSkillAccepted'
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
    projectSelection: null,
    workspace: null,
    updateMessages: (_id, update) => {
      conversation.messages = update(conversation.messages)
    },
    updateConversation: (_id, update) => {
      conversation = update(conversation)
    },
    getPermissions: () => execution,
    observeExecution: () => {},
    isImageAvailable: () => true,
    getImageDescriptor: (imageId) => ({
      imageId,
      name: 'accepted.png',
      mime: 'image/png',
      bytes: 100,
      width: 10,
      height: 10
    }),
    onImagesAccepted: (messageId, imageIds) => calls.push(['imagesAccepted', messageId, imageIds]),
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
    }
  }
  const render = () => {
    options.messages = conversation.messages
    options.toolRuns = conversation.toolRuns
    return harness.render(() => module.useChatRequest(options))
  }
  const emit = (event) => listeners.get('onAgentSkillAccepted')?.(event)
  const accept = (start = starts.at(-1), value = snapshot) =>
    emit({
      requestId: start.id,
      conversationId: start.context.conversationId,
      messageId: start.context.userMessageId,
      snapshot: value
    })
  render()
  await microtasks()
  return {
    render,
    starts,
    calls,
    resolves,
    emit,
    accept,
    getConversation: () => conversation,
    dispose: () => harness.dispose()
  }
}
const sendSkill = (f, onAccepted, onSkillAccepted, imageIds = []) =>
  f
    .render()
    .send(
      '审查实际代码',
      'plan',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onAccepted,
      [],
      undefined,
      imageIds,
      undefined,
      { kind: 'selection', selectionId: 'selection-a' },
      onSkillAccepted
    )

await check(
  'skill send waits for matching main acceptance before callbacks and persists only the confirmed user snapshot',
  async () => {
    const f = await requestFixture()
    let accepted = 0,
      selectionCleared = 0,
      settled = false
    const promise = sendSkill(
      f,
      () => accepted++,
      () => selectionCleared++
    )
    assert(promise instanceof Promise)
    promise.then(() => {
      settled = true
    })
    await microtasks()
    const started = f.starts[0]
    assert.deepEqual(started.context.skill, { kind: 'selection', selectionId: 'selection-a' })
    assert.equal(Object.hasOwn(started.context, 'body'), false)
    assert.equal(accepted, 0)
    assert.equal(settled, false)
    f.emit({
      requestId: started.id,
      conversationId: 'foreign',
      messageId: started.context.userMessageId,
      snapshot
    })
    f.emit({
      requestId: started.id,
      conversationId: started.context.conversationId,
      messageId: 'foreign',
      snapshot
    })
    assert.equal(accepted, 0)
    f.accept()
    assert.equal(await promise, true)
    assert.equal(accepted, 1)
    assert.equal(selectionCleared, 1)
    assert.deepEqual(
      f.getConversation().messages.find((message) => message.role === 'user').skill,
      snapshot
    )
    assert.equal(
      f.getConversation().messages.find((message) => message.role === 'assistant').skill,
      undefined
    )
    f.accept()
    assert.equal(accepted, 1)
    started.result.resolve({ status: 'done', answer: '审查完成', trace: [], items: [] })
    await microtasks()
    f.dispose()
  }
)
await check(
  'failed preacceptance returns false leaves accurate failed placeholders and never calls accepted/title callbacks',
  async () => {
    const f = await requestFixture()
    let accepted = 0
    const promise = sendSkill(f, () => accepted++)
    await microtasks()
    f.starts[0].result.resolve({ status: 'error', error: '技能文件已变化', trace: [], items: [] })
    assert.equal(await promise, false)
    await microtasks()
    assert.equal(accepted, 0)
    assert(
      f.getConversation().messages.every((message) => message.status === 'failed' && !message.skill)
    )
    assert.equal(f.render().canRetry(f.getConversation().messages.at(-1).id), false)
    assert.match(f.render().error, /变化/)
    f.dispose()
  }
)
await check(
  'stop during environment preparation resolves false immediately and late environment starts no task',
  async () => {
    const f = await requestFixture({ heldExecution: true })
    let accepted = 0
    const promise = sendSkill(f, () => accepted++)
    await f.render().stop()
    assert.equal(await promise, false)
    f.resolves[0].resolve(execution)
    await microtasks()
    assert.equal(f.starts.length, 0)
    assert.equal(accepted, 0)
    assert(f.getConversation().messages.every((message) => message.status === 'cancelled'))
    f.dispose()
  }
)
await check(
  'stop before host acceptance ends cancelled without a snapshot or accepted callbacks',
  async () => {
    const f = await requestFixture()
    let accepted = 0
    const promise = sendSkill(f, () => accepted++, undefined, ['image-a'])
    await microtasks()
    await f.render().stop()
    f.starts[0].result.resolve({ status: 'cancelled', trace: [], items: [] })
    assert.equal(await promise, false)
    await microtasks()
    assert.equal(accepted, 0)
    assert.equal(f.calls.filter(([method]) => method === 'imagesAccepted').length, 0)
    assert(
      f
        .getConversation()
        .messages.every((message) => message.status === 'cancelled' && !message.skill)
    )
    f.dispose()
  }
)
await check(
  'matching host acceptance arriving after stop preserves snapshot, image binding and retry source but suppresses title and draft acceptance',
  async () => {
    const f = await requestFixture()
    let accepted = 0,
      pendingCleared = 0
    const promise = sendSkill(
      f,
      () => accepted++,
      () => pendingCleared++,
      ['image-a']
    )
    await microtasks()
    await f.render().stop()
    f.accept()
    assert.equal(await promise, false)
    f.starts[0].result.resolve({ status: 'cancelled', trace: [], items: [] })
    await microtasks()
    const user = f.getConversation().messages.find((message) => message.role === 'user')
    assert.deepEqual(user.skill, snapshot)
    assert.equal(user.status, 'cancelled')
    assert.equal(accepted, 0)
    assert.equal(pendingCleared, 1)
    assert.deepEqual(
      f.calls.filter(([method]) => method === 'imagesAccepted'),
      [['imagesAccepted', user.id, ['image-a']]]
    )
    f.accept()
    assert.equal(f.calls.filter(([method]) => method === 'imagesAccepted').length, 1)
    assert.equal(f.render().canRetry(f.getConversation().messages.at(-1).id), true)
    f.dispose()
  }
)
await check(
  'accepted failed request retries through the original user message reference and retains confirmed snapshot',
  async () => {
    const f = await requestFixture()
    const first = sendSkill(f)
    await microtasks()
    const original = f.starts[0]
    f.accept()
    assert.equal(await first, true)
    original.result.resolve({
      status: 'error',
      error: 'synthetic response failure',
      trace: [],
      items: []
    })
    await microtasks()
    const assistantId = f.getConversation().messages.at(-1).id
    assert.equal(f.render().canRetry(assistantId), true)
    const retry = f.render().retry(assistantId)
    assert(retry instanceof Promise)
    await microtasks()
    assert.deepEqual(f.starts[1].context.skill, {
      kind: 'message',
      messageId: original.context.userMessageId
    })
    f.accept(f.starts[1])
    assert.equal(await retry, true)
    f.starts[1].result.resolve({ status: 'done', answer: '重试完成', trace: [], items: [] })
    await microtasks()
    assert(
      f
        .getConversation()
        .messages.filter((message) => message.role === 'user')
        .every((message) => message.skill.snapshotHash === snapshot.snapshotHash)
    )
    f.dispose()
  }
)
await check(
  'ordinary new send preserves synchronous acceptance and never activates the previous skill',
  async () => {
    const f = await requestFixture()
    const first = sendSkill(f)
    await microtasks()
    f.accept()
    await first
    f.starts[0].result.resolve({ status: 'done', answer: '完成', trace: [], items: [] })
    await microtasks()
    let accepted = 0
    assert.equal(
      f
        .render()
        .send(
          '下一条普通消息',
          'execute',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () => accepted++
        ),
      true
    )
    assert.equal(accepted, 1)
    await microtasks()
    assert.equal(f.starts[1].context.skill, undefined)
    f.starts[1].result.resolve({ status: 'done', answer: '普通完成', trace: [], items: [] })
    await microtasks()
    assert.equal(
      f
        .getConversation()
        .messages.filter((message) => message.role === 'user')
        .at(-1).skill,
      undefined
    )
    f.dispose()
  }
)
await check(
  'explicit resume uses checkpoint and accepts original host snapshot without a selection reference',
  async () => {
    const task = {
      taskId: 'checkpoint-a',
      prompt: '继续原审查',
      mode: 'plan',
      requiresWorkspace: false,
      skillName: 'code-review'
    }
    const f = await requestFixture({ resumable: task })
    assert.equal(f.starts.length, 0)
    assert.equal(f.render().resumableTask.skillName, 'code-review')
    const resume = f.render().resume()
    assert(resume instanceof Promise)
    await microtasks()
    assert.equal(f.starts[0].checkpointTaskId, 'checkpoint-a')
    assert.equal(f.starts[0].context.skill, undefined)
    f.accept()
    assert.equal(await resume, true)
    assert.deepEqual(f.getConversation().messages[0].skill, snapshot)
    f.starts[0].result.resolve({ status: 'done', answer: '续接完成', trace: [], items: [] })
    await microtasks()
    f.dispose()
  }
)
await check(
  'disposing a preparing request resolves false and discards later accepted events',
  async () => {
    const f = await requestFixture()
    let accepted = 0
    const promise = sendSkill(f, () => accepted++)
    await microtasks()
    f.dispose()
    assert.equal(await promise, false)
    f.accept()
    assert.equal(accepted, 0)
    assert(f.calls.some(([method]) => method === 'cancel'))
    f.starts[0].result.resolve({ status: 'cancelled', trace: [], items: [] })
    await microtasks()
  }
)

await check(
  'actual ChatInput keeps the skill draft until acceptance and failed acceptance does not clear it',
  async () => {
    const harness = hooks(),
      held = deferred(),
      changes = []
    const jsx = (type, props) => ({ type, props: props ?? {} })
    globalThis.React = {
      createElement: (type, props, ...children) => jsx(type, { ...props, children }),
      Fragment: 'fragment'
    }
    const module = await load('src/renderer/src/features/chat/ChatInput.tsx', {
      react: harness.react,
      'react/jsx-runtime': { jsx, jsxs: jsx },
      './useFileMentions': {
        useFileMentions: () => ({
          adding: false,
          open: false,
          update: () => {},
          onKeyDown: () => false
        })
      },
      './FileMentionMenu': { FileMentionMenu: () => null }
    })
    const props = {
      value: '未接受的技能草稿',
      draftKey: 'conversation-a',
      onChange: (text) => changes.push(text),
      onSend: () => held.promise,
      onStop: () => {},
      disabled: false,
      isSending: false,
      stopping: false,
      maxLength: 2000,
      tools: null
    }
    const render = () => harness.render(() => module.ChatInput(props))
    render().props.onSubmit({
      preventDefault() {
        return undefined
      }
    })
    await microtasks()
    assert.deepEqual(changes, [])
    held.resolve(false)
    await microtasks()
    assert.deepEqual(changes, [])
    harness.dispose()
    delete globalThis.React
  }
)
await check(
  'actual ChatInput accepts a skill send but preserves a later edited draft or different conversation key',
  async () => {
    for (const change of [{ value: '用户后来输入的新草稿' }, { draftKey: 'conversation-b' }]) {
      const harness = hooks(),
        held = deferred(),
        changes = []
      const jsx = (type, props) => ({ type, props: props ?? {} })
      globalThis.React = {
        createElement: (type, props, ...children) => jsx(type, { ...props, children }),
        Fragment: 'fragment'
      }
      const module = await load('src/renderer/src/features/chat/ChatInput.tsx', {
        react: harness.react,
        'react/jsx-runtime': { jsx, jsxs: jsx },
        './useFileMentions': {
          useFileMentions: () => ({
            adding: false,
            open: false,
            update: () => {},
            onKeyDown: () => false
          })
        },
        './FileMentionMenu': { FileMentionMenu: () => null }
      })
      const props = {
        value: '发送时的技能草稿',
        draftKey: 'conversation-a',
        onChange: (text) => changes.push(text),
        onSend: () => held.promise,
        onStop: () => {},
        disabled: false,
        isSending: false,
        stopping: false,
        maxLength: 2000,
        tools: null
      }
      const render = () => harness.render(() => module.ChatInput(props))
      render().props.onSubmit({
        preventDefault() {
          return undefined
        }
      })
      Object.assign(props, change)
      render()
      held.resolve(true)
      await microtasks()
      assert.deepEqual(changes, [])
      harness.dispose()
      delete globalThis.React
    }
  }
)

await check(
  'actual clear persists the whole deletion before publishing and discarding accepted skills; failed save retains original records',
  async () => {
    const harness = hooks(),
      writes = [],
      calls = [],
      empty = () => undefined
    let operation = 'idle'
    const library = {
      version: 9,
      activeConversationId: 'conversation-a',
      conversations: [
        {
          id: 'conversation-a',
          defaultDirectory: execution.cwd,
          title: '技能原消息',
          pinned: false,
          archived: false,
          agentMode: 'plan',
          messages: [
            {
              id: 'original-user',
              role: 'user',
              mode: 'plan',
              content: '原审查',
              status: 'cancelled',
              skill: snapshot
            }
          ],
          toolRuns: [],
          workspace: null,
          tasks: []
        }
      ]
    }
    const operations = {
      get operation() {
        return operation
      },
      isIdle: () => operation === 'idle',
      getOperation: () => operation,
      begin(next) {
        if (operation !== 'idle') return false
        operation = next
        return true
      },
      finish(next) {
        if (operation === next) operation = 'idle'
      }
    }
    globalThis.window = {
      api: {
        discardConversationSkills: async (id) => {
          calls.push(['discard', id])
          return true
        }
      }
    }
    const module = await load('src/renderer/src/features/conversation/useConversation.ts', {
      react: harness.react,
      './useOperation': { useOperation: () => operations },
      './useConversationStorage': {
        useConversationStorage: ({ setSnapshot }) => {
          harness.react.useEffect(() => {
            setSnapshot(library)
          }, [])
          return {
            ready: true,
            error: null,
            saveSnapshot: (value) => {
              const result = deferred()
              writes.push({ value, result })
              return result.promise
            }
          }
        }
      },
      './useConversationTasks': { useConversationTasks: empty },
      './useConversationTitle': {
        useConversationTitle: () => ({
          invalidate: empty,
          invalidateAll: empty,
          markRenamed: empty,
          start: empty
        })
      },
      '../project/useWorkspace': { useWorkspace: () => ({ runtime: null }) },
      '../project/useProjectSelection': {
        useProjectSelection: () => ({
          projectSelection: null,
          pendingSelection: null,
          revokeSelectionForChange: async () => true,
          clearError: empty
        })
      },
      '../project/useImageSelection': {
        useImageSelection: () => ({ messages: {}, busy: false, release: async () => true })
      },
      '../skills/useSkills': {
        useSkills: () => ({ pending: null, busy: false, error: null, release: async () => true })
      },
      '../execution/useExecutionPermissions': {
        useExecutionPermissions: () => ({ state: { mode: 'default', revision: 0 }, loading: false })
      },
      '../review/useConversationReview': {
        useConversationReview: () => ({ commandReview: {}, changePreview: {} })
      },
      '../chat/useChatRequest': {
        useChatRequest: () => ({
          toolActivity: {},
          clearError: empty,
          clearActivity: () => calls.push(['clear-retries'])
        })
      }
    })
    const render = () => harness.render(() => module.useConversation())
    render()
    render()
    const first = render().clear()
    await microtasks()
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].value.conversations[0].messages, [])
    assert.equal(render().messages[0].id, 'original-user')
    assert.deepEqual(calls, [])
    writes[0].result.resolve(false)
    assert.equal(await first, false)
    assert.equal(render().messages[0].id, 'original-user')
    assert.deepEqual(calls, [])
    const second = render().clear()
    await microtasks()
    writes[1].result.resolve(true)
    assert.equal(await second, true)
    assert.deepEqual(render().messages, [])
    assert.deepEqual(calls, [['clear-retries'], ['discard', 'conversation-a']])
    harness.dispose()
  }
)

function jsx(type, props) {
  return { type, props: props ?? {} }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
const marker = (name) => Object.assign(() => null, { displayName: name })

async function appFixture() {
  const harness = hooks(),
    calls = [],
    frames = [],
    listeners = new Map(),
    observers = [],
    preparations = []
  const markers = Object.fromEntries(
    [
      'Sidebar',
      'SidebarRail',
      'SidebarSearch',
      'ChatWorkspace',
      'SettingsPage',
      'SkillsPage',
      'WorkbenchWorkspace'
    ].map((name) => [name, marker(name)])
  )
  const previous = Object.fromEntries(
    [
      'React',
      'window',
      'document',
      'localStorage',
      'requestAnimationFrame',
      'MutationObserver',
      'HTMLElement'
    ].map((name) => [name, { exists: Object.hasOwn(globalThis, name), value: globalThis[name] }])
  )
  const config = { dialog: null, popover: null, userInput: null, sidebarOpen: true }
  const skills = {
    root: 'D:\\isolated\\skills',
    items: [descriptor()],
    pending: selection(),
    busy: false,
    error: null,
    refresh: async () => {
      calls.push(['refresh'])
      return true
    },
    release: async () => {
      calls.push(['release'])
      return true
    },
    select(item) {
      calls.push(['prepare', item.skillId])
      const result = deferred()
      preparations.push(result)
      return result.promise
    }
  }
  const controller = {
    activeConversationId: 'conversation-a',
    canNavigate: true,
    canChangeSettings: true,
    conversations: [],
    visibleConversations: [],
    messages: [],
    toolRuns: [],
    executionPermissions: { state: { revision: 0 } },
    workspace: { runtime: null, select: async () => true },
    contextSelection: null,
    skills,
    setSearch: (value) => calls.push(['search', value]),
    create: async () => {
      calls.push(['create'])
      return true
    },
    select: async (id) => {
      calls.push(['navigate', id])
      return true
    },
    restore: async () => true
  }
  globalThis.HTMLElement = class {
    constructor(label) {
      this.label = label
    }
    focus() {
      calls.push(['focus', this.label])
      globalThis.document.activeElement = this
    }
  }
  const input = new HTMLElement('chat-input'),
    trigger = new HTMLElement('skills-entry')
  globalThis.React = {
    createElement: (type, props, ...children) => jsx(type, { ...props, children }),
    Fragment: 'fragment'
  }
  globalThis.document = {
    body: {},
    activeElement: trigger,
    getElementById: (id) => (id === 'chat-input' ? input : null),
    querySelector(selector) {
      if (selector.startsWith('dialog[open]:not'))
        return config.dialog?.className === 'skill-detail-dialog' ? null : config.dialog
      if (selector.includes('dialog[open]')) return config.dialog ?? config.popover
      return null
    }
  }
  globalThis.window = {
    innerWidth: 1200,
    api: {
      onAgentUserInputChange(callback) {
        config.userInput = callback
        return () => {
          config.userInput = null
        }
      }
    },
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name)
    }
  }
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback)
    return frames.length
  }
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback
      this.active = false
      observers.push(this)
    }
    observe() {
      this.active = true
    }
    disconnect() {
      this.active = false
    }
  }
  const module = await load('src/renderer/src/App.tsx', {
    react: harness.react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './features/conversation/useConversation': { useConversation: () => controller },
    './components/layout/Sidebar': { Sidebar: markers.Sidebar },
    './components/layout/SidebarRail': { SidebarRail: markers.SidebarRail },
    './components/layout/SidebarSearch': { SidebarSearch: markers.SidebarSearch },
    './components/layout/TitleBar': { TitleBar: marker('TitleBar') },
    './components/layout/useSidebarLayout': {
      useSidebarLayout: () => ({
        open: config.sidebarOpen,
        peeking: false,
        present: true,
        expanded: config.sidebarOpen,
        transitioning: false,
        setOpen: (next) => {
          config.sidebarOpen = typeof next === 'function' ? next(config.sidebarOpen) : next
        },
        enterPreview: () => {},
        leavePreview: () => {},
        finishTransition: () => {}
      })
    },
    './features/chat/ChatWorkspace': { ChatWorkspace: markers.ChatWorkspace },
    './features/chat/useThreadSummaryPanel': {
      useThreadSummaryPanel: () => ({ closeOverlay: () => {} })
    },
    './features/chat/useSourcesSidePanel': {
      useSourcesSidePanel: () => ({
        open: false,
        selected: 'sources',
        select: () => {},
        close: () => {},
        show: () => {}
      })
    },
    './features/workbench/WorkbenchWorkspace': {
      WorkbenchWorkspace: markers.WorkbenchWorkspace
    },
    './features/chat/thread-summary-sources': { threadSummarySources: () => [] },
    './features/files/useFileView': {
      useFileView: () => ({ state: { status: 'idle' }, open: () => {}, close: () => {} })
    },
    './features/settings/SettingsPage': { SettingsPage: markers.SettingsPage },
    './features/skills/SkillsPage': { SkillsPage: markers.SkillsPage }
  })
  const render = () => harness.render(() => module.default())
  const get = (name) => {
    const tree = nodes(render())
    if (name === 'ChatWorkspace') {
      const panel = tree.find((node) => node.type === markers.WorkbenchWorkspace)
      const child = Array.isArray(panel?.props.children) ? panel.props.children[0] : panel?.props.children
      if (typeof child === 'function') return child({ newTabVisible: false, openNewTab() {}, openNewTabMenu() {} })
    }
    return tree.find((node) => node.type === markers[name])
  }
  const shell = () => nodes(render()).find((node) => node.props?.className === 'workspace-shell')
  const flushFrames = () => {
    while (frames.length) frames.shift()()
  }
  render()
  return {
    render,
    get,
    shell,
    calls,
    controller,
    skills,
    preparations,
    config,
    trigger,
    input,
    flushFrames,
    notifyDialog: () =>
      observers.filter((observer) => observer.active).forEach((observer) => observer.callback()),
    key: (event) => listeners.get('keydown')?.(event),
    dispose() {
      harness.dispose()
      for (const [name, saved] of Object.entries(previous))
        if (saved.exists) globalThis[name] = saved.value
        else delete globalThis[name]
    }
  }
}

await check(
  'actual SkillsPage discovers only on an explicit closed-to-open transition; root reset or busy reentry does not ensure a conversation or rescan until manual refresh',
  async () => {
    const harness = hooks(),
      calls = [],
      refs = new WeakMap(),
      frames = []
    const previous = Object.fromEntries(
      ['React', 'document', 'requestAnimationFrame', 'HTMLElement'].map((name) => [
        name,
        { exists: Object.hasOwn(globalThis, name), value: globalThis[name] }
      ])
    )
    globalThis.HTMLElement = class {
      constructor() {
        this.isConnected = true
        this.hidden = false
        this.disabled = false
        this.open = false
      }
      focus() {
        document.activeElement = this
      }
      getClientRects() {
        return this.hidden ? [] : [{}]
      }
      closest() {
        return null
      }
      contains(element) {
        return element === this
      }
      matches(selector) {
        return selector === ':disabled' && this.disabled
      }
      querySelector() {
        return null
      }
      showModal() {
        this.open = true
      }
      close() {
        this.open = false
      }
    }
    const input = new HTMLElement()
    globalThis.document = {
      body: {},
      activeElement: input,
      querySelector: () => null,
      getElementById: (id) => (id === 'chat-input' ? input : null)
    }
    globalThis.requestAnimationFrame = (callback) => {
      frames.push(callback)
      return frames.length
    }
    const pageJsx = (type, props) => {
      if (typeof type === 'string' && props?.ref && typeof props.ref === 'object') {
        let element = refs.get(props.ref)
        if (!element) {
          element = new HTMLElement()
          refs.set(props.ref, element)
        }
        element.hidden = Boolean(props.hidden)
        element.disabled = Boolean(props.disabled)
        props.ref.current = element
      }
      return jsx(type, props)
    }
    globalThis.React = {
      createElement: (type, props, ...children) => pageJsx(type, { ...props, children }),
      Fragment: 'fragment'
    }
    const skills = {
      root: '',
      items: [],
      pending: null,
      error: null,
      busy: false,
      refresh: async () => {
        calls.push(['refresh'])
        skills.busy = true
        return true
      },
      openDirectory: async () => {
        calls.push(['directory'])
        return true
      }
    }
    const props = {
      open: false,
      skills,
      disabled: false,
      returnFocus: input,
      onSelect: async () => {
        calls.push(['select'])
        return true
      }
    }
    const module = await load('src/renderer/src/features/skills/SkillsPage.tsx', {
      react: harness.react,
      'react/jsx-runtime': { jsx: pageJsx, jsxs: pageJsx },
      '../../components/ui/Icon': { Icon: marker('Icon') }
    })
    const render = () => harness.render(() => module.SkillsPage(props))
    try {
      render()
      assert.deepEqual(calls, [], 'A passively mounted hidden skills page has no discovery')
      props.open = true
      render()
      assert.deepEqual(calls, [['refresh']])
      props.open = false
      render()
      props.open = true
      render()
      assert.equal(calls.length, 1, 'Reopening during the first scan never starts a parallel scan')
      skills.busy = false
      skills.root = 'D:\\isolated\\skills'
      skills.items = [descriptor()]
      render()
      props.open = false
      render()
      props.open = true
      render()
      assert.equal(
        calls.length,
        1,
        'The previously discovered library remains available on reentry'
      )
      skills.root = ''
      skills.items = []
      render()
      render()
      assert.equal(
        calls.length,
        1,
        'A conversation change/root reset while the page stays open is passive'
      )
      skills.busy = false
      skills.root = ''
      props.open = false
      render()
      props.open = true
      render()
      assert.equal(
        calls.length,
        2,
        'A later explicit entry into an idle empty scope can discover it'
      )
      skills.busy = false
      skills.pending = selection()
      props.open = false
      render()
      props.open = true
      render()
      assert.equal(
        calls.length,
        2,
        'An explicitly chosen skill is preserved when an empty scope is reopened'
      )
      skills.pending = null
      props.disabled = true
      props.open = false
      render()
      props.open = true
      render()
      assert.equal(calls.length, 2, 'A disabled page never discovers a skill directory')
      props.disabled = false
      render()
      assert.equal(calls.length, 2, 'Becoming available while already open remains passive')
      assert.equal(
        calls.some(([method]) => method === 'directory' || method === 'select'),
        false
      )
    } finally {
      harness.dispose()
      for (const [name, saved] of Object.entries(previous))
        if (saved.exists) globalThis[name] = saved.value
        else delete globalThis[name]
    }
  }
)

await check(
  'actual ChatComposer places only the pending skill notice outside the message input, with removal guarded by existing task and approval state',
  async () => {
    const harness = hooks(),
      input = marker('ChatInput'),
      previousReact = globalThis.React
    globalThis.React = {
      createElement: (type, props, ...children) => jsx(type, { ...props, children }),
      Fragment: 'fragment'
    }
    let removals = 0
    const deps = {
      react: harness.react,
      'react/jsx-runtime': { jsx, jsxs: jsx },
      './ChatInput': { ChatInput: input }
    }
    for (const [file, name] of [
      ['../execution/ExecutionApproval', 'ExecutionApproval'],
      ['../execution/ComposerPermissions', 'ComposerPermissions'],
      ['../project/ComposerAttachments', 'ComposerAttachments'],
      ['../project/AttachmentCards', 'AttachmentCards'],
      ['../project/ImageAttachment', 'ImageAttachment'],
      ['./ComposerMode', 'ComposerPlanIndicator'],
      ['../../components/ui/Icon', 'Icon']
    ])
      deps[file] = { [name]: marker(name) }
    const module = await load('src/renderer/src/features/chat/ChatComposer.tsx', deps)
    const conversation = {
      activeConversationId: 'conversation-a',
      operation: 'idle',
      canSend: true,
      canNavigate: true,
      canEdit: true,
      messages: [],
      workspace: { runtime: null },
      images: { busy: false, pending: [] },
      executionPermissions: { state: { mode: 'default' }, loading: false },
      skills: {
        pending: selection(),
        busy: false,
        remove: async () => {
          removals++
          return true
        }
      }
    }
    const props = {
      conversation,
      draft: '保留的草稿',
      onChange: () => {},
      onSend: () => false,
      executionApprovalPending: false,
      onPendingChange: () => {},
      anchorRef: { current: null }
    }
    const render = () => harness.render(() => module.ChatComposer(props))
    try {
      const tree = render()
      const pending = nodes(tree).find((node) => node.props?.className === 'pending-skill')
      const composerInput = nodes(tree).find((node) => node.type === input)
      assert(pending)
      assert(tree.props.children.includes(pending), 'Pending guidance is a sibling of the input')
      assert(tree.props.children.includes(composerInput))
      assert.equal(
        nodes(composerInput.props.tools).some((node) =>
          /(?:skills|skill-option)/.test(node.props?.className ?? '')
        ),
        false
      )
      const remove = nodes(pending).find((node) => node.type === 'button')
      assert.equal(remove.props.disabled, false)
      remove.props.onClick()
      await microtasks()
      assert.equal(removals, 1)
      for (const state of ['generating', 'approval', 'skills-busy', 'images-busy']) {
        conversation.operation = state === 'generating' ? 'generating' : 'idle'
        props.executionApprovalPending = state === 'approval'
        conversation.skills.busy = state === 'skills-busy'
        conversation.images.busy = state === 'images-busy'
        assert.equal(
          nodes(render()).find((node) => node.props?.className?.includes('pending-skill-remove'))
            .props.disabled,
          true
        )
      }
      conversation.skills.pending = null
      assert.equal(
        nodes(render()).some((node) => node.props?.className === 'pending-skill'),
        false
      )
    } finally {
      harness.dispose()
      if (previousReact === undefined) delete globalThis.React
      else globalThis.React = previousReact
    }
  }
)

await check(
  'actual App shares one sidebar skills destination and hides the continuously mounted chat without discovering or releasing skills on navigation',
  async () => {
    const f = await appFixture()
    try {
      assert.equal(f.get('SkillsPage').props.open, false)
      assert.equal(f.shell().props.hidden, false)
      const chat = f.get('ChatWorkspace')
      const navigation = nodes(f.render()).filter((node) => node.props?.onOpenSkills)
      const expanded = navigation[0].props.onOpenSkills
      assert.equal(expanded, navigation[1].props.onOpenSkills)
      expanded(f.trigger)
      assert.equal(f.get('SkillsPage').props.open, true)
      assert.equal(f.get('SettingsPage').props.open, false)
      assert.equal(f.shell().props.hidden, true)
      assert.equal(f.shell().props.inert, true)
      assert.equal(f.get('WorkbenchWorkspace').props.active, false)
      assert.equal(f.get('ChatWorkspace').type, chat.type)
      assert.equal(f.get('ChatWorkspace').props.conversation, chat.props.conversation)
      f.key({
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      })
      assert.equal(f.shell().props.hidden, false)
      f.config.sidebarOpen = false
      f.get('SidebarRail').props.onOpenSkills(f.trigger)
      assert.equal(f.get('SkillsPage').props.open, true)
      f.key({
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      })
      assert.equal(f.skills.pending.selectionId, 'selection-a')
      assert.deepEqual(f.calls, [], 'Navigation alone neither scans nor discards a pending skill')
      f.controller.canNavigate = false
      assert.equal(f.get('SidebarRail').props.skillsDisabled, true)
      f.get('SidebarRail').props.onOpenSkills(f.trigger)
      assert.equal(f.get('SkillsPage').props.open, false)
    } finally {
      f.dispose()
    }
  }
)

await check(
  'actual App selects into the current chat and focuses its input; failed or late selection does not replace a changed page or conversation',
  async () => {
    const f = await appFixture()
    try {
      f.get('Sidebar').props.onOpenSkills(f.trigger)
      const failed = f.get('SkillsPage').props.onSelect(descriptor())
      f.preparations.at(-1).resolve(false)
      assert.equal(await failed, false)
      assert.equal(f.get('SkillsPage').props.open, true)
      const changedPage = f.get('SkillsPage').props.onSelect(descriptor())
      f.get('Sidebar').props.onOpenSettings(f.trigger)
      f.preparations.at(-1).resolve(true)
      assert.equal(await changedPage, true)
      assert.equal(f.get('SettingsPage').props.open, true)
      f.flushFrames()
      assert.equal(
        f.calls.some(([method]) => method === 'focus'),
        false
      )
      f.get('Sidebar').props.onOpenSkills(f.trigger)
      const changedConversation = f.get('SkillsPage').props.onSelect(descriptor())
      f.controller.activeConversationId = 'conversation-b'
      f.render()
      f.preparations.at(-1).resolve(true)
      assert.equal(await changedConversation, true)
      assert.equal(f.get('SkillsPage').props.open, true)
      const accepted = f.get('SkillsPage').props.onSelect(descriptor())
      f.preparations.at(-1).resolve(true)
      assert.equal(await accepted, true)
      assert.equal(f.get('SkillsPage').props.open, false)
      assert.equal(f.shell().props.hidden, false)
      f.flushFrames()
      assert.deepEqual(
        f.calls.filter(([method]) => method === 'focus'),
        [['focus', 'chat-input']]
      )
    } finally {
      f.dispose()
    }
  }
)

await check(
  'actual App keeps skill details on the skills page while approvals, close dialogs and user input reveal their mounted chat owner first',
  async () => {
    const f = await appFixture()
    try {
      f.get('Sidebar').props.onOpenSkills(f.trigger)
      f.config.dialog = { className: 'skill-detail-dialog' }
      f.notifyDialog()
      assert.equal(f.get('SkillsPage').props.open, true)
      let prevented = 0
      f.key({
        key: 'Escape',
        defaultPrevented: false,
        preventDefault() {
          prevented++
        }
      })
      assert.equal(prevented, 0, 'The skill detail dialog owns its Escape key')
      for (const className of ['execution-approval', 'close-dialog']) {
        f.config.dialog = null
        f.get('Sidebar').props.onOpenSkills(f.trigger)
        f.render()
        const button = new HTMLElement(className)
        f.config.dialog = {
          className,
          open: true,
          isConnected: true,
          contains: () => false,
          querySelector: () => button
        }
        f.notifyDialog()
        assert.equal(f.get('SkillsPage').props.open, false)
        assert.equal(f.shell().props.hidden, false)
        f.flushFrames()
        assert.equal(document.activeElement, button)
      }
      f.config.dialog = null
      f.get('Sidebar').props.onOpenSkills(f.trigger)
      f.config.userInput({ requestId: 'plan-question' })
      assert.equal(f.get('SkillsPage').props.open, false)
      assert.equal(f.shell().props.hidden, false)
      assert.deepEqual(
        f.calls.filter(([method]) => method === 'search').map(([, value]) => value),
        ['', '', '']
      )
    } finally {
      f.dispose()
    }
  }
)

await finish({
  limits: [
    'Synthetic React and IPC do not prove native focus, real desktop lifecycle, main bounded reads or real model behavior.'
  ]
})
