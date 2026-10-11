import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8)
const stream = process.argv.find((arg) => arg.startsWith('--stream='))?.slice(9) || 'stdout'
const prototypeNonblocking = process.argv.includes('--prototype-nonblocking')
const activity = process.argv.find((arg) => arg.startsWith('--activity='))?.slice(11) || 'model'
assert.ok(entryArg)
assert.ok(['stdout', 'stderr'].includes(stream))
assert.ok(['model', 'command'].includes(activity))
assert.ok(
  process.argv
    .slice(2)
    .every(
      (arg) =>
        arg.startsWith('--entry=') ||
        arg.startsWith('--stream=') ||
        arg.startsWith('--activity=') ||
        arg === '--prototype-nonblocking'
    )
)
const entry = path.resolve(root, entryArg),
  evidence = await createEvidence('cli-backpressure')
const workspace = path.join(evidence, 'workspace'),
  preload = fileURLToPath(new URL('./cli-synthetic-preload.cjs', import.meta.url))
await fs.mkdir(workspace, { recursive: true })
await fs.copyFile(fileURLToPath(import.meta.url), path.join(evidence, 'validator.mjs.snapshot'))
await fs.copyFile(preload, path.join(evidence, 'preload.cjs.snapshot'))
await fs.writeFile(
  path.join(workspace, 'long-command.cjs'),
  'console.log("actual-command-ready");setTimeout(()=>console.log("unexpected-late-command"),30000);\n'
)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  identity = hash(await fs.readFile(entry))
const pty = createRequire(path.join(root, 'package.json'))('node-pty')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bounded = async (promise, ms) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const signalObserver = path.join(evidence, 'signal-observer.cjs'),
  wrapper = path.join(evidence, 'actual-pipe-wrapper.cjs')
await fs.writeFile(
  signalObserver,
  `require(${JSON.stringify(preload)});const fs=require('node:fs');const path=require('node:path');const stream=process[${JSON.stringify(stream)}];if(${prototypeNonblocking})stream._handle.setBlocking(false);let maximum=0;const save=()=>{maximum=Math.max(maximum,stream.writableLength);fs.writeFileSync(path.join(process.env.LESSON55_EVIDENCE,'stream-state.json'),JSON.stringify({pid:process.pid,stream:${JSON.stringify(stream)},constructor:stream.constructor.name,handle:stream._handle?.constructor.name,maxWritableLength:maximum,atUTC:new Date().toISOString()}))};save();setInterval(save,50).unref();process.on('SIGINT',()=>fs.writeFileSync(path.join(process.env.LESSON55_EVIDENCE,'actual-child-sigint.json'),JSON.stringify({pid:process.pid,atUTC:new Date().toISOString()})));\n`
)
await fs.writeFile(
  wrapper,
  `
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const directory=process.env.LESSON55_EVIDENCE,stream=${JSON.stringify(stream)}
const data={wrapperPid:process.pid,signals:0,blockedStream:stream,pipePausedBeforeAnyRead:true,childExit:null,pipeReleasedBeforeChildExit:false}
const save=()=>fs.writeFileSync(path.join(directory,'wrapper.json'),JSON.stringify(data,null,2))
process.on('SIGINT',()=>{data.signals++;data.signalUTC=new Date().toISOString();save()})
const child=spawn(process.execPath,['--require',${JSON.stringify(signalObserver)},${JSON.stringify(entry)},'--mode','execute','--cwd',${JSON.stringify(workspace)},'--prompt','固定堵塞输出取消','--permission','full-access','--output',stream==='stdout'?'jsonl':'text'],{cwd:directory,env:process.env,windowsHide:true,stdio:['inherit','pipe','pipe']})
data.childPid=child.pid
const blocked=child[stream];blocked._readableState.highWaterMark=1;blocked.pause()
let output='',error='',reading=false
const collect={stdout:bytes=>output+=bytes,stderr:bytes=>error+=bytes}
child[stream==='stdout'?'stderr':'stdout'].on('data',collect[stream==='stdout'?'stderr':'stdout'])
const read=()=>{if(reading)return;reading=true;blocked.on('data',collect[stream]);blocked.resume()}
const release=setInterval(()=>{if(fs.existsSync(path.join(directory,'release-pipe.txt'))&&!reading){data.pipeReleasedBeforeChildExit=true;data.releaseUTC=new Date().toISOString();save();read()}},50)
child.on('error',cause=>{data.error=cause.message;clearInterval(release);save();process.exitCode=1})
child.on('exit',(code,signal)=>{data.childExit={code,signal,atUTC:new Date().toISOString()};save();read()})
child.on('close',()=>{clearInterval(release);fs.writeFileSync(path.join(directory,'partial-stdout.txt'),output);fs.writeFileSync(path.join(directory,'child-stderr.txt'),error);data.stdoutBytes=Buffer.byteLength(output);data.stderrBytes=Buffer.byteLength(error);save();console.log('actual-child-exit:'+data.childExit.code)})
save();console.log('backpressure-wrapper-started')
`
)
const env = {
  ...process.env,
  MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
  MODEL_NAME: 'gpt-6.1-sol',
  MODEL_API_KEY: 'LESSON55_SYNTHETIC_SECRET_SENTINEL',
  LESSON55_EVIDENCE: evidence,
  LESSON55_FIXTURE: activity === 'command' ? 'stream-backpressure-command' : 'stream-backpressure',
  LESSON55_WORKSPACE: workspace
}
delete env.ELECTRON_RUN_AS_NODE
const terminal = pty.spawn(process.execPath, [wrapper], {
  cwd: evidence,
  env,
  cols: 120,
  rows: 30,
  useConpty: true
})
let raw = '',
  exited,
  forcedKill = false,
  blockedAudit,
  signalSentUTC,
  releaseRequired = false
terminal.onData((data) => (raw += data))
const done = new Promise((resolve) =>
  terminal.onExit((value) => {
    exited = value
    resolve(value)
  })
)
try {
  const deadline = Date.now() + 15000
  let lastGenerated = -1,
    lastProgress = Date.now(),
    lastAck = -1,
    lastAckProgress = Date.now()
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(
          await fs.readFile(path.join(evidence, 'transport-audit.json'), 'utf8')
        ),
        state = JSON.parse(await fs.readFile(path.join(evidence, 'stream-state.json'), 'utf8')),
        writer = value.outputWriters?.[0]
      if (value.generatedEvents !== lastGenerated) {
        lastGenerated = value.generatedEvents
        lastProgress = Date.now()
      }
      if (writer?.receivedAcks !== lastAck) {
        lastAck = writer?.receivedAcks
        lastAckProgress = Date.now()
      }
      const blocked = writer
        ? writer.sentWrites > writer.receivedAcks && Date.now() - lastAckProgress >= 750
        : state.maxWritableLength > 0 ||
          (value.generatedEvents >= 4 && Date.now() - lastProgress >= 750)
      if (
        blocked &&
        (activity !== 'command' ||
          value.spawns.some(
            (child) => /host\.exe$/i.test(child.program) && child.pid && !child.closed
          ))
      ) {
        blockedAudit = {
          ...value,
          streamState: state,
          externallyFrozenForMs: Date.now() - lastProgress,
          writerAckBlockedForMs: writer ? Date.now() - lastAckProgress : null
        }
        break
      }
    } catch {
      // Observation files may be absent or mid-write while the owned process becomes ready.
    }
    if (exited) throw Error('Actual CLI exited before output pipe was observed blocked')
    await pause(50)
  }
  assert.ok(
    blockedAudit,
    'The actual unconsumed child output pipe must be observed blocked before Ctrl+C'
  )
  await fs.writeFile(
    path.join(evidence, 'blocked-before-signal.json'),
    JSON.stringify(blockedAudit, null, 2)
  )
  signalSentUTC = new Date().toISOString()
  terminal.write('\x03')
  let completion = await bounded(done, 2500)
  if (!completion) {
    releaseRequired = true
    await fs.writeFile(
      path.join(evidence, 'release-pipe.txt'),
      'Release only after cancelled process failed to exit while output remained blocked.\n'
    )
    completion = await bounded(done, 10000)
  }
  if (!completion) {
    forcedKill = true
    terminal.kill()
    await bounded(done, 3000)
  }
  assert.equal(forcedKill, false)
  assert.equal(completion?.exitCode, 0)
  const wrapperAudit = JSON.parse(await fs.readFile(path.join(evidence, 'wrapper.json'), 'utf8'))
  const audit = JSON.parse(await fs.readFile(path.join(evidence, 'transport-audit.json'), 'utf8'))
  const actualSignal = JSON.parse(
    await fs.readFile(path.join(evidence, 'actual-child-sigint.json'), 'utf8')
  )
  assert.equal(wrapperAudit.childExit.code, 130)
  assert.ok(wrapperAudit.signals >= 1)
  assert.equal(actualSignal.pid, wrapperAudit.childPid)
  assert.ok(Date.parse(actualSignal.atUTC) >= Date.parse(signalSentUTC))
  assert.equal(audit.requests.length, 1)
  if (activity === 'model') assert.ok(audit.streamCancellations >= 1)
  if (!prototypeNonblocking) {
    assert.equal(audit.outputWriters.length, 1)
    const writer = audit.outputWriters[0]
    assert.ok(writer.closed)
    assert.ok(
      !writer.hasModelCredential &&
        !writer.hasModelEndpoint &&
        !writer.hasModelName &&
        !writer.hasNodeOptions
    )
    assert.ok(writer.environmentNames.every((key) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)))
    if (activity === 'command') {
      const jobs = audit.spawns.filter((child) => /host\.exe$/i.test(child.program))
      assert.equal(jobs.length, 1)
      assert.ok(jobs[0].closed)
      assert.ok(!jobs[0].hasModelCredential)
      assert.ok(
        Date.parse(jobs[0].closedUTC) <= Date.parse(writer.closedUTC),
        'Original Job process finishes cleanup before the output writer is stopped'
      )
    } else assert.equal(audit.spawns.length, 0)
  }
  assert.ok(audit.stdinTTY)
  assert.equal(audit.stdoutTTY, false)
  assert.equal(hash(await fs.readFile(entry)), identity)
  const result = {
    pass: true,
    syntheticModel: true,
    actualPipe: true,
    actualConPTYCtrlC: true,
    prototypeNonblocking,
    evidence,
    entry,
    stream,
    activity,
    entrySHA256: identity,
    runtime: process.version,
    signalSentUTC,
    wrapperAudit,
    auditSummary: {
      requests: audit.requests.length,
      streamCancellations: audit.streamCancellations,
      maxWritableLength: audit.maxWritableLength
    },
    forcedKill,
    releaseRequired,
    boundary:
      'Actual ordinary Node CLI selected output pipe remains paused and open until child exit. ConPTY delivers a real console Ctrl+C to wrapper and CLI; wrapper never forwards a synthetic signal. Transport is a fixed synthetic active stream. Buffered output may be incomplete after cancelled flush; exit130 and release are verified independently of EPIPE.'
  }
  assert.equal(
    releaseRequired,
    false,
    'CLI must process real Ctrl+C and exit while actual output consumer stays blocked'
  )
  assert.equal(wrapperAudit.pipeReleasedBeforeChildExit, false)
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  const result = {
    pass: false,
    evidence,
    entry,
    stream,
    activity,
    prototypeNonblocking,
    entrySHA256: identity,
    forcedKill,
    signalSentUTC,
    blockedAudit,
    releaseRequired,
    error: error.stack
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  console.error(JSON.stringify(result))
  process.exitCode = 1
} finally {
  await fs.writeFile(path.join(evidence, 'raw-terminal.txt'), raw)
  if (exited) {
    terminal._agent._inSocket.destroy()
    terminal._agent._ptyNative.kill(terminal._agent._pty, terminal._agent._useConptyDll)
    terminal._agent._conoutSocketWorker.dispose()
  } else if (!forcedKill) {
    await fs.writeFile(
      path.join(evidence, 'release-pipe.txt'),
      'Failure cleanup for the owned paused child pipe.\n'
    )
    terminal.write('\x03')
    await bounded(done, 3000)
    if (!exited) terminal.kill()
    if (exited) {
      terminal._agent._inSocket.destroy()
      terminal._agent._ptyNative.kill(terminal._agent._pty, terminal._agent._useConptyDll)
      terminal._agent._conoutSocketWorker.dispose()
    }
  }
}
