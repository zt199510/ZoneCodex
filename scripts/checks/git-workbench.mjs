import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/git-workbench/runtime.mjs'

const groups = {
  offline: [
    ['protocol', 'protocol-check.mjs'],
    ['ipc', 'ipc-check.mjs'],
    ['generation', 'generation-check.mjs'],
    ['isolation', 'isolation-check.mjs'],
    ['renderer', 'renderer-check.mjs'],
    ['remote', 'remote-check.mjs'],
    ['pr-protocol', 'pr-protocol-check.mjs'],
    ['turn-host', 'turn-host-check.mjs']
  ],
  native: [
    ['reader', 'reader-check.mjs'],
    ['writer', 'writer-check.mjs'],
    ['unborn-commit', 'unborn-commit-check.mjs'],
    ['worktrees', 'worktrees-check.mjs'],
    ['fetch', 'fetch-check.mjs'],
    ['file-init', 'file-init-check.mjs'],
    ['observers-turns', 'observers-turns-check.mjs'],
    ['pr', 'pr-check.mjs'],
    ['repositories', 'repositories-check.mjs']
  ],
  live: [['generation', 'generation-live-check.mjs']],
  desktop: [
    ['development', 'desktop-check.mjs'],
    ['packaged', 'desktop-check.mjs', '--packaged'],
    ['packaged-ordinary', 'desktop-check.mjs', '--packaged', '--ordinary']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'Git workbench: offline has synthetic model/remote services and current contracts; native uses real Git/disk only in new UUID fixture repositories; desktop debug uses current artifacts with trusted UI clicks, real Git/PTY and synthetic chooser/model replies, ordinary uses an actual chooser without main counters. Only explicit live generation loads model configuration and makes two bounded fixture model requests; no group publishes PRs or pushes externally, and none builds automatically. Default npm test stays lesson58.'
  )
  for (const [name, suites] of Object.entries(groups))
    console.log(name + ': ' + suites.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown group')
  assert(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<name> accepted'
  )
  const selection = args[0]?.slice(8),
    entries = groups[group].filter(([name]) => !selection || name === selection)
  assert(entries.length, 'Unknown suite')
  const evidence = await createEvidence(group + '-group'),
    runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/git-workbench', filename)
    await fs.access(entry)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'desktop' ? 480000 : 240000
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
    realNetworking: group === 'live',
    actualElectron: group === 'desktop',
    actualGit: group !== 'offline',
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
