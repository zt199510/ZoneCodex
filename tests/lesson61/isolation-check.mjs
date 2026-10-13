import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import { root, hash, createEvidence, checksFor, compile } from './runtime.mjs'

const evidence = await createEvidence('isolation')
const identity = {}
const trees = new Map()
async function source(file) {
  if (!trees.has(file)) {
    const text = await fs.readFile(path.join(root, file), 'utf8')
    identity[file] = hash(text)
    trees.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
  }
  return trees.get(file)
}
function walk(node, action) {
  action(node)
  ts.forEachChild(node, (child) => walk(child, action))
}
function edges(tree) {
  const output = []
  walk(tree, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      output.push(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      output.push(node.argument.literal.text)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      assert(
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
        'Computed source import would bypass isolation checks'
      )
      output.push(node.arguments[0].text)
    }
  })
  return [...new Set(output)]
}
async function graph(entries) {
  const pending = [...entries],
    files = new Set(),
    links = []
  while (pending.length) {
    const file = pending.pop()
    if (files.has(file)) continue
    files.add(file)
    for (const name of edges(await source(file))) {
      const resolved = ts.resolveModuleName(
        name,
        path.join(root, file),
        { moduleResolution: ts.ModuleResolutionKind.Node10 },
        ts.sys
      ).resolvedModule
      const target = resolved
        ? path.relative(root, resolved.resolvedFileName).replaceAll('\\', '/')
        : null
      assert(
        target || !name.startsWith('.'),
        'Unresolved local source import: ' + file + ' -> ' + name
      )
      links.push({ from: file, name, to: target })
      if (target?.startsWith('src/')) pending.push(target)
    }
  }
  return { entries, files: [...files].sort(), links }
}
const suite = checksFor(evidence, {
  ordinaryNode: true,
  staticTypeEdgesIncluded: true,
  syntheticAgentExecutor: true,
  actualGitIPCInteractions: false,
  actualElectron: false,
  nativeGit: false,
  realTransport: false,
  ticketsRehydrated: false
})

await suite.check(
  'Agent core, loop and desktop host closures cannot acquire Git viewer or its IPC',
  async () => {
    const result = await graph([
      'src/main/agent/agent-core.ts',
      'src/main/agent/tool-loop.ts',
      'src/main/agent/agent-tools.ts',
      'src/main/agent/desktop-agent-host.ts',
      'src/main/agent/agent-runtime.ts'
    ])
    assert(
      !result.files.some((file) => /(?:main\/git\/|preload\/git-api|features\/git\/)/.test(file))
    )
    assert(!result.links.some((link) => /git-api|git-view-ipc|git-service/.test(link.name)))
    await fs.writeFile(path.join(evidence, 'agent-graph.json'), JSON.stringify(result, null, 2))
    return { modules: result.files.length, gitHostEdges: 0 }
  }
)

await suite.check(
  'lesson61 read-only Git backend closure contains no model, tool loop, permission mutation, workspace grant or persistence sink',
  async () => {
    // The later, explicitly requested text generator has its own dedicated isolation suite.
    const files = ['git-process', 'git-snapshot', 'git-status', 'git-reader', 'git-ipc']
      .map((file) => 'src/main/git/' + file + '.ts')
    assert(files.length > 0, 'Git backend must exist for this check')
    const result = await graph(files)
    assert(
      !result.files.some((file) =>
        /src\/main\/(?:model\/|terminal\/|storage\/(?:conversation|task-checkpoint)|project\/(?:workspace-access|attachment-access|image-access)|agent\/(?:agent-core|tool-loop|agent-runtime|desktop-agent-host|workspace-read-evidence))/.test(
          file
        )
      )
    )
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
      'requestExecutionApproval',
      'requestAgentUserInput',
      'captureWorkspaceAccess',
      'selectWorkspace',
      'bindConversationDirectory'
    ])
    for (const file of files)
      walk(await source(file), (node) => {
        if (ts.isCallExpression(node)) {
          const expression = node.expression
          const name = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : null
          assert(!forbidden.has(name), 'Git viewer acquired forbidden operation: ' + name)
        }
      })
    await fs.writeFile(path.join(evidence, 'git-main-graph.json'), JSON.stringify(result, null, 2))
    return { modules: result.files.length, currentMainEntries: files, forbiddenOperations: 0 }
  }
)

await suite.check(
  'shared Git contract is pure and preload exposes only five literal Git invoke channels',
  async () => {
    const shared = await graph(['src/shared/git-view.ts'])
    assert.deepEqual(shared.files, ['src/shared/git-view.ts'])
    const tree = await source('src/preload/git-api.ts')
    const channels = []
    walk(tree, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(tree) === 'ipcRenderer'
      ) {
        assert.equal(node.expression.name.text, 'invoke')
        assert(ts.isStringLiteral(node.arguments[0]))
        channels.push(node.arguments[0].text)
      }
    })
    assert.deepEqual(channels.sort(), [
      'git:cancel',
      'git:list',
      'git:read',
      'git:release',
      'git:select'
    ])
    const preload = await source('src/preload/index.ts')
    let imports = 0,
      spreads = 0
    walk(preload, (node) => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.getText(preload) === "'./git-api'")
        imports++
      if (ts.isSpreadAssignment(node) && node.expression.getText(preload) === 'gitAPI') spreads++
    })
    assert.equal(imports, 1)
    assert.equal(spreads, 1)
    return { channels, flatAPIGroupMountedOnce: true }
  }
)

const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/agent/agent-instructions.ts',
  'src/main/agent/agent-tools.ts',
  'src/main/agent/workspace-read-evidence.ts',
  'src/shared/project.ts',
  'src/shared/agent-history.ts',
  'src/shared/task-checkpoint.ts',
  'src/main/storage/task-checkpoint-store.ts'
])
Object.assign(identity, sourceHashes)
const forbiddenTools = [
  'git',
  'git_status',
  'git_diff',
  'read_git_item',
  'select_git_directory',
  'refreshGitView',
  'readGitItem',
  'git:list',
  'git:read'
]
const execution = { cwd: evidence, mode: 'default', revision: 0, scopeId: 'a'.repeat(64) }
const scope = { kind: 'project', snapshotId: 'snapshot-isolation', executionId: execution.scopeId }

await suite.check(
  'current Agent tool declarations and active-scope whitelist never admit manual Git operations',
  () => {
    const all = new Set()
    for (const mode of ['execute', 'plan'])
      for (const snapshot of [null, { selection: { files: [] } }])
        for (const context of [null, execution]) {
          const request = api.buildAgentRequest({ mode, snapshot, execution: context })
          request.tools.forEach((tool) => all.add(tool.name))
          for (const name of forbiddenTools)
            assert.equal(api.isToolAllowed(name, scope, mode), false)
        }
    assert(![...all].some((name) => /git|refreshGitView|readGitItem/.test(name)))
    return { actualToolNames: [...all].sort(), admittedManualGitTools: 0 }
  }
)

await suite.check(
  'actual Agent executor rejects Git viewer names before approvals, command proposals, grants or effects',
  async () => {
    const counters = { approval: 0, commands: 0, effects: 0, proposals: 0 }
    for (const mode of ['execute', 'plan']) {
      const executor = api.createAgentToolExecutor({
        mode,
        execution: { info: execution },
        assertCurrent: () => true,
        approve: () => {
          counters.approval++
          throw new Error('Unexpected approval')
        },
        authorizeCommand: () => {
          counters.commands++
          throw new Error('Unexpected command authorization')
        },
        onEffect: () => counters.effects++,
        appendTrace: () => undefined,
        onProgress: () => undefined,
        projectSnapshot: null,
        projectExecutor: undefined,
        executeCommandProposal: () => {
          counters.proposals++
          throw new Error('Unexpected command proposal')
        }
      })
      for (const name of forbiddenTools)
        await assert.rejects(() =>
          executor(name, '{}', new AbortController().signal, 'forbidden-git-call')
        )
    }
    assert.deepEqual(counters, { approval: 0, commands: 0, effects: 0, proposals: 0 })
    return counters
  }
)

const history = [{ role: 'user', content: '独立固定任务，不包含人工 Git 查看内容。' }]
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
const gitResult = {
  status: 'ready',
  requestId: 'git-request',
  viewId: 'git-view',
  revision: 'git-list',
  itemId: 'git-item',
  text: 'manual Git preview'
}

await suite.check(
  'checkpoint v1 and raw protocol reject Git scope, displayed content and claimed host authority without sanitizing them',
  () => {
    assert(api.parseTaskCheckpoint(checkpoint))
    for (const key of [
      'git',
      'gitView',
      'gitViewId',
      'gitRevision',
      'gitItem',
      'gitContent',
      'gitRepository',
      'gitReadEvidence',
      'approval',
      'commandTicket'
    ])
      assert.equal(api.parseTaskCheckpoint({ ...checkpoint, [key]: gitResult }), null, key)
    for (const key of ['raw', 'bindings', 'scope']) {
      const candidate = structuredClone(checkpoint)
      candidate[key].gitView = gitResult
      assert.equal(api.parseTaskCheckpoint(candidate), null)
    }
    for (const raw of [
      [...history, gitResult],
      [{ ...history[0], gitContent: gitResult.text }],
      [
        ...history,
        { type: 'function_call', name: 'read_git_item', call_id: 'git-view-call', arguments: '{}' }
      ]
    ]) {
      assert.throws(
        () => api.createTaskCheckpoint({ ...checkpointInput, history: raw }),
        (error) => error.code === 'RAW_INVALID'
      )
      assert.equal(api.parseResumableHistory(raw, scope, 'execute'), null)
    }
    return { originalSchemaVersion: checkpoint.schemaVersion, hostFieldsRejected: 10 }
  }
)

await suite.check(
  'manual Git result text cannot grant WorkspaceReadEvidence even when it claims matching file hash and lines',
  () => {
    const credentials = new api.WorkspaceReadEvidence()
    const file = path.join(evidence, 'never-granted.txt')
    const sha256 = 'b'.repeat(64)
    const format = { encoding: 'utf-8', hasUtf8Bom: false, newline: 'none', trailingNewlines: 0 }
    const text = 'manual view claims a read'
    credentials.observe(
      JSON.stringify({
        ...gitResult,
        text: JSON.stringify({
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
    return { grantedAgentReadEvidence: false }
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
    'actual Git IPC lifecycle and cross-window scopes (main/native suite)',
    'actual desktop model/permission/storage counters (desktop suite)',
    'real network model',
    'all native handle retirement'
  ]
})
