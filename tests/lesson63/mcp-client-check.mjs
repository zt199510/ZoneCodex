import { spawn } from 'node:child_process'
import { strict as assert } from 'node:assert'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const server = join(root, 'tests/lesson63/mcp-fixture.mjs')
const child = spawn(process.execPath, [server], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let id = 0; const pending = new Map(); let buffer = ''
child.stdout.setEncoding('utf8').on('data', (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break; const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); if (message.id) pending.get(message.id)?.(message) } })
const request = (method, params = {}) => new Promise((resolve) => { const requestId = ++id; pending.set(requestId, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`) })
const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
assert.equal(initialized.result.serverInfo.name, 'lesson63-fixture')
const listed = await request('tools/list')
assert.equal(listed.result.tools[0].name, 'echo')
const called = await request('tools/call', { name: 'echo', arguments: { text: 'ok' } })
assert.equal(called.result.content[0].text, 'ok')
child.kill(); await once(child, 'close')
console.log('lesson63 MCP stdio fixture passed')
