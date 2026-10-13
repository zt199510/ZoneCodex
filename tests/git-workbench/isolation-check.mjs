import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('isolation')
const entries = [
  'reader',
  'writer',
  'worktrees',
  'remote',
  'fetch',
  'init',
  'file',
  'generation',
  'observers',
  'turns',
  'pr'
].map((name) => 'src/main/git/git-workbench-' + name + '.ts')
const bundle = await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: path.join(evidence, 'compiled'),
  metafile: true,
  logLevel: 'silent'
})
const inputNames = Object.keys(bundle.metafile.inputs)
const sourceHashes = Object.fromEntries(
  await Promise.all(
    inputNames.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
const suite = checksFor(evidence, {
  sourceHashes,
  currentDependencyGraph: true,
  syntheticCompileOnly: true,
  realNetworking: false,
  actualGit: false,
  actualElectron: false
})
await suite.check(
  'all manual Git modules have no Agent core, grants, checkpoint, conversation or PTY dependencies',
  () => {
    for (const name of inputNames)
      assert(
        !/\/(?:agent|context|conversation|terminal|command|approval|permission|workspace|title|summary)(?:\/|-)/i.test(
          name
        ),
        name
      )
    assert(inputNames.includes('src/main/model/response-client.ts'))
    for (const name of inputNames)
      assert(
        /^src\/(?:main\/(?:git|model)\/|shared\/)/.test(name) || name === 'src/main/errors.ts',
        name
      )
  }
)
await suite.check('only explicitly invoked generation imports model transport', async () => {
  for (const entry of entries.filter((name) => !name.endsWith('generation.ts'))) {
    const text = await fs.readFile(path.join(root, entry), 'utf8')
    assert(
      !/from ['"][^'"]*response-client|createLiveResponse\(|runAgentCore\(|writeCheckpoint\(|appendRaw\(/.test(
        text
      ),
      entry
    )
  }
  const generator = await fs.readFile(
    path.join(root, 'src/main/git/git-workbench-generation.ts'),
    'utf8'
  )
  assert.match(generator, /createLiveResponse\(\[\], instructions\)/)
  assert.match(generator, /export async function generateGitText/)
})
await suite.check(
  'new preload API accepts no generic command, raw diff, file path, environment or grants',
  async () => {
    const text = await fs.readFile(path.join(root, 'src/preload/git-workbench-api.ts'), 'utf8')
    for (const forbidden of [
      'runAgentCore',
      'startTerminal',
      'checkpoint',
      'workspaceGrant',
      'executeCommand',
      'ptyOutput'
    ])
      assert(!text.includes(forbidden), forbidden)
    const channels = [...text.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(
      channels.sort(),
      [
        'git:init',
        'git:metadata',
        'git:review',
        'git:diff',
        'git:action',
        'git:generate',
        'git:full-file'
      ].sort()
    )
  }
)
await suite.check(
  'Git UI uses independent preferences and never imports Agent or terminal hosts',
  async () => {
    for (const name of [
      'useGitWorkbench.ts',
      'GitWorkbenchPanel.tsx',
      'git-workbench-preferences.ts'
    ]) {
      const text = await fs.readFile(path.join(root, 'src/renderer/src/features/git', name), 'utf8')
      assert(!/from ['"][^'"]*(?:agent|terminal|conversation|checkpoint|context)/i.test(text), name)
    }
    const preferences = await fs.readFile(
      path.join(root, 'src/renderer/src/features/git/git-workbench-preferences.ts'),
      'utf8'
    )
    assert.match(preferences, /zonecodex\.git-ui\.v1/)
  }
)
await suite.finish()
