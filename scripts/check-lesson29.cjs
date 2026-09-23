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

const { runToolLoop } = require('../src/main/agent/tool-loop.ts')
const { createCommandProposalExecutor } = require('../src/main/tools/command-proposal.ts')
const { deriveMessageCommandProposal } = require('../src/shared/command-proposal.ts')

const scope = { kind: 'project', snapshotId: 'snapshot-29' }
const signal = new AbortController().signal

async function run() {
  const callId = 'call_live_29'
  const responses = [
    {
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: callId,
          name: 'propose_command',
          arguments: JSON.stringify({
            template: 'npm_typecheck',
            reason: '检查项目类型；需要用户选择目录并确认后才执行。'
          })
        }
      ]
    },
    (input) => ({
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [
            {
              type: 'output_text',
              text: input.at(-1).output.includes('proposal_ready')
                ? '已提出类型检查建议，尚未执行。'
                : '提案被拒绝。'
            }
          ]
        }
      ]
    })
  ]
  let round = 0
  const result = await runToolLoop(
    '检查项目类型',
    async (input) => (typeof responses[round] === 'function' ? responses[round++](input) : responses[round++]),
    signal,
    [],
    () => undefined,
    [],
    createCommandProposalExecutor(),
    scope
  )
  assert.match(result.answer, /尚未执行/)
  const user = { id: 'user-29', role: 'user', content: '检查项目类型', status: 'complete' }
  const assistant = { id: 'assistant-29', role: 'assistant', content: result.answer, status: 'complete' }
  const runRecord = {
    requestId: 'request-29',
    userId: user.id,
    assistantId: assistant.id,
    mode: 'live',
    scope,
    trace: [],
    items: result.items
  }
  const proposal = deriveMessageCommandProposal('conversation-29', runRecord, user, assistant)
  assert.equal(proposal.template, 'npm_typecheck')
  assert.equal(proposal.snapshotId, scope.snapshotId)

  const invalidResult = await runToolLoop(
    '检查项目类型',
    async () => ({
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_bad_29', name: 'propose_command', arguments: JSON.stringify({ template: 'npm_typecheck', reason: 'x', cwd: 'D:\\' }) }]
    }),
    signal,
    [],
    () => undefined,
    [],
    createCommandProposalExecutor(),
    scope
  ).catch((error) => error)
  assert.match(invalidResult.message, /重复 call_id|工具调用上限|未继续执行工具/)

  const textOnly = await runToolLoop(
    '检查项目类型',
    async () => ({
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '当前无法提出工具调用。' }] }]
    }),
    signal,
    [],
    () => undefined,
    [],
    createCommandProposalExecutor(),
    scope
  )
  assert.equal(textOnly.items.some((item) => item.type === 'function_call'), false)
  console.log('Lesson 29 live proposal checks passed: real-style call, strict rejection, message association, and text-only response.')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
