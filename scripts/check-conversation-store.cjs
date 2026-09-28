const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const ts = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    filename
  )
}

const { createConversationStore } = require('../src/main/storage/conversation-store.ts')

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zonecodex-conversation-store-'))
  try {
    const old = {
      version: 4,
      activeConversationId: 'store-v4',
      conversations: [{
        id: 'store-v4', title: '旧版本', messages: [], toolRuns: [], workspace: null, tasks: []
      }]
    }
    fs.writeFileSync(path.join(directory, 'conversation.json'), JSON.stringify(old))
    const store = createConversationStore(directory)
    const loaded = await store.load()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.snapshot.version, 5)
    assert.equal(loaded.snapshot.conversations[0].pinned, false)
    assert.equal(loaded.snapshot.conversations[0].archived, false)
    const backups = fs.readdirSync(directory).filter((name) => name.startsWith('conversation-v4-'))
    assert.equal(backups.length, 1)
    const saved = await store.save(loaded.snapshot)
    assert.deepEqual(saved, { ok: true })

    const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zonecodex-empty-store-'))
    try {
      const empty = await createConversationStore(emptyDirectory).load()
      assert.equal(empty.ok, true)
      assert.equal(empty.missing, true)
      assert.deepEqual(empty.snapshot, { version: 5, activeConversationId: null, conversations: [] })
    } finally {
      fs.rmSync(emptyDirectory, { recursive: true, force: true })
    }
    console.log('Conversation store checks passed: v4 backup migration, v5 save and v5 empty library.')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
