const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')
const evidence = process.env.LESSON55_EVIDENCE
if (!evidence || !path.isAbsolute(evidence))
  throw Error('An isolated synthetic evidence directory is required')
const fixture = process.env.LESSON55_FIXTURE || 'done'
const audit = {
  syntheticModel: true,
  originalCLI: true,
  fixture,
  pid: process.pid,
  stdinTTY: process.stdin.isTTY === true,
  stdoutTTY: process.stdout.isTTY === true,
  runtime: process.version,
  requests: [],
  spawns: [],
  outputWriters: [],
  streamCancellations: 0
}
const save = () =>
  fs.writeFileSync(path.join(evidence, 'transport-audit.json'), JSON.stringify(audit, null, 2))
process.on('exit', (code) => {
  audit.exitCode = code
  save()
})
const originalSpawn = cp.spawn
cp.spawn = function (program, args, options) {
  const writer = process.argv[1] && path.join(path.dirname(process.argv[1]), 'output-writer.cjs')
  const isWriter =
    typeof program === 'string' &&
    path.resolve(program).toLowerCase() === process.execPath.toLowerCase() &&
    Array.isArray(args) &&
    args.length === 1 &&
    args[0] === writer &&
    options?.cwd === path.dirname(writer) &&
    Array.isArray(options?.stdio) &&
    options.stdio.length === 4 &&
    options.stdio[0] === 'ignore' &&
    options.stdio[3] === 'ipc' &&
    (options.stdio[1] === process.stdout || options.stdio[1] === 'ignore') &&
    (options.stdio[2] === process.stderr || options.stdio[2] === 'ignore') &&
    (options.stdio[1] === process.stdout || options.stdio[2] === process.stderr)
  const entry = {
    program: String(program),
    args: Array.isArray(args) ? args : [],
    cwd: options?.cwd,
    hasModelCredential: !!options?.env?.MODEL_API_KEY,
    hasModelEndpoint: !!options?.env?.MODEL_ENDPOINT,
    hasModelName: !!options?.env?.MODEL_NAME,
    hasNodeOptions: !!options?.env?.NODE_OPTIONS,
    environmentNames: Object.keys(options?.env || {}).sort(),
    atUTC: new Date().toISOString()
  }
  if (isWriter) {
    entry.kind = 'fixed-output-writer'
    entry.sha256 = createHash('sha256').update(fs.readFileSync(writer)).digest('hex')
    entry.sentWrites = 0
    entry.receivedAcks = 0
    entry.inheritedTargets = [
      options.stdio[1] === process.stdout ? 'stdout' : null,
      options.stdio[2] === process.stderr ? 'stderr' : null
    ].filter(Boolean)
    audit.outputWriters.push(entry)
  } else audit.spawns.push(entry)
  save()
  const child = originalSpawn.apply(this, arguments)
  entry.pid = child.pid
  child.once('close', (exitCode, signal) => {
    entry.closed = true
    entry.exitCode = exitCode
    entry.signal = signal
    entry.closedUTC = new Date().toISOString()
    save()
  })
  if (isWriter) {
    const send = child.send
    child.send = function (value) {
      if (value?.type === 'write') {
        entry.sentWrites++
        entry.lastSequence = value.sequence
        entry.lastTarget = value.target
        entry.lastWriteBytes = Buffer.byteLength(value.text)
        save()
      }
      return send.apply(this, arguments)
    }
    child.on('message', (value) => {
      if (value?.type === 'ack') {
        entry.receivedAcks++
        entry.lastAckSequence = value.sequence
        save()
      }
    })
    child.once('error', (error) => {
      entry.error = { message: error.message, code: error.code }
      save()
    })
  }
  save()
  return child
}
const message = (text = 'synthetic public completion', phase = 'final_answer') => ({
  type: 'message',
  role: 'assistant',
  phase,
  content: [{ type: 'output_text', text }]
})
const call = (name, args = {}) => ({
  type: 'function_call',
  name,
  call_id: 'fixture-' + fixture + '-call-' + audit.requests.length,
  arguments: JSON.stringify(args)
})
const question = {
  questions: [
    {
      id: 'layout',
      header: '布局',
      question: '选择布局',
      options: [
        { label: '卡片', description: '使用卡片布局' },
        { label: '列表', description: '使用列表布局' }
      ]
    }
  ]
}
const privateReasoning = {
  type: 'reasoning',
  id: 'fixture-private-reasoning',
  encrypted_content: 'LESSON55_PRIVATE_PROTOCOL_SENTINEL',
  summary: [{ type: 'summary_text', text: 'LESSON55_PRIVATE_REASONING_SENTINEL' }]
}
function completed(output, extraEvents = []) {
  const frame = (event) => 'data: ' + JSON.stringify(event) + '\n\n'
  const response = {
    id: 'synthetic-response-' + audit.requests.length,
    status: 'completed',
    output
  }
  const text = [...extraEvents, { type: 'response.completed', response }].map(frame).join('')
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body)
  const attempt = audit.requests.length + 1
  audit.requests.push({
    attempt,
    atUTC: new Date().toISOString(),
    input: body.input,
    tools: body.tools?.map((tool) => tool.name),
    model: body.model,
    bodySHA256: createHash('sha256').update(init.body).digest('hex'),
    expectedEndpoint: String(url) === 'https://example.invalid/v1/responses'
  })
  save()
  if (String(url) !== 'https://example.invalid/v1/responses')
    throw Error('Synthetic transport refuses unexpected network')
  if (fixture === 'wait-model')
    return new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => undefined, 1000)
      const abort = () => {
        clearInterval(keepAlive)
        audit.cancelled = true
        save()
        reject(init.signal.reason)
      }
      if (init.signal.aborted) abort()
      else init.signal.addEventListener('abort', abort, { once: true })
    })
  if (
    fixture === 'retry-all' ||
    (fixture === 'retry-once' && attempt === 1) ||
    (fixture === 'time-retry' && attempt === 2)
  )
    return new Response('synthetic retry response', {
      status: 503,
      headers: { 'Retry-After': '0' }
    })
  if (fixture === 'stream-epipe') {
    let index = 0,
      timer
    const frame = (event) => new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n')
    return new Response(
      new ReadableStream({
        start(controller) {
          timer = setInterval(() => {
            if (init.signal.aborted) {
              clearInterval(timer)
              controller.error(init.signal.reason)
              return
            }
            controller.enqueue(
              frame({
                type: 'response.output_text.delta',
                delta: 'x'.repeat(300),
                output_index: 0,
                content_index: 0
              })
            )
            if (++index === 150) {
              clearInterval(timer)
              controller.enqueue(
                frame({
                  type: 'response.completed',
                  response: { status: 'completed', output: [message()] }
                })
              )
              controller.close()
            }
          }, 10)
        },
        cancel() {
          clearInterval(timer)
          audit.streamCancellations++
          save()
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  if (fixture === 'stream-backpressure' || fixture === 'stream-backpressure-command') {
    let index = 0,
      timer
    const commandActivity = fixture === 'stream-backpressure-command',
      events = commandActivity ? 30 : 12
    const frame = (event) => new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n')
    audit.generatedEvents = 0
    audit.maxWritableLength = 0
    return new Response(
      new ReadableStream({
        start(controller) {
          timer = setInterval(
            () => {
              audit.maxWritableLength = Math.max(
                audit.maxWritableLength,
                process.stdout.writableLength
              )
              if (init.signal.aborted) {
                clearInterval(timer)
                controller.error(init.signal.reason)
                return
              }
              if (index < events) {
                const outputIndex = commandActivity ? 0 : Math.floor(index / 2)
                if (commandActivity ? index === 0 : index % 2 === 0)
                  controller.enqueue(
                    frame({
                      type: 'response.output_item.added',
                      output_index: outputIndex,
                      item: {
                        type: 'message',
                        role: 'assistant',
                        phase: 'commentary',
                        id: 'backpressure-message-' + outputIndex,
                        content: []
                      }
                    })
                  )
                controller.enqueue(
                  frame({
                    type: 'response.output_text.delta',
                    output_index: outputIndex,
                    content_index: 0,
                    item_id: 'backpressure-message-' + outputIndex,
                    delta: 'x'.repeat(commandActivity ? 500 : 7500)
                  })
                )
                index++
                audit.generatedEvents = index
                if (index === events && commandActivity) {
                  clearInterval(timer)
                  const output = [
                    { ...message('x'.repeat(15000), 'commentary'), id: 'backpressure-message-0' }
                  ]
                  output.push(
                    call('run_workspace_command', {
                      program: process.execPath,
                      args: ['long-command.cjs'],
                      cwd: process.env.LESSON55_WORKSPACE,
                      sandbox_permissions: 'use_default'
                    })
                  )
                  controller.enqueue(
                    frame({ type: 'response.completed', response: { status: 'completed', output } })
                  )
                  controller.close()
                }
              }
              save()
            },
            commandActivity ? 20 : 80
          )
        },
        cancel() {
          clearInterval(timer)
          audit.streamCancellations++
          save()
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  const tools = body.input.filter((item) => item.type === 'function_call_output')
  if (fixture === 'time' || fixture === 'time-retry') {
    if (!tools.length)
      return completed([
        privateReasoning,
        message('公开工具过程', 'commentary'),
        call('get_current_time')
      ])
    return completed([privateReasoning, message('synthetic time completed')])
  }
  if (fixture === 'question') {
    if (!tools.length)
      return completed([
        message('需要计划答案', 'commentary'),
        call('request_user_input', question)
      ])
    return completed([message('synthetic question completed')])
  }
  if (fixture === 'create') {
    if (!tools.length)
      return completed([
        call('create_workspace_file', {
          path: 'created.txt',
          content: 'synthetic actual disk creation\n'
        })
      ])
    return completed([message('synthetic disk completed')])
  }
  if (fixture === 'patch-unread') {
    if (!tools.length)
      return completed([
        call('apply_workspace_patch', {
          path: 'sample.ts',
          expectedSha256: process.env.LESSON55_SOURCE_HASH,
          patch:
            '*** Begin Patch\n*** Update File: sample.ts\n@@\n-export const value = 1\n+export const value = 2\n*** End Patch'
        })
      ])
    return completed([message('synthetic unread patch handled')])
  }
  if (fixture === 'command' || fixture === 'command-approval' || fixture === 'command-long') {
    if (!tools.length)
      return completed([
        call('run_workspace_command', {
          program: process.execPath,
          args: [fixture === 'command-long' ? 'long-command.cjs' : 'command.cjs'],
          cwd: process.env.LESSON55_WORKSPACE,
          sandbox_permissions: fixture === 'command-approval' ? 'require_escalated' : 'use_default',
          ...(fixture === 'command-approval'
            ? { justification: '验证一次明确批准的隔离测试命令' }
            : {})
        })
      ])
    return completed([message('synthetic command completed')])
  }
  return completed(
    [privateReasoning, message()],
    [
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: 'synthetic public completion'
      }
    ]
  )
}
save()
