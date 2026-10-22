import assert from 'node:assert/strict'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import {
  root,
  createEvidence,
  checksFor,
  hash,
  call,
  message,
  response,
  summarize
} from './runtime.mjs'

const evidence = await createEvidence('cli-terminal-failure')
const compiled = path.join(evidence, 'current-public-host.cjs')
const fixtureSources = {
  '../main/model/response-client': `export function readModelConfiguration() { globalThis.__lesson57TerminalFixture.configurationReads++; return { endpoint: 'https://example.invalid/v1/responses', model: 'gpt-6.1-sol', apiKey: 'SYNTHETIC_ONLY' }; }
export function createLiveResponse() { return (...args) => globalThis.__lesson57TerminalFixture.send(...args); }`,
  '../main/model/context-summary': `export function createContextSummaryResponse() { return (...args) => { globalThis.__lesson57TerminalFixture.summaryCalls++; return globalThis.__lesson57TerminalFixture.summarize(...args); }; }`,
  '../main/execution/approval-reviewer': `export function createApprovalReviewer() { return async () => { globalThis.__lesson57TerminalFixture.reviewCalls++; throw new Error('No model approval permitted in this fixture'); }; }`,
  '../main/execution/windows-command-backend': `export async function inspectWindowsCommandBackend() { globalThis.__lesson57TerminalFixture.backendInspections++; return null; }`,
  '../execution/command-runner': `export function startCommandProcess() { globalThis.__lesson57TerminalFixture.commandStarts++; throw new Error('No command process permitted in this fixture'); }`
}
// Shared runtime resolves these same adapters from main/agent rather than cli.
fixtureSources['../model/response-client'] = fixtureSources['../main/model/response-client']
fixtureSources['../model/context-summary'] = fixtureSources['../main/model/context-summary']
fixtureSources['./model-configuration'] = fixtureSources['../main/model/response-client'] + `export const fixedResponsesConfiguration = (value) => value;`
fixtureSources['./responses-provider'] = fixtureSources['../main/model/response-client'].replace('createLiveResponse', 'createResponsesSender')
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli/agent-host.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: compiled,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'lesson57-public-host-synthetic-transport',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: id }) =>
          Object.hasOwn(fixtureSources, id) ? { path: id, namespace: 'lesson57-fixture' } : null
        )
        builder.onLoad({ filter: /.*/, namespace: 'lesson57-fixture' }, ({ path: id }) => ({
          contents: fixtureSources[id],
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceFiles = Object.keys(bundle.metafile.inputs).filter(
  (file) => !file.startsWith('lesson57-fixture:')
)
assert(!sourceFiles.some((file) => /electron|agent-runner|agent-ipc/.test(file)))
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
await fs.writeFile(
  path.join(evidence, 'identity.json'),
  JSON.stringify(
    { sourceHashes, compiledSHA256: hash(await fs.readFile(compiled)), fixtureSources },
    null,
    2
  )
)
const counters = {
  configurationReads: 0,
  sendCalls: 0,
  summaryCalls: 0,
  reviewCalls: 0,
  backendInspections: 0,
  commandStarts: 0,
  unexpectedNetwork: 0
}
const fixture = {
  ...counters,
  summarize,
  send: async () => {
    throw new Error('No task transport installed')
  }
}
globalThis.__lesson57TerminalFixture = fixture
globalThis.fetch = () => {
  fixture.unexpectedNetwork++
  throw new Error('Network denied')
}
const api = createRequire(import.meta.url)(compiled)
assert.equal(typeof api.runAgentTask, 'function')
assert.equal(fixture.configurationReads, 0, 'Public module import remains inert')
const suite = checksFor(evidence, {
  ordinaryNode: true,
  currentSource: true,
  publicRunAgentTask: true,
  realHostToolsAndStore: true,
  realDisk: true,
  syntheticTransport: true,
  realTransport: false,
  sourceHashes,
  stubbedDependencies: Object.keys(fixtureSources)
})

await suite.check(
  'terminal checkpoint failure keeps observed write, current approval and raw evidence instead of returning an empty failed outcome',
  async () => {
    const directory = path.join(evidence, 'fixture')
    const cwd = path.join(directory, 'workspace')
    await fs.mkdir(cwd, { recursive: true })
    const seed = path.join(cwd, 'protected-original.txt')
    const seedBytes = Buffer.from('\ufeffProtected original bytes remain.\r\n\r\n')
    await fs.writeFile(seed, seedBytes, { flag: 'wx' })
    const checkpoint = path.join(directory, 'task.checkpoint.json')
    const target = path.join(directory, 'created-outside-cwd.txt')
    const createdBytes = Buffer.from('Real write already happened; retain its observed outcome.\n')
    const badCheckpoint = Buffer.from('{broken checkpoint from explicit failure injection\n')
    const controller = new AbortController()
    const events = [],
      approvals = []
    let injected = false,
      safeRawPath,
      safeRawBytes,
      safePointer
    fixture.send = async (_input, signal) => {
      fixture.sendCalls++
      signal.throwIfAborted()
      return fixture.sendCalls === 1
        ? response(
            call('lesson57-create-before-terminal-failure', 'create_workspace_file', {
              path: target,
              content: createdBytes.toString('utf8')
            })
          )
        : response(message('Should never reach a second live request after cancellation'))
    }
    const outcome = await api.runAgentTask(
      {
        mode: 'execute',
        prompt: '在隔离证据根明确创建一个文件；当前写入重新批准，随后模拟终态checkpoint故障。',
        cwd,
        permission: 'default',
        checkpoint
      },
      {
        signal: controller.signal,
        approve: async (request, signal) => {
          signal.throwIfAborted()
          assert.equal(request.kind, 'create')
          assert.equal(request.path, target)
          approvals.push({
            requestId: request.requestId,
            conversationId: request.conversationId,
            kind: request.kind,
            path: request.path
          })
          return true
        },
        onEvent: (event) => {
          events.push(structuredClone(event))
          if (event.type === 'progress' && event.message === '第 2 次模型请求') {
            assert.equal(injected, false)
            safePointer = readFileSync(checkpoint)
            const pointer = JSON.parse(safePointer)
            safeRawPath = path.join(path.dirname(checkpoint), pointer.raw.file)
            safeRawBytes = readFileSync(safeRawPath)
            const savedRaw = JSON.parse(safeRawBytes)
            assert(
              savedRaw.some(
                (entry) =>
                  entry.type === 'function_call_output' &&
                  JSON.parse(entry.output).status === 'created'
              )
            )
            assert.deepEqual(readFileSync(target), createdBytes)
            writeFileSync(path.join(directory, 'last-good.checkpoint.snapshot.json'), safePointer)
            writeFileSync(path.join(directory, 'last-good.raw.snapshot.json'), safeRawBytes)
            writeFileSync(checkpoint, badCheckpoint)
            injected = true
            controller.abort(new Error('Explicit fixture cancellation after a saved real write'))
          }
        }
      }
    )
    await fs.writeFile(path.join(directory, 'outcome.json'), JSON.stringify(outcome, null, 2))
    await fs.writeFile(path.join(directory, 'events.json'), JSON.stringify(events, null, 2))
    await fs.writeFile(path.join(directory, 'approvals.json'), JSON.stringify(approvals, null, 2))
    assert.equal(
      injected,
      true,
      'The complete tool group was persisted before injecting terminal save failure'
    )
    assert.equal(controller.signal.aborted, true)
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.task.state, 'failed')
    assert.match(outcome.task.error, /CHECKPOINT_INVALID|续接记录格式无效/)
    assert.deepEqual(outcome.effects, { approved: true, started: true })
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].requestId, outcome.requestId)
    assert.equal(outcome.toolResults.length, 1)
    const observed = outcome.toolResults[0]
    assert.equal(observed.callId, 'lesson57-create-before-terminal-failure')
    assert.equal(observed.name, 'create_workspace_file')
    const toolOutput = JSON.parse(observed.output)
    assert.equal(toolOutput.status, 'created')
    assert.equal(toolOutput.path, target)
    assert.deepEqual(await fs.readFile(target), createdBytes)
    assert.deepEqual(await fs.readFile(seed), seedBytes)
    assert.deepEqual(await fs.readFile(checkpoint), badCheckpoint)
    assert.deepEqual(await fs.readFile(safeRawPath), safeRawBytes)
    const savedOutput = JSON.parse(safeRawBytes).find(
      (entry) => entry.type === 'function_call_output'
    )
    assert.equal(savedOutput.output, observed.output)
    assert.equal(
      fixture.sendCalls,
      1,
      'The cancelled second progress event starts no further transport'
    )
    assert.equal(fixture.summaryCalls, 0)
    assert.equal(fixture.reviewCalls, 0)
    assert.equal(fixture.commandStarts, 0)
    assert.equal(fixture.unexpectedNetwork, 0)
    return {
      requestId: outcome.requestId,
      exitCode: outcome.exitCode,
      effects: outcome.effects,
      currentApprovals: approvals.length,
      actualToolOutput: toolOutput,
      originalSHA256: hash(seedBytes),
      createdSHA256: hash(createdBytes),
      rawSHA256: hash(safeRawBytes),
      brokenCheckpointSHA256: hash(badCheckpoint),
      lastGoodCheckpointSHA256: hash(safePointer),
      preservedRawPath: safeRawPath
    }
  }
)

await suite.finish({
  counters: Object.fromEntries(Object.keys(counters).map((key) => [key, fixture[key]]))
})
