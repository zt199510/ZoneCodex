import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8)
assert.ok(entryArg)
assert.ok(process.argv.slice(2).every((arg) => arg.startsWith('--entry=')))
const entry = path.resolve(root, entryArg),
  installationRoot = path.dirname(entry)
const evidence = await createEvidence('cli-distribution-protection'),
  preload = fileURLToPath(new URL('./cli-synthetic-preload.cjs', import.meta.url))
await fs.copyFile(fileURLToPath(import.meta.url), path.join(evidence, 'validator.mjs.snapshot'))
await fs.copyFile(preload, path.join(evidence, 'preload.cjs.snapshot'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  checks = []
const original = Object.fromEntries(
  await Promise.all(
    ['index.cjs', 'output-writer.cjs', 'build-manifest.json'].map(async (name) => [
      name,
      await fs.readFile(path.join(installationRoot, name))
    ])
  )
)
const identities = Object.fromEntries(
  Object.entries(original).map(([name, bytes]) => [name, hash(bytes)])
)
const scenarios = [
  'healthy',
  'missing-writer',
  'tampered-writer',
  'tampered-writer-and-manifest',
  'missing-manifest',
  'hardlinked-writer',
  'hardlinked-manifest',
  'symlinked-writer',
  'symlinked-manifest'
]
for (const scenario of scenarios) {
  const directory = path.join(evidence, scenario + '-' + randomUUID()),
    installation = path.join(directory, 'isolated-installation'),
    workspace = path.join(directory, 'workspace')
  await fs.mkdir(installation, { recursive: true })
  await fs.mkdir(workspace)
  for (const [name, bytes] of Object.entries(original))
    await fs.writeFile(path.join(installation, name), bytes)
  const writer = path.join(installation, 'output-writer.cjs'),
    manifest = path.join(installation, 'build-manifest.json')
  let preparationError
  try {
    if (scenario === 'missing-writer') await fs.unlink(writer)
    if (scenario === 'missing-manifest') await fs.unlink(manifest)
    if (scenario.startsWith('tampered-writer')) {
      const modified = Buffer.concat([
        original['output-writer.cjs'],
        Buffer.from('\n// isolated identity mutation\n')
      ])
      await fs.writeFile(writer, modified)
      if (scenario === 'tampered-writer-and-manifest') {
        const data = JSON.parse(original['build-manifest.json'])
        const declared = data.entries.find((item) => item.name === 'output-writer.cjs')
        assert.ok(declared)
        declared.sha256 = hash(modified)
        await fs.writeFile(manifest, JSON.stringify(data, null, 2))
      }
    }
    if (scenario.startsWith('hardlinked-') || scenario.startsWith('symlinked-')) {
      const filename = scenario.endsWith('writer') ? writer : manifest,
        sibling = filename + '.controlled-sibling'
      await fs.copyFile(filename, sibling)
      await fs.unlink(filename)
      if (scenario.startsWith('hardlinked-')) await fs.link(sibling, filename)
      else await fs.symlink(sibling, filename, 'file')
      const info = await fs.lstat(filename)
      assert.ok(scenario.startsWith('hardlinked-') ? info.nlink === 2 : info.isSymbolicLink())
      await fs.writeFile(
        path.join(directory, 'actual-link.json'),
        JSON.stringify(
          { filename, sibling, nlink: info.nlink, symbolicLink: info.isSymbolicLink() },
          null,
          2
        )
      )
    }
  } catch (error) {
    preparationError = { code: error.code, message: error.message, stack: error.stack }
  }
  if (preparationError) {
    const value = {
      name: scenario,
      pass: false,
      covered: false,
      reason: 'Environment could not prepare the actual isolated link or mutation',
      preparationError,
      evidence: directory
    }
    checks.push(value)
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(value, null, 2))
    continue
  }
  const env = {
    ...process.env,
    MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
    MODEL_NAME: 'gpt-6.1-sol',
    MODEL_API_KEY: 'LESSON55_SYNTHETIC_SECRET_SENTINEL',
    LESSON55_EVIDENCE: directory,
    LESSON55_FIXTURE: 'done',
    LESSON55_WORKSPACE: workspace
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    process.execPath,
    [
      '--require',
      preload,
      path.join(installation, 'index.cjs'),
      '--mode',
      'execute',
      '--cwd',
      workspace,
      '--prompt',
      '隔离安装身份保护验证',
      '--output',
      'jsonl'
    ],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
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
  const audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
  const processResult = {
    scenario,
    pid: child.pid,
    entry: path.join(installation, 'index.cjs'),
    ...outcome,
    forcedKill,
    stdout,
    stderr,
    audit
  }
  await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(processResult, null, 2))
  try {
    assert.equal(forcedKill, false)
    assert.equal(outcome.signal, null)
    assert.equal(audit.spawns.length, 0)
    assert.ok(!stdout.includes('LESSON55_SYNTHETIC_SECRET_SENTINEL'))
    assert.ok(!stderr.includes('LESSON55_SYNTHETIC_SECRET_SENTINEL'))
    assert.doesNotMatch(
      stderr,
      /Unhandled\s+['"]error['"]\s+event|node:events:\d+|node:internal[\\/]|^\s+at\s+.+(?:\(|:\d+:\d+)/m,
      'CLI must reject or finish without an unhandled native error or crash stack'
    )
    if (scenario === 'healthy') {
      assert.equal(outcome.exitCode, 0, stderr)
      assert.equal(audit.requests.length, 1)
      assert.equal(audit.outputWriters.length, 1)
      const writerProcess = audit.outputWriters[0]
      assert.ok(writerProcess.closed)
      assert.equal(writerProcess.exitCode, 0)
      assert.equal(writerProcess.sha256, identities['output-writer.cjs'])
      assert.ok(!writerProcess.hasModelCredential && !writerProcess.hasNodeOptions)
    } else {
      assert.equal(outcome.exitCode, 1, stderr)
      assert.equal(audit.requests.length, 0)
      assert.equal(audit.outputWriters.length, 0)
      assert.equal(stdout, '')
      if (stderr) assert.match(stderr, /输出|身份|资源/)
    }
    checks.push({
      name: scenario,
      pass: true,
      covered: true,
      evidence: directory,
      modelSynthetic: true,
      compiledCLIActual: true,
      modelRequests: audit.requests.length,
      outputWriters: audit.outputWriters.length,
      toolProcesses: audit.spawns.length
    })
  } catch (error) {
    checks.push({
      name: scenario,
      pass: false,
      covered: true,
      evidence: directory,
      error: error.stack
    })
    console.error(scenario + ': ' + error.message)
  }
}
for (const [name, bytes] of Object.entries(original))
  assert.deepEqual(
    await fs.readFile(path.join(installationRoot, name)),
    bytes,
    'Original compiled artifact untouched: ' + name
  )
const result = {
  pass: checks.every((item) => item.pass),
  evidence,
  entry,
  total: checks.length,
  failed: checks.filter((item) => !item.pass).length,
  checks,
  identities,
  node: process.version,
  boundary:
    'Actual ordinary Node compiled CLI and native fixed output writer. A fixed synthetic model is used only for healthy installation control. Every corruption/link case changes newly copied isolated installation files only and must reject before model, writer or task tool launch. Rejection requires normal exit 1, no signal or forced termination, and no unhandled error/native crash stack. Empty stderr is accepted when both protected output pipes cannot initialize. Exact original artifacts are checked unchanged; links are actual Windows filesystem links, not mocked lstat.'
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
console.log(
  JSON.stringify({ pass: result.pass, evidence, total: result.total, failed: result.failed })
)
if (!result.pass) process.exitCode = 1
