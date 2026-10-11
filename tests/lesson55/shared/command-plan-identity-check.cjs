const { assert, fs, path, root, load, suite } = require('./harness.cjs')
const { randomUUID, createHash } = require('node:crypto')
const checks = suite('lesson55-command-plan-identity')
let directory,
  plan,
  counter = 0
async function prepared(mode = 'full-access') {
  const cwd = path.join(directory, 'case-' + ++counter)
  await fs.mkdir(cwd)
  const program = path.join(cwd, 'fixture.exe')
  await fs.writeFile(program, 'test-fixture-binary-never-launched\n', { flag: 'wx' })
  const controller = new AbortController()
  let current = true
  const request = {
    program,
    args: ['--controlled', 'original'],
    cwd,
    sandbox_permissions: 'use_default',
    justification: null
  }
  const context = {
    owner: {
      kind: 'desktop',
      windowId: 1,
      conversationId: 'conversation-plan',
      requestId: 'request-plan'
    },
    permissions: { mode, revision: 1 },
    scopeId: 'a'.repeat(64),
    writableRoots: [cwd],
    environment: 'tool',
    assertCurrent: () => current
  }
  const candidate = await plan.prepareCommandExecution(request, context, controller.signal)
  return {
    cwd,
    program,
    controller,
    request,
    context,
    candidate,
    invalidate: () => {
      current = false
    }
  }
}
async function main() {
  directory = path.join(__dirname, 'command-plan-run-' + randomUUID())
  await fs.mkdir(directory)
  const fakeHost = {
    path: path.join(directory, 'synthetic-host.exe'),
    hash: 'b'.repeat(64),
    identity: 'synthetic-host-only'
  }
  const fakeBackend = {
    host: fakeHost,
    hostPath: fakeHost.path,
    hostHash: fakeHost.hash,
    cliPath: path.join(directory, 'synthetic-cli.exe'),
    cliHash: 'c'.repeat(64),
    codexHome: path.join(directory, 'synthetic-codex-home'),
    identity: 'synthetic-backend-only',
    files: []
  }
  plan = await load('src/main/execution/command-plan.ts', {
    './windows-command-backend': {
      inspectCommandHost: async () => fakeHost,
      inspectWindowsCommandBackend: async () => fakeBackend,
      verifyCommandHost: () => true,
      verifyWindowsCommandBackend: () => true
    }
  })
  await checks.test(
    'prepared command copied before approval and frozen arguments reject caller mutation',
    async () => {
      const item = await prepared()
      item.request.args[1] = 'changed'
      item.request.cwd = 'changed'
      item.context.permissions.mode = 'default'
      item.context.writableRoots.length = 0
      assert.equal(item.candidate.command.args[1], 'original')
      assert.equal(item.candidate.command.cwd, item.cwd)
      assert.equal(item.candidate.permissions.mode, 'full-access')
      assert.equal(Object.isFrozen(item.candidate.command.args), true)
      const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
      const launch = plan.claimCommandExecution(signed, 1000)
      assert.ok(launch.args.includes('original'))
      assert.equal(launch.args.includes('changed'), false)
      launch.cleanup()
    }
  )
  await checks.test(
    'arbitrary object copied object and JSON cannot forge prepared identity',
    async () => {
      const item = await prepared()
      for (const forged of [
        {
          command: item.candidate.command,
          permissions: item.candidate.permissions,
          sandboxAvailable: false,
          reason: 'forged'
        },
        { ...item.candidate },
        JSON.parse(JSON.stringify(item.candidate))
      ])
        assert.throws(() => plan.authorizeCommandExecution(forged, 'full-access'), /已使用或无效/)
      plan.discardCommandExecution(item.candidate)
    }
  )
  await checks.test('prepared identity signs once and signed identity claims once', async () => {
    const item = await prepared()
    const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
    assert.throws(
      () => plan.authorizeCommandExecution(item.candidate, 'full-access'),
      /已使用或无效/
    )
    const launch = plan.claimCommandExecution(signed, 1000)
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /已使用或无效/)
    launch.cleanup()
  })
  await checks.test(
    'copied or JSON signed plan cannot replace the WeakMap authorization object',
    async () => {
      const item = await prepared()
      const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
      for (const forged of [
        { ...signed },
        JSON.parse(JSON.stringify(signed)),
        { command: signed.command, authorization: true }
      ])
        assert.throws(() => plan.claimCommandExecution(forged, 1000), /已使用或无效/)
      plan.discardCommandExecution(signed)
    }
  )
  await checks.test('context expiry between prepare and authorize prevents signing', async () => {
    const item = await prepared()
    item.invalidate()
    assert.throws(() => plan.authorizeCommandExecution(item.candidate, 'full-access'), /失效/)
    plan.discardCommandExecution(item.candidate)
  })
  await checks.test(
    'context expiry after signing prevents launch and consumes stale plan',
    async () => {
      const item = await prepared()
      const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
      item.invalidate()
      assert.throws(() => plan.claimCommandExecution(signed, 1000), /来源或程序已变化/)
      assert.throws(() => plan.claimCommandExecution(signed, 1000), /已使用或无效/)
    }
  )
  await checks.test('cancelled signed plan cannot launch or replay', async () => {
    const item = await prepared()
    const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
    item.controller.abort()
    assert.throws(() => plan.claimCommandExecution(signed, 1000), { name: 'AbortError' })
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /已使用或无效/)
  })
  await checks.test('real executable-byte modification after signing prevents launch', async () => {
    const item = await prepared()
    const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
    await fs.writeFile(item.program, 'changed-test-fixture-binary')
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /来源或程序已变化/)
  })
  await checks.test('real directory replacement after signing prevents launch', async () => {
    const item = await prepared()
    const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
    const retained = item.cwd + '-retained'
    await fs.rename(item.cwd, retained)
    await fs.mkdir(item.cwd)
    await fs.copyFile(path.join(retained, 'fixture.exe'), item.program)
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /变化/)
  })
  await checks.test('sandbox sign cannot silently become full-access and vice versa', async () => {
    const restricted = await prepared('default')
    assert.equal(restricted.candidate.sandboxAvailable, true)
    assert.throws(
      () => plan.authorizeCommandExecution(restricted.candidate, 'full-access'),
      /后端不一致/
    )
    plan.discardCommandExecution(restricted.candidate)
    const full = await prepared()
    assert.equal(full.candidate.sandboxAvailable, false)
    assert.throws(() => plan.authorizeCommandExecution(full.candidate, 'sandbox'), /后端不一致/)
    plan.discardCommandExecution(full.candidate)
  })
  await checks.test(
    'real protected-path appearance after signed sandbox plan blocks claim',
    async () => {
      const item = await prepared('default')
      const signed = plan.authorizeCommandExecution(item.candidate, 'sandbox')
      await fs.mkdir(path.join(item.cwd, '.codex'))
      await fs.writeFile(
        path.join(item.cwd, '.codex', 'retained.txt'),
        'protected fixture retained'
      )
      assert.throws(() => plan.claimCommandExecution(signed, 1000), /目录或 Git 指向已变化/)
    }
  )
  await checks.test('real Git pointer change after signed sandbox plan blocks claim', async () => {
    const cwd = path.join(directory, 'git-case')
    const first = path.join(directory, 'git-first')
    const second = path.join(directory, 'git-second')
    await fs.mkdir(cwd)
    await fs.mkdir(first)
    await fs.mkdir(second)
    const program = path.join(cwd, 'fixture.exe')
    await fs.writeFile(program, 'never-started')
    const pointer = path.join(cwd, '.git')
    await fs.writeFile(pointer, 'gitdir: ' + first + '\n')
    const candidate = await plan.prepareCommandExecution(
      { program, args: [], cwd },
      {
        owner: {
          kind: 'desktop',
          windowId: 1,
          conversationId: 'conversation',
          requestId: 'request'
        },
        permissions: { mode: 'default', revision: 1 },
        scopeId: 'a'.repeat(64),
        writableRoots: [cwd],
        environment: 'tool',
        assertCurrent: () => true
      },
      new AbortController().signal
    )
    const signed = plan.authorizeCommandExecution(candidate, 'sandbox')
    await fs.writeFile(pointer, 'gitdir: ' + second + '\n')
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /目录或 Git 指向已变化/)
  })
  await checks.test('discarding signed preparation prevents later claim', async () => {
    const item = await prepared()
    const signed = plan.authorizeCommandExecution(item.candidate, 'full-access')
    plan.discardCommandExecution(signed)
    assert.throws(() => plan.claimCommandExecution(signed, 1000), /已使用或无效/)
  })
  await checks.finish({
    directory,
    sourceHashes: {
      'src/main/execution/command-plan.ts': createHash('sha256')
        .update(await fs.readFile(path.join(root, 'src/main/execution/command-plan.ts')))
        .digest('hex')
    },
    method: {
      actual: [
        'original WeakMap prepare/sign/claim/discard',
        'original command data snapshots and one-time consumption',
        'actual isolated executable byte identities directory identities Git pointer and protection path rechecks'
      ],
      synthetic: [
        'Windows backend and command host inspection/verification',
        'non-executable fixture file instead of trusted program binary'
      ],
      processStarts: 0,
      noRealModel: true
    },
    boundaries:
      'No real command execution or sandbox/native backend authenticity is claimed; produced launch descriptions are inspected and cleaned without spawning a process.'
  })
}
main().catch(async (error) => {
  await checks.test('suite setup', () => {
    throw error
  })
  await checks.finish({ noRealModel: true, processStarts: 0 })
})
