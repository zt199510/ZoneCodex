const assert = require('node:assert/strict')
const {
    parseLibrary,
    migrateV1,
    readLibrary,
    getActiveConversation
} = require('../.ui-check/lesson13-build/conversation-library.js')

const message = { id: 'm1', role: 'user', content: '学习 React', status: 'complete' }
const old = { version: 1, messages: [message], workspacePath: null }
const before = JSON.stringify(old)
const migrated = migrateV1(old, 'legacy-chat')
assert.ok(migrated)
assert.equal(migrated.version, 2)
assert.equal(migrated.activeConversationId, 'legacy-chat')
assert.deepEqual(migrated.conversations[0].messages, old.messages)
assert.equal(JSON.stringify(old), before)
assert.notEqual(migrated.conversations[0].messages[0], message)
assert.deepEqual(parseLibrary(migrated), migrated)
assert.deepEqual(readLibrary(old, 'legacy-chat'), migrated)
assert.deepEqual(readLibrary(migrated, 'unused-id'), migrated)
assert.equal('workspacePath' in migrated, false)

const two = parseLibrary({
    ...migrated,
    conversations: [
        ...migrated.conversations,
        { id: 'second-chat', title: 'Electron', messages: [{ ...message, content: '学习 Electron' }] }
    ]
})
assert.ok(two)
assert.equal(getActiveConversation(two).messages[0].content, '学习 React')
const switched = { ...two, activeConversationId: 'second-chat' }
assert.equal(getActiveConversation(switched).messages[0].content, '学习 Electron')
assert.equal(two.activeConversationId, 'legacy-chat')

const empty = parseLibrary({ version: 2, conversations: [], activeConversationId: null })
assert.ok(empty)
assert.equal(getActiveConversation(empty), null)
assert.equal(migrateV1({ ...old, messages: [] }, 'empty-chat').conversations.length, 1)
assert.equal(parseLibrary({ ...two, activeConversationId: 'missing' }), null)
assert.equal(parseLibrary({ ...two, activeConversationId: null }), null)
assert.equal(parseLibrary({ ...empty, activeConversationId: 'missing' }), null)
assert.equal(parseLibrary({ ...two, conversations: [two.conversations[0], two.conversations[0]] }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], title: ' ' }] }), null)
assert.equal(parseLibrary({ ...two, conversations: [{ ...two.conversations[0], messages: [message, message] }] }), null)
assert.equal(migrateV1({ ...old, messages: [{ ...message, role: 'invalid' }] }, 'legacy-chat'), null)
assert.equal(migrateV1(old, ' '), null)
assert.equal(readLibrary({ version: 99 }, 'legacy-chat'), null)
assert.equal(readLibrary(null, 'legacy-chat'), null)

const pending = migrateV1({ ...old, messages: [{ ...message, status: 'pending' }] }, 'pending-chat')
assert.equal(pending.conversations[0].messages[0].status, 'pending')

const tooManyChats = Array.from({ length: 101 }, (_, index) => ({
    id: `c${index}`, title: '测试', messages: []
}))
assert.equal(parseLibrary({ version: 2, activeConversationId: 'c0', conversations: tooManyChats }), null)
const messages = Array.from({ length: 501 }, (_, index) => ({ ...message, id: `m${index}` }))
assert.equal(parseLibrary({
    version: 2, activeConversationId: 'a', conversations: [
        { id: 'a', title: 'A', messages }, { id: 'b', title: 'B', messages }
    ]
}), null)
const longMessages = Array.from({ length: 6 }, (_, index) => ({
    id: `long${index}`, role: 'assistant', status: 'complete', content: 'x'.repeat(100_000)
}))
assert.equal(parseLibrary({
    version: 2, activeConversationId: 'a', conversations: [
        { id: 'a', title: 'A', messages: longMessages }, { id: 'b', title: 'B', messages: longMessages }
    ]
}), null)

console.log('第十三课通过：旧版迁移、活动会话、消息隔离、非法输入与总量限制。')
