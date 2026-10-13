import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import {
  root,
  hash,
  createEvidence,
  checksFor,
  diskIdentity,
  delay,
  verifyProcessRetirement
} from './runtime.mjs'
import { createGitMaterials } from './materials.mjs'

const evidence = await createEvidence('git-readonly')
const harness = checksFor(evidence, {
  actualGit: true,
  actualDisk: true,
  actualElectron: false,
  actualPTY: false,
  realModelTransport: false,
  syntheticGitProcess: false,
  actualControlledNodeProcess: true,
  fixtureGitWrites: 'Only new UUID evidence/fixtures preparation; product APIs remain read-only.'
})
const output = path.join(evidence, 'current-reader.cjs')
const bundle = await build({
  entryPoints: [path.join(root, 'src/main/git/git-reader.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  metafile: true,
  logLevel: 'silent'
})
const runnerOutput = path.join(evidence, 'current-process.cjs')
await build({
  entryPoints: [path.join(root, 'src/main/git/git-process.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: runnerOutput,
  logLevel: 'silent'
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(bundle.metafile.inputs).map(async (name) => [
      name,
      hash(await fs.readFile(path.join(root, name)))
    ])
  )
)
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(sourceHashes, null, 2)
)
const require = createRequire(import.meta.url)
const { createGitReader } = require(output)
const { runGitProcess } = require(runnerOutput)
const materials = await createGitMaterials(evidence)
const processEvents = []
let raceConfig = null
const observe = (event) => {
  processEvents.push({ ...event, atUTC: new Date().toISOString() })
  if (raceConfig && event.event === 'spawn' && event.args.includes('status')) raceConfig(event)
}
const reader = createGitReader({
  cacheRoot: path.join(evidence, 'reader-cache'),
  onProcess: observe
})
const views = []
const open = async (directory) => {
  const view = await reader.open(directory)
  views.push(view)
  return view
}
const find = (list, group, filename) => {
  const item = list.items.find((item) => item.group === group && item.path === filename)
  assert(item, 'Actual status contains ' + group + ':' + filename)
  return item
}
const detail = async (view, list, group, filename) =>
  reader.read(view, list.revision, find(list, group, filename).itemId)
const errors = async (action, allowed) => {
  try {
    await action()
    assert.fail('Expected bounded refusal')
  } catch (error) {
    assert(
      allowed.includes(error.status),
      'Expected ' + allowed.join('/') + ', got ' + error.status + ': ' + error.message
    )
    return { status: error.status, error: error.message }
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
let mainView, mainList, adversarialView
const adversarialDirectory = path.join(evidence, 'adversarial-fixtures')
try {
  await harness.check('real Git installed program identity and versions are recorded', async () => {
    assert.match(materials.gitVersion, /^git version 2\.56\./)
    return {
      executable: materials.git,
      version: materials.gitVersion,
      sha256: materials.gitSHA256,
      preparationCommands: materials.commands.length
    }
  })
  await harness.check(
    'real porcelain status keeps two independent same-path states and all three groups',
    async () => {
      mainView = await open(materials.main)
      mainList = await reader.refresh(mainView)
      const staged = find(mainList, 'staged', 'dual.txt'),
        unstaged = find(mainList, 'unstaged', 'dual.txt')
      assert.notEqual(staged.itemId, unstaged.itemId)
      find(mainList, 'untracked', 'untracked.txt')
      find(mainList, 'staged', 'staged-new.txt')
      assert.equal(mainView.info.repositoryPath, materials.main)
      return { scope: mainView.info, items: mainList.items }
    }
  )
  await harness.check(
    'actual staged HEAD A to INDEX B and unstaged INDEX B to WORKTREE C are exact independent baselines',
    async () => {
      const staged = await detail(mainView, mainList, 'staged', 'dual.txt')
      const unstaged = await detail(mainView, mainList, 'unstaged', 'dual.txt')
      assert.equal(staged.baseline, 'head-index')
      assert.equal(unstaged.baseline, 'index-worktree')
      assert(staged.text.includes('-HEAD A\n') && staged.text.includes('+INDEX B\n'))
      assert(!staged.text.includes('WORKTREE C'))
      assert(unstaged.text.includes('-INDEX B\n') && unstaged.text.includes('+WORKTREE C\n'))
      assert(!unstaged.text.includes('HEAD A'))
      return { staged, unstaged }
    }
  )
  await harness.check(
    'real deletion previews old baseline despite missing leaf; real rename consumes both paths',
    async () => {
      const deleted = await detail(mainView, mainList, 'unstaged', 'deleted.txt')
      assert(deleted.text.includes('-deleted HEAD baseline\n'))
      const item = find(mainList, 'staged', 'rename new 中文.txt')
      assert.equal(item.change, 'renamed')
      assert.equal(item.previousPath, 'rename-old.txt')
      const renamed = await reader.read(mainView, mainList.revision, item.itemId)
      assert(renamed.text.includes('rename from rename-old.txt'))
      return { deleted, renamed }
    }
  )
  await harness.check(
    'real untracked preview has no Git baseline and returns literal content',
    async () => {
      const value = await detail(mainView, mainList, 'untracked', 'untracked.txt')
      assert.equal(value.baseline, 'untracked')
      assert.equal(value.format, 'content')
      assert.equal(value.text, materials.expected.untracked)
      return value
    }
  )
  await harness.check(
    'actual Chinese/space/leading-dash/pathspec-magic/quote filenames use literal identity',
    async () => {
      const checked = []
      for (const name of ['中文 空格.txt', '-leading.txt', '[literal].txt', "single'quote.txt"]) {
        const value = await detail(mainView, mainList, 'unstaged', name)
        assert(value.text.includes('WORKTREE special ' + name))
        checked.push({ path: value.item.path, bytes: value.bytes })
      }
      return { checked, platformRejectedRealNames: materials.unsupportedNames }
    }
  )
  await harness.check('binary and actual oversized byte/line previews clearly refuse', async () => {
    const binary = await errors(
      () => detail(mainView, mainList, 'unstaged', 'binary.bin'),
      ['unsupported']
    )
    const large = await open(materials.large),
      list = await reader.refresh(large)
    const bytes = await errors(() => detail(large, list, 'untracked', 'large.txt'), ['too-large'])
    const lines = await errors(
      () => detail(large, list, 'untracked', 'too-many-lines.txt'),
      ['too-large']
    )
    return { binary, bytes, lines }
  })
  await harness.check(
    'selected subtree excludes siblings and clips cross-boundary rename to the in-scope side',
    async () => {
      const view = await open(materials.subtree),
        list = await reader.refresh(view)
      assert.equal(view.info.scopePath, 'subtree')
      assert(list.items.every((item) => item.path.startsWith('subtree/')))
      assert(!JSON.stringify(list.items).includes('sibling/outside'))
      const inside = await detail(view, list, 'unstaged', 'subtree/inside.txt')
      assert(inside.text.includes('inside WORKTREE'))
      const cross = find(list, 'staged', 'subtree/cross-new.txt')
      let clippedDetail
      if (cross.change === 'renamed') assert.equal(cross.previewable, false)
      else {
        assert.equal(cross.change, 'added')
        assert.equal(cross.previousPath, null)
        clippedDetail = await reader.read(view, list.revision, cross.itemId)
        assert(!clippedDetail.text.includes('rename from cross-old.txt'))
      }
      const scopeCache = await diskIdentity(view.snapshot.worktree)
      assert(!Object.keys(scopeCache).some((name) => name.startsWith('sibling/')))
      assert(!JSON.stringify(scopeCache).includes('outside WORKTREE'))
      return {
        scope: view.info,
        items: list.items,
        inside,
        cross,
        clippedDetail,
        semantics:
          'Native scope-limited status represents a boundary rename as an in-scope addition; no outside-side diff is requested.',
        scopeCachePaths: Object.keys(scopeCache)
      }
    }
  )
  await harness.check('actual empty HEAD uses empty-index for staged addition', async () => {
    const view = await open(materials.empty),
      list = await reader.refresh(view)
    assert.equal(view.info.head, 'unborn')
    const value = await detail(view, list, 'staged', 'empty-staged.txt')
    assert.equal(value.baseline, 'empty-index')
    assert(value.text.includes('+staged before first commit'))
    return { scope: view.info, value }
  })
  await harness.check(
    'actual linked worktree resolves pointer/gitdir/common-dir independently',
    async () => {
      const view = await open(materials.linked),
        list = await reader.refresh(view)
      assert.equal(view.info.linkedWorktree, true)
      const value = await detail(view, list, 'unstaged', 'dual.txt')
      assert(value.text.includes('-HEAD A') && value.text.includes('+linked WORKTREE'))
      return { scope: view.info, value }
    }
  )
  await harness.check(
    'actual nonrepository, alternates, partial clone and structural split/sparse index refuse',
    async () => {
      const refusals = {}
      for (const [name, statuses] of [
        ['notRepository', ['not-repository']],
        ['alternates', ['unsupported']],
        ['partial-clone', ['unsupported']],
        ['split-index', ['unsupported']],
        ['sparse-index', ['unsupported']]
      ])
        refusals[name] = await errors(
          () => open(name === 'notRepository' ? path.parse(materials.main).root : materials[name]),
          statuses
        )
      return refusals
    }
  )
  await harness.check('actual merge conflict is listed as an unsupported preview', async () => {
    const view = await open(materials.conflict),
      list = await reader.refresh(view)
    const conflict = list.items.find(
      (item) => item.path === 'proof.txt' && item.change === 'unmerged'
    )
    assert(conflict && !conflict.previewable)
    return { items: list.items }
  })
  await harness.check(
    'real ignorecase file/directory aliases preserve tracked content in root and subtree while ignored folders are pruned',
    async () => {
      const results = []
      for (const directory of [
        materials.caseAndIgnore,
        path.join(materials.caseAndIgnore, 'folder')
      ]) {
        const view = await open(directory),
          list = await reader.refresh(view)
        assert(!list.items.some((item) => item.path.startsWith('ignored')))
        const item = list.items.find(
          (item) => item.group === 'unstaged' && item.path.toLowerCase() === 'folder/proof.txt'
        )
        assert(item, 'Real case alias still has an unstaged tracked change')
        const value = await reader.read(view, list.revision, item.itemId)
        assert(value.text.includes('-case HEAD') && value.text.includes('+case WORKTREE'))
        const paths = Object.keys(await diskIdentity(view.snapshot.worktree))
        assert(
          !paths.some((name) => name.includes('oversized.txt') || name.includes('ignored-one.txt'))
        )
        results.push({ scope: view.info, item, value, snapshotPaths: paths })
      }
      return { results }
    }
  )
  await harness.check(
    'real custom diff=false attribute and tracked/object snapshot size ceilings refuse before unsafe queries',
    async () => {
      return {
        diffAttribute: await errors(
          () => open(materials.unsupportedDiffAttribute),
          ['unsupported']
        ),
        trackedFile: await errors(() => open(materials.trackedLimit), ['too-large']),
        objectFile: await errors(() => open(materials.objectLimit), ['too-large'])
      }
    }
  )
  await harness.check(
    'effective included clean/process/fsmonitor/external-diff/textconv programs never execute during product reading',
    async () => {
      const refusals = []
      for (const sentinel of materials.sentinels) {
        if (sentinel.isolatedBuiltinSemanticsSupported) {
          const view = await open(sentinel.repo),
            list = await reader.refresh(view)
          const value = await detail(view, list, 'unstaged', 'proof.txt')
          assert(
            value.text.includes('-safe driver HEAD') && value.text.includes('+safe driver WORKTREE')
          )
          refusals.push({ supportedIsolatedConfig: true, value })
        } else refusals.push(await errors(() => open(sentinel.repo), ['unsupported']))
        assert.equal(await fs.readFile(sentinel.marker, 'utf8'), '')
      }
      return {
        refusals,
        controls: materials.sentinels.map((sentinel) => sentinel.controls),
        pager: 'Configured; effective TTY execution is outside this control evidence.'
      }
    }
  )
  await harness.check(
    'effective global/include data is refused without touching user home configuration',
    async () => {
      const home = path.join(evidence, 'synthetic-home')
      await fs.mkdir(home)
      await fs.writeFile(
        path.join(home, '.gitconfig'),
        '[include]\n\tpath = ' + materials.sentinels[0].include.replaceAll('\\', '/') + '\n'
      )
      const original = os.homedir
      os.homedir = () => home
      try {
        const scopedReader = createGitReader({
          cacheRoot: path.join(evidence, 'global-reader-cache'),
          onProcess: observe
        })
        return {
          ...(await errors(() => scopedReader.open(materials.main), ['unsupported'])),
          syntheticHomeDiscovery: true,
          actualConfigData: true,
          userHomeWritten: false
        }
      } finally {
        os.homedir = original
      }
    }
  )
  await harness.check(
    'config changed after capture and restored cannot execute original driver during isolated status',
    async () => {
      await fs.cp(materials.main, adversarialDirectory, { recursive: true })
      adversarialView = await open(adversarialDirectory)
      const config = path.join(adversarialDirectory, '.git/config')
      const original = await fs.readFile(config),
        originalStat = await fs.stat(config)
      let changed = false
      raceConfig = (event) => {
        if (changed) return
        changed = true
        assert.notEqual(path.resolve(event.cwd), path.resolve(materials.main))
        // Deliberate adversarial fixture mutation, not a product write. Restore bytes/timestamps before observing the result.
        require('node:fs').appendFileSync(
          config,
          '\n[include]\n\tpath = ' + materials.sentinels[0].include.replaceAll('\\', '/') + '\n'
        )
        require('node:fs').writeFileSync(config, original)
        require('node:fs').utimesSync(config, originalStat.atime, originalStat.mtime)
      }
      try {
        let result
        try {
          result = await reader.refresh(adversarialView)
        } catch (error) {
          assert.equal(error.status, 'stale')
          result = { status: error.status }
        }
        assert(changed)
        assert.equal(await fs.readFile(materials.sentinels[0].marker, 'utf8'), '')
        return {
          result: result.status ?? 'ready',
          sourceChangedAndRestored: true,
          markerExecutions: 0,
          nonAtomicReadAndHostileOSRaceNotPromised: true
        }
      } finally {
        raceConfig = null
        await fs.writeFile(config, original)
        await fs.utimes(config, originalStat.atime, originalStat.mtime)
      }
    }
  )
  await harness.check(
    'old list revision and source mutation refuse stale detail instead of presenting cached facts',
    async () => {
      const originalList = await reader.refresh(adversarialView)
      const list = await reader.refresh(adversarialView)
      await errors(
        () =>
          reader.read(
            adversarialView,
            originalList.revision,
            find(originalList, 'staged', 'dual.txt').itemId
          ),
        ['stale']
      )
      const filename = path.join(adversarialDirectory, 'dual.txt'),
        bytes = await fs.readFile(filename),
        stat = await fs.stat(filename)
      await fs.writeFile(filename, 'fixture concurrent mutation\n')
      try {
        return await errors(() => detail(adversarialView, list, 'unstaged', 'dual.txt'), ['stale'])
      } finally {
        await fs.writeFile(filename, bytes)
        await fs.utimes(filename, stat.atime, stat.mtime)
      }
    }
  )
  await harness.check(
    'actual controlled blocking child cancellation waits for close and process retirement',
    async () => {
      const events = [],
        controller = new AbortController()
      const work = runGitProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: evidence,
        env: { ...process.env, NODE_OPTIONS: '' },
        signal: controller.signal,
        onProcess: (event) => {
          events.push(event)
          if (event.event === 'spawn') controller.abort()
        }
      })
      const refusal = await errors(() => work, ['cancelled'])
      const start = events.find((event) => event.event === 'spawn'),
        close = events.find((event) => event.event === 'close')
      assert(start?.pid && close?.pid === start.pid)
      assert(!events.some((event) => event.event === 'unconfirmed'))
      await delay(50)
      assert.equal(alive(start.pid), false)
      return { nativeGit: false, actualControlledNodeProcess: true, refusal, events }
    }
  )
  await harness.check(
    'actual controlled child timeout/output overflow/stderr overflow have observed close',
    async () => {
      const results = []
      for (const [name, script, limits, status] of [
        ['timeout', 'setInterval(()=>{},1000)', { timeoutMs: 100 }, 'error'],
        [
          'stdout',
          "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)",
          { stdoutBytes: 1024 },
          'too-large'
        ],
        [
          'stderr',
          "process.stderr.write('x'.repeat(4096));setInterval(()=>{},1000)",
          { stderrBytes: 1024 },
          'too-large'
        ]
      ]) {
        const events = []
        const refusal = await errors(
          () =>
            runGitProcess({
              executable: process.execPath,
              args: ['-e', script],
              cwd: evidence,
              env: { ...process.env, NODE_OPTIONS: '' },
              ...limits,
              onProcess: (event) => events.push(event)
            }),
          [status]
        )
        assert(events.some((event) => event.event === 'close'))
        assert(!events.some((event) => event.event === 'unconfirmed'))
        results.push({ name, refusal, events })
      }
      return { nativeGit: false, actualControlledNodeProcess: true, results }
    }
  )
} finally {
  for (const view of views)
    await reader.dispose(view).catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
await harness.check(
  'all actual reader Git children have close and no owned PID remains alive',
  async () => {
    const spawned = processEvents.filter((event) => event.event === 'spawn')
    assert(spawned.length > 0)
    for (const event of spawned) {
      assert(processEvents.some((close) => close.event === 'close' && close.pid === event.pid))
    }
    assert(!processEvents.some((event) => event.event === 'unconfirmed'))
    const retirementObservations = await verifyProcessRetirement(
      spawned.map((event) => ({
        pid: event.pid,
        executable: event.executable,
        closedAtUTC: processEvents.find(
          (close) => close.event === 'close' && close.pid === event.pid
        )?.atUTC
      }))
    )
    const cache = await fs.readdir(path.join(evidence, 'reader-cache'))
    assert(!cache.some((name) => name.startsWith('query-')))
    return {
      spawned: spawned.length,
      closes: processEvents.filter((event) => event.event === 'close').length,
      cache,
      wholeNativeHandleReclamationProven: false,
      retirementObservations
    }
  }
)
await harness.check(
  'product queries leave every fixture worktree/index/config/ref/object file identity unchanged',
  async () => {
    const after = await diskIdentity(materials.directory)
    await fs.writeFile(
      path.join(evidence, 'after-material-identities.json'),
      JSON.stringify(after, null, 2)
    )
    assert.deepEqual(after, materials.before)
    return {
      filesAndDirectories: Object.keys(after).length,
      compared: ['file bytes/hash/mtime/inode/mode', 'directory inode/mode', 'link target'],
      omittedReadEffects: ['atime'],
      adversarialWritesOutsideComparedReadonlyFixtures: adversarialDirectory
    }
  }
)
await fs.writeFile(
  path.join(evidence, 'process-events.json'),
  JSON.stringify(processEvents, null, 2)
)
await harness.finish({
  gitVersion: materials.gitVersion,
  gitIdentity: materials.gitSHA256,
  sourceHashes,
  notCovered: materials.unsupportedNames.filter((item) => !item.created),
  limitations: [
    'No OS sandbox against external writers.',
    'Effective TTY pager execution is not exercised.',
    'Controlled Node timeout/cancellation tests are real child processes, not real Git queries.'
  ],
  compiledSHA256: hash(await fs.readFile(output))
})
