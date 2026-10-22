import readline from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const [audit, mode = 'normal'] = process.argv.slice(2)
const log = (value) => appendFileSync(audit, JSON.stringify(value) + '\n')
log({ pid: process.pid, mode, modelVariables: Object.keys(process.env).filter((name) => /^(MODEL_|OPENAI_|CODEX_|NODE_OPTIONS$)/i.test(name)) })
let version = 1, listing = 0
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const result = (id, value) => output({ jsonrpc: '2.0', id, result: value })
const schema = (properties = {}) => ({ type: 'object', properties, additionalProperties: false, description: 'version-' + version })
const tools = () => [
  { name: 'echo', description: 'Echo only; no file operations', inputSchema: { ...schema({ text: { type: 'string', description: 'version-' + version } }), required: ['text'] } },
  ...['hold', 'change', 'crash', 'large', 'invalid', 'wrongid', 'error', 'burst', 'environment'].map((name) => ({ name, inputSchema: schema() }))
]
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
  log({ descendant: child.pid })
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); log({ method: request.method, id: request.id, params: request.params })
  if (request.method === 'initialize') {
    const initialized = () => result(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'lesson64', version: '1' } })
    if (mode === 'slow-initialize') setTimeout(initialized, 5000)
    else initialized()
  } else if (request.method === 'tools/list') {
    ++listing; log({ listing })
    setTimeout(() => {
      const list = tools()
      result(request.id, { tools: mode === 'duplicates' ? [...list, list[0]] : list })
      --listing
    }, 15)
  } else if (request.method === 'tools/call') {
    const name = request.params.name
    if (name === 'hold') setTimeout(() => result(request.id, { content: [{ type: 'text', text: 'late' }] }), 10000)
    else if (name === 'crash') process.exit(7)
    else if (name === 'invalid') process.stdout.write('not-json\n')
    else if (name === 'wrongid') result(request.id + 1000, {})
    else if (name === 'error') output({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture failure' } })
    else {
      if (name === 'change' || name === 'burst') {
        version++
        for (let i = 0; i < (name === 'burst' ? 4 : 1); i++) output({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
      result(request.id, { content: [{ type: 'text', text: name === 'large' ? 'x'.repeat(13000) : name === 'environment' ? JSON.stringify(Object.keys(process.env).filter((key) => /MODEL_|OPENAI_|CODEX_/.test(key))) : String(request.params.arguments.text ?? name) }] })
    }
  } else if (request.method === 'notifications/cancelled' && mode === 'cooperative') {
    result(request.params.requestId, { content: [{ type: 'text', text: 'cancelled' }] })
  }
})
// An intentional open handle makes teardown exercise actual process termination.
if (mode === 'stubborn' || mode === 'descendant') setInterval(() => {}, 1000)
if (mode === 'ready-file') writeFileSync(audit + '.ready', String(process.pid))
