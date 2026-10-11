import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { root, createEvidence } from '../../tests/lesson55/runtime.mjs'

const groups = {
  offline: [
    ['io', 'offline/io.mjs'],
    ['shared', 'offline/shared.mjs']
  ],
  native: [
    ['output-bridge', 'native/output-bridge-check.mjs'],
    ...['out/cli', 'dist/agent'].flatMap((folder) => {
      const variant = folder === 'out/cli' ? 'development' : 'distributed'
      return [
        ['cli-' + variant, 'native/cli-process-check.mjs', '--entry=' + folder + '/index.cjs'],
        ['api-' + variant, 'native/public-api-check.mjs', '--entry=' + folder + '/agent.cjs'],
        [
          'resources-' + variant,
          'native/cli-distribution-protection-check.mjs',
          '--entry=' + folder + '/index.cjs'
        ],
        ...['stdout', 'stderr'].map((stream) => [
          'pressure-' + variant + '-' + stream,
          'native/cli-backpressure-check.mjs',
          '--entry=' + folder + '/index.cjs',
          '--stream=' + stream
        ]),
        [
          'pressure-' + variant + '-command',
          'native/cli-backpressure-check.mjs',
          '--entry=' + folder + '/index.cjs',
          '--stream=stdout',
          '--activity=command'
        ]
      ]
    })
  ],
  'real-cli': [
    ['cli-development', 'real/cli-real-task-check.mjs'],
    ['cli-distributed', 'real/cli-real-task-check.mjs', '--packaged']
  ],
  'real-desktop': [
    ['desktop-development', 'real/desktop-real-task-check.mjs'],
    ['desktop-packaged', 'real/desktop-real-task-check.mjs', '--packaged']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'offline: IO and shared protection checks; fixed synthetic transport, no business network.'
  )
  console.log(
    'native: actual Windows Node/ConPTY/Job/resource processes; synthetic model transport. Build both artifacts first.'
  )
  console.log(
    'real-cli / real-desktop: actual configured gpt-6.1-sol business requests; explicit separate commands.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert.ok(Object.hasOwn(groups, group), 'Unknown verification group; run npm run test:list')
  assert.ok(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<listed name> is accepted'
  )
  const selection = args[0]?.slice(8)
  const entries = groups[group].filter(([name]) => !selection || name === selection)
  assert.ok(entries.length, 'Unknown suite within verification group')
  if (group === 'native')
    assert.equal(process.platform, 'win32', 'Native verification requires Windows')
  const evidence = await createEvidence(group + '-group')
  const runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/lesson55', filename)
    await fs.access(entry)
    const env = { ...process.env }
    if (group === 'offline') {
      for (const key of Object.keys(env))
        if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    }
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const child = spawn(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout += bytes
      process.stdout.write(bytes)
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes
      process.stderr.write(bytes)
    })
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    await fs.writeFile(path.join(evidence, name + '.stdout.log'), stdout)
    await fs.writeFile(path.join(evidence, name + '.stderr.log'), stderr)
    runs.push({ name, entry, parameters, pid: child.pid, ...outcome })
  }
  const result = {
    pass: runs.every((run) => run.exitCode === 0 && run.signal === null),
    group,
    selection: selection ?? null,
    evidence,
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ pass: result.pass, group, evidence, suites: runs.length }))
  if (!result.pass) process.exitCode = 1
}
