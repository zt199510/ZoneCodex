import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor, runProcess } from './runtime.mjs'

const evidence = await createEvidence('host-boundary')
const suite = checksFor(evidence, {
  ordinaryNode: true,
  staticTypeEdgesIncluded: true,
  syntheticTransport: true,
  realTransport: false,
  electronStarted: false,
  ticketsRehydrated: false,
  behaviorLockLessons: [55, 56, 57]
})
const sources = new Map()
const identity = {}
const slash = (file) => file.replaceAll('\\', '/')
async function source(file) {
  if (!sources.has(file)) {
    const text = await fs.readFile(path.join(root, file), 'utf8')
    sources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
    identity[file] = hash(text)
  }
  return sources.get(file)
}
function walk(node, inspect) {
  inspect(node)
  ts.forEachChild(node, (child) => walk(child, inspect))
}
function edges(tree) {
  const result = []
  walk(tree, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      result.push(node.argument.literal.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      assert(
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
        'Computed module access is outside the frozen boundary'
      )
      result.push(node.arguments[0].text)
    }
  })
  return [...new Set(result)]
}
async function resolveEdge(file, name) {
  const resolved = ts.resolveModuleName(
    name,
    path.join(root, file),
    { moduleResolution: ts.ModuleResolutionKind.Node10 },
    ts.sys
  ).resolvedModule
  if (resolved) return slash(path.relative(root, resolved.resolvedFileName))
  assert(!name.startsWith('.'), 'Unresolved relative dependency: ' + file + ' -> ' + name)
  return null
}
async function graph(entries) {
  const visited = new Set()
  const links = []
  const externals = new Set()
  const pending = [...entries]
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    assert(!file.startsWith('../'), 'Dependency escaped project source')
    visited.add(file)
    for (const name of edges(await source(file))) {
      const resolved = await resolveEdge(file, name)
      links.push({ from: file, name, to: resolved })
      if (resolved?.startsWith('src/')) pending.push(resolved)
      else externals.add(name)
    }
  }
  return { entries, files: [...visited].sort(), externals: [...externals].sort(), links }
}
const coreEntries = [
  'src/main/agent/agent-core.ts',
  'src/main/agent/agent-core-contract.ts',
  'src/main/agent/tool-loop.ts',
  'src/main/agent/context-manager.ts',
  'src/main/storage/task-checkpoint-store.ts',
  'src/shared/task-checkpoint.ts'
]
const pureEntries = ['src/main/agent/agent-runtime.ts', 'src/shared/permission-policy.ts']
let coreGraph, cliGraph, pureGraph, coreBundle
async function bundle(name, entries) {
  const outfile = path.join(evidence, name + '.cjs')
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: entries.map((file) => `export * from ${JSON.stringify('./' + file)};`).join('\n'),
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile,
    metafile: true,
    logLevel: 'silent'
  })
  for (const output of Object.values(result.metafile.outputs))
    assert(!output.imports.some((item) => /electron/.test(item.path)))
  const inputs = Object.keys(result.metafile.inputs).filter((file) => file !== '<stdin>')
  for (const file of inputs) identity[slash(file)] = hash(await fs.readFile(path.join(root, file)))
  await fs.writeFile(
    path.join(evidence, name + '.metafile.json'),
    JSON.stringify(result.metafile, null, 2)
  )
  return { outfile, inputs, sha256: hash(await fs.readFile(outfile)) }
}
function noDesktopClosure(result) {
  assert(!result.externals.some((name) => /electron/.test(name)), 'Electron package reached')
  assert(
    !result.files.some((file) =>
      /src\/main\/(?:agent\/(?:agent-runner|agent-ipc|desktop-agent-host|desktop-checkpoints|agent-user-input)|execution\/(?:permission-state|execution-context|execution-approval|action-authorization)|project\/(?:attachment-access|image-access|workspace-access))\.ts$/.test(
        file
      )
    ),
    'Desktop state or broker reached by a pure/CLI root'
  )
  assert(
    result.externals.every((name) => name.startsWith('node:')),
    'Non-Node package reached'
  )
}

await suite.check(
  'core, unique loop, context and checkpoint loader static closures exclude Electron and desktop state, including type imports',
  async () => {
    coreGraph = await graph(coreEntries)
    noDesktopClosure(coreGraph)
    await fs.writeFile(path.join(evidence, 'core-graph.json'), JSON.stringify(coreGraph, null, 2))
    return {
      roots: coreGraph.entries,
      modules: coreGraph.files.length,
      externals: coreGraph.externals
    }
  }
)

await suite.check(
  'shared dependency assembly and permission policy exclude Electron, window state and desktop brokers',
  async () => {
    pureGraph = await graph(pureEntries)
    noDesktopClosure(pureGraph)
    await fs.writeFile(path.join(evidence, 'pure-graph.json'), JSON.stringify(pureGraph, null, 2))
    return { roots: pureGraph.entries, modules: pureGraph.files.length }
  }
)

await suite.check(
  'entire CLI entry and library static closures stay ordinary Node without desktop reverse dependency',
  async () => {
    cliGraph = await graph(['src/cli/index.ts', 'src/cli/agent-host.ts'])
    noDesktopClosure(cliGraph)
    await fs.writeFile(path.join(evidence, 'cli-graph.json'), JSON.stringify(cliGraph, null, 2))
    assert(cliGraph.files.includes('src/main/agent/agent-runtime.ts'))
    return { roots: cliGraph.entries, modules: cliGraph.files.length }
  }
)

await suite.check(
  'runner remains only the frozen compatibility export surface and IPC calls the explicit desktop host',
  async () => {
    const runner = await source('src/main/agent/agent-runner.ts')
    assert(runner.statements.every(ts.isExportDeclaration), 'Runner acquired executable statements')
    assert.deepEqual(edges(runner), ['./desktop-agent-host'])
    const names = runner.statements.flatMap((statement) => {
      assert(statement.exportClause && ts.isNamedExports(statement.exportClause))
      return statement.exportClause.elements.map((item) => item.name.text)
    })
    assert.deepEqual(names.sort(), [
      'abortImageJob',
      'abortProjectJob',
      'cancelAgentJob',
      'hasAgentJob',
      'isAgentBusy',
      'runAgentRequest'
    ])
    const ipc = await source('src/main/agent/agent-ipc.ts')
    assert(edges(ipc).includes('./desktop-agent-host'))
    assert(!edges(ipc).includes('./agent-runner'))
    const channels = []
    walk(ipc, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(ipc) === 'ipcMain' &&
        node.expression.name.text === 'handle'
      ) {
        assert(ts.isStringLiteral(node.arguments[0]))
        channels.push(node.arguments[0].text)
      }
    })
    assert.deepEqual(channels.sort(), [
      'agent:cancel',
      'agent:resume',
      'agent:resume-info',
      'agent:start'
    ])
    return { compatibilityExports: names, ipcChannels: channels }
  }
)

await suite.check(
  'desktop and CLI hosts delegate assembly without implementing a second loop, context projection or call identity ledger',
  async () => {
    const forbiddenImports = [
      'buildAgentRequest',
      'createLiveResponse',
      'createContextSummaryResponse',
      'createAgentToolExecutor',
      'runToolLoop',
      'RequestContextManager',
      'contextLimits',
      'parseIncompleteToolTurn',
      'parseResumableHistory'
    ]
    const forbiddenBindings = [
      'roundAttempts',
      'commentaryPositions',
      'publicMessages',
      'executedCallIds',
      'seenCallIds'
    ]
    const facts = []
    for (const file of ['src/main/agent/desktop-agent-host.ts', 'src/cli/agent-host.ts']) {
      const tree = await source(file)
      const imports = []
      let coreCalls = 0
      walk(tree, (node) => {
        if (ts.isImportSpecifier(node)) imports.push((node.propertyName ?? node.name).text)
        if (ts.isIdentifier(node))
          assert(!forbiddenBindings.includes(node.text), file + ': forbidden identity ledger')
        if (ts.isCallExpression(node) && node.expression.getText(tree) === 'runAgentCore')
          coreCalls++
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
          assert(
            !/tool-loop|context-manager/.test(node.moduleSpecifier.text),
            file + ': direct orchestration dependency'
          )
      })
      assert(
        !imports.some((name) => forbiddenImports.includes(name)),
        file + ': shared orchestration copied into host'
      )
      assert.equal(coreCalls, 1, file + ': one explicit core delegation')
      assert(imports.includes('createAgentRuntime'))
      assert(imports.includes('createAgentRuntimeTools'))
      facts.push({ file, coreCalls, assembly: ['createAgentRuntime', 'createAgentRuntimeTools'] })
    }
    return facts
  }
)

await suite.check(
  'runAgentCore is the only production caller of the only declared tool loop',
  async () => {
    const files = new Set([
      ...(coreGraph?.files ?? []),
      ...(pureGraph?.files ?? []),
      ...(cliGraph?.files ?? []),
      'src/main/agent/desktop-agent-host.ts'
    ])
    const declarations = [],
      calls = []
    for (const file of files) {
      const tree = await source(file)
      walk(tree, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'runToolLoop')
          declarations.push(file)
        if (ts.isCallExpression(node) && node.expression.getText(tree) === 'runToolLoop')
          calls.push(file)
      })
    }
    assert.deepEqual(declarations, ['src/main/agent/tool-loop.ts'])
    assert.deepEqual(calls, ['src/main/agent/agent-core.ts'])
    return { declarations, calls }
  }
)

await suite.check(
  'core/shared assembly/CLI library and entry imports start zero network, commands, writers, checkpoint hydration, credentials or exit',
  async () => {
    const results = []
    for (const [name, entries] of [
      ['core', coreEntries],
      ['pure-runtime', pureEntries],
      ['cli-library', ['src/cli/agent-host.ts']],
      ['cli-entry', ['src/cli/index.ts']]
    ]) {
      const compiled = await bundle(name, entries)
      if (name === 'core') coreBundle = compiled
      const result = await runProcess(
        process.execPath,
        [path.join(root, 'tests/lesson58/inert-import-driver.cjs'), compiled.outfile],
        { cwd: root },
        15000
      )
      assert.equal(result.exitCode, 0, result.stderr)
      assert(!result.signal && !result.forcedKill)
      const facts = JSON.parse(result.stdout.trim())
      results.push({ name, pid: result.pid, sha256: compiled.sha256, ...facts })
    }
    return results
  }
)

await suite.check(
  'inert import guard rejects deferred credential reads and process exit even when their errors are swallowed',
  async () => {
    const attempts = []
    for (const [kind, action] of [
      ['credential', 'void process.env.MODEL_API_KEY'],
      ['exit', 'process.exit(0)']
    ]) {
      const file = path.join(evidence, 'guard-self-check-' + kind + '.cjs')
      await fs.writeFile(
        file,
        `module.exports = { fixture: true }\nPromise.resolve().then(() => { ${action} }).catch(() => {})\n`
      )
      const result = await runProcess(
        process.execPath,
        [path.join(root, 'tests/lesson58/inert-import-driver.cjs'), file],
        { cwd: root },
        15000
      )
      assert.equal(result.exitCode, 1, result.stdout + result.stderr)
      assert(!result.signal && !result.forcedKill)
      const rejected = JSON.parse(result.stderr.trim())
      assert.equal(rejected.pass, false)
      assert.equal(rejected.counts[kind], 1)
      assert.equal(
        Object.values(rejected.counts).reduce((total, count) => total + count, 0),
        1
      )
      await fs.writeFile(
        path.join(evidence, 'guard-self-check-' + kind + '.stdout.log'),
        result.stdout
      )
      await fs.writeFile(
        path.join(evidence, 'guard-self-check-' + kind + '.stderr.log'),
        result.stderr
      )
      attempts.push({ kind, pid: result.pid, exitCode: result.exitCode, counts: rejected.counts })
    }
    return attempts
  }
)

await suite.check(
  'ordinary Node executes the unique core with synthetic transport and preserves the complete frozen context limits',
  async () => {
    assert(coreBundle, 'Core import bundle was not produced')
    const api = createRequire(import.meta.url)(coreBundle.outfile)
    assert.deepEqual(api.contextLimits, {
      workingCharacters: 128000,
      triggerCharacters: 96000,
      rawTurnItems: 160,
      rawTurnCharacters: 128000,
      recentGroups: 2,
      summaryResponseCharacters: 6000,
      summaryProjectionCharacters: 20000,
      summaryInputCharacters: 32000,
      chunksPerPublication: 6,
      summaryRequests: 12,
      sourceGroups: 1000
    })
    let sends = 0,
      executions = 0
    const outcome = await api.runAgentCore(
      {
        requestId: randomUUID(),
        conversationId: randomUUID(),
        mode: 'execute',
        prompt: '固定普通 Node 断网任务',
        history: [],
        scope: { kind: 'time', executionId: 'a'.repeat(64) }
      },
      {
        signal: new AbortController().signal,
        assertCurrent: () => true,
        createTools: () => async () => {
          executions++
          return '{"ok":true}'
        },
        send: async (input) => {
          assert.equal(input[0].role, 'user')
          sends++
          return sends === 1
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: 'lesson58-node-call',
                    name: 'get_current_time',
                    arguments: '{}'
                  }
                ]
              }
            : {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    phase: 'final_answer',
                    content: [{ type: 'output_text', text: '合成任务完成' }]
                  }
                ]
              }
        }
      }
    )
    assert.equal(outcome.task.state, 'completed')
    assert.equal(outcome.task.result, '合成任务完成')
    assert.equal(sends, 2)
    assert.equal(executions, 1)
    return { sends, executions, limits: api.contextLimits }
  }
)

await suite.check(
  'every inspected source retains its captured identity through the boundary checks',
  async () => {
    for (const [file, expected] of Object.entries(identity))
      assert.equal(
        hash(await fs.readFile(path.join(root, file))),
        expected,
        file + ': source drift'
      )
    return { sourceFiles: Object.keys(identity).length, drift: 0 }
  }
)

await fs.writeFile(path.join(evidence, 'source-identity.json'), JSON.stringify(identity, null, 2))
await suite.finish({ sourceHashes: identity })
