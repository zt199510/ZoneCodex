import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const root = join(import.meta.dirname, '../..')
const bundle = join(root, 'out/main/index.js')
assert.ok(existsSync(bundle), '先执行 npm run build 生成产品编译产物')
const source = readFileSync(bundle, 'utf8')
for (const marker of ['notifications/tools/list_changed', 'notifications/cancelled', 'mcp__', 'MCP Server 已退出'])
  assert.ok(source.includes(marker), `编译产物缺少 MCP 稳定化逻辑：${marker}`)

const fixture = join(root, 'tests/lesson63/mcp-fixture.mjs')
const child = spawn(process.execPath, [fixture], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let id = 0; let buffer = ''; const pending = new Map()
child.stdout.setEncoding('utf8').on('data', (chunk) => { buffer += chunk; for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue; const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id) } })
const request = (method, params = {}) => new Promise((resolve) => { const requestId = ++id; pending.set(requestId, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`) })
const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lesson63.1', version: '1' } })
assert.equal(init.result.serverInfo.name, 'lesson63-fixture')
const listed = await request('tools/list'); assert.equal(listed.result.tools[0].name, 'echo')
const called = await request('tools/call', { name: 'echo', arguments: { text: 'lesson63.1' } }); assert.equal(called.result.content[0].text, 'lesson63.1')
child.kill(); await once(child, 'close')
console.log('lesson63.1 MCP offline product checks passed')
