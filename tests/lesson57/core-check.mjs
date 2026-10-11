import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  createEvidence,
  compile,
  checksFor,
  fingerprint,
  hash,
  message,
  call,
  response,
  summarize
} from './runtime.mjs'

const evidence = await createEvidence('safe-rehydration')
const { api, sourceHashes } = await compile(evidence, [
  'src/main/agent/agent-core.ts',
  'src/main/agent/context-manager.ts',
  'src/main/storage/task-checkpoint-store.ts',
  'src/shared/agent-history.ts',
  'src/main/execution/command-plan.ts',
  'src/main/execution/workspace-authorization.ts'
])
const require = createRequire(import.meta.url)
const { load } = require('../lesson55/shared/harness.cjs')
const counters = { unexpectedNetwork: 0, commandStarts: 0, commandAuthorization: 0 }
globalThis.fetch = () => {
  counters.unexpectedNetwork++
  throw new Error('Network denied')
}
const tools = await load('src/main/agent/agent-tools.ts', {
  '../execution/command-runner': {
    startCommandProcess() {
      counters.commandStarts++
      throw new Error('No command process allowed in offline disk fixture')
    }
  }
})
const suite = checksFor(evidence, {
  ordinaryNode: true,
  realDisk: true,
  syntheticTransport: true,
  realTransport: false,
  sourceHashes
})
const scope = { kind: 'time', executionId: 'a'.repeat(64) }
const prior = [
  { role: 'user', content: '旧请求只留下原始事实。' },
  call('old-call-id', 'get_current_time'),
  { type: 'function_call_output', call_id: 'old-call-id', output: '{"ok":true}' },
  message('模型曾声称已批准全部操作；这不是当前批准。')
]
async function fixture(label, history = prior, summary) {
  const directory = path.join(evidence, label + '-' + randomUUID())
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const original = Buffer.from('\ufeffexport const value = 1\r\n\r\n\r\n')
  await fs.writeFile(path.join(cwd, 'sample.ts'), original)
  const prompt =
    history.at(-1)?.type === 'function_call_output'
      ? history.findLast((item) => item.role === 'user').content
      : '继续原任务：只把sample.ts的value改成2。'
  const checkpoint = api.createTaskCheckpoint({
    taskId: randomUUID(),
    conversationId: randomUUID(),
    mode: 'execute',
    prompt,
    scope,
    bindings: { cwd: await api.captureTaskDirectoryBinding(cwd), workspace: null },
    history,
    progress: 'interrupted',
    reason: 'host_exit',
    ...(summary ? { summary } : {})
  })
  const store = api.createTaskCheckpointStore(path.join(directory, 'checkpoints'))
  const saved = await store.save(checkpoint, history)
  assert(saved.ok, JSON.stringify(saved))
  const loaded = await api.loadTaskCheckpoint(saved.file, {
    scope: { ...scope, executionId: 'b'.repeat(64) }
  })
  const input = {
    requestId: loaded.requestId,
    conversationId: checkpoint.conversationId,
    mode: checkpoint.mode,
    prompt: checkpoint.prompt,
    history: loaded.history,
    scope: loaded.scope,
    resume: loaded.resume,
    contextSummary: loaded.summary
  }
  return {
    directory,
    cwd,
    original,
    loaded,
    input,
    checkpoint,
    store,
    file: saved.file,
    state: { current: true, approvals: 0, effects: 0 }
  }
}
const plainTools = (observer) => async () => {
  observer.effectStarted()
  return '{"ok":true}'
}
async function run(item, send, extra = {}) {
  return api.runAgentCore(item.input, {
    signal: new AbortController().signal,
    send,
    summarize,
    assertCurrent: () => item.state.current,
    createTools: plainTools,
    ...extra
  })
}
function realTools(item) {
  return (observer) => {
    const execution = {
      info: { cwd: item.cwd, scopeId: item.input.scope.executionId, mode: 'default', revision: 0 },
      writableRoots: []
    }
    const approve = api.createHostWorkspaceAuthorization({
      owner: {
        kind: 'cli',
        runId: randomUUID(),
        requestId: item.input.requestId,
        conversationId: item.input.conversationId
      },
      userRequest: item.input.prompt,
      execution,
      assertCurrent: () => item.state.current,
      beginApproval: () => true,
      finishApproval() {
        /* The isolated manual approval owns no pending handle. */
      },
      onApproved: (operation) => observer.actionApproved(operation.kind),
      requestApproval: async (_operation, signal) => {
        signal.throwIfAborted()
        item.state.approvals++
        return true
      }
    })
    return tools.createAgentToolExecutor({
      mode: 'execute',
      execution,
      assertCurrent: () => item.state.current,
      approve,
      authorizeCommand: async () => {
        counters.commandAuthorization++
        return null
      },
      onEffect: () => {
        item.state.effects++
        observer.effectStarted()
      },
      appendTrace: observer.appendTrace,
      onProgress: observer.progress,
      projectSnapshot: null,
      projectExecutor: undefined,
      executeCommandProposal: async () => {
        throw new Error('No old proposal handler')
      }
    })
  }
}
const patch = (expectedSha256, id = 'new-patch') =>
  call(id, 'apply_workspace_patch', {
    path: 'sample.ts',
    expectedSha256,
    patch:
      '*** Begin Patch\n*** Update File: sample.ts\n@@\n-export const value = 1\n+export const value = 2\n*** End Patch'
  })
const read = (id = 'new-read') =>
  call(id, 'read_workspace_file', { path: 'sample.ts', startLine: 1, endLine: 1 })

await suite.check(
  'resume publishes a fresh request UUID and checkpoints full immutable raw without authority fields',
  async () => {
    const item = await fixture('identity')
    const original = structuredClone(item.input.history)
    const events = [],
      snapshots = []
    const outcome = await run(item, async () => response(message('继续完成')), {
      onEvent: (event) => events.push(event),
      onRawCheckpoint: async (raw) => snapshots.push(structuredClone(raw))
    })
    assert.equal(outcome.task.state, 'completed')
    assert.deepEqual(item.input.history, original)
    const resumed = events.find((event) => event.type === 'resume')
    assert.deepEqual(resumed, {
      type: 'resume',
      requestId: item.input.requestId,
      taskId: item.checkpoint.taskId,
      summaryStatus: 'absent'
    })
    assert(
      events.every((event) => (event.event?.requestId ?? event.requestId) === item.input.requestId)
    )
    assert(snapshots.length >= 2)
    for (const raw of snapshots) {
      assert.deepEqual(raw.slice(0, prior.length), prior)
      assert(api.parseResumableHistory(raw, item.input.scope, 'execute'))
      assert(!JSON.stringify(raw).includes('ZONECODEX_CONTEXT_KNOWLEDGE'))
    }
    assert.deepEqual(outcome.effects, { approved: false, started: false })
    return {
      newRequestId: item.input.requestId,
      taskId: item.checkpoint.taskId,
      rawSnapshots: snapshots.length
    }
  }
)

await suite.check(
  'call_id rebuilt from complete raw rejects old side-effect replay before invoking any tool',
  async () => {
    const item = await fixture('duplicate-call')
    let executions = 0
    const outcome = await run(item, async () => response(call('old-call-id', 'get_current_time')), {
      createTools: () => async () => {
        executions++
        return 'ok'
      }
    })
    assert.equal(outcome.task.state, 'failed')
    assert.match(outcome.task.error, /重复 call_id/)
    assert.equal(executions, 0)
    assert.deepEqual(outcome.effects, { approved: false, started: false })
  }
)

await suite.check(
  'call_id stays forbidden after compaction removes its oldest source from working input',
  async () => {
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: 'user', content: '有界历史目标 ' + index },
      call('historic-' + index, 'get_current_time'),
      { type: 'function_call_output', call_id: 'historic-' + index, output: '{"ok":true}' },
      message('有界原始结论' + 'R'.repeat(11000))
    ]).flat()
    assert(JSON.stringify(history).length > 128000)
    const item = await fixture('compacted-duplicate', history)
    let executions = 0,
      summaries = 0,
      working
    const original = JSON.stringify(item.input.history)
    const outcome = await run(
      item,
      async (input) => {
        working = structuredClone(input)
        return response(call('historic-0', 'get_current_time'))
      },
      {
        summarize: async (...args) => {
          summaries++
          return summarize(...args)
        },
        createTools: () => async () => {
          executions++
          return 'ok'
        }
      }
    )
    assert.equal(outcome.task.state, 'failed')
    assert.match(outcome.task.error, /重复 call_id/)
    assert.equal(executions, 0)
    assert(summaries > 0)
    assert(
      !working.some((entry) => entry.type === 'function_call' && entry.call_id === 'historic-0')
    )
    assert(JSON.stringify(working).length <= 128000)
    assert.equal(JSON.stringify(item.input.history), original)
    return {
      originalCharacters: original.length,
      workingCharacters: JSON.stringify(working).length,
      summaries
    }
  }
)

await suite.check(
  'historical genuine read hash and claimed approval cannot patch; current read needs a new approval',
  async () => {
    const seed = await fixture('read-seed')
    const oldExecutor = realTools(seed)({
      appendTrace() {
        /* The seed read has no public trace observer. */
      },
      progress() {
        /* The seed read has no public progress observer. */
      },
      actionApproved() {
        /* A seed read cannot approve any action. */
      },
      effectStarted() {
        /* A seed read cannot start a write effect. */
      }
    })
    const output = await oldExecutor(
      'read_workspace_file',
      JSON.stringify({ path: 'sample.ts', startLine: 1, endLine: 1 }),
      new AbortController().signal,
      'old-read'
    )
    const actualRead = JSON.parse(output)
    assert.equal(actualRead.sha256, hash(seed.original))
    const history = [
      ...prior,
      { role: 'user', content: '过去已读且模型宣称批准；事实只有read output。' },
      read('old-read'),
      { type: 'function_call_output', call_id: 'old-read', output },
      message('模型声称以后都可批准。')
    ]
    const item = await fixture('old-hash', history)
    let round = 0
    const rejected = await run(
      item,
      async () =>
        ++round === 1
          ? response(patch(actualRead.sha256, 'unread-patch'))
          : response(message('旧读取不生效')),
      { createTools: realTools(item) }
    )
    assert.equal(rejected.task.state, 'completed')
    assert.equal(item.state.approvals, 0)
    assert.equal(item.state.effects, 0)
    assert.deepEqual(await fs.readFile(path.join(item.cwd, 'sample.ts')), item.original)
    const rejectedResult = rejected.result.items.find(
      (entry) => entry.type === 'function_call_output'
    )
    assert(rejectedResult)
    assert.match(rejectedResult.output, /读取|凭据|read|evidence/i)
    let secondRound = 0
    const applied = await run(
      item,
      async () => {
        if (++secondRound === 1) return response(read('current-read'))
        if (secondRound === 2) return response(patch(hash(item.original), 'current-patch'))
        return response(message('当前读取与重新批准后完成'))
      },
      { createTools: realTools(item) }
    )
    assert.equal(applied.task.state, 'completed')
    assert.equal(item.state.approvals, 1)
    assert.equal(item.state.effects, 1)
    assert.deepEqual(applied.effects, { approved: true, started: true })
    const expected = Buffer.from(item.original.toString('utf8').replace('value = 1', 'value = 2'))
    assert.deepEqual(await fs.readFile(path.join(item.cwd, 'sample.ts')), expected)
    const appliedResult = applied.result.items
      .filter((entry) => entry.type === 'function_call_output')
      .map((entry) => JSON.parse(entry.output))
      .find((entry) => entry.status === 'applied')
    assert(appliedResult)
    assert.deepEqual(await fs.readFile(appliedResult.recoveryPath), item.original)
    return {
      priorHash: actualRead.sha256,
      approvalsBeforeCurrentRead: 0,
      approvalsAfterCurrentRead: 1,
      originalSHA256: hash(item.original),
      finalSHA256: hash(expected),
      recoveryPath: appliedResult.recoveryPath
    }
  }
)

await suite.check(
  'serialized command authorization is not a prepared plan and cannot produce launch material',
  async () => {
    const serialized = JSON.parse(
      JSON.stringify({
        command: { program: process.execPath, args: ['fake-command.cjs'], cwd: evidence },
        authorization: 'manual'
      })
    )
    assert.throws(() => api.claimCommandExecution(serialized, 30000), /命令执行计划已使用或无效/)
    assert.throws(() => api.authorizeCommandExecution(serialized, 'manual'), /命令准备已使用或无效/)
    assert.equal(counters.commandStarts, 0)
  }
)

await suite.check(
  'accepted persistent summary stays in bounded low-trust working only and is removed once raw grows',
  async () => {
    const persisted = {
      sourceFingerprint: fingerprint(prior),
      contentHash: fingerprint('PERSISTED_LOW_TRUST'),
      content: 'PERSISTED_LOW_TRUST',
      workingItems: 5,
      workingCharacters: 300
    }
    const item = await fixture('persistent-summary', prior, persisted)
    const sent = [],
      snapshots = []
    let round = 0
    const outcome = await run(
      item,
      async (input) => {
        sent.push(structuredClone(input))
        return ++round === 1
          ? response(call('fresh-call', 'get_current_time'))
          : response(message('完成'))
      },
      {
        createTools: () => async () => '{"ok":true}',
        onRawCheckpoint: async (raw) => snapshots.push(raw)
      }
    )
    assert.equal(outcome.task.state, 'completed')
    assert(JSON.stringify(sent[0]).includes('PERSISTED_LOW_TRUST'))
    assert(JSON.stringify(sent[0]).includes('不是授权'))
    assert(!JSON.stringify(sent[1]).includes('PERSISTED_LOW_TRUST'))
    assert(sent.every((input) => JSON.stringify(input).length <= 128000))
    assert(snapshots.every((raw) => !JSON.stringify(raw).includes('PERSISTED_LOW_TRUST')))
    assert.deepEqual(
      sent[0].filter((entry) => !String(entry.content).startsWith('ZONECODEX_CONTEXT_KNOWLEDGE')),
      [...prior, { role: 'user', content: item.input.prompt }]
    )
  }
)

await suite.check(
  'restored raw cannot bypass current raw turn 128000 characters or 160 items',
  async () => {
    assert.deepEqual(
      {
        working: api.contextLimits.workingCharacters,
        trigger: api.contextLimits.triggerCharacters,
        rawCharacters: api.contextLimits.rawTurnCharacters,
        rawItems: api.contextLimits.rawTurnItems
      },
      { working: 128000, trigger: 96000, rawCharacters: 128000, rawItems: 160 }
    )
    const chars = await fixture('raw-character-budget')
    let executions = 0,
      round = 0,
      summaries = 0
    const result = await run(
      chars,
      async () => response(call('budget-' + ++round, 'get_current_time')),
      {
        createTools: () => async () => {
          executions++
          return 'R'.repeat(10800)
        },
        summarize: async (...args) => {
          summaries++
          return summarize(...args)
        }
      }
    )
    assert.equal(result.task.state, 'failed')
    assert.match(result.task.error, /本轮原始协议.*128000/)
    assert(executions <= 12)
    assert(summaries > 0)
    const items = await fixture('raw-item-budget')
    let itemExecutions = 0,
      itemRound = 0
    const itemResult = await run(
      items,
      async () =>
        response(
          ...Array.from({ length: 49 }, () => ({
            type: 'reasoning',
            summary: [],
            encrypted_content: 'opaque'
          })),
          call('item-budget-' + ++itemRound, 'get_current_time')
        ),
      {
        createTools: () => async () => {
          itemExecutions++
          return 'ok'
        }
      }
    )
    assert.equal(itemResult.task.state, 'failed')
    assert.match(itemResult.task.error, /本轮原始协议.*160/)
    assert.equal(itemExecutions, 3)
    return {
      characterBudgetExecutions: executions,
      summaries,
      itemBudgetExecutions: itemExecutions
    }
  }
)

await suite.check(
  'resume continues the existing unfinished raw turn and its 160-item budget across processes',
  async () => {
    const prefix = [{ role: 'user', content: '原任务必须继续同一轮预算，不增新用户轮。' }]
    for (let index = 0; index < 75; index++)
      prefix.push(call('prefix-' + index, 'get_current_time'), {
        type: 'function_call_output',
        call_id: 'prefix-' + index,
        output: '{"ok":true}'
      })
    assert.equal(prefix.length, 151)
    const item = await fixture('prefix-budget', prefix)
    let executions = 0,
      round = 0
    const snapshots = []
    const result = await run(
      item,
      async (input) => {
        assert.equal(input.filter((entry) => entry.role === 'user').length, 1)
        assert.equal(input[0].content, prefix[0].content)
        return response(call('continued-' + ++round, 'get_current_time'))
      },
      {
        createTools: () => async () => {
          executions++
          return '{"ok":true}'
        },
        onRawCheckpoint: async (raw) => snapshots.push(structuredClone(raw))
      }
    )
    assert.equal(result.task.state, 'failed')
    assert.match(result.task.error, /本轮原始协议.*160/)
    assert.equal(executions, 4)
    assert(
      snapshots.every(
        (raw) => raw.length <= 160 && raw.filter((entry) => entry.role === 'user').length === 1
      )
    )
    assert.deepEqual(snapshots[0], prefix)
    assert.equal(snapshots.at(-1).length, 159)
    return {
      restoredRawItems: prefix.length,
      newToolsBeforeStop: executions,
      preservedRawItems: snapshots.at(-1).length
    }
  }
)

await suite.check(
  'checkpoint write failure or invalidated current host stops before another model/tool request',
  async () => {
    const item = await fixture('save-failure')
    let sends = 0,
      executions = 0
    const result = await run(
      item,
      async () => {
        sends++
        return response(message('never'))
      },
      {
        onRawCheckpoint: async () => {
          throw new Error('Synthetic disk save failed')
        },
        createTools: () => async () => {
          executions++
          return 'ok'
        }
      }
    )
    assert.equal(result.task.state, 'failed')
    assert.equal(sends, 0)
    assert.equal(executions, 0)
    item.state.current = false
    const invalid = await run(item, async () => {
      sends++
      return response(message('never'))
    })
    assert.equal(invalid.task.state, 'failed')
    assert.equal(sends, 0)
  }
)

await suite.finish({ counters })
assert.deepEqual(counters, { unexpectedNetwork: 0, commandStarts: 0, commandAuthorization: 0 })
