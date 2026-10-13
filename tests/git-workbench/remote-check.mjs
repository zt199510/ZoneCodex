import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createEvidence, compile, checksFor, root, hash, assertOwnedPath } from './runtime.mjs'

const evidence = await createEvidence('remote')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-workbench-remote.ts',
  'src/main/git/git-snapshot.ts',
  'src/main/git/git-process.ts',
  'src/shared/git-workbench.ts'
])
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256,
  actualCurrentRemoteLogic: true,
  actualSourceCaptureAndRepositoryLock: true,
  actualDisk: true,
  syntheticGitRunner: true,
  syntheticGhRunner: true,
  realNetworking: false,
  actualGhProcess: false,
  actualGitProcess: false,
  actualElectron: false,
  actualPTY: false,
  realModelTransport: false,
  note: 'Fake gh.exe contains identity fixture data only and is never executed. The process seam substitutes only the remote module gh runner.'
})
const dispatcherKey = '__zonecodexRemoteTest_' + randomUUID().replaceAll('-', '')
const seamFile = assertOwnedPath(evidence, path.join(evidence, 'synthetic-gh-process.ts'))
await fs.writeFile(
  seamFile,
  'export { GitReadError } from ' +
    JSON.stringify(path.join(root, 'src/main/git/git-process.ts')) +
    ';\n' +
    'export async function runGitProcess(options: unknown) { return await globalThis[' +
    JSON.stringify(dispatcherKey) +
    '](options); }\n'
)
const seamOutput = assertOwnedPath(evidence, path.join(evidence, 'current-synthetic-gh.cjs'))
const seam = await build({
  stdin: {
    contents:
      'export * from "./src/main/git/git-workbench-remote.ts"; export * from "./src/main/git/git-snapshot.ts"; export * from "./src/main/git/git-process.ts";',
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: seamOutput,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'explicit-test-only-gh-process-seam',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/git-process$/ }, ({ importer }) =>
          importer.replaceAll('\\', '/').endsWith('/git-workbench-remote.ts')
            ? { path: seamFile }
            : null
        )
      }
    }
  ]
})
const seamHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(seam.metafile.inputs)
      .filter((filename) => filename !== '<stdin>')
      .map(async (filename) => [filename, hash(await fs.readFile(path.resolve(root, filename)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'synthetic-gh-source-identity.json'),
  JSON.stringify(seamHashes, null, 2)
)
const synthetic = createRequire(import.meta.url)(seamOutput)
const installation = assertOwnedPath(evidence, path.join(evidence, 'synthetic-installation'))
const ghPath = assertOwnedPath(evidence, path.join(installation, 'GitHub CLI', 'gh.exe'))
await fs.mkdir(path.dirname(ghPath), { recursive: true })
const ghIdentity = 'Identity fixture data, not an executable; synthetic runner only.\n'
await fs.writeFile(ghPath, ghIdentity)
const absentInstallation = assertOwnedPath(evidence, path.join(evidence, 'no-installed-gh'))
await fs.mkdir(absentInstallation, { recursive: true })
const emptyGlobal = assertOwnedPath(evidence, path.join(evidence, 'empty-global.config'))
await fs.writeFile(emptyGlobal, '')
const authToken = 'synthetic-auth-token-' + randomUUID()
const environmentToken = 'synthetic-environment-token-' + randomUUID()
const secondEnvironmentToken = 'synthetic-github-token-' + randomUUID()
const modelSecret = 'synthetic-model-key-' + randomUUID()
const oid = 'a'.repeat(40),
  expected = 'b'.repeat(40)
const github = 'https://github.com/fixture-owner/fixture-repo.git'
const syntheticCalls = []
let ghMode = 'ready',
  onAuth = null
globalThis[dispatcherKey] = async (options) => {
  const safe = {
    args: [...options.args],
    executable: options.executable,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    environmentKeys: Object.keys(options.env).sort(),
    promptDisabled: options.env.GH_PROMPT_DISABLED,
    gitPromptDisabled: options.env.GIT_TERMINAL_PROMPT,
    path: options.env.PATH
  }
  syntheticCalls.push(safe)
  assert.equal(options.executable, ghPath)
  assert(
    !Object.keys(options.env).some((key) =>
      ['NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR'].includes(key)
    )
  )
  if (options.args[0] === 'auth') {
    if (onAuth) await onAuth()
    if (ghMode === 'no-auth') return Buffer.alloc(0)
    return Buffer.from(authToken + '\n')
  }
  if (ghMode === 'error')
    throw new synthetic.GitReadError(
      'error',
      'PR failure ' + authToken + ' ' + environmentToken + ' ' + secondEnvironmentToken
    )
  if (ghMode === 'unconfirmed')
    throw new synthetic.GitReadError(
      'error',
      '退出未确认 ' + environmentToken + ' ' + secondEnvironmentToken
    )
  if (ghMode === 'bad-url') return Buffer.from('Created, unable to determine URL')
  return Buffer.from('https://github.com/fixture-owner/fixture-repo/pull/42\n')
}
async function environment(overrides, action) {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
const absentEnv = {
  ProgramFiles: absentInstallation,
  ProgramW6432: absentInstallation,
  GH_TOKEN: environmentToken,
  GITHUB_TOKEN: secondEnvironmentToken
}
const installedEnv = {
  ...absentEnv,
  ProgramFiles: installation,
  ProgramW6432: installation,
  NODE_OPTIONS: 'synthetic-untrusted-options',
  GIT_SSH_COMMAND: 'synthetic-untrusted-command',
  GH_CONFIG_DIR: 'synthetic-untrusted-config'
}
const request = (action, fields = {}) => ({
  requestId: randomUUID(),
  viewId: randomUUID(),
  revision: randomUUID(),
  action,
  ...fields
})
async function context(
  module = api,
  { url = github, scope = '', head = 'ref: refs/heads/feature\n', tracking = true } = {}
) {
  const directory = assertOwnedPath(evidence, path.join(evidence, 'context-' + randomUUID()))
  const gitdir = path.join(directory, 'source', '.git'),
    material = path.join(directory, 'material')
  await fs.mkdir(gitdir, { recursive: true })
  await fs.mkdir(material, { recursive: true })
  await fs.writeFile(path.join(gitdir, 'HEAD'), head)
  const configFile = path.join(gitdir, 'config'),
    hookFile = path.join(gitdir, 'hooks', 'pre-push')
  await fs.mkdir(path.dirname(hookFile), { recursive: true })
  await fs.writeFile(
    configFile,
    '[alias]\n push = !should-not-run\n[credential]\n helper = should-not-run\n[core]\n hooksPath = should-not-run\n'
  )
  await fs.writeFile(hookFile, 'Source hook fixture; must never execute.\n')
  const source = new module.SourceCapture()
  await source.file(path.join(gitdir, 'HEAD'), 4096)
  await source.file(configFile, 4096)
  await source.file(hookFile, 4096)
  const remoteId = randomUUID(),
    baseId = randomUUID(),
    calls = []
  const safeEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_DIR: path.join(material, '.git'),
    GIT_WORK_TREE: material,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  }
  const ctx = {
    location: {
      repositoryPath: path.join(directory, 'source'),
      selectedPath: path.join(directory, 'source'),
      scopePath: scope,
      gitdir,
      common: gitdir
    },
    snapshot: { source, worktree: material, env: safeEnv, head: 'present' },
    remotes: new Map([[remoteId, { remoteId, name: 'origin', url }]]),
    refs: new Map([
      [
        baseId,
        { refId: baseId, ref: 'refs/heads/main', name: 'main', oid: 'c'.repeat(40), remote: false }
      ],
      ...(tracking
        ? [
            [
              randomUUID(),
              {
                ref: 'refs/remotes/origin/feature',
                name: 'origin/feature',
                oid: expected,
                remote: true
              }
            ]
          ]
        : [])
    ]),
    config: new Map([
      ['alias.push', '!should-not-run'],
      ['credential.helper', 'should-not-run'],
      ['core.hooksPath', 'should-not-run']
    ]),
    run: async (args, _signal, extra) => {
      calls.push({
        args: [...args],
        extra,
        authenticationHeaderPresent: !!extra?.env?.GIT_CONFIG_VALUE_0,
        authenticationHeaderExact:
          extra?.env?.GIT_CONFIG_VALUE_0 ===
          'Authorization: Basic ' + Buffer.from('x-access-token:' + authToken).toString('base64')
      })
      return Buffer.from(args[0] === 'rev-parse' ? oid + '\n' : 'synthetic successful Git output')
    }
  }
  const metadata = {
    revision: randomUUID(),
    branch: 'feature',
    headSha: oid,
    ahead: 1,
    behind: 0,
    branches: [],
    commits: [],
    worktrees: [],
    remotes: [{ remoteId, name: 'origin', url, pushable: false, reason: null }],
    capabilities: []
  }
  return {
    ctx,
    metadata,
    remoteId,
    baseId,
    calls,
    configFile,
    hookFile,
    configHash: hash(await fs.readFile(configFile)),
    hookHash: hash(await fs.readFile(hookFile))
  }
}
function forbiddenSecrets(value) {
  const text = JSON.stringify(value)
  for (const secret of [
    authToken,
    environmentToken,
    secondEnvironmentToken,
    modelSecret,
    Buffer.from('x-access-token:' + authToken).toString('base64')
  ])
    assert(!text.includes(secret), 'Secret leaked into output or arguments')
}
async function unchangedSource(f) {
  assert.equal(hash(await fs.readFile(f.configFile)), f.configHash)
  assert.equal(hash(await fs.readFile(f.hookFile)), f.hookHash)
}

await suite.check(
  'transport accepts canonical HTTPS only, rejects userinfo/query/fragment/SSH/local/ext/control variants',
  () => {
    assert.deepEqual(api.gitRemoteTransport(github), {
      url: github,
      hostname: 'github.com',
      github: true
    })
    assert.equal(api.gitRemoteTransport('https://example.invalid/repo.git').github, false)
    for (const url of [
      'http://github.com/a/b',
      'ssh://github.com/a/b',
      'git@github.com:a/b.git',
      'file:///fixture/repo',
      'ext::command',
      'https://user:secret@github.com/a/b',
      'https://github.com/a/b?token=secret',
      'https://github.com/a/b#secret',
      'https://github.com/a/b\n',
      ''
    ])
      assert.equal(api.gitRemoteTransport(url), null, url)
  }
)
await suite.check(
  'metadata reads availability only: no Git, gh, model or network; absent CLI disables PR accurately',
  async () =>
    environment(
      {
        ...absentEnv,
        MODEL_ENDPOINT: 'https://fixture.invalid/v1/responses',
        MODEL_NAME: 'fixture',
        MODEL_API_KEY: modelSecret
      },
      async () => {
        const f = await context(),
          before = syntheticCalls.length
        const data = await api.createGitWorkbenchRemote().metadata(f.ctx, f.metadata)
        assert.equal(f.calls.length, 0)
        assert.equal(syntheticCalls.length, before)
        assert.equal(data.capabilities.find((value) => value.name === 'generate').available, true)
        const pr = data.capabilities.find((value) => value.name === 'create-pr')
        assert.equal(pr.available, false)
        assert.match(pr.reason, /安装 GitHub CLI/)
        forbiddenSecrets(data)
        await unchangedSource(f)
      }
    )
)
await suite.check(
  'availability disables invalid model endpoint and scoped network actions without asking the model',
  async () =>
    environment(
      {
        ...absentEnv,
        MODEL_ENDPOINT: 'http://fixture.invalid',
        MODEL_NAME: 'fixture',
        MODEL_API_KEY: modelSecret
      },
      async () => {
        const f = await context(api, { scope: 'sub' }),
          data = await api.createGitWorkbenchRemote().metadata(f.ctx, f.metadata)
        for (const name of [
          'push',
          'fetch',
          'create-pr',
          'generate',
          'generate-commit',
          'generate-pr'
        ])
          assert.equal(
            data.capabilities.find((value) => value.name === name).available,
            false,
            name
          )
        assert.equal(f.calls.length, 0)
        forbiddenSecrets(data)
      }
    )
)
await suite.check(
  'push pins local ref, explicit OID, exact tracking lease and HTTPS protocol; source config/hooks are not addressed',
  async () =>
    environment(absentEnv, async () => {
      const f = await context(),
        remote = api.createGitWorkbenchRemote()
      const result = await remote.execute(
        f.ctx,
        request('push', { remoteId: f.remoteId, forceWithLease: true })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(result.headSha, oid)
      assert.deepEqual(f.calls[0].args, ['rev-parse', '--verify', 'HEAD'])
      const push = f.calls[1]
      assert(push.args.includes('--no-verify'))
      assert(push.args.includes('--no-recurse-submodules'))
      assert(push.args.includes('--force-with-lease=refs/heads/feature:' + expected))
      assert.deepEqual(push.args.slice(-3), ['--', github, oid + ':refs/heads/feature'])
      assert.equal(push.extra.env.GIT_ALLOW_PROTOCOL, 'https')
      assert.equal(push.extra.env.GIT_PROTOCOL_FROM_USER, '0')
      assert.equal(push.extra.env.GIT_CONFIG_GLOBAL, emptyGlobal)
      assert.equal(push.extra.env.GIT_WORK_TREE, f.ctx.snapshot.worktree)
      assert(!push.args.includes('origin'))
      assert(!JSON.stringify(push.args).includes(f.ctx.location.repositoryPath))
      forbiddenSecrets({ result, args: push.args })
      await unchangedSource(f)
    })
)
await suite.check(
  'normal push never adds force; unknown tracking lease uses explicit empty expected value',
  async () =>
    environment(absentEnv, async () => {
      const regular = await context()
      await api
        .createGitWorkbenchRemote()
        .execute(
          regular.ctx,
          request('push', { remoteId: regular.remoteId, forceWithLease: false })
        )
      assert(!regular.calls[1].args.some((arg) => arg.startsWith('--force')))
      const fresh = await context(api, { tracking: false })
      await api
        .createGitWorkbenchRemote()
        .execute(fresh.ctx, request('push', { remoteId: fresh.remoteId, forceWithLease: true }))
      assert(fresh.calls[1].args.includes('--force-with-lease=refs/heads/feature:'))
    })
)
await suite.check(
  'unsupported/scoped/stale/detached source blocks push before any network runner invocation',
  async () =>
    environment(absentEnv, async () => {
      for (const config of [
        { url: 'git@github.com:a/b' },
        { scope: 'sub' },
        { head: oid + '\n' }
      ]) {
        const f = await context(api, config)
        await assert.rejects(
          api
            .createGitWorkbenchRemote()
            .execute(f.ctx, request('push', { remoteId: f.remoteId, forceWithLease: false })),
          /HTTPS|根目录|本地分支/
        )
        assert.equal(f.calls.length, 0)
      }
      const f = await context()
      await fs.writeFile(path.join(f.ctx.location.gitdir, 'HEAD'), 'ref: refs/heads/external\n')
      await assert.rejects(
        api
          .createGitWorkbenchRemote()
          .execute(f.ctx, request('push', { remoteId: f.remoteId, forceWithLease: false })),
        /变化/
      )
      assert.equal(f.calls.length, 0)
    })
)
await suite.check(
  'GitHub auth uses only fixed hashed CLI; token is header environment only and erased after push',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'ready'
      const f = await context(synthetic),
        start = syntheticCalls.length
      const result = await synthetic
        .createGitWorkbenchRemote()
        .execute(f.ctx, request('push', { remoteId: f.remoteId, forceWithLease: false }))
      assert.deepEqual(syntheticCalls[start].args, ['auth', 'token', '--hostname', 'github.com'])
      const push = f.calls[1]
      assert.equal(push.authenticationHeaderPresent, true)
      assert.equal(push.authenticationHeaderExact, true)
      assert.equal(push.extra.env.GIT_CONFIG_VALUE_0, undefined)
      assert.equal(push.extra.env.GIT_CONFIG_KEY_0, 'http.' + github + '.extraHeader')
      forbiddenSecrets({
        result,
        args: push.args,
        processObservations: syntheticCalls.slice(start)
      })
      await unchangedSource(f)
    })
)
await suite.check(
  'Git error result redacts bare token, base64, decoded token, complete header and both environment tokens',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'ready'
      const f = await context(synthetic)
      f.ctx.run = async (args, _signal, extra) => {
        if (args[0] === 'rev-parse') return Buffer.from(oid)
        const header = extra.env.GIT_CONFIG_VALUE_0
        assert(header.startsWith('Authorization: Basic '))
        const encoded = header.slice('Authorization: Basic '.length)
        throw new synthetic.GitReadError(
          'error',
          [
            header,
            encoded,
            'x-access-token:' + authToken,
            authToken,
            environmentToken,
            secondEnvironmentToken,
            'https://userinfo:password@github.com/a/b'
          ].join(' ')
        )
      }
      let error
      try {
        await synthetic
          .createGitWorkbenchRemote()
          .execute(f.ctx, request('push', { remoteId: f.remoteId, forceWithLease: false }))
      } catch (value) {
        error = value
      }
      assert(error)
      forbiddenSecrets({ message: error.message })
      assert(error.message.includes('[凭据已隐藏]'))
      assert(!error.message.includes('userinfo:password'))
    })
)
await suite.check(
  'PR remains unavailable without CLI and no authentication invocation occurs',
  async () =>
    environment(absentEnv, async () => {
      const f = await context(),
        before = syntheticCalls.length
      await assert.rejects(
        api.createGitWorkbenchRemote().execute(
          f.ctx,
          request('create-pr', {
            title: 'Manual',
            body: 'Body',
            draft: true,
            baseRefId: f.baseId
          })
        ),
        /登录|GitHub CLI/
      )
      assert.equal(f.calls.length, 0)
      assert.equal(syntheticCalls.length, before)
    })
)
await suite.check(
  'explicit PR invocation uses fixed repo/head/base/title/body/draft flags, never push/merge/model or implicit publish on opening',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'ready'
      const f = await context(synthetic),
        remote = synthetic.createGitWorkbenchRemote(),
        start = syntheticCalls.length
      await remote.metadata(f.ctx, f.metadata)
      assert.equal(syntheticCalls.length, start)
      assert.equal(f.calls.length, 0)
      const title = 'Manual "title"',
        body = 'Line1\nLine2; $(not-a-shell)'
      const result = await remote.execute(
        f.ctx,
        request('create-pr', { title, body, draft: true, baseRefId: f.baseId })
      )
      assert.equal(result.message, 'https://github.com/fixture-owner/fixture-repo/pull/42')
      const calls = syntheticCalls.slice(start)
      assert.deepEqual(
        calls.map((call) => call.args[0]),
        ['auth', 'pr']
      )
      assert.deepEqual(calls[1].args, [
        'pr',
        'create',
        '--repo',
        'fixture-owner/fixture-repo',
        '--head',
        'feature',
        '--base',
        'main',
        '--title',
        title,
        '--body',
        body,
        '--draft'
      ])
      assert.equal(calls[1].cwd, f.ctx.snapshot.worktree)
      assert.equal(calls[1].promptDisabled, '1')
      assert.equal(calls[1].gitPromptDisabled, '0')
      assert.equal(f.calls.length, 0)
      forbiddenSecrets({ result, calls })
      await unchangedSource(f)
    })
)
await suite.check(
  'non-draft PR omits draft; malformed returned URL is partial success and is never blindly retried',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'bad-url'
      const f = await context(synthetic),
        start = syntheticCalls.length
      const result = await synthetic
        .createGitWorkbenchRemote()
        .execute(
          f.ctx,
          request('create-pr', { title: 'Manual', body: '', draft: false, baseRefId: f.baseId })
        )
      assert.equal(result.outcome, 'partial-success')
      assert.equal(result.stage, 'remote-pr')
      assert(!syntheticCalls.at(-1).args.includes('--draft'))
      assert.equal(syntheticCalls.length - start, 2)
      forbiddenSecrets(result)
      ghMode = 'ready'
    })
)
await suite.check(
  'PR requires authentication and held base ref; missing auth or stale ref prevents pr create',
  async () =>
    environment(installedEnv, async () => {
      const f = await context(synthetic)
      ghMode = 'no-auth'
      let start = syntheticCalls.length
      await assert.rejects(
        synthetic
          .createGitWorkbenchRemote()
          .execute(
            f.ctx,
            request('create-pr', { title: 'Manual', body: '', draft: true, baseRefId: f.baseId })
          ),
        /登录/
      )
      assert.equal(syntheticCalls.length - start, 1)
      ghMode = 'ready'
      start = syntheticCalls.length
      await assert.rejects(
        synthetic.createGitWorkbenchRemote().execute(
          f.ctx,
          request('create-pr', {
            title: 'Manual',
            body: '',
            draft: true,
            baseRefId: randomUUID()
          })
        ),
        /失效/
      )
      assert.equal(syntheticCalls.length, start)
    })
)
await suite.check(
  'PR errors redact both environment and CLI-returned authentication token',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'error'
      const f = await context(synthetic)
      let error
      try {
        await synthetic
          .createGitWorkbenchRemote()
          .execute(
            f.ctx,
            request('create-pr', { title: 'Manual', body: '', draft: true, baseRefId: f.baseId })
          )
      } catch (value) {
        error = value
      }
      assert(error)
      forbiddenSecrets({ message: error.message })
      ghMode = 'ready'
    })
)
await suite.check(
  'unconfirmed CLI exit blocks later use without exposing credentials in repeated error',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'unconfirmed'
      const f = await context(synthetic),
        remote = synthetic.createGitWorkbenchRemote()
      for (let round = 0; round < 2; round++) {
        let error
        try {
          await remote.execute(
            f.ctx,
            request('create-pr', { title: 'Manual', body: '', draft: true, baseRefId: f.baseId })
          )
        } catch (value) {
          error = value
        }
        assert(error)
        forbiddenSecrets({ message: error.message })
      }
      ghMode = 'ready'
    })
)
await suite.check(
  'CLI identity replacement is detected before auth; external edit during auth prevents push',
  async () =>
    environment(installedEnv, async () => {
      const f = await context(synthetic),
        remote = synthetic.createGitWorkbenchRemote()
      await remote.metadata(f.ctx, f.metadata)
      await fs.writeFile(ghPath, ghIdentity + 'changed')
      await assert.rejects(
        remote.execute(f.ctx, request('push', { remoteId: f.remoteId, forceWithLease: false })),
        /身份已变化|登录|程序身份/
      )
      await fs.writeFile(ghPath, ghIdentity)
      const next = await context(synthetic)
      onAuth = async () =>
        fs.writeFile(path.join(next.ctx.location.gitdir, 'HEAD'), 'ref: refs/heads/external\n')
      try {
        await assert.rejects(
          synthetic
            .createGitWorkbenchRemote()
            .execute(next.ctx, request('push', { remoteId: next.remoteId, forceWithLease: false })),
          /变化/
        )
        assert.equal(next.calls.filter((call) => call.args.includes('push')).length, 0)
      } finally {
        onAuth = null
      }
    })
)

await suite.check(
  'remote interruption reports uncertain remote outcome and retires transient authentication header',
  async () =>
    environment(installedEnv, async () => {
      ghMode = 'ready'
      const f = await context(synthetic),
        controller = new AbortController()
      let environmentReference
      f.ctx.run = async (args, _signal, extra) => {
        if (args[0] === 'rev-parse') return Buffer.from(oid)
        environmentReference = extra.env
        controller.abort()
        throw new synthetic.GitReadError('error', '连接退出未确认 ' + authToken)
      }
      let error
      try {
        await synthetic
          .createGitWorkbenchRemote()
          .execute(
            f.ctx,
            request('push', { remoteId: f.remoteId, forceWithLease: false }),
            controller.signal
          )
      } catch (value) {
        error = value
      }
      assert(error)
      assert.match(error.message, /远程结果可能已发生/)
      forbiddenSecrets({ message: error.message })
      assert.equal(environmentReference.GIT_CONFIG_VALUE_0, undefined)
    })
)

await suite.check(
  'shared repository lock serializes two manual pushes before their network runner stage',
  async () =>
    environment(absentEnv, async () => {
      const f = await context(),
        remote = api.createGitWorkbenchRemote()
      let firstNetworkResolve
      const firstNetwork = new Promise((resolve) => {
        firstNetworkResolve = resolve
      })
      let networkCount = 0
      f.ctx.run = async (args) => {
        f.calls.push({ args: [...args] })
        if (args[0] === 'rev-parse') return Buffer.from(oid)
        networkCount += 1
        if (networkCount === 1) await firstNetwork
        return Buffer.alloc(0)
      }
      const first = remote.execute(
        f.ctx,
        request('push', { remoteId: f.remoteId, forceWithLease: false })
      )
      for (let round = 0; round < 30 && networkCount === 0; round++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.equal(networkCount, 1)
      const second = remote.execute(
        f.ctx,
        request('push', { remoteId: f.remoteId, forceWithLease: false })
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(f.calls.length, 2)
      firstNetworkResolve()
      const results = await Promise.all([first, second])
      assert.equal(networkCount, 2)
      assert(results.every((result) => result.outcome === 'success'))
      forbiddenSecrets(results)
    })
)

await fs.writeFile(
  path.join(evidence, 'synthetic-process-contracts.json'),
  JSON.stringify(syntheticCalls, null, 2)
)
delete globalThis[dispatcherKey]
await suite.finish({
  syntheticGhCompiledSHA256: hash(await fs.readFile(seamOutput)),
  syntheticGhSourceHashes: seamHashes
})
