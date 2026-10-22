import readline from 'node:readline'

const tools = [{ name: 'echo', description: '返回输入文字', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]
const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  if (request.method === 'initialize') output({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'lesson63-fixture', version: '1.0.0' } } })
  else if (request.method === 'tools/list') output({ jsonrpc: '2.0', id: request.id, result: { tools } })
  else if (request.method === 'tools/call') output({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: String(request.params?.arguments?.text ?? '') }] } })
})
