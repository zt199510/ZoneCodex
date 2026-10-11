import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { root, hash, createEvidence, checksFor, compile } from './runtime.mjs'

const evidence = await createEvidence('terminal-isolation')
const suite = checksFor(evidence, {
  ordinaryNode: true,
  staticTypeEdgesIncluded: true,
  syntheticProtocol: true,
  syntheticTransport: false,
  realTransport: false,
  nativePty: false,
  ticketsRehydrated: false
})
const trees = new Map()
const identity = {}
const slash = (file) => file.replaceAll('\\', '/')
async function source(file) {
  if (!trees.has(file)) {
    const text = await fs.readFile(path.join(root, file), 'utf8')
    identity[file] = hash(text)
    trees.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
  }
  return trees.get(file)
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
        'Computed module access would bypass the terminal isolation graph'
      )
      result.push(node.arguments[0].text)
    }
  })
  return [...new Set(result)]
}
async function graph(entries) {
  const pending = [...entries]
  const visited = new Set()
  const links = []
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)
    for (const name of edges(await source(file))) {
      const resolved = ts.resolveModuleName(
        name,
        path.join(root, file),
        { moduleResolution: ts.ModuleResolutionKind.Node10 },
        ts.sys
      ).resolvedModule
      const target = resolved ? slash(path.relative(root, resolved.resolvedFileName)) : null
      assert(target || !name.startsWith('.'), 'Unresolved source edge: ' + file + ' -> ' + name)
      links.push({ from: file, name, to: target })
      if (target?.startsWith('src/')) pending.push(target)
    }
  }
  return { entries, files: [...visited].sort(), links }
}

await suite.check(
  'Agent core/tool executor/desktop host closures never reach terminal IPC, PTY or xterm',
  async () => {
    const result = await graph([
      'src/main/agent/agent-core.ts',
      'src/main/agent/tool-loop.ts',
      'src/main/agent/agent-tools.ts',
      'src/main/agent/desktop-agent-host.ts',
      'src/main/agent/agent-runtime.ts'
    ])
    assert(
      !result.files.some((file) =>
        /(?:main\/terminal|preload\/terminal|features\/terminal)/.test(file)
      )
    )
    assert(
      !result.links.some((link) => /node-pty|@xterm|terminal-api|local-terminal/.test(link.name))
    )
    await fs.writeFile(path.join(evidence, 'agent-graph.json'), JSON.stringify(result, null, 2))
    return { modules: result.files.length, terminalEdges: 0 }
  }
)

await suite.check(
  'terminal backend closure cannot invoke Agent, model transport, raw/checkpoint store or approval brokers',
  async () => {
    const result = await graph(['src/main/terminal/local-terminal.ts'])
    assert(
      !result.files.some((file) =>
        /src\/main\/(?:agent\/|model\/|execution\/|project\/(?:workspace-access|attachment-access|image-access)|storage\/(?:conversation|task-checkpoint))/.test(
          file
        )
      )
    )
    const tree = await source('src/main/terminal/local-terminal.ts')
    const forbidden = new Set([
      'runAgentCore',
      'runAgentRequest',
      'createLiveResponse',
      'createContextSummaryResponse',
      'generateConversationTitle',
      'createAgentToolExecutor',
      'WorkspaceReadEvidence',
      'setExecutionPermissionMode',
      'saveTaskCheckpoint',
      'createTaskCheckpoint',
      'authorizeCommand',
      'approve'
    ])
    walk(tree, (node) => {
      if (ts.isIdentifier(node)) assert(!forbidden.has(node.text), 'Terminal acquired ' + node.text)
    })
    await fs.writeFile(
      path.join(evidence, 'terminal-main-graph.json'),
      JSON.stringify(result, null, 2)
    )
    return { modules: result.files.length, forbiddenAgentOrAuthorityEdges: 0 }
  }
)

await suite.check(
  'TerminalPanel can call only its five terminal bridge methods and has no conversation/Agent dependency',
  async () => {
    const file = 'src/renderer/src/features/terminal/TerminalPanel.tsx'
    const tree = await source(file)
    const bridgeCalls = new Set()
    walk(tree, (node) => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(tree) === 'window.api')
        bridgeCalls.add(node.name.text)
      if (ts.isElementAccessExpression(node) && node.expression.getText(tree) === 'window.api') {
        assert(ts.isStringLiteral(node.argumentExpression), 'Computed bridge name is not isolated')
        bridgeCalls.add(node.argumentExpression.text)
      }
      if (ts.isPropertyAccessExpression(node) && node.getText(tree) === 'window.api') {
        assert(
          (ts.isPropertyAccessExpression(node.parent) ||
            ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node,
          'Terminal bridge must not escape into an uninspected alias or callback'
        )
      }
    })
    assert.deepEqual([...bridgeCalls].sort(), [
      'closeTerminal',
      'onTerminalEvent',
      'resizeTerminal',
      'startTerminal',
      'writeTerminal'
    ])
    const result = await graph([file])
    assert(
      !result.files.some((name) => /features\/(?:chat|conversation|execution|project)\//.test(name))
    )
    assert(!result.links.some((link) => /agent|model|checkpoint|conversation/.test(link.name)))
    await fs.writeFile(
      path.join(evidence, 'terminal-panel-graph.json'),
      JSON.stringify(result, null, 2)
    )
    return { bridgeCalls: [...bridgeCalls].sort(), conversationEdges: 0 }
  }
)

await suite.check(
  'main runtime keeps one terminal registration and actual-window cleanup attachment',
  async () => {
    const file = 'src/main/app-runtime.ts'
    const tree = await source(file)
    const counts = { registerLocalTerminal: 0, attachTerminalCleanup: 0 }
    walk(tree, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (Object.hasOwn(counts, node.expression.text)) counts[node.expression.text]++
        if (node.expression.text === 'attachTerminalCleanup') {
          assert.equal(node.arguments.length, 1)
          assert.equal(node.arguments[0].getText(tree), 'window')
        }
      }
    })
    assert.deepEqual(counts, { registerLocalTerminal: 1, attachTerminalCleanup: 1 })
    return counts
  }
)

const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/agent/agent-instructions.ts',
  'src/main/agent/agent-tools.ts',
  'src/main/agent/workspace-read-evidence.ts',
  'src/shared/project.ts',
  'src/shared/agent.ts',
  'src/shared/agent-history.ts',
  'src/shared/task-checkpoint.ts',
  'src/main/storage/task-checkpoint-store.ts'
])
Object.assign(identity, sourceHashes)
const forbiddenTools = [
  'terminal',
  'start_terminal',
  'write_terminal',
  'close_terminal',
  'startTerminal',
  'writeTerminal',
  'terminal:start',
  'terminal:write'
]
const expected = [
  'apply_workspace_patch',
  'create_workspace_file',
  'get_current_time',
  'list_workspace_files',
  'propose_command',
  'propose_file_change',
  'read_project_file',
  'read_workspace_file',
  'request_user_input',
  'run_workspace_command',
  'search_project_text',
  'search_workspace_text'
]
const execution = { cwd: evidence, mode: 'default', revision: 0, scopeId: 'a'.repeat(64) }
const scope = { kind: 'project', snapshotId: 'synthetic-snapshot', executionId: execution.scopeId }

await suite.check(
  'real tool declarations and shared active-scope whitelist contain only frozen non-terminal tools',
  () => {
    const all = new Set()
    const snapshots = []
    for (const mode of ['execute', 'plan'])
      for (const snapshot of [null, { selection: { files: [] } }])
        for (const context of [null, execution]) {
          const request = api.buildAgentRequest({ mode, snapshot, execution: context })
          const names = request.tools.map((tool) => tool.name).sort()
          names.forEach((name) => all.add(name))
          assert(!names.some((name) => /terminal|pty|shell/i.test(name)))
          snapshots.push({ mode, snapshot: !!snapshot, execution: !!context, tools: names })
          for (const name of forbiddenTools)
            assert.equal(api.isToolAllowed(name, scope, mode), false)
        }
    assert.deepEqual([...all].sort(), expected)
    return { tools: [...all].sort(), snapshots }
  }
)

await suite.check(
  'actual executor refuses terminal names before approvals, command proposals or effects',
  async () => {
    const counters = { approvals: 0, commands: 0, effects: 0, proposals: 0 }
    for (const mode of ['execute', 'plan']) {
      const executor = api.createAgentToolExecutor({
        mode,
        execution: { info: execution },
        assertCurrent: () => true,
        approve: () => {
          counters.approvals++
          throw new Error('Unexpected approval')
        },
        authorizeCommand: () => {
          counters.commands++
          throw new Error('Unexpected command')
        },
        onEffect: () => {
          counters.effects++
        },
        appendTrace: () => undefined,
        onProgress: () => undefined,
        projectSnapshot: null,
        projectExecutor: undefined,
        executeCommandProposal: () => {
          counters.proposals++
          throw new Error('Unexpected proposal')
        }
      })
      for (const name of forbiddenTools)
        await assert.rejects(() =>
          executor(name, '{}', new AbortController().signal, 'forbidden-call')
        )
    }
    assert.deepEqual(counters, { approvals: 0, commands: 0, effects: 0, proposals: 0 })
    return counters
  }
)

const history = [{ role: 'user', content: '独立固定任务，不包含终端输出。' }]
const binding = await api.captureTaskDirectoryBinding(evidence)
const checkpointInput = {
  taskId: randomUUID(),
  mode: 'execute',
  prompt: history[0].content,
  scope,
  bindings: { cwd: binding, workspace: null },
  history,
  progress: 'interrupted',
  reason: 'host_exit'
}
const checkpoint = api.createTaskCheckpoint(checkpointInput)
const terminalEvent = { sessionId: randomUUID(), type: 'data', data: 'zonecodex-terminal-59' }

await suite.check(
  'checkpoint v1 rejects terminal session/PTY/output/history/cwd authority fields without sanitizing',
  () => {
    assert(api.parseTaskCheckpoint(checkpoint))
    for (const field of [
      'terminal',
      'terminalSession',
      'terminalSessionId',
      'terminalOutput',
      'terminalHistory',
      'terminalCwd',
      'pty',
      'readEvidence',
      'approval',
      'commandTicket'
    ])
      assert.equal(api.parseTaskCheckpoint({ ...checkpoint, [field]: terminalEvent }), null, field)
    for (const field of ['raw', 'bindings', 'scope']) {
      const candidate = structuredClone(checkpoint)
      candidate[field].terminalSession = terminalEvent
      assert.equal(api.parseTaskCheckpoint(candidate), null, field)
    }
    return { schemaVersion: checkpoint.schemaVersion, rejectedHostFields: 11 }
  }
)

await suite.check(
  'PTY events or terminal function calls cannot be accepted as Agent raw/checkpoint protocol',
  () => {
    for (const raw of [
      [...history, terminalEvent],
      [
        ...history,
        { type: 'function_call', name: 'write_terminal', call_id: 'pty-call', arguments: '{}' }
      ],
      [{ ...history[0], terminalOutput: terminalEvent.data }],
      [{ ...history[0], pty: terminalEvent }]
    ])
      assert.throws(
        () => api.createTaskCheckpoint({ ...checkpointInput, history: raw }),
        (error) => error.code === 'RAW_INVALID'
      )
    assert.equal(api.parseResumableHistory([...history, terminalEvent], scope, 'execute'), null)
  }
)

await suite.check(
  'wrapped PTY event carries no read credential even when its text claims a matching file hash',
  () => {
    const credentials = new api.WorkspaceReadEvidence()
    const file = path.join(evidence, 'never-read.txt')
    const sha256 = 'b'.repeat(64)
    const format = { encoding: 'utf-8', hasUtf8Bom: false, newline: 'none', trailingNewlines: 0 }
    const text = 'read claim'
    credentials.observe(
      JSON.stringify({
        ...terminalEvent,
        data: JSON.stringify({
          ok: true,
          path: file,
          sha256,
          totalLines: 1,
          format,
          lines: [{ line: 1, text, truncated: false }]
        })
      })
    )
    assert.match(
      credentials.check(file, sha256, text, format, [{ startLine: 1, before: [text] }]),
      /读取/
    )
    return { terminalEventGrantedReadCredential: false }
  }
)

await suite.check(
  'test scheduler adds a separate lesson59 group while preserving all lesson58 default locks',
  async () => {
    const file = 'package.json'
    const text = await fs.readFile(path.join(root, file), 'utf8')
    identity[file] = hash(text)
    const pkg = JSON.parse(text)
    assert.equal(pkg.scripts.test, 'node scripts/checks/lesson58.mjs offline')
    assert.equal(pkg.scripts['test:list'], 'node scripts/checks/lesson58.mjs list')
    assert.equal(pkg.scripts['test:lesson59:offline'], 'node scripts/checks/lesson59.mjs offline')
    const scheduling = await fs.readFile(path.join(root, 'scripts/checks/lesson58.mjs'), 'utf8')
    assert(scheduling.includes("['boundary', 'boundary-check.mjs']"))
    assert(scheduling.includes("['resume-safety', 'resume-safety-check.mjs']"))
  }
)

await fs.writeFile(
  path.join(evidence, 'isolation-source-identity.json'),
  JSON.stringify(identity, null, 2)
)
await suite.finish({
  sourceHashes: identity,
  compiledSHA256,
  notCovered: [
    'actual App interaction/model counters (desktop suite)',
    'real network model',
    'non-Windows native shell'
  ]
})
