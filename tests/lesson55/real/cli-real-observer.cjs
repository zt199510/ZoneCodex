const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createHash } = require('node:crypto')
const evidence = process.env.LESSON55_EVIDENCE
if (!evidence || !path.isAbsolute(evidence))
  throw Error('An isolated real evidence directory is required')
if (
  !process.env.MODEL_ENDPOINT ||
  !process.env.MODEL_API_KEY ||
  process.env.MODEL_NAME !== 'gpt-6.1-sol'
)
  throw Error('Current real default gpt-6.1-sol configuration is required')
const audit = {
  synthetic: false,
  originalCLI: true,
  pid: process.pid,
  stdinTTY: process.stdin.isTTY === true,
  stdoutTTY: process.stdout.isTTY === true,
  modelMatches: true,
  configurationPresent: true,
  stage: process.env.LESSON55_STAGE,
  requests: [],
  allFetches: [],
  spawns: [],
  outputWriters: [],
  observationWriteFailures: []
}
const save = () => {
  try {
    fs.writeFileSync(path.join(evidence, 'transport-audit.json'), JSON.stringify(audit, null, 2))
  } catch (error) {
    const issue = { atUTC: new Date().toISOString(), code: error.code, message: error.message }
    audit.observationWriteFailures.push(issue)
    try {
      fs.writeFileSync(
        path.join(evidence, 'observer-failure-' + require('node:crypto').randomUUID() + '.json'),
        JSON.stringify({ issue, audit })
      )
    } catch {
      // Secondary evidence writing must not replace the original observed product outcome.
    }
  }
}
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
const actualFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const expectedEndpoint = String(url) === process.env.MODEL_ENDPOINT
  audit.allFetches.push({ atUTC: new Date().toISOString(), method: init.method, expectedEndpoint })
  save()
  if (!expectedEndpoint || init.method !== 'POST' || typeof init.body !== 'string')
    throw Error('Unexpected observer network request')
  const body = JSON.parse(init.body)
  if (body.model !== 'gpt-6.1-sol') throw Error('Unexpected model')
  const entry = {
    atUTC: new Date().toISOString(),
    startedAtMs: Date.now(),
    model: body.model,
    bodySHA256: createHash('sha256').update(init.body).digest('hex'),
    bodyBytes: Buffer.byteLength(init.body),
    title: body.instructions.includes('你负责为桌面聊天会话生成标题'),
    approval: body.instructions.includes('独立风险评估器'),
    rawBody: body,
    httpStatus: null,
    completed: false,
    stream: { chunks: 0, bytes: 0, eof: false, eventTypes: {}, terminalEvents: [] }
  }
  audit.requests.push(entry)
  save()
  let response
  try {
    response = await actualFetch(url, init)
  } catch (error) {
    entry.error = { message: error.message, code: error.cause?.code }
    save()
    throw error
  }
  entry.httpStatus = response.status
  save()
  if (!response.ok || !response.body) return response
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  const accept = (text) => {
    buffer += text
    let boundary
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') continue
      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      entry.stream.eventTypes[event.type] = (entry.stream.eventTypes[event.type] || 0) + 1
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type))
        entry.stream.terminalEvents.push(event)
      if (event.type === 'response.completed') {
        entry.completed = true
        entry.response = event.response
        entry.elapsedMs = Date.now() - entry.startedAtMs
        save()
      }
    }
  }
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const value = await reader.read()
          if (value.done) {
            accept(decoder.decode())
            entry.stream.eof = true
            entry.stream.unparsedTailCharacters = buffer.length
            save()
            controller.close()
            reader.releaseLock()
          } else {
            entry.stream.chunks++
            entry.stream.bytes += value.value.byteLength
            accept(decoder.decode(value.value, { stream: true }))
            controller.enqueue(value.value)
          }
        } catch (error) {
          entry.stream.error = { message: error.message, code: error.cause?.code }
          save()
          controller.error(error)
        }
      },
      async cancel(reason) {
        entry.stream.cancelled = true
        save()
        await reader.cancel(reason)
      }
    }),
    { status: response.status, headers: response.headers }
  )
}
save()
