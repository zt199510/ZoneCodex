import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { root, compile, checksFor, hash, runProcess } from '../lesson57/runtime.mjs'

const packaged = process.argv.includes('--packaged')
assert(process.argv.slice(2).every((argument) => argument === '--packaged'))
const evidence = path.join(
  root,
  '.ui-check/test-runs/lesson62',
  'cli-' + (packaged ? 'distributed-' : 'development-') + randomUUID()
)
await fs.mkdir(evidence, { recursive: true })
const install = path.join(root, packaged ? 'dist/agent' : 'out/cli')
const entry = path.join(install, 'index.cjs')
const library = path.join(install, 'agent.cjs')
const launcher = path.join(install, 'agent.cmd')
const manifest = JSON.parse(await fs.readFile(path.join(install, 'build-manifest.json'), 'utf8'))
const identities = {}
try {
  for (const item of manifest.entries) {
    const file = path.join(install, item.name)
    identities[file] = hash(await fs.readFile(file))
    assert.equal(identities[file], item.sha256, 'Built entry identity: ' + item.name)
    for (const [source, expected] of Object.entries(item.sources))
      assert.equal(
        hash(await fs.readFile(path.join(root, source))),
        expected,
        'Build current CLI artifacts before running lesson62: ' + source
      )
  }
  identities[launcher] = hash(await fs.readFile(launcher))
  assert.equal(identities[launcher], manifest.launcher.sha256)
  assert(manifest.entries.find((item) => item.name === 'index.cjs').sources['src/shared/skills.ts'])
} catch (error) {
  await fs.writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      {
        pass: false,
        evidence,
        packaged,
        phase: 'artifact-current-source-identity',
        actualCLIProcessesStarted: false,
        realModelTransport: false,
        error: error.stack ?? String(error)
      },
      null,
      2
    )
  )
  throw error
}

const preload = path.join(evidence, 'synthetic-preload.cjs')
// This fixture changes only transport. Product argument handling, process startup,
// checkpoint persistence, the tool loop and the distributed launcher stay real.
await fs.writeFile(
  preload,
  String.raw`
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')
const directory = process.env.LESSON62_CLI_EVIDENCE
if (!directory || !path.isAbsolute(directory)) throw new Error('Isolated evidence required')
const fixture = process.env.LESSON62_CLI_FIXTURE || 'complete'
const audit = { pid: process.pid, fixture, syntheticTransport: true, realTransport: false,
  requests: [], skillDiskOperations: [], spawns: [], unexpectedNetwork: 0 }
const save = () => fs.writeFileSync(path.join(directory, 'transport-audit.json'), JSON.stringify(audit, null, 2))
const watch = (name, args) => {
  const value = args[0]
  const filename = value instanceof URL ? value.pathname : Buffer.isBuffer(value) ? value.toString() : value
  if (typeof filename === 'string' && /(?:^|[\\/])skills(?:[\\/]|$)|(?:^|[\\/])SKILL\.md$/i.test(filename)) {
    audit.skillDiskOperations.push({ operation: name, filename })
    save()
    throw new Error('CLI must not inspect skill source directories or SKILL.md')
  }
}
for (const name of ['readFileSync', 'readdirSync', 'opendirSync', 'openSync', 'lstatSync', 'statSync', 'realpathSync',
  'readFile', 'readdir', 'opendir', 'open', 'lstat', 'stat', 'realpath', 'access']) {
  if (typeof fs[name] !== 'function') continue
  const original = fs[name]
  fs[name] = function (...args) { watch(name, args); return original.apply(this, args) }
}
for (const name of ['readFile', 'readdir', 'opendir', 'open', 'lstat', 'stat', 'realpath', 'access']) {
  const original = fs.promises[name]
  fs.promises[name] = function (...args) { watch('promises.' + name, args); return original.apply(this, args) }
}
const deny = () => { audit.unexpectedNetwork++; save(); throw new Error('Real network denied') }
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny
const originalSpawn = cp.spawn
cp.spawn = function (program, args, options) {
  const writer = path.join(path.dirname(process.argv[1] || ''), 'output-writer.cjs')
  const allowed = program === process.execPath && Array.isArray(args) && args.length === 1 && args[0] === writer
  const item = { kind: allowed ? 'fixed-output-writer' : 'unexpected-tool-process', program, args,
    hasCredential: !!options?.env?.MODEL_API_KEY, hasNodeOptions: !!options?.env?.NODE_OPTIONS }
  audit.spawns.push(item); save()
  if (!allowed) throw new Error('CLI fixture does not launch task commands')
  const child = originalSpawn.apply(this, arguments)
  item.pid = child.pid
  child.once('close', (code, signal) => { item.closed = true; item.exitCode = code; item.signal = signal; save() })
  save()
  return child
}
const response = (value) => new Response('data: ' + JSON.stringify(value) + '\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } })
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://example.invalid/v1/responses') return deny()
  const body = JSON.parse(init.body)
  const kind = body.instructions.includes('ZONECODEX_CONTEXT_SUMMARY_V1') ? 'summary' : body.tools?.length ? 'main' : 'auxiliary'
  let selectedSkill = null
  for (const line of body.instructions.split('\n')) {
    try { const value = JSON.parse(line); if (value.selectedSkill) selectedSkill = value.selectedSkill } catch {}
  }
  audit.requests.push({ kind, selectedSkill, input: body.input, toolNames: body.tools?.map((tool) => tool.name) || [],
    instructionsCharacters: body.instructions.length, bodySHA256: createHash('sha256').update(init.body).digest('hex') })
  save()
  if (kind !== 'main') throw new Error('Unexpected auxiliary model request')
  if (fixture === 'must-not-request') throw new Error('Inert or invalid input must not request a model')
  const requests = audit.requests.length
  const callId = fixture === 'interrupt' ? 'lesson62-first-pid-time' : 'lesson62-next-pid-time'
  if (fixture === 'interrupt' && requests === 2)
    return response({ type: 'response.failed', response: { status: 'failed', error: { message: 'Controlled synthetic task interruption.' } } })
  const output = requests === 1 && fixture !== 'ordinary'
    ? [{ type: 'function_call', call_id: callId, name: 'get_current_time', arguments: '{}' }]
    : [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Lesson62 synthetic CLI task completed.' }] }]
  return response({ type: 'response.completed', response: { status: 'completed', output } })
}
process.on('exit', (code) => { audit.exitCode = code; save() })
save()
`
)
const { api, sourceHashes } = await compile(evidence, [
  'src/main/storage/task-checkpoint-store.ts',
  'src/main/skills/skill-reader.ts'
])
const suite = checksFor(evidence, {
  actualNodeProcesses: true,
  actualCLI: true,
  actualDistributedLauncher: packaged,
  realDisk: true,
  syntheticTransport: true,
  realModelTransport: false,
  automaticBuild: false,
  packaged,
  sourceHashes,
  identities
})
const processes = []
const cleanEnvironment = () => {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|LESSON(?:55|56|57|58|60|62)_)/i.test(key))
      delete env[key]
  return env
}
function invocation(args, env, importOnly) {
  if (importOnly)
    return {
      program: process.execPath,
      parameters: [
        '--require',
        preload,
        '-e',
        'require(' +
          JSON.stringify(importOnly === 'entry' ? entry : library) +
          ');setTimeout(()=>{},5100)'
      ],
      env
    }
  if (!packaged)
    return { program: process.execPath, parameters: ['--require', preload, entry, ...args], env }
  assert(args.every((argument) => !/["\r\n]/.test(argument)))
  const quote = (value) => '"' + value + '"'
  return {
    program: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    parameters: ['/d', '/s', '/c', '"' + [quote(launcher), ...args.map(quote)].join(' ') + '"'],
    env: { ...env, NODE_OPTIONS: '--require "' + preload.replaceAll('\\', '/') + '"' },
    windowsVerbatimArguments: true
  }
}
async function capture(label, args, fixture = 'complete', importOnly) {
  const directory = path.join(evidence, label)
  await fs.mkdir(directory, { recursive: true })
  const env = {
    ...cleanEnvironment(),
    MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
    MODEL_NAME: 'gpt-6.1-sol',
    MODEL_API_KEY: 'LESSON62_SYNTHETIC_ONLY',
    LESSON62_CLI_EVIDENCE: directory,
    LESSON62_CLI_FIXTURE: fixture
  }
  const inv = invocation(args, env, importOnly)
  const result = await runProcess(
    inv.program,
    inv.parameters,
    { cwd: directory, env: inv.env, windowsVerbatimArguments: inv.windowsVerbatimArguments },
    30000
  )
  await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(result, null, 2))
  const audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
  processes.push({
    label,
    launcherPID: result.pid,
    cliPID: audit.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    forcedKill: result.forcedKill,
    directory
  })
  assert.equal(result.forcedKill, false, result.stderr)
  assert.equal(audit.unexpectedNetwork, 0)
  assert.deepEqual(audit.skillDiskOperations, [])
  assert(
    audit.spawns.every(
      (item) =>
        item.kind === 'fixed-output-writer' &&
        !item.hasCredential &&
        !item.hasNodeOptions &&
        item.closed
    )
  )
  const records =
    importOnly || args.includes('--help')
      ? []
      : result.stdout
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
  return {
    result,
    audit,
    directory,
    records,
    final: records.findLast((record) => record.type === 'result')
  }
}
async function seed(label, withSkill = true) {
  const directory = path.join(evidence, label)
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const skillRoot = path.join(directory, 'skills')
  const skillDirectory = path.join(skillRoot, 'code-review')
  await fs.mkdir(skillDirectory, { recursive: true })
  const source = path.join(skillDirectory, 'SKILL.md')
  const sourceBytes = Buffer.from(
    '---\nname: code-review\ndescription: Read real code and report evidence.\n---\n\n# Original method\nLESSON62_CLI_ORIGINAL_A\nPreserve this exact task snapshot.\n'
  )
  await fs.writeFile(source, sourceBytes, { flag: 'wx' })
  const skill = (await api.readSkillSnapshot(skillRoot, 'code-review')).snapshot
  assert.equal(skill.sourceHash, hash(sourceBytes))
  const history = [{ role: 'user', content: 'Continue the original bounded task.' }]
  const checkpoint = api.createTaskCheckpoint({
    taskId: randomUUID(),
    conversationId: randomUUID(),
    mode: 'plan',
    prompt: history[0].content,
    scope: { kind: 'time', executionId: 'a'.repeat(64) },
    bindings: { cwd: await api.captureTaskDirectoryBinding(cwd), workspace: null },
    history,
    ...(withSkill ? { skill } : {}),
    progress: 'interrupted',
    reason: 'host_exit'
  })
  const file = path.join(directory, 'task.checkpoint.json')
  assert.equal((await api.saveTaskCheckpoint(file, checkpoint, history)).ok, true)
  return { directory, cwd, source, sourceBytes, skill, history, checkpoint, file }
}
function verifySelected(audit, skill) {
  assert.equal(audit.requests.length, 2)
  for (const request of audit.requests) {
    assert.equal(request.kind, 'main')
    assert.deepEqual(request.selectedSkill, {
      name: skill.name,
      description: skill.description,
      body: skill.body
    })
    assert(!JSON.stringify(request.input).includes('LESSON62_CLI_ORIGINAL_A'))
  }
}

for (const change of ['modified', 'deleted'])
  await suite.check(
    'real CLI new PID resume keeps the original snapshot after source is ' + change,
    async () => {
      const item = await seed('source-' + change)
      const first = await capture(
        change + '-first-pid',
        ['--resume', item.file, '--output', 'jsonl'],
        'interrupt'
      )
      assert.equal(first.result.exitCode, 1, JSON.stringify(first.result))
      assert.equal(first.final.task.state, 'failed')
      verifySelected(first.audit, item.skill)
      const pointerBefore = JSON.parse(await fs.readFile(item.file, 'utf8'))
      assert.equal(pointerBefore.progress, 'interrupted')
      assert.deepEqual(pointerBefore.skill, item.skill)
      const rawFile = path.join(item.directory, pointerBefore.raw.file)
      const rawBefore = await fs.readFile(rawFile)
      assert(
        JSON.parse(rawBefore).some(
          (record) =>
            record.type === 'function_call_output' && record.call_id === 'lesson62-first-pid-time'
        )
      )
      if (change === 'modified')
        await fs.writeFile(
          item.source,
          item.sourceBytes.toString().replace('LESSON62_CLI_ORIGINAL_A', 'LESSON62_CLI_CHANGED_B')
        )
      else await fs.unlink(item.source)
      const second = await capture(change + '-second-pid', [
        '--resume',
        item.file,
        '--output',
        'jsonl'
      ])
      assert.equal(second.result.exitCode, 0, JSON.stringify(second.result))
      assert.equal(second.final.task.state, 'completed')
      assert.notEqual(first.audit.pid, second.audit.pid)
      assert.notEqual(first.final.requestId, second.final.requestId)
      verifySelected(second.audit, item.skill)
      const pointerAfter = JSON.parse(await fs.readFile(item.file, 'utf8'))
      assert.equal(pointerAfter.taskId, pointerBefore.taskId)
      assert.deepEqual(pointerAfter.skill, item.skill)
      assert.equal(pointerAfter.skill.sourceHash, hash(item.sourceBytes))
      assert.equal(pointerAfter.progress, 'completed')
      assert.notEqual(pointerAfter.scope.executionId, pointerBefore.scope.executionId)
      assert.deepEqual(await fs.readFile(rawFile), rawBefore)
      if (change === 'modified')
        assert((await fs.readFile(item.source, 'utf8')).includes('LESSON62_CLI_CHANGED_B'))
      else
        await assert.rejects(
          () => fs.access(item.source),
          (error) => error.code === 'ENOENT'
        )
      return {
        firstPID: first.audit.pid,
        resumedPID: second.audit.pid,
        snapshotHash: pointerAfter.skill.snapshotHash,
        sourceHash: pointerAfter.skill.sourceHash,
        originalRawSHA256: hash(rawBefore),
        sourceChange: change
      }
    }
  )
await suite.check(
  'actual ordinary CLI and no-skill resume do not scan source or inherit skills',
  async () => {
    const item = await seed('plain-task', false)
    const resumed = await capture('plain-resume', ['--resume', item.file, '--output', 'jsonl'])
    assert.equal(resumed.result.exitCode, 0)
    assert(resumed.audit.requests.every((request) => request.selectedSkill === null))
    assert.equal(JSON.parse(await fs.readFile(item.file, 'utf8')).skill, undefined)
    const checkpoint = path.join(item.directory, 'ordinary.checkpoint.json')
    const ordinary = await capture(
      'ordinary',
      [
        '--mode',
        'plan',
        '--cwd',
        item.cwd,
        '--prompt',
        'A fresh task with no selected skill.',
        '--checkpoint',
        checkpoint,
        '--output',
        'jsonl'
      ],
      'ordinary'
    )
    assert.equal(ordinary.result.exitCode, 0)
    assert.equal(ordinary.audit.requests.length, 1)
    assert.equal(ordinary.audit.requests[0].selectedSkill, null)
    assert.equal(JSON.parse(await fs.readFile(checkpoint, 'utf8')).skill, undefined)
  }
)
await suite.check(
  'invalid snapshot hash is rejected by the actual CLI before a model and preserves pointer/raw',
  async () => {
    const item = await seed('bad-hash')
    const damaged = structuredClone(item.checkpoint)
    damaged.skill.snapshotHash = '0'.repeat(64)
    const bytes = Buffer.from(JSON.stringify(damaged))
    await fs.writeFile(item.file, bytes)
    const rawFile = path.join(item.directory, damaged.raw.file)
    const rawBefore = await fs.readFile(rawFile)
    const result = await capture(
      'bad-hash-run',
      ['--resume', item.file, '--output', 'jsonl'],
      'must-not-request'
    )
    assert.equal(result.result.exitCode, 2)
    assert(result.final.task.error.includes('CHECKPOINT_INVALID'))
    assert.deepEqual(result.audit.requests, [])
    assert.deepEqual(await fs.readFile(item.file), bytes)
    assert.deepEqual(await fs.readFile(rawFile), rawBefore)
  }
)
await suite.check(
  'actual help and public/entry imports stay passive without skill disk or model access',
  async () => {
    const help = await capture('help', ['--help'], 'must-not-request')
    assert.equal(help.result.exitCode, 0)
    assert(help.result.stdout.includes('--resume'))
    assert.deepEqual(help.audit.requests, [])
    for (const kind of ['library', 'entry']) {
      const result = await capture('import-' + kind, [], 'must-not-request', kind)
      assert.equal(result.result.exitCode, 0)
      assert(result.result.elapsedMs >= 5000)
      assert.deepEqual(result.audit.requests, [])
      assert.deepEqual(result.audit.spawns, [])
    }
    return { importObservationMs: 5100 }
  }
)
for (const [file, expected] of Object.entries(identities))
  assert.equal(hash(await fs.readFile(file)), expected, 'Artifact remained unchanged: ' + file)
await suite.finish({
  processes,
  notCovered: ['real model/network', 'actual TTY SIGINT', 'desktop selector'],
  firstInterruption: 'synthetic SSE response.failed after actual time tool checkpoint'
})
