const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const directory = process.env.LESSON60_EVIDENCE
if (!directory || !path.isAbsolute(directory))
  throw new Error('Isolated lesson60 evidence required')
// Reuse the existing strict network/process guard; only this lesson's transport is new.
process.env.LESSON57_EVIDENCE = directory
require('../lesson57/cli-synthetic-preload.cjs')
const fixture = process.env.LESSON60_FIXTURE
const audit = {
  pid: process.pid,
  stdinTTY: process.stdin.isTTY === true,
  stderrTTY: process.stderr.isTTY === true,
  syntheticTransport: true,
  realTransport: false,
  main: 0,
  review: 0,
  summary: 0,
  cancelled: 0,
  requests: []
}
const save = () =>
  fs.writeFileSync(path.join(directory, 'lesson60-transport.json'), JSON.stringify(audit, null, 2))
process.on('exit', (code) => {
  audit.exitCode = code
  save()
})
const message = (text) => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
const call = (name, args) => ({
  type: 'function_call',
  call_id: 'lesson60-' + fixture + '-' + audit.main,
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
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== 'https://example.invalid/v1/responses')
    throw new Error('Unexpected network refused')
  const body = JSON.parse(init.body)
  const kind = body.instructions?.includes('ZONECODEX_CONTEXT_SUMMARY_V1')
    ? 'summary'
    : body.tools?.length
      ? 'main'
      : 'review'
  audit[kind]++
  audit.requests.push({
    kind,
    input: body.input,
    instructions: body.instructions,
    bodySHA256: createHash('sha256').update(init.body).digest('hex')
  })
  save()
  if (kind === 'summary') throw new Error('No summary permitted in bounded lesson60 fixture')
  if (kind === 'review') {
    if (fixture === 'review-failure') throw new Error('Synthetic review transport failure')
    return completed([
      message(JSON.stringify({ risk: fixture === 'review-safe' ? 'safe' : 'risky' }))
    ])
  }
  const current = body.input.filter(
    (item) => item.type === 'function_call' && item.call_id?.startsWith('lesson60-' + fixture + '-')
  )
  if (fixture === 'hold' || (fixture === 'create-then-hold' && current.length))
    return new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => undefined, 1000)
      const cancel = () => {
        clearInterval(keepAlive)
        audit.cancelled++
        save()
        reject(init.signal.reason)
      }
      if (init.signal.aborted) cancel()
      else init.signal.addEventListener('abort', cancel, { once: true })
    })
  if (!current.length && fixture === 'question')
    return completed([
      call('request_user_input', {
        questions: [
          {
            id: 'layout',
            header: '布局',
            question: '选择固定布局',
            options: [
              { label: '卡片', description: '固定卡片布局' },
              { label: '列表', description: '固定列表布局' }
            ]
          }
        ]
      })
    ])
  if (
    !current.length &&
    [
      'create',
      'create-then-hold',
      'review-safe',
      'review-risky',
      'review-failure',
      'resume-create'
    ].includes(fixture)
  )
    return completed([
      call('create_workspace_file', {
        path: process.env.LESSON60_TARGET,
        content: 'Lesson60 current authorization bytes\n'
      })
    ])
  return completed([
    { type: 'reasoning', encrypted_content: 'LESSON60_PRIVATE_SENTINEL', summary: [] },
    message('Current operation result was handled; this does not imply every operation succeeded.')
  ])
}
save()
