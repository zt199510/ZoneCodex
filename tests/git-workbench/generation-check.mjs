import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createEvidence, compile, checksFor } from './runtime.mjs'

const evidence = await createEvidence('generation')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-workbench-generation.ts',
  'src/main/model/response-client.ts',
  'src/main/git/git-snapshot.ts',
  'src/shared/git-workbench.ts'
])
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256,
  actualCurrentGeneratorAndResponseClient: true,
  actualDisk: true,
  syntheticGitRunner: true,
  syntheticHTTPSResponse: true,
  realNetworking: false,
  agentCoreCalls: 0
})
const marker = path.join(evidence, 'freshness.txt')
await fs.writeFile(marker, 'original')
const source = new api.SourceCapture()
await source.file(marker, 4096)
const snapshot = { source, head: 'present', pathspecs: ['.'] }
let gitCalls = [],
  modelCalls = []
const patch = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
const context = {
  snapshot,
  refs: new Map(),
  run: async (args) => {
    gitCalls.push(args)
    return Buffer.from(patch)
  }
}
const request = {
  requestId: randomUUID(),
  viewId: randomUUID(),
  revision: randomUUID(),
  purpose: 'commit'
}
let modelOutput = { subject: '更新文件', body: '说明候选，等待手工提交。' }
const send = async (input) => {
  modelCalls.push(input)
  return {
    status: 'completed',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(modelOutput) }] }
    ]
  }
}
await suite.check('import and availability do not send any model request', () => {
  assert.equal(modelCalls.length, 0)
  assert.equal(gitCalls.length, 0)
})
await suite.check(
  'explicit generation uses only current staged Git data and returns editable candidate',
  async () => {
    const data = await api.generateGitText(context, request, new AbortController().signal, send)
    assert.deepEqual(data, modelOutput)
    assert(gitCalls[0].includes('--cached'))
    const payload = JSON.parse(modelCalls[0][0].content)
    assert.deepEqual(Object.keys(payload).sort(), ['diff', 'guidance', 'purpose'])
    assert.equal(payload.diff, patch)
    assert(!JSON.stringify(modelCalls).includes('terminal'))
  }
)
await suite.check(
  'exact generation request rejects Agent grants, arbitrary paths and renderer diff data',
  () => {
    assert(api.parseGitGenerateRequest(request))
    for (const field of [
      'raw',
      'diff',
      'cwd',
      'ticket',
      'conversationId',
      'approvalId',
      'ptyOutput'
    ])
      assert.equal(api.parseGitGenerateRequest({ ...request, [field]: 'injected' }), null)
  }
)
await suite.check('empty patch never sends model request', async () => {
  const before = modelCalls.length
  await assert.rejects(
    api.generateGitText(
      { ...context, run: async () => Buffer.alloc(0) },
      request,
      new AbortController().signal,
      send
    ),
    /没有可用于/
  )
  assert.equal(modelCalls.length, before)
})
await suite.check(
  'PR generation resolves only main-held comparison ref and commit tree',
  async () => {
    const refId = randomUUID(),
      oid = '1'.repeat(40)
    const calls = []
    const data = await api.generateGitText(
      {
        ...context,
        refs: new Map([[refId, { oid }]]),
        run: async (args) => {
          calls.push(args)
          return Buffer.from(args[0] === 'merge-base' ? oid : patch)
        }
      },
      { ...request, purpose: 'pr', baseRefId: refId },
      new AbortController().signal,
      send
    )
    assert.deepEqual(data, modelOutput)
    assert.deepEqual(calls[0], ['merge-base', 'HEAD', oid])
    assert(calls[1].includes(oid) && calls[1].includes('HEAD'))
  }
)
await suite.check('response with tool request is rejected and never executed', async () => {
  await assert.rejects(
    api.generateGitText(context, request, new AbortController().signal, async () => ({
      status: 'completed',
      output: [{ type: 'function_call', name: 'read_file', arguments: '{}' }]
    })),
    /不支持的内容/
  )
})
await suite.check('malformed, oversized, control-bearing model candidate is rejected', async () => {
  for (const invalid of [
    { subject: '标题\n换行', body: '' },
    { subject: '标题', body: '', approval: true },
    { subject: '', body: '' },
    { subject: '标题', body: '\0' }
  ]) {
    modelOutput = invalid
    await assert.rejects(
      api.generateGitText(context, request, new AbortController().signal, send),
      /无效|限制/
    )
  }
  modelOutput = { subject: '候选', body: '正文' }
})
await suite.check(
  'current transport has no tools, no storage and only dedicated generation instructions',
  async () => {
    const previous = globalThis.fetch
    const bodies = []
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: JSON.stringify(modelOutput) }]
                }
              ]
            }
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    try {
      const response = api.createLiveResponse([], 'Dedicated Git generation', {
        endpoint: 'https://fixture.invalid/v1/responses',
        model: 'fixture-model',
        apiKey: 'synthetic-not-a-credential'
      })
      await api.generateGitText(context, request, new AbortController().signal, response)
      assert.equal(bodies.length, 1)
      assert.deepEqual(bodies[0].tools, [])
      assert.equal(bodies[0].store, false)
      assert.equal(bodies[0].instructions, 'Dedicated Git generation')
      assert.equal(bodies[0].input.length, 1)
    } finally {
      globalThis.fetch = previous
    }
  }
)
await suite.check(
  'serialized input escaping and guidance stay inside 256 KiB before any model request',
  async () => {
    const before = modelCalls.length
    await assert.rejects(
      api.generateGitText(
        { ...context, run: async () => Buffer.from('+' + '\t'.repeat(150000)) },
        request,
        new AbortController().signal,
        send
      ),
      /256 KiB/
    )
    assert.equal(modelCalls.length, before)
  }
)
await suite.check(
  'source change during generation rejects stale candidate without a Git write',
  async () => {
    await assert.rejects(
      api.generateGitText(context, request, new AbortController().signal, async (input) => {
        await fs.writeFile(marker, 'external edit')
        return send(input)
      }),
      /变化/
    )
    assert.equal(await fs.readFile(marker, 'utf8'), 'external edit')
    assert(gitCalls.every((args) => args[0] === 'diff'))
  }
)
await suite.finish()
