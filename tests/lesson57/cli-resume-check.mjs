import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { root, createEvidence, checksFor, compile, hash, delay, runProcess } from './runtime.mjs'
import { contracts, materialize, outsideBusiness } from '../lesson55/real/task-contracts.mjs'

const packaged = process.argv.includes('--packaged')
assert(process.argv.slice(2).every((arg) => arg === '--packaged'))
const evidence = await createEvidence('cli-resume-' + (packaged ? 'distributed' : 'development'))
const install = path.join(root, packaged ? 'dist/agent' : 'out/cli')
const entry = path.join(install, 'index.cjs')
const library = path.join(install, 'agent.cjs')
const preload = path.join(root, 'tests/lesson57/cli-synthetic-preload.cjs')
const suite = checksFor(evidence, {
  actualNodeProcesses: true,
  actualCLI: true,
  actualDistributedLauncher: packaged,
  syntheticTransport: true,
  realTransport: false,
  realDisk: true,
  packaged
})
const processes = []
const { api } = await compile(evidence, ['src/main/storage/task-checkpoint-store.ts'])
const cleanEnvironment = () => {
  const env = { ...process.env }
  for (const name of Object.keys(env))
    if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|LESSON55_|LESSON56_|LESSON57_)/i.test(name))
      delete env[name]
  return env
}
async function environment(directory, fixture, extras = {}) {
  await fs.mkdir(directory, { recursive: true })
  return {
    ...cleanEnvironment(),
    MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
    MODEL_NAME: 'gpt-6.1-sol',
    MODEL_API_KEY: 'LESSON57_SYNTHETIC_KEY',
    LESSON57_EVIDENCE: directory,
    LESSON57_FIXTURE: fixture,
    ...extras
  }
}
function invocation(args, env, importOnly) {
  if (importOnly)
    return {
      program: process.execPath,
      parameters: [
        '--require',
        preload,
        '-e',
        'require(' + JSON.stringify(importOnly === 'entry' ? entry : library) + ')'
      ],
      env
    }
  if (!packaged)
    return { program: process.execPath, parameters: ['--require', preload, entry, ...args], env }
  assert(
    args.every((arg) => !/["\r\n]/.test(arg)),
    'Fixed launcher fixture arguments must have simple quoting'
  )
  const quote = (value) => '"' + value + '"'
  return {
    program: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    parameters: [
      '/d',
      '/s',
      '/c',
      '"' + [quote(path.join(install, 'agent.cmd')), ...args.map(quote)].join(' ') + '"'
    ],
    env: { ...env, NODE_OPTIONS: '--require "' + preload.replaceAll('\\', '/') + '"' },
    windowsVerbatimArguments: true
  }
}
async function capture(label, args, fixture = 'done', extras = {}, importOnly) {
  const directory = path.join(evidence, label)
  const env = await environment(directory, fixture, extras)
  const inv = invocation(args, env, importOnly)
  const result = await runProcess(
    inv.program,
    inv.parameters,
    { cwd: directory, env: inv.env, windowsVerbatimArguments: inv.windowsVerbatimArguments },
    30000
  )
  await fs.writeFile(path.join(directory, 'stdout.jsonl'), result.stdout)
  await fs.writeFile(path.join(directory, 'stderr.txt'), result.stderr)
  const audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
  processes.push({
    label,
    processPid: result.pid,
    cliPid: audit.pid,
    exitCode: result.exitCode,
    signal: result.signal,
    forcedKill: result.forcedKill,
    directory
  })
  assert.equal(result.forcedKill, false)
  assert.equal(audit.unexpectedNetwork, 0)
  assert(
    audit.spawns.every(
      (spawn) =>
        spawn.kind === 'fixed-output-writer' && !spawn.hasCredential && !spawn.hasNodeOptions
    )
  )
  return { result, audit, directory }
}
const records = (stdout) =>
  stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
async function prepareBusiness(label) {
  const directory = path.join(evidence, label)
  const cwd = path.join(directory, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const contract = contracts[0]
  const { source, test, totalLines } = materialize(contract)
  await fs.writeFile(path.join(cwd, 'business.ts'), source, { flag: 'wx' })
  await fs.writeFile(path.join(cwd, 'business.test.mjs'), test, { flag: 'wx' })
  await fs.writeFile(path.join(cwd, 'requirements.md'), contract.spec, { flag: 'wx' })
  await fs.writeFile(
    path.join(cwd, 'sidecar.txt'),
    'Lesson57 protected evidence fixture, never modify.\n',
    { flag: 'wx' }
  )
  const protectedHashes = Object.fromEntries(
    await Promise.all(
      ['business.test.mjs', 'requirements.md', 'sidecar.txt'].map(async (name) => [
        name,
        hash(await fs.readFile(path.join(cwd, name)))
      ])
    )
  )
  const lines = source.toString('utf8').split(/\r?\n/)
  const windows = [0, 1].map((index) => {
    const start = lines.findIndex((line) => line === '// BUSINESS AREA ' + index + ' BEGIN') + 1
    const end = lines.findIndex((line) => line === '// BUSINESS AREA ' + index + ' END') + 1
    assert(start > 0 && end > start)
    return [start, end]
  })
  return {
    directory,
    cwd,
    source,
    test,
    totalLines,
    windows,
    protectedHashes,
    checkpoint: path.join(directory, 'task.checkpoint.json')
  }
}
async function businessTest(item, label) {
  const result = await runProcess(
    process.execPath,
    ['business.test.mjs'],
    { cwd: item.cwd, env: cleanEnvironment() },
    15000
  )
  await fs.writeFile(path.join(item.directory, label + '.stdout.json'), result.stdout)
  await fs.writeFile(path.join(item.directory, label + '.stderr.txt'), result.stderr)
  assert.equal(result.forcedKill, false)
  const facts = JSON.parse(result.stdout)
  assert.equal(facts.checks, 8)
  return { ...facts, exitCode: result.exitCode, pid: result.pid }
}
async function interrupt(item, label) {
  const directory = path.join(evidence, label)
  const env = await environment(directory, 'interrupt', {
    LESSON57_SOURCE_HASH: hash(item.source),
    LESSON57_READ_WINDOWS: JSON.stringify(item.windows)
  })
  const args = [
    '--mode',
    'execute',
    '--prompt',
    '按照 requirements.md 修正 business.ts 两个价格函数，只修改业务函数，保留格式并重新核验。',
    '--cwd',
    item.cwd,
    '--permission',
    'full-access',
    '--checkpoint',
    item.checkpoint,
    '--output',
    'jsonl'
  ]
  const inv = invocation(args, env)
  const child = spawn(inv.program, inv.parameters, {
    cwd: directory,
    env: inv.env,
    windowsHide: true,
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let audit,
    loaded,
    interrupted = false
  const started = Date.now()
  try {
    while (Date.now() - started < 15000) {
      try {
        audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
        if (audit.requests.length === 2) {
          loaded = await api.loadTaskCheckpoint(item.checkpoint)
          if (
            loaded.history.some(
              (entry) =>
                entry.type === 'function_call_output' && entry.call_id === 'lesson57-original-read'
            )
          )
            break
        }
      } catch {
        /* Save and audit are observed only after both complete. */
      }
      await delay(50)
    }
    assert(
      audit?.requests.length === 2,
      'Actual first CLI reached a real read and pending synthetic main request'
    )
    assert(loaded)
    assert.equal(audit.unexpectedNetwork, 0)
    await fs.copyFile(item.checkpoint, path.join(directory, 'interrupted.checkpoint.snapshot.json'))
    const rawPath = path.join(path.dirname(item.checkpoint), loaded.checkpoint.raw.file)
    await fs.copyFile(rawPath, path.join(directory, 'interrupted.raw.snapshot.json'))
    // Deliberate host exit: a real CLI PID terminates while the synthetic second
    // model request is pending. The saved complete read group is the recovery point.
    process.kill(audit.pid, 'SIGKILL')
    interrupted = true
    const result = await Promise.race([done, delay(10000).then(() => null)])
    assert(result, 'Actual interrupted process and launcher close within the observation bound')
    await fs.writeFile(path.join(directory, 'stdout.jsonl'), stdout)
    await fs.writeFile(path.join(directory, 'stderr.txt'), stderr)
    const firstRecords = records(stdout)
    const requestId = firstRecords.find((record) => record.requestId)?.requestId
    assert(requestId)
    processes.push({
      label,
      processPid: child.pid,
      cliPid: audit.pid,
      ...result,
      deliberateHostExit: true,
      directory
    })
    assert.deepEqual(await fs.readFile(path.join(item.cwd, 'business.ts')), item.source)
    assert.equal(loaded.history.filter((entry) => entry.role === 'user').length, 1)
    return { audit, loaded, requestId, cliPid: audit.pid, raw: loaded.history }
  } finally {
    if (!interrupted) {
      if (audit?.pid) {
        try {
          process.kill(audit.pid, 'SIGKILL')
        } catch {
          /* Already closed. */
        }
      }
      child.kill()
    }
  }
}

await suite.check(
  'current compiled CLI identities match present source and packaged launcher',
  async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(install, 'build-manifest.json'), 'utf8')
    )
    for (const build of manifest.entries) {
      assert.equal(hash(await fs.readFile(path.join(install, build.name))), build.sha256)
      for (const [file, expected] of Object.entries(build.sources))
        assert.equal(
          hash(await fs.readFile(path.join(root, file))),
          expected,
          'Current source identity: ' + file
        )
    }
    if (packaged)
      assert.equal(
        hash(await fs.readFile(path.join(install, manifest.launcher.name))),
        manifest.launcher.sha256
      )
    return {
      entry,
      entrySHA256: hash(await fs.readFile(entry)),
      librarySHA256: hash(await fs.readFile(library)),
      preloadSHA256: hash(await fs.readFile(preload))
    }
  }
)

await suite.check(
  'new-process help, entry import, library import and no-task startup issue zero model/tool/writer requests',
  async () => {
    const counts = []
    for (const [label, args, importOnly, code] of [
      ['help', ['--help'], null, 0],
      ['import-entry', [], 'entry', 0],
      ['import-library', [], 'library', 0],
      ['no-task', [], null, 2]
    ]) {
      const { result, audit } = await capture(label, args, 'done', {}, importOnly)
      assert.equal(result.exitCode, code)
      assert.equal(audit.requests.length, 0)
      assert.equal(audit.spawns.length, 0)
      counts.push({ label, pid: audit.pid, main: 0, summary: 0, approval: 0, tools: 0, writers: 0 })
    }
    return counts
  }
)

await suite.check(
  'without resume the original single-task CLI starts with exactly empty historical context',
  async () => {
    const item = await prepareBusiness('fresh')
    const { result, audit } = await capture('fresh-process', [
      '--mode',
      'execute',
      '--prompt',
      '明确新任务',
      '--cwd',
      item.cwd,
      '--output',
      'jsonl'
    ])
    assert.equal(result.exitCode, 0)
    assert.equal(audit.requests.length, 1)
    assert.equal(audit.requests[0].resumeSafety, false)
    assert.deepEqual(audit.requests[0].input, [{ role: 'user', content: '明确新任务' }])
    assert(!records(result.stdout).some((record) => record.type === 'resume'))
    assert.deepEqual(await fs.readFile(path.join(item.cwd, 'business.ts')), item.source)
  }
)

await suite.check(
  'actual CLI interruption, new PID explicit resume and fixed eight-test price business are independently verifiable',
  async () => {
    const item = await prepareBusiness('price-resume')
    const before = await businessTest(item, 'before')
    assert.equal(before.exitCode, 1)
    const first = await interrupt(item, 'first-interrupted-process')
    const checkpointIdentity = first.loaded.checkpoint
    const { result, audit } = await capture(
      'resumed-process',
      ['--resume', item.checkpoint, '--permission', 'full-access', '--output', 'jsonl'],
      'resume-business',
      {
        LESSON57_SOURCE_HASH: hash(item.source),
        LESSON57_READ_WINDOWS: JSON.stringify(item.windows)
      }
    )
    assert.equal(result.exitCode, 0, result.stderr)
    assert.notEqual(audit.pid, first.cliPid)
    const output = records(result.stdout)
    const resume = output.find((record) => record.type === 'resume')
    const terminal = output.find((record) => record.type === 'result')
    assert(resume && terminal)
    assert.notEqual(resume.requestId, first.requestId)
    assert.equal(resume.taskId, checkpointIdentity.taskId)
    assert.deepEqual(Object.keys(resume).sort(), ['requestId', 'summaryStatus', 'taskId', 'type'])
    assert(JSON.stringify(resume).length < 300)
    assert.deepEqual(audit.requests[0].input, first.raw)
    assert(audit.requests.every((request) => request.inputCharacters <= 128000))
    assert.equal(audit.requests.filter((request) => request.kind === 'main').length, 4)
    assert(
      audit.requests
        .filter((request) => request.kind === 'main')
        .every((request) => request.resumeSafety)
    )
    assert(
      audit.requests[1].input.some(
        (entry) =>
          entry.type === 'function_call_output' && entry.call_id === 'lesson57-current-read-a'
      )
    )
    const finalPointer = JSON.parse(await fs.readFile(item.checkpoint, 'utf8'))
    assert.equal(finalPointer.progress, 'completed')
    assert.equal(finalPointer.taskId, checkpointIdentity.taskId)
    assert.equal(finalPointer.createdAt, checkpointIdentity.createdAt)
    const finalRaw = JSON.parse(
      await fs.readFile(path.join(path.dirname(item.checkpoint), finalPointer.raw.file), 'utf8')
    )
    assert.deepEqual(finalRaw.slice(0, first.raw.length), first.raw)
    assert.equal(finalRaw.filter((entry) => entry.role === 'user').length, 1)
    assert.equal(
      finalRaw.filter(
        (entry) => entry.type === 'function_call' && entry.call_id === 'lesson57-original-read'
      ).length,
      1
    )
    const after = await businessTest(item, 'after')
    const repeated = await businessTest(item, 'repeated-independent')
    assert.equal(after.exitCode, 0)
    assert.deepEqual(after.failures, [])
    assert.equal(repeated.exitCode, 0)
    const final = await fs.readFile(path.join(item.cwd, 'business.ts'))
    assert.notEqual(hash(final), hash(item.source))
    assert.deepEqual(outsideBusiness(final), outsideBusiness(item.source))
    assert.equal(final.toString('utf8').split('\n').length, item.totalLines)
    assert(final.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    assert(!/(?<!\r)\n/.test(final.toString('utf8')))
    assert(final.toString('utf8').endsWith('\r\n\r\n\r\n'))
    for (const [file, expected] of Object.entries(item.protectedHashes))
      assert.equal(hash(await fs.readFile(path.join(item.cwd, file))), expected)
    const applied = finalRaw
      .filter((entry) => entry.type === 'function_call_output')
      .map((entry) => JSON.parse(entry.output))
      .find((entry) => entry.status === 'applied')
    assert(applied)
    assert.deepEqual(await fs.readFile(applied.recoveryPath), item.source)
    return {
      firstPID: first.cliPid,
      resumedPID: audit.pid,
      previousRequestId: first.requestId,
      newRequestId: resume.requestId,
      taskId: resume.taskId,
      sourceSHA256: hash(item.source),
      finalSHA256: hash(final),
      rawItemsBefore: first.raw.length,
      rawItemsAfter: finalRaw.length,
      before,
      after,
      repeated,
      protectedHashes: item.protectedHashes,
      recoveryPath: applied.recoveryPath
    }
  }
)

await suite.check(
  'resume does not imply approval: noninteractive default permission refuses a newly required external write',
  async () => {
    const item = await prepareBusiness('approval-resume')
    const first = await interrupt(item, 'approval-interrupted-process')
    const outside = path.join(item.directory, 'outside-workspace.txt')
    const { result, audit } = await capture(
      'approval-resumed-process',
      ['--resume', item.checkpoint, '--output', 'jsonl'],
      'approval-required',
      { LESSON57_OUTSIDE_FILE: outside }
    )
    assert.equal(result.exitCode, 3)
    assert.notEqual(audit.pid, first.cliPid)
    await assert.rejects(fs.access(outside), (error) => error.code === 'ENOENT')
    assert.deepEqual(await fs.readFile(path.join(item.cwd, 'business.ts')), item.source)
    assert.equal(
      records(result.stdout).find((record) => record.type === 'result').effects.started,
      false
    )
    return {
      firstPID: first.cliPid,
      resumedPID: audit.pid,
      exitCode: result.exitCode,
      absentFile: outside
    }
  }
)

await suite.check(
  'resume invalid file, cwd drift and conflicting explicit input fail before model transport without rewriting saved files',
  async () => {
    const item = await prepareBusiness('refusal')
    await interrupt(item, 'refusal-interrupted-process')
    const originalPointer = await fs.readFile(item.checkpoint)
    const other = path.join(item.directory, 'other-cwd')
    await fs.mkdir(other)
    for (const [label, args] of [
      ['refuse-cwd', ['--resume', item.checkpoint, '--cwd', other, '--output', 'jsonl']],
      ['refuse-mode', ['--resume', item.checkpoint, '--mode', 'execute', '--output', 'jsonl']],
      ['refuse-prompt', ['--resume', item.checkpoint, '--prompt', 'new task', '--output', 'jsonl']],
      ['refuse-stdin', ['--resume', item.checkpoint, '--stdin', '--output', 'jsonl']],
      [
        'refuse-checkpoint',
        ['--resume', item.checkpoint, '--checkpoint', item.checkpoint, '--output', 'jsonl']
      ]
    ]) {
      const { result, audit } = await capture(label, args)
      assert.equal(result.exitCode, 2)
      assert.equal(audit.requests.length, 0)
      assert.deepEqual(await fs.readFile(item.checkpoint), originalPointer)
    }
    const bad = path.join(item.directory, 'broken.checkpoint.json')
    const badBytes = Buffer.from('{not valid json\n')
    await fs.writeFile(bad, badBytes)
    const { result, audit } = await capture('refuse-bad-file', [
      '--resume',
      bad,
      '--output',
      'jsonl'
    ])
    assert.equal(result.exitCode, 2)
    assert.equal(audit.requests.length, 0)
    assert.deepEqual(await fs.readFile(bad), badBytes)
  }
)

await suite.finish({
  processes,
  inheritedOpen: [
    'lesson56 user confirmation',
    'lesson56 eight questions',
    'native resource EPERM',
    'real multiple image compaction',
    'natural break-then-repair'
  ]
})
