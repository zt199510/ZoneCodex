const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    filename
  )
}

const { parseTaskRecords, maxTaskRecords } = require('../src/shared/task.ts')
const { canTransitionTaskStatus } = require('../src/main/agent/task-registry.ts')

assert.equal(canTransitionTaskStatus('created', 'running'), true)
assert.equal(canTransitionTaskStatus('running', 'completed'), true)
assert.equal(canTransitionTaskStatus('waiting_approval', 'running'), true)
assert.equal(canTransitionTaskStatus('created', 'completed'), false)
assert.equal(canTransitionTaskStatus('running', 'created'), false)
assert.equal(canTransitionTaskStatus('completed', 'running'), false)

const record = (index) => ({
  taskId: `task-33-${index}`,
  requestId: `request-33-${index}`,
  conversationId: 'conversation-33',
  kind: 'chat',
  status: 'completed',
  createdAt: '2026-09-26T00:00:00.000Z',
  startedAt: '2026-09-26T00:00:01.000Z',
  finishedAt: '2026-09-26T00:00:02.000Z',
  result: 'ok',
  error: null
})

assert.equal(
  parseTaskRecords(Array.from({ length: maxTaskRecords }, (_, index) => record(index))).length,
  maxTaskRecords
)
assert.equal(
  parseTaskRecords(Array.from({ length: maxTaskRecords + 1 }, (_, index) => record(index))),
  null
)

console.log(
  'Lesson 33 lifecycle checks passed: transition direction, terminal closure and bounded records.'
)
