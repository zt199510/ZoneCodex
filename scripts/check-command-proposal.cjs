const assert = require('node:assert/strict')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(require('node:fs').readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    filename
  )
const {
  parseCommandProposalArgs: args,
  parseCommandProposalOutput: output,
  deriveMessageCommandProposal: derive
} = require('../src/shared/command-proposal.ts')
const { createCommandProposalExecutor } = require('../src/main/tools/command-proposal.ts')
const { createProjectMock } = require('../src/main/model/project-response.ts')
const { runToolLoop } = require('../src/main/agent/tool-loop.ts')
const { parseLibrary } = require('../src/shared/conversation-library.ts')
const { isToolAllowed } = require('../src/shared/project.ts')
async function main() {
  const valid = { template: 'npm_typecheck', reason: '  检查类型  ' }
  assert.equal(args(valid).reason, '检查类型')
  for (const key of ['cwd', 'command', 'env', 'args'])
    assert.equal(args({ ...valid, [key]: 'x' }), null)
  for (const reason of ['', ' ', 'x'.repeat(501), 'x\n', '\u0085'])
    assert.equal(args({ ...valid, reason }), null)
  assert.equal(args({ ...valid, template: 'other' }), null)
  assert.equal(args(Object.create(valid)), null)
  assert.equal(
    args(
      Object.defineProperty({ template: 'npm_typecheck' }, 'reason', {
        get() {
          throw Error('getter')
        }
      })
    ),
    null
  )
  assert.equal(output({ status: 'approved', template: 'npm_typecheck' }), null)
  assert.equal(output({ status: 'error', error: 'x'.repeat(501) }), null)
  assert.equal(output({ status: 'proposal_ready', template: 'npm_typecheck', cwd: '.' }), null)
  const execute = createCommandProposalExecutor()
  const signal = new AbortController().signal
  const invoke = (value) =>
    execute('propose_command', JSON.stringify(value), signal).then(JSON.parse)
  assert.equal((await invoke({ ...valid, cwd: '.' })).status, 'error')
  assert.equal(
    JSON.parse(await execute('propose_command', ' '.repeat(4097), signal)).status,
    'error'
  )
  assert.equal((await invoke(valid)).status, 'proposal_ready')
  assert.equal((await invoke(valid)).status, 'error')
  const cancelled = AbortSignal.abort()
  await assert.rejects(
    createCommandProposalExecutor()('propose_command', JSON.stringify(valid), cancelled)
  )
  const selection = {
    snapshotId: 'snapshot-26',
    label: 'fixture',
    createdAt: new Date().toISOString(),
    files: []
  }
  const scope = { kind: 'project', snapshotId: selection.snapshotId }
  assert.equal(isToolAllowed('propose_command', { kind: 'time' }), false)
  const result = await runToolLoop(
    '模拟命令提案',
    createProjectMock(selection),
    signal,
    [],
    () => {},
    [],
    createCommandProposalExecutor(),
    scope
  )
  assert.match(result.answer, /尚未运行/)
  const user = { id: 'user-26', role: 'user', content: '模拟命令提案', status: 'complete' }
  const assistant = {
    id: 'assistant-26',
    role: 'assistant',
    content: result.answer,
    status: 'complete'
  }
  const run = {
    requestId: 'request-26',
    userId: user.id,
    assistantId: assistant.id,
    mode: 'mock',
    scope,
    items: result.items,
    trace: []
  }
  assert(derive('conversation-26', run, user, assistant))
  for (const status of ['failed', 'cancelled', 'pending'])
    assert.equal(derive('conversation-26', run, user, { ...assistant, status }), null)
  const changed = structuredClone(run)
  changed.items.find((i) => i.type === 'function_call_output').call_id = 'mismatch'
  assert.equal(derive('conversation-26', changed, user, assistant), null)
  const duplicate = structuredClone(run)
  const pair = duplicate.items
    .filter((i) => i.type === 'function_call' || i.type === 'function_call_output')
    .map((i) => ({ ...i, call_id: 'second' }))
  duplicate.items.splice(-1, 0, ...pair)
  assert.equal(derive('conversation-26', duplicate, user, assistant), null)
  const library = {
    version: 4,
    activeConversationId: 'conversation-26',
    conversations: [
      { id: 'conversation-26', title: '测试', messages: [user, assistant], toolRuns: [run] }
    ]
  }
  assert(parseLibrary(JSON.parse(JSON.stringify(library))))
  console.log(
    'Lesson 26 protocol checks passed: exact parameters, quota, cancellation, mock loop, scope, pairing, failed rounds and v4 history.'
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
