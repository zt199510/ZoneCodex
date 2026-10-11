import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const evidence = await createEvidence('output-bridge')
await fs.copyFile(fileURLToPath(import.meta.url), path.join(evidence, 'run.mjs'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const identities = []
for (const name of ['index.ts', 'output.ts', 'output-bridge.ts', 'output-writer.ts']) {
  const source = path.join(root, 'src/cli', name),
    bytes = await fs.readFile(source)
  identities.push({ source, sha256: hash(bytes) })
  await fs.writeFile(path.join(evidence, name + '.snapshot'), bytes)
}
const compiled = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli/output-writer.ts'],
  outfile: 'output-writer.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  metafile: true,
  logLevel: 'silent'
})
const writerBytes = compiled.outputFiles[0].contents,
  writerHash = hash(writerBytes)
await fs.writeFile(
  path.join(evidence, 'writer-metafile.json'),
  JSON.stringify(compiled.metafile, null, 2)
)
const checks = []
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const harness = String.raw`
const cp = require('node:child_process'), crypto = require('node:crypto'), { Writable } = require('node:stream');
const originalSpawn = cp.spawn, children = [];
const send = value => process.send?.(value);
cp.spawn = (...args) => {
  const child = originalSpawn(...args), record = { pid:child.pid, program:args[0], argv:args[1], cwd:args[2].cwd, envKeys:Object.keys(args[2].env).sort(), inheritedStdout:args[2].stdio[1]===process.stdout, inheritedStderr:args[2].stdio[2]===process.stderr };
  children.push(record); send({ observer:'spawn', record });
  child.on('close',(code,signal)=>{record.closed=true;record.code=code;record.signal=signal;send({observer:'helper-close',pid:child.pid,code,signal});});
  return child;
};
const {WindowsOutputBridge}=require('./src/cli/output-bridge'), {CLIOutput}=require('./src/cli/output');
const mode=process.argv[2];
async function main(){
  const native={platform:process.platform,stdoutType:process.stdout._type,stderrType:process.stderr._type,stdoutNative:process.stdout._isStdio,stderrNative:process.stderr._isStdio};
  if(mode==='custom'){
    let text=''; const custom=new Writable({write(b,e,done){text+=b;done();}}),bridge=new WindowsOutputBridge(custom,custom);
    if(bridge.stdout!==custom||bridge.stderr!==custom)throw Error('Custom stream replaced');await bridge.ready();
    await new Promise((resolve,reject)=>custom.write('custom😀',e=>e?reject(e):resolve()));await bridge.dispose();
    return {native,children,text,customPreserved:true};
  }
  if(mode==='cli-help-shutdown'){
    const {runCLI}=require('./index.cjs');const exitCode=await runCLI(['--help']);
    return {native,children,exitCode};
  }
  const bridge=new WindowsOutputBridge(process.stdout,process.stderr);let failure=null;
  bridge.stdout.on('error',()=>{});bridge.stderr.on('error',()=>{});
  if(mode==='disposed-before-ready'){
    await bridge.dispose();try{await bridge.ready();}catch(e){failure=e.message;}
    return {native,children,failure};
  }
  if(mode==='identity'){
    try{await bridge.ready();}catch(e){failure=e.message;}await bridge.dispose();
    return {native,children,failure};
  }
  if(mode==='protocol'){
    try{await bridge.ready();await new Promise((resolve,reject)=>bridge.stdout.write('probe',e=>e?reject(e):resolve()));await new Promise(resolve=>setTimeout(resolve,30));}
    catch(e){failure=e.message;}
    try{await bridge.dispose();}catch(e){failure??=e.message;}
    return {native,children,failure,streamDestroyed:bridge.stdout.destroyed};
  }
  await bridge.ready();await bridge.ready();
  if(mode==='shutdown'){
    await new Promise((resolve,reject)=>bridge.stdout.write('probe',e=>e?reject(e):resolve()));
    try{await bridge.dispose();}catch(e){failure=e.message;}
    return {native,children,failure};
  }
  const controller=new AbortController(),errors=[];
  const output=new CLIOutput('text',bridge.stdout,bridge.stderr,error=>errors.push(error.message));
  if(mode==='cancel-stdout'||mode==='cancel-stderr'){
    const start=Date.now();
    if(mode==='cancel-stdout')output.help('x'.repeat(4*1024*1024));else output.diagnostic('x'.repeat(4*1024*1024-1));
    setTimeout(()=>{send({observer:'abort-fired',elapsedMs:Date.now()-start});controller.abort(new Error('owned fixture cancellation'));},60);
    try{await output.flush(controller.signal);}catch(e){failure=e.message;}
    await bridge.dispose();output.dispose();
    return {native,children,failure,errors,elapsedMs:Date.now()-start,exitCode:130};
  }
  const texts=['头😀\n'+'ab汉😀'.repeat(12000)+'\n','second\r\n','tail🙂\n'];
  for(const text of texts)output.help(text);output.diagnostic('诊断🙂');
  await output.flush();await bridge.dispose();output.dispose();
  return {native,children,stdoutHash:crypto.createHash('sha256').update(texts.join('')).digest('hex'),stderrHash:crypto.createHash('sha256').update('诊断🙂\n').digest('hex'),errors};
}
main().then(result=>{send({result});process.exitCode=result.exitCode??0;if(process.connected)process.disconnect();},error=>{send({uncaught:error.stack});process.exitCode=1;if(process.connected)process.disconnect();});
`

async function runCase(name, mode, { fake, mutation, expectedExit = 0, paused = null } = {}) {
  const directory = path.join(evidence, name)
  await fs.mkdir(directory)
  const bytes = fake === undefined ? writerBytes : Buffer.from(fake),
    pin = hash(bytes)
  await fs.writeFile(path.join(directory, 'output-writer.cjs'), bytes)
  await fs.writeFile(
    path.join(directory, 'build-manifest.json'),
    JSON.stringify({ entries: [{ name: 'output-writer.cjs', sha256: pin }] })
  )
  if (mode === 'cli-help-shutdown')
    await build({
      absWorkingDir: root,
      entryPoints: ['src/cli/index.ts'],
      outfile: path.join(directory, 'index.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: { __OUTPUT_WRITER_SHA256__: JSON.stringify(pin) },
      logLevel: 'silent'
    })
  const built = await build({
    stdin: { contents: harness, resolveDir: root, loader: 'js' },
    outfile: path.join(directory, 'harness.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['./index.cjs'],
    define: { __OUTPUT_WRITER_SHA256__: JSON.stringify(pin) },
    metafile: true,
    logLevel: 'silent'
  })
  await fs.writeFile(path.join(directory, 'metafile.json'), JSON.stringify(built.metafile, null, 2))
  if (mutation) await mutation(directory)
  const child = spawn(process.execPath, [path.join(directory, 'harness.cjs'), mode], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      MODEL_API_KEY: 'fixture-not-a-real-key',
      NODE_OPTIONS: '--no-deprecation',
      OUTPUT_BRIDGE_SENTINEL: 'must-not-inherit'
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const observers = [],
    out = [],
    err = []
  let result,
    uncaught,
    forcedKill = false,
    releasedBeforeExit = false
  child.on('message', (message) => {
    if (message.result) result = message.result
    else if (message.uncaught) uncaught = message.uncaught
    else observers.push(message)
  })
  child.stdout.on('data', (bytes) => out.push(bytes))
  child.stderr.on('data', (bytes) => err.push(bytes))
  if (paused === 'stdout') child.stdout.pause()
  if (paused === 'stderr') child.stderr.pause()
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  const closed = new Promise((resolve) => child.once('close', () => resolve()))
  let outcome = await Promise.race([exited, pause(7000).then(() => null)])
  if (!outcome) {
    releasedBeforeExit = true
    child.stdout.resume()
    child.stderr.resume()
    outcome = await Promise.race([exited, pause(2000).then(() => null)])
    if (!outcome) {
      forcedKill = true
      child.kill()
      outcome = await exited
    }
  }
  const observedBeforeRelease = {
    outcome,
    result,
    observers: [...observers],
    releasedBeforeExit,
    forcedKill
  }
  child.stdout.resume()
  child.stderr.resume()
  await closed
  const report = {
    name,
    mode,
    classification:
      fake === undefined
        ? 'original bridge and original fixed writer on actual Windows native pipes'
        : 'synthetic fixed writer protocol fixture; original bridge/CLI on actual Windows pipes',
    harnessPid: child.pid,
    originalWriterHash: writerHash,
    pinnedWriterHash: pin,
    outcome,
    result,
    uncaught,
    observers,
    observedBeforeRelease,
    stdoutHash: hash(Buffer.concat(out)),
    stdoutBytes: Buffer.concat(out).length,
    stderrHash: hash(Buffer.concat(err)),
    stderrBytes: Buffer.concat(err).length,
    releasedBeforeExit,
    forcedKill,
    modelRequests: 0,
    agentTasks: 0,
    taskToolSpawns: 0
  }
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2))
  assert.equal(uncaught, undefined)
  assert.equal(forcedKill, false)
  assert.equal(releasedBeforeExit, false)
  assert.equal(outcome.code, expectedExit)
  assert.equal(outcome.signal, null)
  assert.ok(result)
  if (mode !== 'custom') {
    assert.equal(result.native.platform, 'win32')
    assert.equal(result.native.stdoutType, 'pipe')
    assert.equal(result.native.stderrType, 'pipe')
  }
  for (const helper of result.children) {
    assert.equal(helper.program, process.execPath)
    assert.deepEqual(helper.argv, [path.join(directory, 'output-writer.cjs')])
    assert.equal(helper.cwd, directory)
    assert.ok(helper.envKeys.every((key) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)))
    assert.equal(helper.closed, true)
  }
  return report
}
async function check(name, action) {
  const start = Date.now()
  try {
    const details = await action()
    checks.push({ name, pass: true, elapsedMs: Date.now() - start, ...details })
  } catch (error) {
    checks.push({ name, pass: false, elapsedMs: Date.now() - start, error: error.stack })
    console.error(name + ': ' + error.message)
  }
}
await check(
  'native healthy pipes preserve all UTF8 bytes and use one exact system-only helper',
  async () => {
    const report = await runCase('healthy', 'healthy')
    assert.equal(report.stdoutHash, report.result.stdoutHash)
    assert.equal(report.stderrHash, report.result.stderrHash)
    assert.deepEqual(report.result.errors, [])
    assert.equal(report.result.children.length, 1)
    assert.equal(report.result.children[0].code, 0)
    return {
      evidence: 'healthy/results.json',
      helperCount: 1,
      stdoutBytes: report.stdoutBytes,
      stderrBytes: report.stderrBytes
    }
  }
)
for (const target of ['stdout', 'stderr'])
  await check(
    'cancel actual paused native ' +
      target +
      ' exits before reader release and observes helper close',
    async () => {
      const report = await runCase('cancel-' + target, 'cancel-' + target, {
        paused: target,
        expectedExit: 130
      })
      assert.equal(report.result.children.length, 1)
      assert.ok(report.result.failure)
      assert.equal(report.result.exitCode, 130)
      assert.ok(report.observers.some((item) => item.observer === 'abort-fired'))
      assert.ok(report.result.elapsedMs < 3000)
      assert.equal(report.result.children[0].closed, true)
      return {
        evidence: 'cancel-' + target + '/results.json',
        elapsedMs: report.result.elapsedMs,
        realNativePausedPipe: true,
        forceExit: false
      }
    }
  )
await check('custom stream identities preserved with no output helper', async () => {
  const report = await runCase('custom', 'custom')
  assert.equal(report.result.text, 'custom😀')
  assert.deepEqual(report.result.children, [])
})
await check('disposed-before-ready never creates a late helper', async () => {
  const report = await runCase('disposed-before-ready', 'disposed-before-ready')
  assert.ok(report.result.failure)
  assert.deepEqual(report.result.children, [])
})
for (const [name, mutation] of [
  ['missing-writer', (directory) => fs.unlink(path.join(directory, 'output-writer.cjs'))],
  [
    'tampered-writer',
    (directory) => fs.appendFile(path.join(directory, 'output-writer.cjs'), '\n// changed')
  ],
  ['missing-manifest', (directory) => fs.unlink(path.join(directory, 'build-manifest.json'))],
  [
    'malformed-manifest',
    (directory) => fs.writeFile(path.join(directory, 'build-manifest.json'), '{}')
  ],
  [
    'wrong-manifest-hash',
    (directory) =>
      fs.writeFile(
        path.join(directory, 'build-manifest.json'),
        JSON.stringify({ entries: [{ name: 'output-writer.cjs', sha256: '0'.repeat(64) }] })
      )
  ],
  [
    'duplicate-manifest-entry',
    (directory) =>
      fs.writeFile(
        path.join(directory, 'build-manifest.json'),
        JSON.stringify({
          entries: [
            { name: 'output-writer.cjs', sha256: writerHash },
            { name: 'output-writer.cjs', sha256: '0'.repeat(64) }
          ]
        })
      )
  ],
  [
    'hardlinked-writer',
    (directory) =>
      fs.link(path.join(directory, 'output-writer.cjs'), path.join(directory, 'writer-alias.cjs'))
  ],
  [
    'hardlinked-manifest',
    (directory) =>
      fs.link(
        path.join(directory, 'build-manifest.json'),
        path.join(directory, 'manifest-alias.json')
      )
  ]
])
  await check('fixed resource identity rejects ' + name + ' before helper launch', async () => {
    const report = await runCase(name, 'identity', { mutation })
    assert.ok(report.result.failure?.includes('身份'))
    assert.deepEqual(report.result.children, [])
  })
const fakePrefix = "process.on('SIGINT',()=>{});process.send({type:'ready'});"
for (const [name, fake] of [
  ['invalid-ready', "process.send({type:'ready',extra:true});process.on('message',()=>{});"],
  ['unexpected-ready', fakePrefix + "process.on('message',()=>process.send({type:'ready'}));"],
  [
    'wrong-ack-sequence',
    fakePrefix + "process.on('message',m=>process.send({type:'ack',sequence:m.sequence+1}));"
  ],
  [
    'extra-ack-key',
    fakePrefix +
      "process.on('message',m=>process.send({type:'ack',sequence:m.sequence,extra:true}));"
  ],
  [
    'error-ack',
    fakePrefix + "process.on('message',m=>process.send({type:'error',sequence:m.sequence}));"
  ],
  ['startup-exit', 'process.exitCode=7;'],
  [
    'duplicate-ack',
    fakePrefix +
      "process.on('message',m=>{process.send({type:'ack',sequence:m.sequence});setTimeout(()=>process.send({type:'ack',sequence:m.sequence}),5);});"
  ]
])
  await check('original bridge fails closed for synthetic ' + name, async () => {
    const report = await runCase(name, 'protocol', { fake })
    assert.ok(report.result.failure || report.result.streamDestroyed)
  })
const shutdownFail =
  fakePrefix +
  "process.on('message',m=>{if(m.type==='finish'){process.exitCode=7;process.disconnect();}else process.send({type:'ack',sequence:m.sequence});});"
await check('normal finish observes helper nonzero exit as output failure', async () => {
  const report = await runCase('shutdown-exit-seven', 'shutdown', { fake: shutdownFail })
  assert.ok(report.result.failure)
  assert.equal(report.result.children[0].code, 7)
})
await check(
  'CLI help reports helper shutdown failure after cleanup instead of premature success',
  async () => {
    const report = await runCase('cli-help-shutdown', 'cli-help-shutdown', {
      fake: shutdownFail,
      expectedExit: 1
    })
    assert.equal(report.result.exitCode, 1)
  }
)

async function writerCase(name, messages, valid) {
  const directory = path.join(evidence, 'writer-' + name)
  await fs.mkdir(directory)
  const writer = path.join(directory, 'output-writer.cjs')
  await fs.writeFile(writer, writerBytes)
  const child = spawn(process.execPath, [writer], {
    cwd: directory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let out = '',
    err = '',
    sent = false
  const received = []
  child.stdout.on('data', (bytes) => (out += bytes))
  child.stderr.on('data', (bytes) => (err += bytes))
  child.on('message', (message) => {
    received.push(message)
    if (message.type === 'ready' && !sent) {
      sent = true
      for (const entry of messages) child.send(entry)
    } else if (valid && message.type === 'ack') child.send({ type: 'finish' })
  })
  const outcome = await new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal }))
  )
  const report = {
    originalWriterHash: writerHash,
    outcome,
    received,
    stdout: out,
    stderr: err,
    modelRequests: 0,
    taskToolSpawns: 0
  }
  await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(report, null, 2))
  assert.equal(outcome.code, valid ? 0 : 1)
  assert.equal(outcome.signal, null)
  if (valid) {
    assert.equal(out, '汉😀\n')
    assert.ok(received.some((value) => value.type === 'ack' && value.sequence === 1))
  }
}
await check(
  'original writer sends ACK only after exact UTF8 native write and finishes naturally',
  () => writerCase('valid', [{ type: 'write', sequence: 1, target: 1, text: '汉😀\n' }], true)
)
for (const [name, message] of [
  ['unknown-type', { type: 'execute' }],
  ['array', []],
  ['null', null],
  ['invalid-target', { type: 'write', sequence: 1, target: 3, text: 'x' }],
  ['extra-key', { type: 'write', sequence: 1, target: 1, text: 'x', command: 'no' }],
  ['sequence-zero', { type: 'write', sequence: 0, target: 1, text: 'x' }],
  ['oversize', { type: 'write', sequence: 1, target: 1, text: 'x'.repeat(4 * 1024 * 1024 + 1) }],
  ['finish-extra-key', { type: 'finish', command: 'no' }]
])
  await check('original writer rejects malformed ' + name + ' without output', () =>
    writerCase(name, [message], false)
  )
const report = {
  node: process.version,
  platform: process.platform,
  sourceIdentities: identities,
  writerHash,
  modelRequests: 0,
  agentTasks: 0,
  taskToolSpawns: 0,
  checks,
  passed: checks.filter((check) => check.pass).length,
  failed: checks.filter((check) => !check.pass).length,
  limitations: [
    'Native pipe cancellation is an offline I/O test with scheduled AbortController, not ConPTY Ctrl+C or a model/tool business run.',
    'Malformed IPC and exit status cases use expressly synthetic writer resources with their own injected pin; these never bypass release resource pinning.',
    'Symbolic-link identity branch is not exercised here; hardlink and content/missing/manifest identities are exercised.',
    'No detached grandchildren, Agent task, business tool or model request is created by this fixture.'
  ]
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ evidence, passed: report.passed, failed: report.failed }))
process.exitCode = report.failed ? 1 : 0
