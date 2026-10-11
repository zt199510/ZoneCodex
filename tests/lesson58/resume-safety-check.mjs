import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { compile, delay } from '../lesson57/runtime.mjs'
import { root, hash, createEvidence, checksFor, runProcess } from './runtime.mjs'

const evidence = await createEvidence('resume-effect-gap')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/agent/agent-core.ts',
  'src/main/agent/agent-runtime.ts',
  'src/main/agent/agent-instructions.ts',
  'src/main/storage/task-checkpoint-store.ts',
  'src/main/execution/workspace-authorization.ts',
  'src/main/execution/command-plan.ts',
  'src/shared/agent-resume.ts',
  'src/cli/output.ts'
])
const suite = checksFor(evidence, {
  ordinaryNode: true,
  actualProcessHardExit: true,
  realDisk: true,
  syntheticTransport: true,
  realTransport: false,
  taskCommandLaunched: false,
  fixedSupervisorCapabilityQuery: true,
  arbitraryTaskExactlyOnce: false,
  scope:
    'A single controlled file patch commits before its complete raw checkpoint; recovery observes current disk instead of repeating that patch.',
  sourceHashes,
  compiledSHA256
})
const originalBytes = Buffer.from('\ufeffexport const value = 1\r\n\r\n')
const expectedBytes = Buffer.from(originalBytes.toString('utf8').replace('value = 1', 'value = 2'))
const cwd = path.join(evidence, 'workspace')
await fs.mkdir(cwd)
const target = path.join(cwd, 'sample.ts')
const checkpoint = path.join(evidence, 'task.checkpoint.json')
await fs.writeFile(target, originalBytes, { flag: 'wx' })
const config = {
  directory: evidence,
  cwd,
  target,
  checkpoint,
  prompt: '只把 sample.ts 的 value 从 1 改为 2；继续时先核对当前实际结果，已生效就不要重复修改。',
  requestId: randomUUID(),
  conversationId: randomUUID(),
  taskId: randomUUID(),
  expectedBytes: expectedBytes.toString('base64'),
  runtimeRoot: path.join(root, 'resources/windows-command-runtime')
}
const configFile = path.join(evidence, 'fixture-config.json')
await fs.writeFile(configFile, JSON.stringify(config, null, 2))
const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
const driver = path.join(root, 'tests/lesson58/effect-gap-driver.cjs')
const bundle = path.join(evidence, 'current-source.cjs')
const env = { ...process.env }
for (const key of Object.keys(env))
  if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
let gap, oldPointer, oldRaw, oldRawFile, interruptedPid

await suite.check(
  'resume risk is one shared instruction/notice and appears only for a verified resumed capability',
  async () => {
    assert.equal(typeof api.agentResumeSafetyNotice, 'string')
    assert.equal(typeof api.agentResumeSafetyInstructions, 'string')
    assert(api.agentResumeSafetyNotice.length > 20)
    assert(api.agentResumeSafetyInstructions.length > 20)
    const capabilities = {
      mode: 'execute',
      execution: { cwd, scopeId: 'a'.repeat(64), mode: 'default', revision: 0 }
    }
    const ordinary = api.buildAgentRequest(capabilities)
    const resumed = api.buildAgentRequest({ ...capabilities, resuming: true })
    assert(!ordinary.instructions.includes(api.agentResumeSafetyInstructions))
    assert(resumed.instructions.includes(api.agentResumeSafetyInstructions))
    assert.deepEqual(resumed.tools, ordinary.tools)
    for (const file of ['src/main/agent/desktop-agent-host.ts', 'src/cli/agent-host.ts']) {
      const text = await fs.readFile(path.join(root, file), 'utf8')
      assert.match(text, /resuming:\s*(?:Boolean\((?:resumed|loaded)\)|!!(?:resumed|loaded))/)
      assert(
        !text.includes(api.agentResumeSafetyInstructions),
        'Host must consume shared instructions rather than copy them'
      )
    }
    const renderer = await fs.readFile(
      path.join(root, 'src/renderer/src/features/chat/ChatWorkspace.tsx'),
      'utf8'
    )
    assert.match(renderer, /agentResumeSafetyNotice/)
    return {
      notice: api.agentResumeSafetyNotice,
      instructions: api.agentResumeSafetyInstructions,
      toolsUnchanged: true
    }
  }
)

await suite.check(
  'CLI text renders the shared recovery notice while the JSONL resume record keeps its exact four fields',
  async () => {
    const event = {
      type: 'resume',
      requestId: randomUUID(),
      taskId: config.taskId,
      summaryStatus: 'absent'
    }
    const outputs = []
    for (const mode of ['text', 'jsonl']) {
      let stdout = '',
        stderr = ''
      const sink = (receive) =>
        new Writable({
          write(bytes, _encoding, done) {
            receive(bytes.toString('utf8'))
            done()
          }
        })
      const output = new api.CLIOutput(
        mode,
        sink((text) => {
          stdout += text
        }),
        sink((text) => {
          stderr += text
        })
      )
      try {
        output.event(event)
        await output.flush(new AbortController().signal)
        if (mode === 'text') {
          assert.equal(stdout, '')
          assert(stderr.includes(api.agentResumeSafetyNotice))
        } else {
          assert.equal(stderr, '')
          const record = JSON.parse(stdout.trim())
          assert.deepEqual(record, event)
          assert.deepEqual(Object.keys(record).sort(), [
            'requestId',
            'summaryStatus',
            'taskId',
            'type'
          ])
          assert(!stdout.includes(api.agentResumeSafetyNotice))
        }
        outputs.push({ mode, stdout, stderr })
      } finally {
        output.dispose()
      }
    }
    return outputs
  }
)

await suite.check(
  'an actual Node PID is hard-killed after a real approved file replacement and before the complete checkpoint commits',
  async () => {
    const child = spawn(
      process.execPath,
      ['--require', guard, driver, bundle, configFile, 'first'],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    interruptedPid = child.pid
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout += bytes
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    let killed = false
    try {
      const started = Date.now()
      while (Date.now() - started < 20000) {
        try {
          gap = JSON.parse(await fs.readFile(path.join(evidence, 'gap-audit.json'), 'utf8'))
          break
        } catch {
          /* The audit barrier is published only after the actual replacement. */
        }
        if (child.exitCode !== null)
          throw new Error('First process ended before the checkpoint-gap barrier: ' + stderr)
        await delay(25)
      }
      assert(gap?.waitingBeforeCompleteCheckpointSave, stderr)
      assert.equal(gap.pid, interruptedPid)
      assert.deepEqual(await fs.readFile(target), expectedBytes)
      assert.deepEqual(gap.counts, {
        commandStarts: 0,
        resourceProbes: 1,
        unexpectedNetwork: 0,
        approvals: 1,
        effects: 1
      })
      oldPointer = await fs.readFile(checkpoint)
      const pointer = JSON.parse(oldPointer)
      oldRawFile = path.join(path.dirname(checkpoint), pointer.raw.file)
      oldRaw = await fs.readFile(oldRawFile)
      const raw = JSON.parse(oldRaw)
      assert.equal(pointer.prompt, config.prompt)
      assert.equal(pointer.progress, 'resumable')
      assert.equal(hash(oldPointer), gap.oldPointerSHA256)
      assert(raw.some((item) => item.call_id === 'original-safe-read'))
      assert(!raw.some((item) => item.call_id === 'lost-gap-patch'))
      assert(
        gap.uncommittedRaw.some(
          (item) => item.call_id === 'lost-gap-patch' && item.type === 'function_call_output'
        )
      )
      await fs.writeFile(path.join(evidence, 'last-safe.checkpoint.snapshot.json'), oldPointer)
      await fs.writeFile(path.join(evidence, 'last-safe.raw.snapshot.json'), oldRaw)
      process.kill(interruptedPid, 'SIGKILL')
      killed = true
      const close = await Promise.race([closed, delay(10000).then(() => null)])
      assert(close, 'The actual killed Node PID must close')
      assert.notEqual(close.exitCode, 0)
      assert.deepEqual(await fs.readFile(checkpoint), oldPointer)
      assert.deepEqual(await fs.readFile(oldRawFile), oldRaw)
      assert.deepEqual(await fs.readFile(target), expectedBytes)
      await fs.writeFile(path.join(evidence, 'first.stdout.log'), stdout)
      await fs.writeFile(path.join(evidence, 'first.stderr.log'), stderr)
      await fs.writeFile(
        path.join(evidence, 'hard-exit.json'),
        JSON.stringify(
          { pid: interruptedPid, ...close, deliberateHardExit: true, gapVerifiedBeforeKill: true },
          null,
          2
        )
      )
      return {
        pid: interruptedPid,
        ...close,
        originalSHA256: hash(originalBytes),
        actualCommittedSHA256: hash(expectedBytes),
        safeRawItems: raw.length,
        safePointerSHA256: hash(oldPointer)
      }
    } finally {
      if (!killed && child.exitCode === null) child.kill()
    }
  }
)

await suite.check(
  'a new PID rehydrates no authority, rereads the actual completed result, and completes the unchanged intent without another write',
  async () => {
    assert(gap && oldRaw)
    const loaded = await api.loadTaskCheckpoint(checkpoint, {
      scope: { kind: 'time', executionId: 'b'.repeat(64) }
    })
    assert.deepEqual(loaded.history, JSON.parse(oldRaw))
    assert.equal(loaded.checkpoint.prompt, config.prompt)
    assert.deepEqual(await fs.readFile(checkpoint), oldPointer)
    const result = await runProcess(
      process.execPath,
      ['--require', guard, driver, bundle, configFile, 'resume'],
      { cwd: root, env },
      20000
    )
    await fs.writeFile(path.join(evidence, 'resume.stdout.log'), result.stdout)
    await fs.writeFile(path.join(evidence, 'resume.stderr.log'), result.stderr)
    assert.equal(result.exitCode, 0, result.stderr)
    assert(!result.signal && !result.forcedKill)
    const resumed = JSON.parse(await fs.readFile(path.join(evidence, 'resume-audit.json'), 'utf8'))
    assert.notEqual(resumed.pid, interruptedPid)
    assert.notEqual(resumed.requestId, config.requestId)
    assert.deepEqual(resumed.loadedRaw, JSON.parse(oldRaw))
    assert.equal(resumed.originalPrompt, config.prompt)
    assert.deepEqual(resumed.requests[0].input, JSON.parse(oldRaw))
    assert(resumed.requests.every((item) => item.safetyInstructionsIncluded))
    assert.deepEqual(resumed.counts, {
      commandStarts: 0,
      resourceProbes: 0,
      unexpectedNetwork: 0,
      approvals: 0,
      effects: 0
    })
    assert.equal(resumed.authorityProbes.counts.approvals, 1)
    assert.equal(resumed.authorityProbes.counts.effects, 0)
    const resumedCalls = resumed.events.filter(
      (item) => item.type === 'tool' && item.event.phase === 'start'
    )
    assert.deepEqual(
      resumedCalls.map((item) => item.event.name),
      ['read_workspace_file']
    )
    const finalPointer = JSON.parse(await fs.readFile(checkpoint, 'utf8'))
    const finalRaw = JSON.parse(
      await fs.readFile(path.join(evidence, finalPointer.raw.file), 'utf8')
    )
    assert.equal(finalPointer.progress, 'completed')
    assert.equal(finalPointer.prompt, config.prompt)
    assert.deepEqual(finalRaw.slice(0, JSON.parse(oldRaw).length), JSON.parse(oldRaw))
    assert.deepEqual(await fs.readFile(oldRawFile), oldRaw)
    assert.deepEqual(await fs.readFile(target), expectedBytes)
    assert(!JSON.stringify(finalRaw).includes(api.agentResumeSafetyInstructions))
    return {
      oldPID: interruptedPid,
      newPID: resumed.pid,
      oldRequestId: config.requestId,
      newRequestId: resumed.requestId,
      recoveryToolOrder: resumedCalls.map((item) => item.event.name),
      recoveredEffects: resumed.counts.effects,
      originalPromptPreserved: true,
      oldRawImmutable: true,
      arbitraryTaskExactlyOnce: false
    }
  }
)

await suite.finish()
