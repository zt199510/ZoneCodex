const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    filename
  )
}

const {
  parseLibrary,
  parseLibraryV4,
  migrateV1,
  migrateV4,
  readLibrary,
  getActiveConversation
} = require('../src/shared/conversation-library.ts')

const message = { id: 'm1', role: 'user', content: '学习 React', status: 'complete' }
const oldV1 = { version: 1, messages: [message], workspacePath: null }
const oldV4 = {
  version: 4,
  activeConversationId: 'legacy-chat',
  conversations: [{ id: 'legacy-chat', title: '历史会话', messages: [message], toolRuns: [], workspace: null, tasks: [] }]
}
const before = JSON.stringify(oldV4)
const migrated = migrateV4(oldV4)
assert.ok(migrated)
assert.equal(migrated.version, 5)
assert.equal(migrated.conversations[0].pinned, false)
assert.equal(migrated.conversations[0].archived, false)
assert.equal(JSON.stringify(oldV4), before)
assert.deepEqual(readLibrary(oldV4, 'unused-id'), migrated)
assert.deepEqual(parseLibrary(migrated), migrated)
assert.deepEqual(parseLibraryV4(oldV4)?.conversations[0].messages, oldV4.conversations[0].messages)
assert.equal(parseLibraryV4({ ...oldV4, extra: true }), null)

const v1 = migrateV1(oldV1, 'legacy-v1')
assert.ok(v1)
assert.equal(v1.version, 5)
assert.deepEqual(readLibrary(oldV1, 'legacy-v1'), v1)
assert.notEqual(v1.conversations[0].messages[0], message)

const second = {
  id: 'second-chat', title: 'Electron', pinned: true, archived: false,
  messages: [{ ...message, content: '学习 Electron' }], toolRuns: [], workspace: null, tasks: []
}
const two = parseLibrary({ ...migrated, conversations: [...migrated.conversations, second] })
assert.ok(two)
assert.equal(getActiveConversation(two)?.messages[0].content, '学习 React')
const switched = parseLibrary({ ...two, activeConversationId: 'second-chat' })
assert.equal(getActiveConversation(switched)?.messages[0].content, '学习 Electron')
assert.equal(parseLibrary({ ...two, activeConversationId: 'second-chat', extra: true }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], extra: true }, two.conversations[1]] }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], pinned: 'yes' }, two.conversations[1]] }), null)
assert.equal(parseLibrary({ ...two, activeConversationId: 'missing' }), null)
assert.ok(parseLibrary({ ...two, activeConversationId: null }))
assert.equal(parseLibrary({ ...two, conversations: [two.conversations[0], two.conversations[0]] }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], title: ' ' }, two.conversations[1]] }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], messages: [message, message] }, two.conversations[1]] }), null)
assert.equal(parseLibrary({ ...two, activeConversationId: 'second-chat', conversations: [two.conversations[0], { ...two.conversations[1], archived: true }] }), null)

const archived = parseLibrary({ ...two, activeConversationId: null, conversations: two.conversations.map((item) => ({ ...item, archived: true })) })
assert.ok(archived)
assert.equal(getActiveConversation(archived), null)
assert.equal(migrateV1({ ...oldV1, messages: [{ ...message, status: 'invalid' }] }, 'legacy-v1'), null)
assert.equal(readLibrary({ version: 99 }, 'legacy-chat'), null)
assert.equal(readLibrary(null, 'legacy-chat'), null)

console.log('Lesson 35 conversation library checks passed: v4 to v5 migration, strict metadata, archive invariant and legacy compatibility.')
