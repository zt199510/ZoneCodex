const { assert, fs, path, root, load, FakeClock, electronFixture, suite } = require('./harness.cjs')
const { finalMessage, response } = require('./fixture.cjs')
const { randomUUID, createHash } = require('node:crypto')
const { deflateSync } = require('node:zlib')
const checks = suite('lesson55-desktop-source-material-final')
const isolatedMaterialPaths = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let number = index
  for (let bit = 0; bit < 8; bit++) number = number & 1 ? 0xedb88320 ^ (number >>> 1) : number >>> 1
  return number >>> 0
})
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
function png() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function gate(signal) {
  let resolve
  const promise = new Promise((yes, no) => {
    resolve = yes
    if (signal.aborted) no(signal.reason)
    else signal.addEventListener('abort', () => no(signal.reason), { once: true })
  })
  return { promise, resolve }
}
async function waitUntil(predicate) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 5000) throw new Error('wait did not settle')
    await new Promise((resolve) => setImmediate(resolve))
  }
}
function released(env) {
  assert.equal(env.runner.hasAgentJob(1), false)
  for (const event of ['did-start-loading', 'render-process-gone', 'destroyed'])
    assert.equal(env.source.sender.listenerCount(event), 0)
  assert.equal(env.input.hasAgentUserInput(1), false)
  assert.equal(env.approval.hasExecutionApproval(1), false)
  assert.equal(env.clock.timers.size, 0)
}
async function environment(model = async () => response(finalMessage('受保护桌面流程完成'))) {
  const fixture = electronFixture()
  const clock = new FakeClock()
  const source = fixture.window(1)
  const other = fixture.window(2)
  const directory = path.join(__dirname, 'desktop-case-' + randomUUID())
  await fs.mkdir(directory)
  let picked = []
  fixture.electron.dialog = {
    showOpenDialog: async () => ({ canceled: picked.length === 0, filePaths: [...picked] })
  }
  const settings = {
    getAppSettings: () => ({
      taskRoot: path.join(directory, 'tasks'),
      defaultPermissionMode: 'default'
    })
  }
  const permission = await load('src/main/execution/permission-state.ts', {
    '../settings/settings-service': settings
  })
  const directories = await load('src/main/settings/conversation-directory.ts', {
    './settings-service': settings
  })
  directories.configureConversationDirectoryLookup(async () => null)
  const conversationId = 'chat-desktop'
  const cwd = await directories.bindConversationDirectory(1, conversationId, () => true)
  directories.commitConversationDirectorySave(1, {
    conversations: [{ id: conversationId, defaultDirectory: cwd }]
  })
  const attachment = await load('src/main/project/attachment-access.ts', {
    electron: fixture.electron
  })
  const workspace = await load('src/main/project/workspace-access.ts', {
    electron: fixture.electron
  })
  const image = await load('src/main/project/image-access.ts', {
    electron: fixture.electron,
    './image-decoder': {
      decodeImageThumbnail: async (_bytes, header, signal) => {
        signal.throwIfAborted()
        return { thumbnail: png(), width: header.width, height: header.height }
      }
    }
  })
  image.configureImageStorage(path.join(directory, 'isolated-user-data'))
  const execution = await load('src/main/execution/execution-context.ts', {
    '../project/attachment-access': attachment,
    '../project/workspace-access': workspace,
    './permission-state': permission,
    '../settings/settings-service': settings,
    '../settings/conversation-directory': directories
  })
  const input = await load(
    'src/main/agent/agent-user-input.ts',
    { electron: fixture.electron },
    { clock }
  )
  const approval = await load(
    'src/main/execution/execution-approval.ts',
    { electron: fixture.electron },
    { clock }
  )
  approval.registerExecutionApproval()
  const tasks = await load(
    'src/main/execution/task-registry.ts',
    { electron: fixture.electron },
    { clock }
  )
  const auth = await load('src/main/execution/action-authorization.ts', {
    electron: fixture.electron,
    './execution-context': execution,
    './permission-state': permission,
    './execution-approval': approval,
    './approval-reviewer': {
      reviewExecutionApproval: async () => {
        throw new Error('No approval-model request allowed by this fixture')
      }
    }
  })
  const spy = { modelRequests: 0, commandProcesses: 0, backendInspections: 0 }
  const env = {
    ...fixture,
    source,
    other,
    clock,
    directory,
    conversationId,
    cwd,
    settings,
    permission,
    directories,
    attachment,
    workspace,
    image,
    execution,
    input,
    approval,
    tasks,
    spy,
    pick: (values) => {
      picked = values
    }
  }
  const deps = {
    electron: fixture.electron,
    './agent-user-input': input,
    '../model/response-client': {
      readModelConfiguration: () =>
        Object.freeze({
          endpoint: 'https://fixture.invalid/responses',
          apiKey: 'fixture-only',
          model: 'gpt-6.1-sol'
        }),
      createLiveResponse: () => async (items, signal, hooks) => {
        spy.modelRequests++
        env.sentInput = structuredClone(items)
        env.signal = signal
        env.hooks = hooks
        return model(env, items, signal, hooks)
      }
    },
    '../model/context-summary': {
      createContextSummaryResponse: () => async () => {
        throw new Error('Unexpected summary in short protected fixture')
      }
    },
    '../project/attachment-access': attachment,
    '../project/workspace-access': workspace,
    '../project/image-access': image,
    '../execution/execution-context': execution,
    '../execution/action-authorization': auth,
    '../execution/task-registry': tasks,
    '../execution/execution-approval': approval,
    '../execution/windows-command-backend': {
      inspectWindowsCommandBackend: async () => {
        spy.backendInspections++
        return null
      }
    },
    '../execution/command-runner': {
      startCommandProcess: () => {
        spy.commandProcesses++
        throw new Error('No command launch authorized in material fixture')
      }
    },
    '../execution/command-plan': {
      discardCommandExecution() {
        /* Deliberate no-op fixture callback. */
      },
      claimCommandExecution: () => {
        throw new Error('No command plan authorized in material fixture')
      }
    }
  }
  env.runner = await load('src/main/agent/agent-runner.ts', deps, {
    clock,
    dependencyScopes: { './agent-user-input': '/src/main/agent/' }
  })
  attachment.configureAttachmentAccess({
    isAgentJobActive: env.runner.hasAgentJob,
    hasWorkspaceSelection: workspace.hasWorkspaceSelection,
    abortProjectJob: env.runner.abortProjectJob
  })
  workspace.configureWorkspaceAccess({
    isAgentJobActive: env.runner.hasAgentJob,
    hasProjectSelection: attachment.hasProjectSelection
  })
  image.configureImageAccess({
    isBusy: (id) => env.runner.hasAgentJob(id),
    abortImageJob: env.runner.abortImageJob
  })
  const ipc = await load('src/main/agent/agent-ipc.ts', {
    electron: fixture.electron,
    './agent-runner': env.runner,
    './agent-user-input': input
  })
  ipc.registerAgentRequest()
  env.context = async (extra) => {
    const base = { conversationId, mode: 'execute', ...extra }
    const resolved = await execution.resolveExecutionContext(1, base)
    return { ...base, execution: resolved.info }
  }
  env.start = async (context, prompt = '核对可信桌面材料', history = [], id = 'request-desktop') =>
    fixture.handlers.get('agent:start')(
      source.event(),
      id,
      prompt,
      history,
      context ?? (await env.context()),
      'task-' + randomUUID()
    )
  env.importImage = async (name) => {
    const imported = await image.importImage(source.owner, conversationId, {
      bytes: new Uint8Array(png()),
      name
    })
    assert.equal(imported.status, 'selected')
    const prepared = await image.prepareImage(1, conversationId, imported.image.imageId)
    assert.equal(prepared.status, 'ready')
    return imported.image
  }
  env.attachmentFile = async (content) => {
    const directory = path.join(
      require('node:os').tmpdir(),
      'ZoneCodexLesson55Attachment-' + randomUUID()
    )
    await fs.mkdir(directory)
    const filename = path.join(directory, 'attachment.txt')
    await fs.writeFile(filename, content, { flag: 'wx' })
    isolatedMaterialPaths.push(filename)
    return filename
  }
  env.notice = (text, count = 1) => requireImageNotice(text, count)
  return env
}
let imageShared
const requireImageNotice = (text, count) => imageShared.appendImageTurnNotice(text, count)
async function main() {
  imageShared = await load('src/shared/image-input.ts')
  await checks.test(
    'actual agent IPC rejects subframe and unregistered sender before runner/model',
    async () => {
      const env = await environment()
      const context = await env.context()
      const handler = env.handlers.get('agent:start')
      await assert.rejects(
        handler({ sender: env.source.sender, senderFrame: {} }, 'request', '任务', [], context),
        /来源/
      )
      await assert.rejects(
        handler({ sender: { mainFrame: {} }, senderFrame: {} }, 'request', '任务', [], context),
        /来源/
      )
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual agent IPC validates request mode context and prompt before model',
    async () => {
      const env = await environment()
      const valid = await env.context()
      for (const context of [
        { ...valid, mode: 'invalid' },
        { ...valid, execution: { ...valid.execution, revision: -1 } },
        { ...valid, conversationId: '' }
      ])
        assert.equal((await env.start(context)).status, 'error')
      assert.equal((await env.start(valid, '')).status, 'error')
      assert.equal((await env.start(valid, 'x'.repeat(2001))).status, 'error')
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test('cancel IPC is bound to original window and request identity', async () => {
    const env = await environment(async (env, _items, signal) => {
      env.gate = gate(signal)
      return env.gate.promise
    })
    const completion = env.start()
    await waitUntil(() => env.gate)
    const cancel = env.handlers.get('agent:cancel')
    assert.equal(cancel(env.other.event(), 'request-desktop'), false)
    assert.equal(cancel(env.source.event(), 'other-request'), false)
    assert.throws(
      () => cancel({ sender: env.source.sender, senderFrame: {} }, 'request-desktop'),
      /来源/
    )
    assert.equal(cancel(env.source.event(), 'request-desktop'), true)
    assert.equal((await completion).status, 'cancelled')
    released(env)
  })
  await checks.test(
    'permission revision changed before request rejects stale captured context with zero model requests',
    async () => {
      const env = await environment()
      const context = await env.context()
      env.permission.setExecutionPermissionMode(1, 'full-access')
      const result = await env.start(context)
      assert.equal(result.status, 'error')
      assert.match(result.error, /目录或权限已变化/)
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual context recheck detects revision change while model awaits',
    async () => {
      const env = await environment(async (env, _items, signal) => {
        env.gate = gate(signal)
        return env.gate.promise
      })
      const completion = env.start()
      await waitUntil(() => env.gate)
      env.permission.setExecutionPermissionMode(1, 'auto-approve')
      env.gate.resolve(response(finalMessage('迟到正常返回')))
      const result = await completion
      assert.equal(result.status, 'error')
      assert.match(result.error, /上下文已失效/)
      assert.equal(env.spy.modelRequests, 1)
      released(env)
    }
  )
  await checks.test(
    'unsaved or revoked actual conversation directory binding never authorizes execution',
    async () => {
      const env = await environment()
      const unsaved = 'chat-unsaved'
      await env.directories.bindConversationDirectory(1, unsaved, () => true)
      await assert.rejects(
        env.execution.resolveExecutionContext(1, { conversationId: unsaved, mode: 'execute' }),
        /尚未保存/
      )
      const context = await env.context()
      env.directories.clearConversationDirectories(1)
      const result = await env.start(context)
      assert.equal(result.status, 'error')
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual workspace grant belongs to original window conversation and ID',
    async () => {
      const env = await environment()
      env.pick([env.cwd])
      const selected = await env.workspace.selectWorkspace(
        env.source.owner,
        env.conversationId,
        'selection-workspace'
      )
      assert.equal(selected.status, 'selected')
      assert.equal(env.workspace.captureWorkspaceAccess(2, env.conversationId), null)
      assert.equal(env.workspace.captureWorkspaceAccess(1, 'other-conversation'), null)
      const context = await env.context({ workspaceId: selected.workspace.workspaceId })
      const result = await env.start({ ...context, workspaceId: 'forged-workspace' })
      assert.equal(result.status, 'error')
      assert.match(result.error, /工作区授权/)
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'real AGENTS.md fingerprint change after workspace selection blocks preparation',
    async () => {
      const env = await environment()
      const filename = path.join(env.cwd, 'AGENTS.md')
      await fs.writeFile(filename, '# Original policy\nOnly read controlled files.\n', {
        flag: 'wx'
      })
      env.pick([env.cwd])
      const selected = await env.workspace.selectWorkspace(
        env.source.owner,
        env.conversationId,
        'workspace-agents'
      )
      assert.equal(selected.status, 'selected')
      assert.ok(selected.workspace.instruction)
      const context = await env.context({ workspaceId: selected.workspace.workspaceId })
      await fs.writeFile(filename, '# Changed policy\nChanged rules.\n')
      const result = await env.start(context)
      assert.equal(result.status, 'error')
      assert.match(result.error, /AGENTS.md 已变化/)
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual attachment snapshot identity rejects different window conversation and forged request',
    async () => {
      const env = await environment()
      const filename = await env.attachmentFile('actual text attachment\n')
      env.pick([filename])
      const selected = await env.attachment.selectProjectFiles(env.source.owner, env.conversationId)
      assert.equal(selected.status, 'selected', JSON.stringify(selected))
      const id = selected.selection.snapshotId
      assert.equal(env.attachment.captureProjectAccess(2, env.conversationId, id), null)
      assert.equal(env.attachment.captureProjectAccess(1, 'other-conversation', id), null)
      const context = await env.context({ attachment: { snapshotId: id, allowUpload: true } })
      const result = await env.start({
        ...context,
        attachment: { snapshotId: 'forged-snapshot', allowUpload: true }
      })
      assert.equal(result.status, 'error')
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'revoking actual captured attachment cancels active model and releases request',
    async () => {
      const env = await environment(async (env, _items, signal) => {
        env.gate = gate(signal)
        return env.gate.promise
      })
      const filename = await env.attachmentFile('actual attachment\n')
      env.pick([filename])
      const selected = await env.attachment.selectProjectFiles(env.source.owner, env.conversationId)
      assert.equal(selected.status, 'selected', JSON.stringify(selected))
      const context = await env.context({
        attachment: { snapshotId: selected.selection.snapshotId, allowUpload: true }
      })
      const completion = env.start(context)
      await waitUntil(() => env.gate)
      assert.equal(env.attachment.revokeProjectFiles(1, selected.selection.snapshotId), true)
      assert.equal((await completion).status, 'cancelled')
      released(env)
    }
  )
  await checks.test(
    'actual image entry group rejects wrong conversation and partial original group with zero requests',
    async () => {
      const env = await environment()
      const first = await env.importImage('one.png'),
        second = await env.importImage('two.png')
      const ids = [first.imageId, second.imageId]
      assert.equal(
        env.image.bindImageMessageGroup(1, env.conversationId, ids, 'image-message'),
        true
      )
      assert.equal(env.image.verifyImageRequestGroup(2, env.conversationId, ids), false)
      assert.equal(env.image.verifyImageRequestGroup(1, 'other-conversation', ids), false)
      assert.equal(env.image.verifyImageRequestGroup(1, env.conversationId, [first.imageId]), false)
      const context = await env.context({
        images: [{ imageId: first.imageId, messageId: 'image-message' }]
      })
      const result = await env.start(context, env.notice('图组必须完整', 1))
      assert.equal(result.status, 'error')
      assert.match(result.error, /原图片组/)
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual image bytes reach model projection and pins release after success',
    async () => {
      const env = await environment()
      const imported = await env.importImage('actual.png')
      const context = await env.context({
        images: [{ imageId: imported.imageId, messageId: 'actual-image-message' }]
      })
      const result = await env.start(context, env.notice('读取实际图片', 1))
      assert.equal(result.status, 'done')
      const projected = env.sentInput.at(-1).content
      assert.ok(Array.isArray(projected))
      assert.ok(
        projected.some(
          (part) =>
            part.type === 'input_image' &&
            part.image_url === 'data:image/png;base64,' + png().toString('base64')
        )
      )
      assert.equal(env.image.revokeImage(1, env.conversationId, imported.imageId), true)
      released(env)
    }
  )
  await checks.test(
    'actual image pins release after preparation fails due to stale permission',
    async () => {
      const env = await environment()
      const imported = await env.importImage('preparation-fail.png')
      const context = await env.context({
        images: [{ imageId: imported.imageId, messageId: 'prep-image-message' }]
      })
      env.permission.setExecutionPermissionMode(1, 'full-access')
      const result = await env.start(context, env.notice('准备失败图片', 1))
      assert.equal(result.status, 'error')
      assert.equal(env.spy.modelRequests, 0)
      assert.equal(env.image.revokeImage(1, env.conversationId, imported.imageId), true)
      released(env)
    }
  )
  for (const kind of ['model-error', 'cancel', 'revoke'])
    await checks.test('actual image capture and pins release after ' + kind, async () => {
      const env = await environment(async (env, _items, signal) => {
        if (kind === 'model-error') throw new Error('synthetic model failure')
        env.gate = gate(signal)
        return env.gate.promise
      })
      const imported = await env.importImage(kind + '.png')
      const context = await env.context({
        images: [{ imageId: imported.imageId, messageId: 'terminal-image-message' }]
      })
      const completion = env.start(context, env.notice('图片终态释放', 1))
      if (kind !== 'model-error') {
        await waitUntil(() => env.gate)
        assert.equal(env.image.revokeImage(1, env.conversationId, imported.imageId), false)
        if (kind === 'cancel') env.runner.cancelAgentJob(1, 'request-desktop')
        else env.image.cleanupImageAccess(1)
      }
      const result = await completion
      assert.equal(result.status, kind === 'model-error' ? 'error' : 'cancelled')
      assert.equal(env.image.revokeImage(1, env.conversationId, imported.imageId), true)
      released(env)
    })
  await checks.test(
    'historical actual image association rejects forged original message before model request',
    async () => {
      const env = await environment()
      const imported = await env.importImage('historical.png')
      assert.equal(
        env.image.bindImageMessageGroup(
          1,
          env.conversationId,
          [imported.imageId],
          'history-original'
        ),
        true
      )
      const priorPrompt = env.notice('历史图片', 1)
      const history = [{ role: 'user', content: priorPrompt }, finalMessage('原答复')]
      const context = await env.context({
        imageHistory: [
          { index: 0, messageId: 'forged-original-message', imageId: imported.imageId }
        ]
      })
      const result = await env.start(context, '核对历史图', history)
      assert.equal(result.status, 'error')
      assert.match(result.error, /历史图片组/)
      assert.equal(env.spy.modelRequests, 0)
      released(env)
    }
  )
  await checks.test(
    'actual approval broker rejects subframes other windows stale duplicate and refreshed answers',
    async () => {
      const env = await environment()
      const request = {
        kind: 'create',
        requestId: 'approval-request',
        conversationId: env.conversationId,
        cwd: env.cwd,
        path: path.join(env.cwd, 'approved.txt'),
        content: 'controlled'
      }
      const controller = new AbortController()
      const pending = env.approval.requestExecutionApproval(1, request, controller.signal)
      const get = (event) => env.handlers.get('execution:approval-get')(event)
      const answer = (event, value) => env.handlers.get('execution:approval-respond')(event, value)
      const active = get(env.source.event())
      const reply = { approvalId: active.approvalId, approved: true }
      assert.equal(get(env.other.event()), null)
      assert.equal(answer(env.other.event(), reply), false)
      assert.throws(() => answer({ sender: env.source.sender, senderFrame: {} }, reply), /来源/)
      assert.equal(answer(env.source.event(), { ...reply, approvalId: randomUUID() }), false)
      controller.abort()
      assert.equal(await pending, false)
      assert.equal(answer(env.source.event(), reply), false)
      const next = env.approval.requestExecutionApproval(1, request, new AbortController().signal)
      const latest = get(env.source.event())
      assert.notEqual(latest.approvalId, active.approvalId)
      assert.equal(answer(env.source.event(), reply), false)
      assert.equal(
        answer(env.source.event(), { approvalId: latest.approvalId, approved: true }),
        true
      )
      assert.equal(await next, true)
      assert.equal(
        answer(env.source.event(), { approvalId: latest.approvalId, approved: true }),
        false
      )
      const refreshed = env.approval.requestExecutionApproval(
        1,
        request,
        new AbortController().signal
      )
      const before = get(env.source.event())
      env.source.reload()
      assert.equal(await refreshed, false)
      assert.equal(
        answer(env.source.event(), { approvalId: before.approvalId, approved: true }),
        false
      )
      released(env)
    }
  )
  const sourceHashes = {}
  for (const relative of [
    'src/main/agent/agent-ipc.ts',
    'src/main/agent/agent-runner.ts',
    'src/main/agent/agent-core.ts',
    'src/main/execution/execution-context.ts',
    'src/main/execution/execution-approval.ts',
    'src/main/project/attachment-access.ts',
    'src/main/project/workspace-access.ts',
    'src/main/project/image-access.ts',
    'src/main/model/image-input.ts',
    'src/main/settings/conversation-directory.ts'
  ])
    sourceHashes[relative] = hash(await fs.readFile(path.join(root, relative)))
  await checks.finish({
    sourceHashes,
    isolatedMaterialPaths,
    method: {
      actual: [
        'current IPC handlers and getIpcWindow checks',
        'current desktop adapter/core/unique loop',
        'permission revision and execution context',
        'conversation directory validation on real isolated disk',
        'workspace/attachment grants and actual snapshot files',
        'actual AGENTS.md fingerprint reads',
        'image group association capture actual original bytes projection and isolated image storage',
        'approval broker and user-input broker'
      ],
      synthetic: [
        'Electron window/frame and IPC transport fixtures',
        'model transport',
        'dialog selections',
        'thumbnail decoder',
        'Windows backend absent and command startup blocked'
      ],
      noRealModel: true,
      realElectron: false
    },
    untested: [
      'actual native Electron window interactions covered separately by root desktop/real business runs',
      'native thumbnail decoding and OS command process chain not claimed by this suite'
    ]
  })
}
main().catch(async (error) => {
  await checks.test('suite setup', () => {
    throw error
  })
  await checks.finish({ noRealModel: true, realElectron: false })
})
