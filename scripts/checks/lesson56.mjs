import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/lesson56/runtime.mjs'

const groups = {
  offline: [
    ['io', '../lesson55/offline/io.mjs'],
    ['shared', '../lesson55/offline/shared.mjs'],
    ['context-core', 'context-core-check.mjs'],
    ['context-disk', 'context-disk-check.mjs'],
    ['host', 'host-check.mjs'],
    ['adapters', 'adapters.mjs']
  ],
  'real-cli': [
    ['cli-development', 'cli-real-task-check.mjs'],
    ['cli-distributed', 'cli-real-task-check.mjs', '--packaged']
  ],
  'real-desktop': [
    ['desktop-development', 'desktop-real-task-check.mjs'],
    ['desktop-packaged', 'desktop-real-task-check.mjs', '--packaged']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson56 offline: fixed synthetic transport and isolated disk; no business network or Electron. Existing lesson55 groups remain available.'
  )
  console.log(
    'lesson56 real-cli / real-desktop: actual default gpt-6.1-sol summary and business requests; explicit invocation only, existing artifacts required.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert.ok(Object.hasOwn(groups, group), 'Unknown lesson56 group')
  assert.ok(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<name> accepted'
  )
  const selection = args[0]?.slice(8)
  const entries = groups[group].filter(([name]) => !selection || name === selection)
  assert.ok(entries.length, 'Unknown suite')
  const evidence = await createEvidence(group + '-group'),
    runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/lesson56', filename),
      env = { ...process.env }
    if (group === 'offline')
      for (const key of Object.keys(env))
        if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'offline' ? 120000 : 1200000
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
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
