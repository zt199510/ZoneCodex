import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

assert.equal(process.argv.length, 2)
const evidence = await createEvidence('authorization')
const handlers = new Map(),
  windows = new Map(),
  directories = new Map()
const fixture = { busy: new Set(), validation: null, review: null, modelCalls: 0, processStarts: 0 }
const fakeHost = {
  path: path.join(evidence, 'synthetic-host.exe'),
  identity: 'synthetic',
  hash: 'b'.repeat(64)
}
globalThis.__lesson60Authorization = {
  BrowserWindow: {
    fromId: (id) => windows.get(id) ?? null,
    fromWebContents: (sender) =>
      [...windows.values()].find((window) => window.webContents === sender) ?? null
  },
  ipcMain: {
    handle: (name, handler) => {
      assert(!handlers.has(name))
      handlers.set(name, handler)
    }
  },
  getAppSettings: () => ({ defaultPermissionMode: 'default' }),
  captureWorkspaceAccess: () => null,
  captureProjectAccess: () => null,
  captureConversationDirectory: (id, conversation) =>
    directories.get(id + ':' + conversation) ?? null,
  validateConversationDirectory: async (_conversation, directory) =>
    fixture.validation ? fixture.validation(directory) : directory,
  inspectCommandHost: async () => fakeHost,
  inspectWindowsCommandBackend: async () => null,
  verifyCommandHost: () => true,
  verifyWindowsCommandBackend: () => true,
  startCommandProcess: () => {
    fixture.processStarts++
    throw new Error('No process launch allowed in synthetic authorization suite')
  },
  createLiveResponse:
    () =>
    async (...args) => {
      fixture.modelCalls++
      return fixture.review(...args)
    }
}
const stubs = {
  electron: 'BrowserWindow, ipcMain',
  'settings-service': 'getAppSettings',
  'workspace-access': 'captureWorkspaceAccess',
  'attachment-access': 'captureProjectAccess',
  'conversation-directory': 'captureConversationDirectory, validateConversationDirectory',
  'windows-command-backend':
    'inspectCommandHost, inspectWindowsCommandBackend, verifyCommandHost, verifyWindowsCommandBackend',
  'command-runner': 'startCommandProcess',
  'response-client': 'createLiveResponse'
}
const files = [
  'src/main/execution/execution-ipc.ts',
  'src/main/execution/execution-context.ts',
  'src/main/execution/permission-state.ts',
  'src/main/execution/execution-approval.ts',
  'src/main/execution/task-registry.ts',
  'src/main/execution/workspace-authorization.ts',
  'src/main/execution/approval-reviewer.ts',
  'src/main/execution/command-plan.ts',
  'src/main/tools/workspace-actions.ts',
  'src/shared/permission-policy.ts'
]
const outfile = path.join(evidence, 'current-authorization.cjs')
const bundle = await build({
  absWorkingDir: root,
  stdin: {
    contents: files.map((file) => `export * from ${JSON.stringify('./' + file)};`).join('\n'),
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
      name: 'lesson60-explicit-native-and-storage-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: id }) => {
          const name = id.split('/').at(-1)
          return Object.hasOwn(stubs, name) ? { path: name, namespace: 'fixture' } : null
        })
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: id }) => ({
          contents: `export const { ${stubs[id]} } = globalThis.__lesson60Authorization;`,
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
      .map(async (file) => [file, hash(await fs.readFile(path.resolve(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'identity.json'),
  JSON.stringify(
    { sourceHashes, compiledSHA256: hash(await fs.readFile(outfile)), stubbedDependencies: stubs },
    null,
    2
  )
)
const api = createRequire(import.meta.url)(outfile)
api.registerExecutionContext((id) => fixture.busy.has(id))
api.registerExecutionApproval()
api.registerTaskLifecycle()
const suite = checksFor(evidence, {
  ordinaryNode: true,
  syntheticElectron: true,
  syntheticBackend: true,
  realDisk: true,
  syntheticReviewTransport: true,
  realTransport: false,
  sourceHashes
})
let sequence = 100
function owner() {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, destroyed: false, sent: [] })
  sender.isDestroyed = () => sender.destroyed
  sender.send = (channel, value) => sender.sent.push({ channel, value: structuredClone(value) })
  const window = Object.assign(new EventEmitter(), {
    id: sequence++,
    webContents: sender,
    destroyed: false
  })
  window.isDestroyed = () => window.destroyed
  windows.set(window.id, window)
  return { window, sender, event: { sender, senderFrame: sender.mainFrame } }
}
const invoke = (source, channel, ...args) => handlers.get(channel)(source.event, ...args)
const approvalInput = {
  requestId: 'request-current',
  conversationId: 'conversation-current',
  kind: 'create',
  cwd: evidence,
  path: path.join(evidence, 'candidate.txt'),
  content: 'Exact candidate\n'
}
const currentApproval = (source) => invoke(source, 'execution:approval-get')
function respond(source, approvalId, approved = true) {
  return invoke(source, 'execution:approval-respond', { approvalId, approved })
}
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}
async function boundDirectory(source, label) {
  const cwd = path.join(evidence, label)
  await fs.mkdir(cwd, { recursive: true })
  directories.set(source.window.id + ':conversation-current', cwd)
  return cwd
}
const context = { conversationId: 'conversation-current', mode: 'execute' }

await suite.check(
  'three permission modes retain read/write/backend/range decisions without granting executable success',
  async () => {
    const rows = []
    for (const mode of ['default', 'auto-approve', 'full-access'])
      for (const operation of ['read', 'write', 'command'])
        for (const withinWritableRoots of [false, true])
          for (const sandboxAvailable of [false, true]) {
            const decision = api.decideLocalPermission({
              mode,
              operation,
              withinWritableRoots,
              sandboxAvailable
            })
            const expected =
              mode === 'full-access' ||
              operation === 'read' ||
              (operation === 'write' && withinWritableRoots) ||
              (operation === 'command' && withinWritableRoots && sandboxAvailable)
                ? 'allow'
                : mode === 'auto-approve'
                  ? 'review'
                  : 'ask'
            assert.equal(decision, expected)
            rows.push({ mode, operation, withinWritableRoots, sandboxAvailable, decision })
          }
    assert.equal(
      api.decideLocalPermission({
        mode: 'default',
        operation: 'write',
        withinWritableRoots: false,
        approvalPolicy: 'never'
      }),
      'deny'
    )
    return { decisions: rows, policyDoesNotSpawn: fixture.processStarts === 0 }
  }
)
await suite.check(
  'window permissions return copies, same-value is stable and different windows remain independent',
  async () => {
    const a = owner(),
      b = owner()
    const first = invoke(a, 'execution:permissions-get')
    first.mode = 'full-access'
    first.revision = 999
    assert.deepEqual(invoke(a, 'execution:permissions-get'), { mode: 'default', revision: 0 })
    assert.deepEqual(invoke(a, 'execution:permissions-set', 'default'), {
      mode: 'default',
      revision: 0
    })
    assert.deepEqual(invoke(a, 'execution:permissions-set', 'auto-approve'), {
      mode: 'auto-approve',
      revision: 1
    })
    assert.deepEqual(invoke(b, 'execution:permissions-get'), { mode: 'default', revision: 0 })
    return { noModelRequests: fixture.modelCalls === 0 }
  }
)
await suite.check(
  'busy and invalid direct permission IPC reject without changing mode/revision',
  async () => {
    const source = owner()
    fixture.busy.add(source.window.id)
    for (const mode of ['default', 'auto-approve', 'full-access'])
      assert.throws(() => invoke(source, 'execution:permissions-set', mode), /等待当前任务/)
    assert.deepEqual(invoke(source, 'execution:permissions-get'), { mode: 'default', revision: 0 })
    fixture.busy.delete(source.window.id)
    assert.throws(() => invoke(source, 'execution:permissions-set', 'unknown'), /权限模式无效/)
    assert.throws(
      () =>
        handlers.get('execution:permissions-set')(
          { sender: source.sender, senderFrame: {} },
          'full-access'
        ),
      /请求来源/
    )
  }
)
await suite.check(
  'real execution context rejects ABA revision and revoked directory with a new scope on re-resolution',
  async () => {
    const source = owner()
    const cwd = await boundDirectory(source, 'aba-workspace')
    const execution = await api.resolveExecutionContext(source.window.id, context)
    assert(api.executionStillCurrent(source.window.id, context, execution))
    invoke(source, 'execution:permissions-set', 'full-access')
    invoke(source, 'execution:permissions-set', 'default')
    assert.deepEqual(invoke(source, 'execution:permissions-get'), { mode: 'default', revision: 2 })
    assert.equal(api.executionStillCurrent(source.window.id, context, execution), false)
    const fresh = await api.resolveExecutionContext(source.window.id, context)
    assert.notEqual(fresh.info.scopeId, execution.info.scopeId)
    directories.delete(source.window.id + ':conversation-current')
    assert.equal(api.executionStillCurrent(source.window.id, context, fresh), false)
    return { cwd, oldScope: execution.info.scopeId, newScope: fresh.info.scopeId }
  }
)
await suite.check(
  'resolve IPC rechecks a directory binding that changes during its real asynchronous preparation',
  async () => {
    const source = owner()
    const cwd = await boundDirectory(source, 'resolve-workspace')
    const gate = deferred()
    fixture.validation = async () => {
      await gate.promise
      return cwd
    }
    const pending = invoke(source, 'agent:resolve-execution', context)
    directories.delete(source.window.id + ':conversation-current')
    gate.resolve()
    await assert.rejects(pending, /绑定已失效|上下文已变化/)
    fixture.validation = null
  }
)
await suite.check(
  'approval is a copied exact candidate with one UUID and rejects duplicate pending or foreign UUID/window replies',
  async () => {
    const source = owner(),
      foreign = owner(),
      controller = new AbortController()
    const pending = api.requestExecutionApproval(source.window.id, approvalInput, controller.signal)
    const approval = currentApproval(source)
    assert.match(approval.approvalId, /^[a-f0-9-]{36}$/)
    const copy = currentApproval(source)
    copy.content = 'mutated'
    assert.equal(currentApproval(source).content, approvalInput.content)
    assert.equal(
      await api.requestExecutionApproval(source.window.id, approvalInput, controller.signal),
      false
    )
    assert.equal(respond(foreign, approval.approvalId), false)
    assert.equal(respond(source, '00000000-0000-4000-8000-000000000000'), false)
    assert.equal(respond(source, approval.approvalId, false), true)
    assert.equal(await pending, false)
    assert.equal(respond(source, approval.approvalId), false)
    assert.equal(currentApproval(source), null)
    assert.equal(
      source.sender.listenerCount('zonecodex-main-navigation') +
        source.sender.listenerCount('render-process-gone') +
        source.sender.listenerCount('destroyed') +
        source.window.listenerCount('closed'),
      0
    )
  }
)
await suite.check(
  'approval response refuses accessors, extras, nonboolean and non-main frame without consuming the valid wait',
  async () => {
    const source = owner(),
      controller = new AbortController()
    const pending = api.requestExecutionApproval(source.window.id, approvalInput, controller.signal)
    const id = currentApproval(source).approvalId
    let getterCalls = 0
    const malformed = { approved: true }
    Object.defineProperty(malformed, 'approvalId', {
      enumerable: true,
      get: () => {
        getterCalls++
        return id
      }
    })
    for (const value of [
      malformed,
      { approvalId: id, approved: 1 },
      { approvalId: id, approved: true, extra: true },
      [id, true]
    ])
      assert.equal(invoke(source, 'execution:approval-respond', value), false)
    assert.equal(getterCalls, 0)
    assert.throws(
      () =>
        handlers.get('execution:approval-respond')(
          { sender: source.sender, senderFrame: {} },
          { approvalId: id, approved: true }
        ),
      /审批来源/
    )
    assert.equal(api.hasExecutionApproval(source.window.id), true)
    assert.equal(respond(source, id), true)
    assert.equal(await pending, true)
  }
)
for (const teardown of [
  'abort',
  'zonecodex-main-navigation',
  'render-process-gone',
  'destroyed',
  'closed',
  'replacement-frame'
])
  await suite.check(
    teardown + ' retires current wait; late approved UUID cannot affect a fresh wait',
    async () => {
      const source = owner(),
        controller = new AbortController()
      const pending = api.requestExecutionApproval(
        source.window.id,
        approvalInput,
        controller.signal
      )
      const oldId = currentApproval(source).approvalId
      if (teardown === 'abort') controller.abort()
      else if (teardown === 'replacement-frame') {
        source.sender.mainFrame = {}
        source.event.senderFrame = source.sender.mainFrame
        assert.equal(currentApproval(source), null)
      } else (teardown === 'closed' ? source.window : source.sender).emit(teardown)
      assert.equal(await pending, false)
      assert.equal(respond(source, oldId), false)
      const fresh = api.requestExecutionApproval(
        source.window.id,
        approvalInput,
        new AbortController().signal
      )
      const newId = currentApproval(source).approvalId
      assert.notEqual(newId, oldId)
      assert.equal(respond(source, oldId), false)
      assert.equal(currentApproval(source).approvalId, newId)
      respond(source, newId, false)
      assert.equal(await fresh, false)
      assert.equal(api.hasExecutionApproval(source.window.id), false)
    }
  )
const transitions = {
  created: ['running', 'waiting_approval', 'cancelled', 'failed', 'interrupted'],
  running: [
    'waiting_approval',
    'waiting_input',
    'completed',
    'cancelled',
    'failed',
    'timed_out',
    'interrupted'
  ],
  waiting_approval: ['running', 'cancelled', 'failed', 'timed_out', 'interrupted'],
  waiting_input: ['running', 'cancelled', 'failed', 'timed_out', 'interrupted'],
  completed: [],
  cancelled: [],
  failed: [],
  timed_out: [],
  interrupted: []
}
await suite.check(
  'all nine public states obey the owner transition table and every terminal record rejects late events',
  async () => {
    for (const from of Object.keys(transitions))
      for (const to of Object.keys(transitions))
        assert.equal(
          api.canTransitionTaskStatus(from, to),
          transitions[from].includes(to),
          from + ' -> ' + to
        )
    const source = owner()
    for (const terminal of ['completed', 'cancelled', 'failed', 'timed_out', 'interrupted']) {
      const id = 'task-' + terminal
      api.createTask({
        windowId: source.window.id,
        taskId: id,
        requestId: id,
        conversationId: 'conversation-current',
        kind: 'agent'
      })
      api.updateTask(source.window.id, id, 'running')
      api.updateTask(source.window.id, id, terminal)
      const saved = api.listTasks(source.window.id).find((task) => task.taskId === id)
      for (const state of Object.keys(transitions))
        assert.equal(api.updateTask(source.window.id, id, state), null)
      assert.deepEqual(
        api.listTasks(source.window.id).find((task) => task.taskId === id),
        saved
      )
      assert.equal(api.cancelTask(source.window.id, id), false)
    }
  }
)
await suite.check(
  'running cancellation asks the owner and stays running until its result; cancellation failure does not settle a task',
  async () => {
    const source = owner()
    let requests = 0
    for (const [id, cancel] of [
      [
        'running-task',
        () => {
          requests++
        }
      ],
      [
        'broken-task',
        () => {
          throw new Error('Synthetic cancel send failure')
        }
      ]
    ]) {
      api.createTask({
        windowId: source.window.id,
        taskId: id,
        requestId: id,
        conversationId: 'conversation-current',
        kind: 'agent',
        cancel
      })
      api.updateTask(source.window.id, id, 'running')
      assert.equal(api.cancelTask(source.window.id, id), id === 'running-task')
      assert.equal(
        api.listTasks(source.window.id).find((task) => task.taskId === id).status,
        'running'
      )
    }
    assert.equal(requests, 1)
    api.updateTask(source.window.id, 'running-task', 'cancelled')
    assert.equal(api.updateTask(source.window.id, 'running-task', 'completed'), null)
    api.cleanupTaskWindow(source.window.id)
    assert.equal(
      api.listTasks(source.window.id).find((task) => task.taskId === 'broken-task').status,
      'interrupted'
    )
  }
)
await suite.check(
  'approval/input waiting cancellation cannot be revived by finish or a late running result; teardown reports interrupted',
  async () => {
    const source = owner()
    for (const state of ['waiting_approval', 'waiting_input']) {
      const id = state.replaceAll('_', '-')
      api.createTask({
        windowId: source.window.id,
        taskId: id,
        requestId: id,
        conversationId: 'conversation-current',
        kind: 'agent'
      })
      api.updateTask(source.window.id, id, 'running')
      api.updateTask(source.window.id, id, state)
      assert.equal(api.cancelTask(source.window.id + 1, id), false)
      assert.equal(api.cancelTask(source.window.id, id), true)
      assert.equal(api.updateTask(source.window.id, id, 'running'), null)
    }
    api.createTask({
      windowId: source.window.id,
      taskId: 'teardown',
      requestId: 'teardown',
      conversationId: 'conversation-current',
      kind: 'agent'
    })
    api.updateTask(source.window.id, 'teardown', 'running')
    api.cleanupTaskWindow(source.window.id)
    assert.match(
      api.listTasks(source.window.id).find((task) => task.taskId === 'teardown').error,
      /实际收尾结果无法继续显示/
    )
  }
)

async function fileScenario(label, hooks = {}) {
  const source = owner(),
    cwd = await boundDirectory(source, label + '/workspace'),
    target = path.join(path.dirname(cwd), 'target.txt')
  const controller = new AbortController()
  let valid = true,
    approved = 0,
    started = 0,
    waits = 0,
    finished = 0
  const execution = {
    info: { cwd, mode: hooks.mode ?? 'default', revision: 0, scopeId: 'a'.repeat(64) },
    writableRoots: [cwd]
  }
  const options = {
    owner: {
      kind: 'desktop',
      windowId: source.window.id,
      requestId: 'request-current',
      conversationId: 'conversation-current'
    },
    userRequest: 'Create this exact isolated file only',
    execution,
    assertCurrent: () => valid && !controller.signal.aborted,
    beginApproval: () => {
      waits++
      return true
    },
    finishApproval: () => {
      finished++
    },
    onApproved: () => {
      approved++
      hooks.onApproved?.(controller)
    },
    requestApproval: (input, signal) =>
      api.requestExecutionApproval(source.window.id, input, signal),
    ...(hooks.reviewer ? { reviewApproval: hooks.reviewer } : {})
  }
  const authorization = api.createHostWorkspaceAuthorization(options)
  const execute = api.createWorkspaceActionExecutor(cwd, options.assertCurrent, authorization, {
    isPathAllowed: () => true,
    onEffect: () => {
      started++
    }
  })
  const operation = () =>
    execute(
      'create_workspace_file',
      JSON.stringify({ path: target, content: 'Isolated authorized bytes\n' }),
      controller.signal
    )
  return {
    source,
    cwd,
    target,
    controller,
    operation,
    invalidate: () => {
      valid = false
    },
    counts: () => ({ approved, started, waits, finished })
  }
}
async function waitApproval(item) {
  for (let index = 0; index < 100 && !api.hasExecutionApproval(item.source.window.id); index++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert(
    api.hasExecutionApproval(item.source.window.id),
    'Real file executor must reach current approval wait'
  )
  return currentApproval(item.source)
}
await suite.check(
  'rejecting an exact file operation returns tool cancellation and leaves actual disk untouched',
  async () => {
    const item = await fileScenario('file-refused'),
      pending = item.operation(),
      approval = await waitApproval(item)
    respond(item.source, approval.approvalId, false)
    assert.equal(JSON.parse(await pending).status, 'cancelled')
    await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    assert.deepEqual(item.counts(), { approved: 0, started: 0, waits: 1, finished: 1 })
  }
)
await suite.check(
  'stop before late approval retires the wait and starts no real write',
  async () => {
    const item = await fileScenario('stop-before-approve'),
      pending = item.operation(),
      approval = await waitApproval(item)
    const rejection = assert.rejects(pending, { name: 'AbortError' })
    item.controller.abort()
    assert.equal(respond(item.source, approval.approvalId), false)
    await rejection
    await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    assert.deepEqual(item.counts(), { approved: 0, started: 0, waits: 1, finished: 1 })
  }
)
await suite.check(
  'accepted approval then stop before commit blocks the actual executor, retaining approval as distinct from started',
  async () => {
    const item = await fileScenario('approve-before-stop', {
        onApproved: (controller) => controller.abort()
      }),
      pending = item.operation(),
      approval = await waitApproval(item)
    const rejection = assert.rejects(pending, { name: 'AbortError' })
    assert.equal(respond(item.source, approval.approvalId), true)
    await rejection
    await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    assert.deepEqual(item.counts(), { approved: 1, started: 0, waits: 1, finished: 1 })
  }
)
await suite.check(
  'stop after a completed actual write retains the bytes and observed output; no rollback promise',
  async () => {
    const item = await fileScenario('effect-before-stop'),
      pending = item.operation(),
      approval = await waitApproval(item)
    respond(item.source, approval.approvalId)
    const output = JSON.parse(await pending)
    assert.equal(output.status, 'created')
    item.controller.abort()
    assert.equal(await fs.readFile(item.target, 'utf8'), 'Isolated authorized bytes\n')
    assert.deepEqual(item.counts(), { approved: 1, started: 1, waits: 1, finished: 1 })
    return { output, sha256: hash(await fs.readFile(item.target)) }
  }
)
await suite.check(
  'context revoked during approval cannot turn a late true into an authorization or write',
  async () => {
    const item = await fileScenario('revoked-wait'),
      pending = item.operation(),
      approval = await waitApproval(item)
    item.invalidate()
    respond(item.source, approval.approvalId)
    assert.equal(JSON.parse(await pending).status, 'error')
    await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    assert.deepEqual(item.counts(), { approved: 0, started: 0, waits: 1, finished: 1 })
  }
)
await suite.check(
  'target appearing during approval is preserved by exclusive create, even after a true decision',
  async () => {
    const item = await fileScenario('target-conflict'),
      pending = item.operation(),
      approval = await waitApproval(item)
    await fs.writeFile(item.target, 'External bytes remain\n', { flag: 'wx' })
    respond(item.source, approval.approvalId)
    assert.equal(JSON.parse(await pending).status, 'conflict')
    assert.equal(await fs.readFile(item.target, 'utf8'), 'External bytes remain\n')
  }
)
await suite.check(
  'parent replaced during approval blocks actual create and retains the replaced directory',
  async () => {
    const item = await fileScenario('parent-conflict'),
      pending = item.operation(),
      approval = await waitApproval(item)
    const parent = path.dirname(item.cwd),
      retained = parent + '-retained'
    await fs.rename(parent, retained)
    await fs.mkdir(parent)
    await fs.mkdir(item.cwd)
    respond(item.source, approval.approvalId)
    assert.equal(JSON.parse(await pending).status, 'error')
    await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    assert((await fs.stat(retained)).isDirectory())
    assert.equal(item.counts().started, 0)
  }
)
for (const verdict of ['risky', 'transport-failure'])
  await suite.check(
    'actual auto-review ' +
      verdict +
      ' falls back to current manual decision, never default approval',
    async () => {
      const before = fixture.modelCalls
      fixture.review = async () => {
        if (verdict === 'transport-failure') throw new Error('Synthetic review failure')
        return {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"risk":"risky"}' }]
            }
          ]
        }
      }
      const item = await fileScenario('review-' + verdict, {
          mode: 'auto-approve',
          reviewer: api.createApprovalReviewer()
        }),
        pending = item.operation(),
        approval = await waitApproval(item)
      assert.equal(fixture.modelCalls - before, 1)
      respond(item.source, approval.approvalId, false)
      assert.equal(JSON.parse(await pending).status, 'cancelled')
      assert.equal(item.counts().approved, 0)
      await assert.rejects(fs.access(item.target), { code: 'ENOENT' })
    }
  )
await suite.check(
  'auto-review reply after stop cannot begin fallback or grant an operation',
  async () => {
    const gate = deferred()
    fixture.review = () => gate.promise
    const item = await fileScenario('review-late', {
      mode: 'auto-approve',
      reviewer: api.createApprovalReviewer()
    })
    const pending = item.operation()
    const rejection = assert.rejects(pending, { name: 'AbortError' })
    for (let index = 0; index < 100 && item.counts().waits === 0; index++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(item.counts().waits, 1)
    item.controller.abort()
    await rejection
    gate.resolve({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"risk":"safe"}' }]
        }
      ]
    })
    await flush()
    assert.equal(api.hasExecutionApproval(item.source.window.id), false)
    assert.equal(item.counts().approved, 0)
    assert.equal(item.counts().started, 0)
  }
)
async function preparation(label) {
  const cwd = path.join(evidence, label)
  await fs.mkdir(cwd)
  const program = path.join(cwd, 'never-launched.exe')
  await fs.writeFile(program, 'Not an executable. Never launched.\n')
  const controller = new AbortController()
  let valid = true
  const prepared = await api.prepareCommandExecution(
    { program, args: ['exact', 'args'], cwd, sandbox_permissions: 'use_default' },
    {
      owner: {
        kind: 'desktop',
        windowId: 1,
        conversationId: 'conversation-current',
        requestId: 'request-current'
      },
      permissions: { mode: 'full-access', revision: 3 },
      scopeId: 'a'.repeat(64),
      writableRoots: [cwd],
      environment: 'tool',
      assertCurrent: () => valid
    },
    controller.signal
  )
  return {
    prepared,
    controller,
    program,
    invalidate: () => {
      valid = false
    }
  }
}
await suite.check(
  'exact command preparation/signature/claim are unforgeable and consumed once per launch attempt',
  async () => {
    const item = await preparation('ticket-once')
    assert.throws(
      () => api.authorizeCommandExecution({ ...item.prepared }, 'full-access'),
      /已使用或无效/
    )
    const signed = api.authorizeCommandExecution(item.prepared, 'full-access')
    assert.throws(() => api.authorizeCommandExecution(item.prepared, 'full-access'), /已使用或无效/)
    assert.throws(() => api.claimCommandExecution({ ...signed }, 1000), /已使用或无效/)
    const launch = api.claimCommandExecution(signed, 1000)
    assert(launch.args.includes('exact'))
    assert.throws(() => api.claimCommandExecution(signed, 1000), /已使用或无效/)
    launch.cleanup()
  }
)
for (const invalidation of ['abort', 'scope-revoke', 'program-change', 'discard'])
  await suite.check(
    'signed command ' +
      invalidation +
      ' prevents launch and cannot be retried with the same ticket',
    async () => {
      const item = await preparation('ticket-' + invalidation),
        signed = api.authorizeCommandExecution(item.prepared, 'full-access')
      if (invalidation === 'abort') item.controller.abort()
      else if (invalidation === 'scope-revoke') item.invalidate()
      else if (invalidation === 'program-change')
        await fs.writeFile(item.program, 'Changed candidate bytes\n')
      else api.discardCommandExecution(signed)
      assert.throws(() => api.claimCommandExecution(signed, 1000))
      assert.throws(() => api.claimCommandExecution(signed, 1000), /已使用或无效/)
    }
  )
await suite.check(
  'all synthetic approval waits and listeners retire, with no command process starts',
  async () => {
    assert.equal(fixture.processStarts, 0)
    for (const [id, window] of windows) {
      assert.equal(api.hasExecutionApproval(id), false)
      for (const event of ['zonecodex-main-navigation', 'render-process-gone', 'destroyed']) {
        assert.equal(window.webContents.listenerCount(event), 0)
      }
      assert.equal(window.listenerCount('closed'), 0)
    }
  }
)
await suite.finish({
  modelReviewCalls: fixture.modelCalls,
  processStarts: fixture.processStarts,
  pendingApprovals: [...windows.keys()].filter((id) => api.hasExecutionApproval(id)),
  notCovered: [
    'real Electron/mainFrame process',
    'real Windows command backend/Job or native handle cleanup',
    'network models',
    'CLI and renderer (separate suites)'
  ]
})
delete globalThis.__lesson60Authorization
