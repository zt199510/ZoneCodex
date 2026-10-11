import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/lesson58/runtime.mjs'

// The preceding lessons remain the behavior lock. Their fixtures and assertions
// are executed from present source, rather than replaced or read as old results.
const groups = {
  offline: [
    ['io', '../lesson55/offline/io.mjs'],
    ['shared', '../lesson55/offline/shared.mjs'],
    ['context-core', '../lesson56/context-core-check.mjs'],
    ['context-disk', '../lesson56/context-disk-check.mjs'],
    ['host', '../lesson56/host-check.mjs'],
    ['adapters', '../lesson56/adapters.mjs'],
    ['checkpoint', '../lesson57/checkpoint-check.mjs'],
    ['core', '../lesson57/core-check.mjs'],
    ['cli-terminal', '../lesson57/cli-terminal-check.mjs'],
    ['boundary', 'boundary-check.mjs'],
    ['resume-safety', 'resume-safety-check.mjs']
  ],
  'resume-cli': [
    ['cli-development', '../lesson57/cli-resume-check.mjs'],
    ['cli-distributed', '../lesson57/cli-resume-check.mjs', '--packaged']
  ],
  'resume-desktop': [
    ['desktop-development', '../lesson57/desktop-resume-check.mjs'],
    ['desktop-packaged', '../lesson57/desktop-resume-check.mjs', '--packaged']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson58 offline: frozen lesson55/56/57 behavior locks, current-source host boundaries and hard-exit resume safety; real isolated disk/ordinary Node processes, synthetic transport, zero network or Electron.'
  )
  console.log(
    'lesson58 resume-cli / resume-desktop: actual existing development/distributed builds and new-process explicit continuation using unchanged lesson57 fixed business fixtures; synthetic transport, separately reported from real model tests.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown lesson58 group')
  assert(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<name> accepted'
  )
  const selection = args[0]?.slice(8)
  const entries = groups[group].filter(([name]) => !selection || name === selection)
  assert(entries.length, 'Unknown suite')
  const evidence = await createEvidence(group + '-group')
  const runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/lesson58', filename)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'offline' ? 120000 : 180000
    )
    await fs.writeFile(path.join(evidence, name + '.stdout.log'), result.stdout)
    await fs.writeFile(path.join(evidence, name + '.stderr.log'), result.stderr)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    runs.push({
      name,
      entry,
      parameters,
      pid: result.pid,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      elapsedMs: result.elapsedMs,
      forcedKill: result.forcedKill
    })
  }
  const report = {
    pass: runs.every((run) => run.exitCode === 0 && run.signal === null && !run.forcedKill),
    group,
    selection: selection ?? null,
    evidence,
    behaviorLockLessons: [55, 56, 57],
    syntheticTransport: true,
    realTransport: false,
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
