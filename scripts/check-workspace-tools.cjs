const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } = require('node:fs/promises')
const Module = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')

function loadBundled(relativePath) {
  const filename = path.join(root, relativePath)
  const result = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent'
  })
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(result.outputFiles[0].text, filename)
  return loaded.exports
}

function call(execute, name, args, signal) {
  return execute(name, JSON.stringify(args), signal)
}

function functionCall(name, args, callId = 'call-workspace') {
  return {
    type: 'function_call',
    name,
    arguments: JSON.stringify(args),
    call_id: callId
  }
}

function finalResponse(text) {
  return {
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
  }
}

async function main() {
  const { createWorkspaceReadExecutor, workspaceReadTools } = loadBundled(
    'src/main/tools/workspace-files.ts'
  )
  const { createWorkspaceActionExecutor } = loadBundled('src/main/tools/workspace-actions.ts')
  const { runToolLoop } = loadBundled('src/main/agent/tool-loop.ts')
  const { buildAgentRequest } = loadBundled('src/main/agent/agent-instructions.ts')
  const { parseToolHistory, selectToolHistory } = loadBundled('src/shared/agent-history.ts')
  const { isToolAllowed, sameToolScope, toolScopeForAgentRequest } =
    loadBundled('src/shared/project.ts')
  const base = await realpath(tmpdir())
  const temporaryRoot = await mkdtemp(path.join(base, 'zonecodex-workspace-tools-'))
  const workspace = path.join(temporaryRoot, 'workspace')
  const outside = path.join(temporaryRoot, 'outside')
  const source = path.join(workspace, 'example.ts')
  const original = 'export const answer = 42\n// needle in workspace\n'
  const signal = new AbortController().signal

  try {
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await mkdir(outside)
    await writeFile(source, original, 'utf8')
    await writeFile(path.join(workspace, 'src', 'nested.txt'), 'nested needle\n', 'utf8')
    await writeFile(path.join(outside, 'outside.txt'), 'outside needle\n', 'utf8')
    await symlink(
      outside,
      path.join(workspace, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    let authorized = true
    const read = createWorkspaceReadExecutor(workspace, () => authorized)
    assert.deepEqual(
      workspaceReadTools.map((tool) => tool.name),
      ['list_workspace_files', 'search_workspace_text', 'read_workspace_file']
    )

    const listing = JSON.parse(
      await call(
        read,
        'list_workspace_files',
        {
          path: '',
          recursive: true
        },
        signal
      )
    )
    assert.equal(listing.ok, true)
    assert.ok(listing.entries.some((entry) => entry.path === 'example.ts' && entry.type === 'file'))
    assert.ok(listing.entries.some((entry) => entry.path === 'src/nested.txt'))
    assert.ok(!listing.entries.some((entry) => entry.path.startsWith('linked-outside')))

    const search = JSON.parse(
      await call(
        read,
        'search_workspace_text',
        {
          path: '',
          query: 'needle'
        },
        signal
      )
    )
    assert.equal(search.ok, true)
    assert.ok(search.matches.some((match) => match.path === 'example.ts' && match.line === 2))
    assert.ok(search.matches.some((match) => match.path === 'src/nested.txt'))
    assert.ok(!search.matches.some((match) => match.path.includes('outside')))

    const readResult = JSON.parse(
      await call(
        read,
        'read_workspace_file',
        {
          path: 'example.ts',
          startLine: 1,
          endLine: 2
        },
        signal
      )
    )
    assert.equal(readResult.ok, true)
    assert.deepEqual(
      readResult.lines.map((line) => line.text),
      ['export const answer = 42', '// needle in workspace']
    )
    const expectedSha256 = createHash('sha256').update(original).digest('hex')
    assert.equal(readResult.sha256, expectedSha256)

    for (const [name, args] of [
      ['list_workspace_files', { path: '../outside', recursive: true }],
      ['search_workspace_text', { path: '../outside', query: 'needle' }],
      ['read_workspace_file', { path: '../outside/outside.txt', startLine: 1, endLine: 1 }],
      ['read_workspace_file', { path: path.join(outside, 'outside.txt'), startLine: 1, endLine: 1 }]
    ]) {
      const rejected = JSON.parse(await call(read, name, args, signal))
      assert.equal(rejected.ok, false, `${name} accepted an escaping path`)
    }
    const linked = JSON.parse(
      await call(
        read,
        'read_workspace_file',
        {
          path: 'linked-outside/outside.txt',
          startLine: 1,
          endLine: 1
        },
        signal
      )
    )
    assert.equal(linked.ok, false)
    assert.ok(!JSON.stringify(linked).includes('outside needle'))

    authorized = false
    await assert.rejects(
      call(read, 'read_workspace_file', { path: 'example.ts', startLine: 1, endLine: 1 }, signal),
      /工作区授权已失效/
    )
    authorized = true

    const scopeA = toolScopeForAgentRequest({
      conversationId: 'conversation-a',
      workspaceId: 'workspace-a'
    })
    const scopeB = toolScopeForAgentRequest({
      conversationId: 'conversation-a',
      workspaceId: 'workspace-b'
    })
    assert.deepEqual(scopeA, { kind: 'time', workspaceId: 'workspace-a' })
    assert.equal(sameToolScope(scopeA, scopeB), false)
    assert.equal(isToolAllowed('read_workspace_file', scopeA), true)
    assert.equal(isToolAllowed('read_workspace_file', { kind: 'time' }), false)
    assert.equal(isToolAllowed('run_workspace_command', scopeA), true)
    assert.equal(isToolAllowed('search_project_text', scopeA), false)
    assert.equal(isToolAllowed('unknown_tool', scopeA), false)
    const workspaceTools = buildAgentRequest({ workspaceId: 'workspace-a' }).tools

    const args = { path: 'example.ts', startLine: 1, endLine: 2 }
    const callItem = functionCall('read_workspace_file', args)
    const history = [
      { role: 'user', content: 'Read the source' },
      callItem,
      {
        type: 'function_call_output',
        call_id: callItem.call_id,
        output: JSON.stringify(readResult)
      },
      finalResponse('Read complete').output[0]
    ]
    assert.deepEqual(parseToolHistory(history, scopeA), history)
    assert.equal(parseToolHistory(history, { kind: 'time' }), null)
    const messages = [
      { id: 'user-a', role: 'user', status: 'complete', content: 'Read the source' },
      { id: 'assistant-a', role: 'assistant', status: 'complete', content: 'Read complete' }
    ]
    const runs = [
      {
        requestId: 'request-a',
        userId: 'user-a',
        assistantId: 'assistant-a',
        mode: 'live',
        scope: scopeA,
        trace: [],
        items: history
      }
    ]
    assert.deepEqual(selectToolHistory(messages, runs, 'live', scopeA), history)
    assert.deepEqual(selectToolHistory(messages, runs, 'live', scopeB), [])

    let executionCount = 0
    const unauthorizedSend = async () => ({ status: 'completed', output: [callItem] })
    await assert.rejects(
      runToolLoop(
        'Read the source',
        unauthorizedSend,
        signal,
        [],
        () => undefined,
        [],
        async () => {
          executionCount += 1
          return '{}'
        },
        { kind: 'time' }
      ),
      /工具不在当前范围内/
    )
    assert.equal(executionCount, 0)

    let round = 0
    const result = await runToolLoop(
      'Read the source',
      async () => {
        round += 1
        return round === 1
          ? { status: 'completed', output: [callItem] }
          : finalResponse('Read complete')
      },
      signal,
      [],
      () => undefined,
      [],
      async (name, raw, activeSignal) => {
        executionCount += 1
        return read(name, raw, activeSignal)
      },
      scopeA
    )
    assert.equal(round, 2)
    assert.equal(executionCount, 1)
    assert.equal(result.answer, 'Read complete')
    assert.deepEqual(result.items, history)

    const approvals = []
    let approvalDecision = false
    const actions = createWorkspaceActionExecutor(
      workspace,
      () => true,
      async (request) => {
        approvals.push(request)
        return approvalDecision
      }
    )
    const createdFile = path.join(workspace, 'created.ts')
    const newContent = 'export const created = true\n'
    const deniedCreate = JSON.parse(
      await call(
        actions,
        'create_workspace_file',
        {
          path: 'created.ts',
          content: newContent
        },
        signal
      )
    )
    assert.equal(deniedCreate.status, 'cancelled')
    assert.equal(approvals.at(-1)?.kind, 'create')
    await assert.rejects(readFile(createdFile), { code: 'ENOENT' })

    const beforeInvalidCreate = approvals.length
    for (const pathValue of [
      '../outside/escape.ts',
      'missing/escape.ts',
      'linked-outside/escape.ts'
    ]) {
      const blocked = JSON.parse(
        await call(
          actions,
          'create_workspace_file',
          {
            path: pathValue,
            content: newContent
          },
          signal
        )
      )
      assert.equal(blocked.status, 'error')
    }
    assert.equal(approvals.length, beforeInvalidCreate)
    await assert.rejects(readFile(path.join(outside, 'escape.ts')), { code: 'ENOENT' })

    approvalDecision = true
    const acceptedCreate = JSON.parse(
      await call(
        actions,
        'create_workspace_file',
        {
          path: 'created.ts',
          content: newContent
        },
        signal
      )
    )
    assert.equal(acceptedCreate.status, 'created')
    assert.equal(await readFile(createdFile, 'utf8'), newContent)
    const existingCreate = JSON.parse(
      await call(
        actions,
        'create_workspace_file',
        {
          path: 'created.ts',
          content: 'overwrite attempt\n'
        },
        signal
      )
    )
    assert.equal(existingCreate.status, 'conflict')
    assert.equal(await readFile(createdFile, 'utf8'), newContent)

    const beforeStaleEdit = approvals.length
    const staleEdit = JSON.parse(
      await call(
        actions,
        'edit_workspace_file',
        {
          path: 'example.ts',
          proposedText: 'export const answer = 43\n',
          expectedSha256: '0'.repeat(64)
        },
        signal
      )
    )
    assert.equal(staleEdit.status, 'conflict')
    assert.equal(approvals.length, beforeStaleEdit)
    assert.equal(await readFile(source, 'utf8'), original)

    approvalDecision = false
    const edit = JSON.parse(
      await call(
        actions,
        'edit_workspace_file',
        {
          path: 'example.ts',
          proposedText: 'export const answer = 43\n',
          expectedSha256
        },
        signal
      )
    )
    assert.equal(edit.status, 'cancelled')
    assert.equal(approvals.at(-1)?.kind, 'edit')
    assert.equal(await readFile(source, 'utf8'), original)
    const command = JSON.parse(
      await call(
        actions,
        'run_workspace_command',
        {
          program: 'zonecodex-nonexistent-test-program',
          args: []
        },
        signal
      )
    )
    assert.equal(command.status, 'cancelled')
    assert.equal(approvals.at(-1)?.kind, 'command')
    assert.equal(await readFile(source, 'utf8'), original)

    approvalDecision = true
    const appliedEdit = JSON.parse(
      await call(
        actions,
        'edit_workspace_file',
        {
          path: 'example.ts',
          proposedText: 'export const answer = 43\n',
          expectedSha256
        },
        signal
      )
    )
    assert.equal(appliedEdit.status, 'applied')
    assert.equal(await readFile(source, 'utf8'), 'export const answer = 43\n')

    assert.equal(isToolAllowed('create_workspace_file', scopeA), true)
    assert.equal(isToolAllowed('create_workspace_file', { kind: 'time' }), false)
    assert.deepEqual(
      workspaceTools.map((tool) => tool.name),
      [
        'get_current_time',
        'list_workspace_files',
        'search_workspace_text',
        'read_workspace_file',
        'create_workspace_file',
        'edit_workspace_file',
        'run_workspace_command'
      ]
    )

    // Exercise real subprocess boundaries after both command entries share their runner.
    let effects = 0
    let commandAccess = true
    let onCommandEffect = () => {}
    const executeCommand = createWorkspaceActionExecutor(
      workspace,
      () => commandAccess,
      async () => true,
      {
        onEffect: () => {
          effects++
          onCommandEffect()
        }
      }
    )
    const nodeCommand = async (code, commandSignal = signal) =>
      JSON.parse(
        await call(
          executeCommand,
          'run_workspace_command',
          { program: process.execPath, args: ['-e', code], cwd: null },
          commandSignal
        )
      )
    const normalCommand = await nodeCommand(
      "process.stdout.write('output'); process.stderr.write('diagnostic')"
    )
    assert.equal(normalCommand.status, 'completed')
    assert.equal(normalCommand.exitCode, 0)
    assert.equal(normalCommand.stdout, 'output')
    assert.equal(normalCommand.stderr, 'diagnostic')
    assert.equal(normalCommand.truncated, false)
    const failedCommand = await nodeCommand('process.exitCode = 7')
    assert.equal(failedCommand.status, 'failed')
    assert.equal(failedCommand.exitCode, 7)
    const clippedCommand = await nodeCommand("process.stdout.write('x'.repeat(1900))")
    assert.equal(clippedCommand.status, 'completed')
    assert.equal(Buffer.byteLength(clippedCommand.stdout), 1800)
    assert.equal(clippedCommand.truncated, true)
    const environmentKey = 'ZONECODEX_COMMAND_CHECK'
    const previousEnvironment = process.env[environmentKey]
    try {
      process.env[environmentKey] = 'must-not-reach-general-tool'
      const environmentCommand = await nodeCommand(
        "process.stdout.write(process.env.ZONECODEX_COMMAND_CHECK || 'absent')"
      )
      assert.equal(environmentCommand.stdout, 'absent')
    } finally {
      if (previousEnvironment === undefined) delete process.env[environmentKey]
      else process.env[environmentKey] = previousEnvironment
    }
    const beforeMissing = effects
    const missingCommand = JSON.parse(
      await call(
        executeCommand,
        'run_workspace_command',
        {
          program: path.join(workspace, 'nonexistent-program'),
          args: [],
          cwd: null
        },
        signal
      )
    )
    assert.equal(missingCommand.status, 'error')
    assert.equal(effects, beforeMissing + 1, 'spawn failure is still a side-effect attempt')
    const commandAbort = new AbortController()
    const abortReason = new Error('cancel-command-check')
    onCommandEffect = () => setTimeout(() => commandAbort.abort(abortReason), 100)
    await assert.rejects(
      nodeCommand('setInterval(() => {}, 1000)', commandAbort.signal),
      (error) => error === abortReason
    )
    onCommandEffect = () =>
      setTimeout(() => {
        commandAccess = false
      }, 100)
    const revokedCommand = await nodeCommand('setInterval(() => {}, 1000)')
    assert.equal(revokedCommand.status, 'error')
    assert.match(revokedCommand.error, /进程是否退出未确认/)
    const beforeDenied = effects
    assert.equal((await nodeCommand("process.stdout.write('should-not-run')")).status, 'error')
    assert.equal(effects, beforeDenied, 'revoked access cannot launch another process')
    commandAccess = true
    onCommandEffect = () => {}
    const { startCommandProcess } = loadBundled('src/main/execution/command-runner.ts')
    let terminalEvents = 0
    await new Promise((resolve, reject) => {
      startCommandProcess({
        program: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: workspace,
        outputMode: 'bytes',
        outputLimit: 1800,
        timeoutMs: 25,
        onError: reject,
        onClose: () => reject(new Error('timeout command closed before its timer')),
        onTimeout: (process) => {
          terminalEvents++
          process.stop()
          resolve()
        }
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(terminalEvents, 1, 'timeout requests termination once and suppresses a late close')

    console.log(
      'Workspace tools passed: read/search/list, boundary, authorization, scope, loop, create, hash-checked edit; real command exit/output/truncation/environment/spawn failure/cancellation/revocation/timeout.'
    )
  } finally {
    const cleanupRoot = path.resolve(temporaryRoot)
    assert.equal(path.dirname(cleanupRoot), base)
    assert.match(path.basename(cleanupRoot), /^zonecodex-workspace-tools-/)
    await rm(cleanupRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
