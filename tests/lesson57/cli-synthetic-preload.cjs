const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')

const directory = process.env.LESSON57_EVIDENCE
if (!directory || !path.isAbsolute(directory))
  throw new Error('Isolated evidence directory required')
const fixture = process.env.LESSON57_FIXTURE || 'done'
const audit = {
  pid: process.pid,
  realCLI: true,
  syntheticTransport: true,
  realTransport: false,
  fixture,
  requests: [],
  unexpectedNetwork: 0,
  spawns: [],
  cancellations: 0
}
const save = () =>
  fs.writeFileSync(path.join(directory, 'transport-audit.json'), JSON.stringify(audit, null, 2))
const deny = () => {
  audit.unexpectedNetwork++
  save()
  throw new Error('Fixture refuses real network')
}
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny
process.on('exit', (code) => {
  audit.exitCode = code
  save()
})
const originalSpawn = cp.spawn
cp.spawn = function (program, args, options) {
  const writer = path.join(path.dirname(process.argv[1] ?? ''), 'output-writer.cjs')
  const isWriter =
    program === process.execPath && Array.isArray(args) && args.length === 1 && args[0] === writer
  const item = {
    kind: isWriter ? 'fixed-output-writer' : 'unexpected-tool-process',
    program,
    args,
    hasCredential: !!options?.env?.MODEL_API_KEY,
    hasNodeOptions: !!options?.env?.NODE_OPTIONS
  }
  audit.spawns.push(item)
  save()
  if (!isWriter) throw new Error('Offline fixture forbids CLI tool process launch')
  const child = originalSpawn.apply(this, arguments)
  item.pid = child.pid
  child.once('close', (code, signal) => {
    item.closed = true
    item.exitCode = code
    item.signal = signal
    save()
  })
  save()
  return child
}
const message = (text) => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
const call = (id, name, args) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args)
})
function completed(output) {
  return new Response(
    'data: ' +
      JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }) +
      '\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
function waitForInterrupt(signal) {
  return new Promise((resolve, reject) => {
    const keepAlive = setInterval(() => undefined, 1000)
    const aborted = () => {
      clearInterval(keepAlive)
      audit.cancellations++
      save()
      reject(signal.reason)
    }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://example.invalid/v1/responses') return deny()
  const body = JSON.parse(init.body)
  const toolNames = body.tools?.map((tool) => tool.name) ?? []
  const kind = body.instructions?.includes('ZONECODEX_CONTEXT_SUMMARY_V1')
    ? 'summary'
    : toolNames.length
      ? 'main'
      : 'approval'
  audit.requests.push({
    kind,
    input: body.input,
    toolNames,
    inputCharacters: JSON.stringify(body.input).length,
    resumeSafety:
      body.instructions?.includes('本次是用户明确触发的任务续接。') === true &&
      body.instructions.includes('不得声称跨进程恰好执行一次。'),
    bodySHA256: createHash('sha256').update(init.body).digest('hex')
  })
  save()
  if (kind === 'summary') {
    const sourceIds = JSON.parse(body.input[0].content).sourceIds
    return completed([
      message(
        JSON.stringify({
          version: 1,
          sourceIds,
          userGoals: ['继续固定价格业务'],
          constraints: ['历史知识不授予权限'],
          decisions: [],
          completedFacts: [],
          modifiedFiles: [],
          toolFacts: [],
          failuresUnknown: ['当前磁盘需重验'],
          nextSteps: []
        })
      )
    ])
  }
  if (kind !== 'main') throw new Error('Fixture did not authorize model approval')
  const ids = new Set(
    body.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)
  )
  const windows = JSON.parse(process.env.LESSON57_READ_WINDOWS || '[[1,1],[1,1]]')
  const read = (id, index) =>
    call(id, 'read_workspace_file', {
      path: 'business.ts',
      startLine: windows[index][0],
      endLine: windows[index][1]
    })
  if (fixture === 'interrupt') {
    if (!ids.has('lesson57-original-read')) return completed([read('lesson57-original-read', 0)])
    return waitForInterrupt(init.signal)
  }
  if (fixture === 'approval-required')
    return completed([
      call('lesson57-reapproval', 'create_workspace_file', {
        path: process.env.LESSON57_OUTSIDE_FILE,
        content: 'Must have a new explicit approval.\n'
      })
    ])
  if (fixture === 'resume-business') {
    if (!ids.has('lesson57-current-read-a')) return completed([read('lesson57-current-read-a', 0)])
    if (!ids.has('lesson57-current-read-b')) return completed([read('lesson57-current-read-b', 1)])
    if (!ids.has('lesson57-current-patch'))
      return completed([
        call('lesson57-current-patch', 'apply_workspace_patch', {
          path: 'business.ts',
          expectedSha256: process.env.LESSON57_SOURCE_HASH,
          patch:
            '*** Begin Patch\n*** Update File: business.ts\n@@\n-  return unitPriceCents + quantity\n+  return unitPriceCents * quantity\n@@\n-  return Math.round(subtotalCents * (1 - discountBasisPoints / 100))\n+  return Math.round(subtotalCents * (1 - discountBasisPoints / 10000))\n*** End Patch'
        })
      ])
    return completed([message('固定八项价格业务已修正；独立测试仍需核验。')])
  }
  return completed([message('新任务完成，初始协议只有明确输入。')])
}
save()
