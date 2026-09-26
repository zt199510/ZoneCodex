const assert = require('node:assert/strict')
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => {
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
}

const { parseTaskRecord, parseTaskRecords, isTerminalTaskStatus } = require('../src/shared/task.ts')

const base = {
  taskId: 'task-32',
  requestId: 'request-32',
  conversationId: 'conversation-32',
  kind: 'agent',
  status: 'created',
  createdAt: '2026-09-25T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null
}

assert.deepEqual(parseTaskRecord(base), base)
assert.equal(parseTaskRecord({ ...base, preparedId: 'must-not-persist' }), null)
assert.equal(parseTaskRecord({ ...base, status: 'unknown' }), null)
assert.equal(parseTaskRecord({ ...base, taskId: 'bad id' }), null)
assert.equal(parseTaskRecords([base, { ...base, taskId: 'task-33', requestId: 'request-33' }]).length, 2)
assert.equal(parseTaskRecords([base, base]), null)
assert.equal(isTerminalTaskStatus('interrupted'), true)
assert.equal(isTerminalTaskStatus('running'), false)

console.log('Lesson 32 task protocol checks passed: bounded records, strict fields, duplicate rejection and terminal states.')
