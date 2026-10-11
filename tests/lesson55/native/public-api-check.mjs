import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8)
assert.ok(process.argv.slice(2).every((arg) => arg.startsWith('--entry=')))
const api = path.resolve(root, entryArg || 'out/cli/agent.cjs')
const evidence = await createEvidence('public-api')
const preload = fileURLToPath(new URL('./cli-synthetic-preload.cjs', import.meta.url)),
  driver = fileURLToPath(new URL('./public-api-driver.cjs', import.meta.url))
for (const file of ['public-api-check.mjs', 'public-api-driver.cjs', 'cli-synthetic-preload.cjs'])
  await fs.copyFile(
    fileURLToPath(new URL('./' + file, import.meta.url)),
    path.join(evidence, file + '.snapshot')
  )
const checks = [],
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const identity = hash(await fs.readFile(api))
const fixtureFor = (scenario) =>
  scenario === 'input-frozen'
    ? 'create'
    : scenario.startsWith('question-')
      ? 'question'
      : scenario.startsWith('command-')
        ? 'command-approval'
        : ['model-cancel', 'agents-invalidated'].includes(scenario)
          ? 'wait-model'
          : scenario.endsWith('-command')
            ? 'command'
            : 'done'
for (const scenario of [
  'import',
  'normal',
  'input-frozen',
  'configuration-frozen',
  'no-on-event',
  'event-exception',
  'already-cancelled',
  'model-cancel',
  'question-answer',
  'question-unavailable',
  'question-invalid',
  'question-exception',
  'question-cancel-late',
  'command-approve',
  'command-reject',
  'command-spoof-json',
  'command-finish-cancel',
  'agents-invalidated',
  'read-only-missing-resources',
  'missing-resources-command',
  'tampered-host-command'
]) {
  const directory = path.join(evidence, scenario + '-' + randomUUID()),
    workspace = path.join(directory, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(
    path.join(workspace, 'command.cjs'),
    'console.log(JSON.stringify({command:true,credential:!!process.env.MODEL_API_KEY}));\n'
  )
  if (scenario === 'agents-invalidated')
    await fs.writeFile(
      path.join(workspace, 'AGENTS.md'),
      '# original controlled test instruction\n'
    )
  let actualAPI = api
  if (scenario.includes('resources') || scenario === 'tampered-host-command') {
    const installation = path.join(directory, 'isolated-installation')
    await fs.mkdir(installation)
    actualAPI = path.join(installation, 'agent.cjs')
    await fs.copyFile(api, actualAPI)
    // A fake cwd/PATH resource must never become the trusted command supervisor.
    await fs.writeFile(path.join(workspace, 'host.exe'), 'self-authored untrusted host sentinel')
    if (scenario === 'tampered-host-command') {
      const resource = path.join(installation, 'windows-command-runtime')
      await fs.mkdir(resource)
      await fs.copyFile(
        path.join(path.dirname(api), 'windows-command-runtime/manifest.json'),
        path.join(resource, 'manifest.json')
      )
      const host = await fs.readFile(
        path.join(path.dirname(api), 'windows-command-runtime/host.exe')
      )
      host[host.length - 1] ^= 1
      await fs.writeFile(path.join(resource, 'host.exe'), host)
    }
  }
  const env = {
    ...process.env,
    MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
    MODEL_NAME: 'gpt-6.1-sol',
    MODEL_API_KEY: 'LESSON55_SYNTHETIC_SECRET_SENTINEL',
    LESSON55_EVIDENCE: directory,
    LESSON55_FIXTURE: fixtureFor(scenario),
    LESSON55_PUBLIC_API: actualAPI,
    LESSON55_WORKSPACE: workspace,
    PATH: workspace + path.delimiter + (process.env.PATH || '')
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, ['--require', preload, driver, scenario], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = '',
    timer,
    forcedKill = false
  child.stdout.on('data', (bytes) => (stdout += bytes))
  child.stderr.on('data', (bytes) => (stderr += bytes))
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let outcome
  try {
    outcome = await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 15000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  if (!outcome) {
    forcedKill = true
    child.kill()
    await done
  }
  let audit
  try {
    audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
  } catch {
    // Preserve missing audit evidence in the process result for the existing assertions to reject.
  }
  const processResult = {
    scenario,
    directory,
    actualAPI,
    pid: child.pid,
    ...outcome,
    forcedKill,
    stdout,
    stderr,
    audit
  }
  await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(processResult, null, 2))
  try {
    assert.equal(forcedKill, false)
    assert.equal(outcome.exitCode, 0, stderr)
    assert.ok(Array.isArray(audit.outputWriters))
    assert.equal(
      audit.outputWriters.length,
      0,
      'Ordinary public API does not create CLI output processes'
    )
    const result = JSON.parse(stdout)
    assert.equal(result.pass, true)
    assert.ok(!result.details.imports.some((name) => name === 'electron'))
    if (['import', 'event-exception', 'already-cancelled'].includes(scenario)) {
      assert.equal(audit.requests.length, 0)
      assert.equal(audit.spawns.length, 0)
    }
    if (scenario === 'configuration-frozen') assert.equal(audit.requests[0].model, 'gpt-6.1-sol')
    if (scenario === 'input-frozen')
      assert.equal(
        audit.requests[0].input.findLast((value) => value.role === 'user').content,
        '固定公共脚本任务'
      )
    if (scenario === 'question-answer') {
      assert.equal(audit.requests.length, 2)
      assert.deepEqual(
        JSON.parse(
          audit.requests[1].input.find((value) => value.type === 'function_call_output').output
        ).answers,
        [{ id: 'layout', answer: '列表' }]
      )
    }
    if (
      [
        'question-unavailable',
        'question-invalid',
        'question-exception',
        'question-cancel-late'
      ].includes(scenario)
    )
      assert.equal(audit.requests.length, 1)
    if (
      [
        'command-reject',
        'command-spoof-json',
        'missing-resources-command',
        'tampered-host-command'
      ].includes(scenario)
    )
      assert.equal(audit.spawns.length, 0)
    if (['command-approve', 'command-finish-cancel'].includes(scenario)) {
      assert.ok(audit.spawns.some((value) => /host\.exe$/i.test(value.program)))
      assert.ok(audit.spawns.every((value) => !value.hasModelCredential))
    }
    checks.push({
      name: scenario,
      pass: true,
      evidence: directory,
      modelSynthetic: true,
      originalHostActual: true
    })
  } catch (error) {
    checks.push({ name: scenario, pass: false, evidence: directory, error: error.stack })
    console.error(scenario + ': ' + error.message)
  }
}
try {
  assert.equal(
    hash(await fs.readFile(api)),
    identity,
    'Original compiled public module changed during verification'
  )
} catch (error) {
  checks.push({
    name: 'compiled module identity during verification',
    pass: false,
    error: error.stack
  })
}
const result = {
  pass: checks.every((check) => check.pass),
  total: checks.length,
  failed: checks.filter((check) => !check.pass).length,
  evidence,
  checks,
  provenance: {
    api,
    sha256: identity,
    node: process.version,
    preloadSHA256: hash(await fs.readFile(preload)),
    driverSHA256: hash(await fs.readFile(driver))
  },
  boundary:
    'Actual public compiled ordinary Node module and original host/core/tools. Model transport is synthetic. Actual isolated disk, resource copies and supervised command processes are separately identified. No original resource, product or user data is changed.'
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
console.log(
  JSON.stringify({ pass: result.pass, total: result.total, failed: result.failed, evidence })
)
if (!result.pass) process.exitCode = 1
