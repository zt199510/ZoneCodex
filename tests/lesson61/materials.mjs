import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assertOwnedPath, diskIdentity, hash, root } from './runtime.mjs'

export async function findFixtureGit() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/cmd/git.exe'),
          path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/git.exe')
        ]
      : ['/usr/bin/git', '/usr/local/bin/git']
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      /* Try the next fixed installation location. */
    }
  }
  throw Error('Fixture preparation requires an already installed Git at a fixed trusted path')
}

export async function createGitMaterials(evidence, { extended = true } = {}) {
  const directory = assertOwnedPath(evidence, path.join(evidence, 'fixtures'))
  await fs.mkdir(directory, { recursive: true })
  const git = await findFixtureGit()
  const emptyConfig = path.join(directory, 'empty-global-config')
  await fs.writeFile(emptyConfig, '')
  const environment = { ...process.env }
  for (const key of Object.keys(environment))
    if (/^GIT_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^MODEL_/i.test(key)) delete environment[key]
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1'
  })
  const commands = []
  async function run(cwd, args, { allowedFailure = false, env = {} } = {}) {
    assertOwnedPath(evidence, cwd)
    const started = Date.now()
    const child = spawn(
      git,
      [
        '--no-optional-locks',
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        '-c',
        'user.name=Lesson61 Isolated Fixture',
        '-c',
        'user.email=lesson61@example.invalid',
        ...args
      ],
      {
        cwd,
        env: { ...environment, ...env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const stdout = [],
      stderr = []
    let timeout = false
    child.stdout.on('data', (bytes) => stdout.push(bytes))
    child.stderr.on('data', (bytes) => stderr.push(bytes))
    const timer = setTimeout(() => {
      timeout = true
      child.kill()
    }, 15000)
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    }).finally(() => clearTimeout(timer))
    const record = {
      cwd,
      args,
      pid: child.pid,
      ...result,
      timeout,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      elapsedMs: Date.now() - started
    }
    commands.push(record)
    await fs.writeFile(
      path.join(evidence, 'preparation-commands.json'),
      JSON.stringify(commands, null, 2)
    )
    assert.equal(timeout, false, 'Fixture command is bounded')
    if (!allowedFailure) assert.equal(result.exitCode, 0, record.stderr)
    return record
  }
  async function repository(name) {
    const result = path.join(directory, name)
    assertOwnedPath(evidence, result)
    await fs.mkdir(result, { recursive: true })
    await run(result, ['init', '--initial-branch=fixture-main'])
    await run(result, ['config', 'core.filemode', 'false'])
    return result
  }
  async function write(repository, name, value) {
    const filename = assertOwnedPath(evidence, path.join(repository, name))
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, value)
  }
  const main = await repository('main')
  const initial = {
    'dual.txt': 'HEAD A\n',
    'deleted.txt': 'deleted HEAD baseline\n',
    'rename-old.txt': 'stable rename body\n',
    'subtree/inside.txt': 'inside HEAD\n',
    'sibling/outside.txt': 'outside HEAD\n',
    'cross-old.txt': 'cross boundary rename\n',
    '中文 空格.txt': '中文 HEAD\n',
    '-leading.txt': 'leading HEAD\n',
    '[literal].txt': 'literal HEAD\n',
    "single'quote.txt": 'quote HEAD\n',
    'binary.bin': Buffer.from([0, 1, 2, 10, 255])
  }
  for (const [name, value] of Object.entries(initial)) await write(main, name, value)
  await run(main, ['add', '--', '.'])
  await run(main, ['commit', '-m', 'Isolated lesson61 HEAD baseline'])
  await write(main, 'dual.txt', 'INDEX B\n')
  await write(main, 'staged-new.txt', 'staged addition\n')
  await run(main, ['add', '--', 'dual.txt', 'staged-new.txt'])
  await run(main, ['mv', '--', 'rename-old.txt', 'rename new 中文.txt'])
  await run(main, ['mv', '--', 'cross-old.txt', 'subtree/cross-new.txt'])
  await write(main, 'dual.txt', 'WORKTREE C\n')
  await fs.unlink(assertOwnedPath(evidence, path.join(main, 'deleted.txt')))
  await write(main, 'untracked.txt', 'untracked has no Git baseline\n')
  await write(main, 'subtree/inside.txt', 'inside WORKTREE\n')
  await write(main, 'sibling/outside.txt', 'outside WORKTREE must not preview in subtree\n')
  for (const name of ['中文 空格.txt', '-leading.txt', '[literal].txt', "single'quote.txt"])
    await write(main, name, 'WORKTREE special ' + name + '\n')
  await write(main, 'binary.bin', Buffer.from([0, 1, 3, 10, 255]))
  const empty = await repository('empty-head')
  await write(empty, 'empty-staged.txt', 'staged before first commit\n')
  await run(empty, ['add', '--', 'empty-staged.txt'])
  await write(empty, 'empty-untracked.txt', 'untracked before first commit\n')
  const linked = path.join(directory, 'linked-worktree')
  await run(main, ['worktree', 'add', '-b', 'fixture-linked', linked, 'HEAD'])
  await write(linked, 'dual.txt', 'linked WORKTREE\n')
  const notRepository = path.join(directory, 'not-repository')
  await fs.mkdir(notRepository)
  await write(notRepository, 'ordinary.txt', 'ordinary folder\n')
  const result = {
    directory,
    git,
    gitSHA256: hash(await fs.readFile(git)),
    gitVersion: (await run(main, ['--version'])).stdout.trim(),
    main,
    empty,
    linked,
    subtree: path.join(main, 'subtree'),
    notRepository,
    expected: {
      dual: {
        stagedBefore: 'HEAD A\n',
        stagedAfter: 'INDEX B\n',
        unstagedBefore: 'INDEX B\n',
        unstagedAfter: 'WORKTREE C\n'
      },
      deleted: 'deleted HEAD baseline\n',
      rename: 'stable rename body\n',
      untracked: 'untracked has no Git baseline\n'
    },
    commands,
    unsupportedNames: [],
    sentinels: []
  }
  for (const name of ['newline\nname.txt', 'double"quote.txt']) {
    try {
      await write(notRepository, name, 'platform filename probe\n')
      result.unsupportedNames.push({ name, created: true })
    } catch (error) {
      result.unsupportedNames.push({
        name,
        created: false,
        code: error.code,
        reason:
          'Windows/platform filesystem rejected this real filename; parser coverage is separate.'
      })
    }
  }
  if (extended) {
    const large = await repository('over-limit')
    await write(large, 'large.txt', 'x'.repeat(256 * 1024 + 1))
    await write(large, 'too-many-lines.txt', Array.from({ length: 4001 }, () => 'line').join('\n'))
    result.large = large
    const caseAndIgnore = await repository('case-and-ignore')
    await run(caseAndIgnore, ['config', 'core.ignorecase', 'true'])
    await write(caseAndIgnore, 'Folder/Proof.txt', 'case HEAD\n')
    await write(caseAndIgnore, '.gitignore', 'ignored-folder/\nignored*.txt\n')
    await run(caseAndIgnore, ['add', '--', '.'])
    await run(caseAndIgnore, ['commit', '-m', 'Isolated case and ignored subtree baseline'])
    await fs.rename(
      path.join(caseAndIgnore, 'Folder/Proof.txt'),
      path.join(caseAndIgnore, 'Folder/proof.txt')
    )
    await fs.rename(path.join(caseAndIgnore, 'Folder'), path.join(caseAndIgnore, 'folder'))
    await write(caseAndIgnore, 'folder/proof.txt', 'case WORKTREE\n')
    await write(caseAndIgnore, 'ignored-folder/oversized.txt', 'x'.repeat(8 * 1024 * 1024 + 1))
    await write(caseAndIgnore, 'ignored-one.txt', 'outside ignored data\n')
    result.caseAndIgnore = caseAndIgnore
    const unsupportedDiffAttribute = await repository('unsupported-diff-attribute')
    await write(unsupportedDiffAttribute, '.gitattributes', 'proof.txt diff=false\n')
    await write(unsupportedDiffAttribute, 'proof.txt', 'unsupported driver attribute\n')
    result.unsupportedDiffAttribute = unsupportedDiffAttribute
    const trackedLimit = await repository('tracked-limit')
    await write(trackedLimit, 'tracked.txt', 'tracked baseline\n')
    await run(trackedLimit, ['add', '--', '.'])
    await run(trackedLimit, ['commit', '-m', 'Isolated tracked file limit baseline'])
    await write(trackedLimit, 'tracked.txt', 'x'.repeat(8 * 1024 * 1024 + 1))
    result.trackedLimit = trackedLimit
    const objectLimit = await repository('object-limit')
    await write(objectLimit, 'proof.txt', 'object limit baseline\n')
    await run(objectLimit, ['add', '--', '.'])
    await run(objectLimit, ['commit', '-m', 'Isolated object limit baseline'])
    const oversizedPack = path.join(
      objectLimit,
      '.git/objects/pack/pack-' + 'a'.repeat(40) + '.pack'
    )
    const packHandle = await fs.open(oversizedPack, 'w')
    try {
      await packHandle.truncate(128 * 1024 * 1024 + 1)
    } finally {
      await packHandle.close()
    }
    result.objectLimit = objectLimit
    for (const kind of [
      'alternates',
      'partial-clone',
      'split-index',
      'sparse-index',
      'conflict',
      'drivers'
    ]) {
      const repo = await repository(kind)
      await write(repo, 'proof.txt', 'proof HEAD\n')
      await write(repo, 'excluded/data.txt', 'excluded HEAD\n')
      await run(repo, ['add', '--', '.'])
      await run(repo, ['commit', '-m', 'Isolated refusal baseline'])
      result[kind] = repo
      if (kind === 'alternates')
        await write(
          repo,
          '.git/objects/info/alternates',
          path.join(main, '.git/objects').replaceAll('\\', '/') + '\n'
        )
      else if (kind === 'partial-clone') {
        await run(repo, ['config', 'extensions.partialClone', 'fixture-origin'])
        await run(repo, ['config', 'remote.fixture-origin.promisor', 'true'])
      } else if (kind === 'split-index') await run(repo, ['update-index', '--split-index'])
      else if (kind === 'sparse-index') {
        await run(repo, ['sparse-checkout', 'init', '--cone', '--sparse-index'])
        await run(repo, ['sparse-checkout', 'set', 'included'])
      } else if (kind === 'conflict') {
        await run(repo, ['checkout', '-b', 'fixture-side'])
        await write(repo, 'proof.txt', 'side branch\n')
        await run(repo, ['commit', '-am', 'Isolated conflict side'])
        await run(repo, ['checkout', 'fixture-main'])
        await write(repo, 'proof.txt', 'main branch\n')
        await run(repo, ['commit', '-am', 'Isolated conflict main'])
        const merge = await run(repo, ['merge', 'fixture-side'], { allowedFailure: true })
        assert.equal(merge.exitCode, 1, 'Fixture contains a real merge conflict')
      }
    }
    const sentinelScript = path.join(directory, 'driver-sentinel.cjs')
    await fs.writeFile(
      sentinelScript,
      "const fs=require('node:fs');const [marker,kind]=process.argv.slice(2);fs.appendFileSync(marker,kind+'\\n');" +
        "if(kind==='clean'){process.stdin.pipe(process.stdout)}else if(kind==='fsmonitor'){process.stdout.write('\\0')}" +
        "else if(kind==='textconv'){process.stdout.write(fs.readFileSync(process.argv.at(-1)))}"
    )
    const shellQuote = (value) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'"
    const driver = result.drivers
    const include = path.join(directory, 'effective-driver-include.config')
    const marker = path.join(directory, 'driver-executed.log')
    const command = (kind) =>
      [process.execPath, sentinelScript, marker, kind].map(shellQuote).join(' ')
    await write(driver, '.gitattributes', 'proof.txt filter=lesson61 diff=lesson61\n')
    await fs.writeFile(
      include,
      '[filter "lesson61"]\n\tclean = ' +
        command('clean') +
        '\n\tsmudge = ' +
        command('clean') +
        '\n\trequired = true\n' +
        '[diff "lesson61"]\n\tcommand = ' +
        command('external-diff') +
        '\n\ttextconv = ' +
        command('textconv') +
        '\n' +
        '[core]\n\tfsmonitor = ' +
        command('fsmonitor') +
        '\n\tpager = ' +
        command('pager') +
        '\n'
    )
    await run(driver, ['config', 'include.path', include.replaceAll('\\', '/')])
    await write(driver, 'proof.txt', 'proof WORKTREE with valid drivers\n')
    const controls = []
    for (const [kind, args] of [
      ['clean', ['hash-object', '--path=proof.txt', 'proof.txt']],
      ['fsmonitor', ['status', '--porcelain=v2', '-z']],
      ['external-diff', ['diff', '--no-textconv', '--ext-diff', '--', 'proof.txt']],
      ['textconv', ['diff', '--no-ext-diff', '--textconv', '--', 'proof.txt']]
    ]) {
      await fs.writeFile(marker, '')
      const controlled = await run(driver, args, { allowedFailure: true })
      const executed = await fs.readFile(marker, 'utf8')
      assert(
        executed.includes(kind),
        'Effective fixture configuration must invoke its ' + kind + ' sentinel'
      )
      controls.push({ kind, executed, exitCode: controlled.exitCode, pid: controlled.pid })
    }
    await fs.writeFile(marker, '')
    result.sentinels.push({
      repo: driver,
      marker,
      include,
      script: sentinelScript,
      controls,
      pagerControl: 'Pager configured but effective TTY invocation is not claimed by this fixture.'
    })
    const processRepository = await repository('process-driver')
    await write(processRepository, 'proof.txt', 'process HEAD\n')
    await run(processRepository, ['add', '--', '.'])
    await run(processRepository, ['commit', '-m', 'Isolated process filter baseline'])
    const processMarker = path.join(directory, 'process-driver-executed.log')
    const processScript = path.join(root, 'tests/lesson61/process-filter-fixture.cjs')
    const processCommand = [process.execPath, processScript, processMarker]
      .map(shellQuote)
      .join(' ')
    await run(processRepository, ['config', 'filter.lesson61process.process', processCommand])
    await run(processRepository, ['config', 'filter.lesson61process.required', 'true'])
    await write(processRepository, '.gitattributes', 'proof.txt filter=lesson61process\n')
    await write(processRepository, 'proof.txt', 'process WORKTREE\n')
    await fs.writeFile(processMarker, '')
    const processControl = await run(processRepository, [
      'hash-object',
      '--path=proof.txt',
      'proof.txt'
    ])
    const processExecuted = await fs.readFile(processMarker, 'utf8')
    assert(
      processExecuted.includes('process'),
      'Valid filter protocol must actually dispatch its process program'
    )
    await fs.writeFile(processMarker, '')
    result.sentinels.push({
      repo: processRepository,
      marker: processMarker,
      script: processScript,
      controls: [
        {
          kind: 'process',
          validFilterProtocol: true,
          executed: processExecuted,
          exitCode: processControl.exitCode,
          pid: processControl.pid
        }
      ]
    })
    const passiveDrivers = await repository('passive-drivers')
    await write(passiveDrivers, 'proof.txt', 'safe driver HEAD\n')
    await run(passiveDrivers, ['add', '--', '.'])
    await run(passiveDrivers, ['commit', '-m', 'Isolated passive configured programs'])
    const passiveMarker = path.join(directory, 'passive-drivers-executed.log')
    const passiveCommand = (kind) =>
      [process.execPath, sentinelScript, passiveMarker, kind].map(shellQuote).join(' ')
    await run(passiveDrivers, ['config', 'core.fsmonitor', passiveCommand('fsmonitor')])
    await run(passiveDrivers, ['config', 'diff.external', passiveCommand('external-diff')])
    await run(passiveDrivers, ['config', 'core.pager', passiveCommand('pager')])
    await run(passiveDrivers, ['config', 'credential.helper', passiveCommand('credential')])
    await write(passiveDrivers, 'proof.txt', 'safe driver WORKTREE\n')
    const passiveControls = []
    for (const [kind, args] of [
      ['fsmonitor', ['status', '--porcelain=v2', '-z']],
      ['external-diff', ['diff', '--no-textconv', '--ext-diff', '--', 'proof.txt']]
    ]) {
      await fs.writeFile(passiveMarker, '')
      const control = await run(passiveDrivers, args)
      const executed = await fs.readFile(passiveMarker, 'utf8')
      assert(executed.includes(kind), 'Direct local configuration really invokes ' + kind)
      passiveControls.push({ kind, executed, exitCode: control.exitCode, pid: control.pid })
    }
    await fs.writeFile(passiveMarker, '')
    result.sentinels.push({
      repo: passiveDrivers,
      marker: passiveMarker,
      controls: passiveControls,
      isolatedBuiltinSemanticsSupported: true
    })
    const passiveLinked = path.join(directory, 'passive-driver-linked-worktree')
    await run(passiveDrivers, [
      'worktree',
      'add',
      '-b',
      'fixture-passive-linked',
      passiveLinked,
      'HEAD'
    ])
    await write(passiveLinked, 'proof.txt', 'safe driver WORKTREE\n')
    await fs.writeFile(passiveMarker, '')
    result.sentinels.push({
      repo: passiveLinked,
      marker: passiveMarker,
      controls: passiveControls,
      isolatedBuiltinSemanticsSupported: true,
      actualLinkedCommonConfig: true
    })
    const lazyMarker = path.join(directory, 'lazy-fetch-driver-executed.log')
    const remoteHelper = path.join(directory, 'git-remote-lesson61fixture')
    await fs.writeFile(
      remoteHelper,
      '#!/bin/sh\nexec ' +
        [process.execPath, sentinelScript, lazyMarker, 'lazy-fetch'].map(shellQuote).join(' ') +
        '\n',
      { mode: 0o755 }
    )
    await run(result['partial-clone'], [
      'config',
      'remote.fixture-origin.url',
      'lesson61fixture::controlled-local-helper'
    ])
    await run(result['partial-clone'], [
      'config',
      'remote.fixture-origin.partialclonefilter',
      'blob:none'
    ])
    const missingObject = 'b'.repeat(40)
    await fs.writeFile(lazyMarker, '')
    const lazyControl = await run(result['partial-clone'], ['cat-file', '-p', missingObject], {
      allowedFailure: true,
      env: { GIT_NO_LAZY_FETCH: '0', GIT_EXEC_PATH: directory }
    })
    const lazyExecuted = await fs.readFile(lazyMarker, 'utf8')
    assert(
      lazyExecuted.includes('lazy-fetch'),
      'Promisor missing-object control must actually dispatch the local remote helper'
    )
    await fs.writeFile(lazyMarker, '')
    const noLazyControl = await run(result['partial-clone'], ['cat-file', '-p', missingObject], {
      allowedFailure: true,
      env: { GIT_NO_LAZY_FETCH: '1', GIT_EXEC_PATH: directory }
    })
    assert.equal(await fs.readFile(lazyMarker, 'utf8'), '')
    result.sentinels.push({
      repo: result['partial-clone'],
      marker: lazyMarker,
      controls: [
        {
          kind: 'lazy-fetch',
          executed: lazyExecuted,
          exitCode: lazyControl.exitCode,
          pid: lazyControl.pid,
          actualNetwork: false
        },
        {
          kind: 'no-lazy-fetch',
          executed: '',
          exitCode: noLazyControl.exitCode,
          pid: noLazyControl.pid,
          actualNetwork: false
        }
      ]
    })
  }
  result.before = await diskIdentity(directory)
  await fs.writeFile(
    path.join(evidence, 'materials.json'),
    JSON.stringify({ ...result, commands }, null, 2)
  )
  return result
}
