import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const source = fileURLToPath(new URL('../shared/', import.meta.url))
const guard = fileURLToPath(new URL('./deny-network.cjs', import.meta.url))
const evidence = await createEvidence('shared')
const suites = [
  'core-check.cjs',
  'protection-check.cjs',
  'capacity-check.cjs',
  'question-source-check.cjs',
  'runner-check.cjs',
  'desktop-source-material-check.cjs',
  'command-plan-identity-check.cjs',
  'patch-capacity-check.cjs'
]
const provenance = []
for (const name of [...suites, 'harness.cjs', 'fixture.cjs']) {
  const bytes = await fs.readFile(path.join(source, name))
  await fs.writeFile(path.join(evidence, name), bytes, { flag: 'wx' })
  provenance.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const runs = []
for (const name of suites) {
  const child = spawn(process.execPath, ['--require', guard, path.join(evidence, name)], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = '',
    timer,
    forcedKill = false
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
  let outcome
  try {
    outcome = await Promise.race([
      done,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 60000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  if (!outcome) {
    forcedKill = true
    child.kill()
    outcome = await done
  }
  await fs.writeFile(path.join(evidence, name + '.stdout.log'), stdout)
  await fs.writeFile(path.join(evidence, name + '.stderr.log'), stderr)
  runs.push({ name, pid: child.pid, ...outcome, forcedKill, stdout: stdout.trim(), stderr })
  console.log(JSON.stringify({ name, ...outcome, forcedKill }))
  if (outcome.exitCode !== 0 && stderr) console.error(stderr)
}
const result = {
  pass: runs.every((run) => run.exitCode === 0 && run.signal === null && !run.forcedKill),
  evidence,
  runs,
  provenance,
  boundary:
    'Current source, original assertions, isolated disk and fixed synthetic transport. Electron, command backend and selected CommitIO races are substitutes. No old UUID reports are read. Test sources are copied to this new run directory; attachment cases also create uniquely named self-authored system-temp materials. Offline network guard remains installed around synthetic transport overrides.'
}
await fs.writeFile(path.join(evidence, 'process-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ pass: result.pass, evidence, suites: runs.length }))
if (!result.pass) process.exitCode = 1
