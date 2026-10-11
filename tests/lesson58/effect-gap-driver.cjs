const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const childProcess = require('node:child_process')

const [bundle, configFile, stage] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const api = require(bundle)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const counts = {
  commandStarts: 0,
  resourceProbes: 0,
  unexpectedNetwork: 0,
  approvals: 0,
  effects: 0
}
const originalExecFile = childProcess.execFile
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  childProcess[name] = () => {
    counts.commandStarts++
    throw new Error('The effect-gap fixture never launches a command')
  }
childProcess.execFile = (program, args, ...rest) => {
  if (
    stage === 'first' &&
    path.resolve(program).toLowerCase() ===
      path.join(config.runtimeRoot, 'host.exe').toLowerCase() &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === '--capabilities' &&
    counts.resourceProbes === 0
  ) {
    counts.resourceProbes++
    return originalExecFile(program, args, ...rest)
  }
  counts.commandStarts++
  throw new Error('Only the fixed supervisor capability query is allowed; no task command launches')
}
const audit = { stage, pid: process.pid, counts, requests: [], events: [], savedBoundaries: [] }
const writeAudit = (name = stage + '-audit.json') =>
  fs.writeFileSync(path.join(config.directory, name), JSON.stringify(audit, null, 2))
const call = (callId, name, args) => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: JSON.stringify(args)
})
const read = (id) =>
  call(id, 'read_workspace_file', { path: 'sample.ts', startLine: 1, endLine: 1 })
const patchArguments = (expectedSha256, from = 1, to = 2) => ({
  path: 'sample.ts',
  expectedSha256,
  patch: `*** Begin Patch\n*** Update File: sample.ts\n@@\n-export const value = ${from}\n+export const value = ${to}\n*** End Patch`
})
const completed = (output) =>
  new Response(
    'data: ' +
      JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }) +
      '\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const message = (text) => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
function resultFrom(items, id) {
  const item = items.find((item) => item.type === 'function_call_output' && item.call_id === id)
  assert(item, 'Expected actual tool output: ' + id)
  return JSON.parse(item.output)
}

async function run() {
  const isResume = stage === 'resume'
  const scope = { kind: 'time', executionId: (isResume ? 'b' : 'a').repeat(64) }
  const loaded = isResume ? await api.loadTaskCheckpoint(config.checkpoint, { scope }) : null
  const requestId = loaded?.requestId ?? config.requestId
  const conversationId = loaded?.checkpoint.conversationId ?? config.conversationId
  const prompt = loaded?.checkpoint.prompt ?? config.prompt
  const controller = new AbortController()
  const execution = {
    info: { cwd: config.cwd, scopeId: scope.executionId, mode: 'default', revision: 0 },
    writableRoots: []
  }
  const bindings = loaded?.checkpoint.bindings ?? {
    cwd: await api.captureTaskDirectoryBinding(config.cwd),
    workspace: null
  }
  let createdAt = loaded?.checkpoint.createdAt
  audit.requestId = requestId
  audit.loadedRaw = loaded?.history
  audit.originalPrompt = prompt
  const createTools = (observer, allowApproval = !isResume) => {
    const authorization = api.createHostWorkspaceAuthorization({
      owner: { kind: 'cli', runId: randomUUID(), requestId, conversationId },
      userRequest: prompt,
      execution,
      assertCurrent: () => !controller.signal.aborted,
      beginApproval: () => true,
      finishApproval() {
        /* This isolated fixture has no persistent pending UI handle. */
      },
      onApproved: (operation) => observer.actionApproved(operation.kind),
      requestApproval: async (_input, signal) => {
        signal.throwIfAborted()
        counts.approvals++
        return allowApproval
      }
    })
    return api.createAgentRuntimeTools(
      {
        conversationId,
        mode: 'execute',
        execution,
        assertCurrent: () => !controller.signal.aborted,
        approve: authorization,
        authorizeCommand: async () => {
          throw new Error('No current command request is authorized by this fixture')
        },
        projectSnapshot: null,
        executeCommandProposal: async () => {
          throw new Error('No desktop proposal bridge in ordinary Node')
        }
      },
      {
        ...observer,
        effectStarted() {
          counts.effects++
          observer.effectStarted()
        }
      }
    )
  }
  if (!isResume) {
    // This is a real in-process preparation/signature, never a launched command.
    // Only its public serialized projection crosses to the subsequent process.
    const prepared = await api.prepareCommandExecution(
      { program: process.execPath, args: ['--version'], cwd: config.cwd },
      {
        owner: { kind: 'cli', runId: randomUUID(), requestId, conversationId },
        permissions: { mode: 'full-access', revision: 0 },
        scopeId: scope.executionId,
        writableRoots: [config.cwd],
        environment: 'tool',
        assertCurrent: () => true,
        runtimeRoot: config.runtimeRoot
      },
      controller.signal
    )
    audit.serializedCommandPlan = JSON.parse(
      JSON.stringify(api.authorizeCommandExecution(prepared, 'full-access'))
    )
  } else {
    assert.deepEqual(fs.readFileSync(config.target), Buffer.from(config.expectedBytes, 'base64'))
    const previous = JSON.parse(
      fs.readFileSync(path.join(config.directory, 'gap-audit.json'), 'utf8')
    )
    assert.throws(
      () => api.claimCommandExecution(previous.serializedCommandPlan, 30000),
      /命令执行计划已使用或无效/
    )
    assert.throws(
      () => api.authorizeCommandExecution(previous.serializedCommandPlan, 'manual'),
      /命令准备已使用或无效/
    )
    const probeEvents = []
    const probe = createTools({
      appendTrace() {
        /* The probe records results directly rather than publishing a task. */
      },
      progress() {
        /* No public task progress is produced by the authority probe. */
      },
      actionApproved: (kind) => probeEvents.push(kind),
      effectStarted: () => probeEvents.push('effect')
    })
    // Even a guessed current hash plus the genuine old raw read/approval cannot
    // recreate the fresh executor's private visible-line evidence.
    const attempted = JSON.parse(
      await probe(
        'apply_workspace_patch',
        JSON.stringify(patchArguments(hash(fs.readFileSync(config.target)), 2, 3)),
        controller.signal,
        'untrusted-prior-approval-patch'
      )
    )
    assert.equal(attempted.status, 'error')
    assert.match(attempted.error, /本执行请求.*读取/)
    assert.equal(counts.approvals, 0)
    const currentRead = JSON.parse(
      await probe(
        'read_workspace_file',
        JSON.stringify({ path: 'sample.ts', startLine: 1, endLine: 1 }),
        controller.signal,
        'fresh-probe-read'
      )
    )
    assert.equal(currentRead.ok, true)
    const declined = JSON.parse(
      await probe(
        'apply_workspace_patch',
        JSON.stringify(patchArguments(currentRead.sha256, 2, 3)),
        controller.signal,
        'fresh-declined-patch'
      )
    )
    assert.equal(declined.status, 'cancelled')
    assert.equal(counts.approvals, 1, 'A current approval decision is required after a new read')
    assert.equal(counts.effects, 0)
    assert.deepEqual(probeEvents, [])
    assert.deepEqual(fs.readFileSync(config.target), Buffer.from(config.expectedBytes, 'base64'))
    audit.authorityProbes = {
      oldReadRejected: attempted,
      freshRead: currentRead,
      freshApprovalDeclined: declined,
      serializedCommandRejected: true,
      counts: { ...counts }
    }
    counts.approvals = 0
  }
  const runtime = api.createAgentRuntime({
    capabilities: { mode: 'execute', execution: execution.info, resuming: isResume },
    configuration: {
      endpoint: 'https://lesson58-gap.invalid/responses',
      model: 'synthetic-gap',
      apiKey: 'synthetic-fixture-key'
    }
  })
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== 'https://lesson58-gap.invalid/responses' || init.method !== 'POST') {
      counts.unexpectedNetwork++
      throw new Error('Fixture rejects real network')
    }
    const body = JSON.parse(init.body)
    assert.equal(body.instructions.includes(api.agentResumeSafetyInstructions), isResume)
    assert(!JSON.stringify(body.input).includes(api.agentResumeSafetyInstructions))
    audit.requests.push({
      input: structuredClone(body.input),
      instructions: body.instructions,
      safetyInstructionsIncluded: isResume
    })
    writeAudit()
    const number = audit.requests.length
    if (!isResume) {
      if (number === 1) return completed([read('original-safe-read')])
      assert.equal(number, 2, 'The process must stop before a post-write model request')
      const actualRead = resultFrom(body.input, 'original-safe-read')
      assert.equal(actualRead.ok, true)
      return completed([
        call('lost-gap-patch', 'apply_workspace_patch', patchArguments(actualRead.sha256))
      ])
    }
    if (number === 1) {
      assert.deepEqual(body.input, loaded.history)
      return completed([read('resumed-current-result-read')])
    }
    assert.equal(number, 2)
    const observed = resultFrom(body.input, 'resumed-current-result-read')
    assert.equal(observed.ok, true)
    assert.equal(observed.lines[0].text, 'export const value = 2')
    return completed([message('已重新读取当前文件：原修改已经生效，本次没有重复写入。')])
  }
  const outcome = await api.runAgentCore(
    {
      requestId,
      conversationId,
      mode: 'execute',
      prompt,
      history: loaded?.history ?? [],
      scope,
      ...(loaded ? { resume: loaded.resume } : {})
    },
    {
      ...runtime,
      signal: controller.signal,
      assertCurrent: () => !controller.signal.aborted,
      createTools,
      onEvent: (event) => audit.events.push(structuredClone(event)),
      onRawCheckpoint: async (raw, summary, completed) => {
        if (
          !isResume &&
          raw.some(
            (item) => item.type === 'function_call_output' && item.call_id === 'lost-gap-patch'
          )
        ) {
          const result = resultFrom(raw, 'lost-gap-patch')
          assert.equal(result.status, 'applied')
          assert.deepEqual(
            fs.readFileSync(config.target),
            Buffer.from(config.expectedBytes, 'base64')
          )
          assert.equal(counts.approvals, 1)
          assert.equal(counts.effects, 1)
          audit.uncommittedRaw = raw
          audit.oldPointerSHA256 = hash(fs.readFileSync(config.checkpoint))
          audit.diskSHA256 = hash(fs.readFileSync(config.target))
          audit.waitingBeforeCompleteCheckpointSave = true
          writeAudit('gap-audit.json')
          // The parent kills this real process. A live timer prevents natural
          // exit, and no thrown error substitutes for the hard-exit window.
          await new Promise(() => {
            setInterval(() => {}, 1000)
          })
          throw new Error('Hard-exit barrier unexpectedly released')
        }
        const checkpoint = api.createTaskCheckpoint({
          taskId: config.taskId,
          conversationId,
          createdAt,
          mode: 'execute',
          prompt,
          scope,
          bindings,
          history: raw,
          summary,
          progress: completed ? 'completed' : 'resumable',
          reason: completed ? 'completed' : 'saved'
        })
        const saved = await api.saveTaskCheckpoint(config.checkpoint, checkpoint, raw)
        assert(saved.ok, JSON.stringify(saved))
        createdAt = checkpoint.createdAt
        audit.savedBoundaries.push({
          items: raw.length,
          fingerprint: checkpoint.raw.fingerprint,
          completed: Boolean(completed)
        })
      }
    }
  )
  assert(isResume, 'The first process must be killed before returning')
  assert.equal(outcome.task.state, 'completed')
  assert.equal(counts.effects, 0)
  assert.equal(counts.approvals, 0)
  assert.equal(counts.commandStarts, 0)
  assert.equal(counts.unexpectedNetwork, 0)
  assert(
    !outcome.result.items.some(
      (item) => item.type === 'function_call' && item.name === 'apply_workspace_patch'
    )
  )
  assert.deepEqual(fs.readFileSync(config.target), Buffer.from(config.expectedBytes, 'base64'))
  audit.outcome = outcome
  writeAudit()
  console.log(JSON.stringify({ pass: true, stage, pid: process.pid, counts }))
}
run().catch((error) => {
  audit.failure = error.stack ?? String(error)
  writeAudit()
  console.error(error)
  process.exitCode = 1
})
