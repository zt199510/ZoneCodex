import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/lesson59/runtime.mjs'

const groups = {
  offline: [
    ['terminal-ipc', 'terminal-ipc-check.mjs'],
    ['isolation', 'isolation-check.mjs'],
    ['node-pty-cleanup', 'node-pty-cleanup-check.mjs']
  ],
  desktop: [
    ['desktop-development', 'desktop-check.mjs'],
    ['desktop-packaged', 'desktop-check.mjs', '--packaged']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson59 offline: present terminal IPC/preload/shared modules with synthetic Electron/PTY boundaries; owner, bounds, asynchronous cleanup and isolation guards, byte-locked node-pty preparation/cleanup fault timing, ordinary Node, zero network.'
  )
  console.log(
    'lesson59 desktop: actual existing development/Windows directory builds and real local PTY harmless commands; Agent business transport is synthetic and reported separately.'
  )
  console.log('Default npm test remains the lesson58 behavior-lock group.')
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown lesson59 group')
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
    const entry = path.join(root, 'tests/lesson59', filename)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'offline' ? 120000 : 240000
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
    ordinaryNodeOnly: group === 'offline',
    syntheticTransport: true,
    realTransport: false,
    nativePty: group === 'desktop',
    defaultRegressionGroup: 'lesson58',
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
