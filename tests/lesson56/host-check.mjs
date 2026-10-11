import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = process.cwd()
const evidence = path.join(root, '.ui-check/test-runs/lesson56', 'host-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const output = path.join(evidence, 'host.cjs')
await build({
  stdin: {
    contents: `export * from './src/main/model/image-input'; export * from './src/main/model/context-summary'; export * from './src/main/model/response-client'; export { IMAGE_TURN_NOTICE } from './src/shared/image-input'`,
    resolveDir: root,
    loader: 'ts'
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
const api = createRequire(import.meta.url)(output)
const checks = []
async function check(name, test) {
  try {
    await test()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, error: String(error) })
  }
}
const prompt = '当前任务' + api.IMAGE_TURN_NOTICE
const historicalPrompt = '原历史图片' + api.IMAGE_TURN_NOTICE
let current = true
const captured = (id) => ({
  image: { imageId: id, name: 'fixture.png', mime: 'image/png', bytes: 3, width: 1, height: 1 },
  dataUrl: 'data:image/png;base64,AQID',
  assertCurrent: () => {
    if (!current) throw new Error('图片失效')
  }
})
const images = [
  { index: 2, prompt: historicalPrompt, captured: captured('old-image') },
  { index: 4, prompt, captured: captured('current-image') }
]
const working = [
  { role: 'assistant', content: '派生历史资料' },
  { role: 'user', content: historicalPrompt },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '历史回答' }] },
  { role: 'user', content: prompt }
]
const indices = [-1, 2, 3, 4]
await check('双图片组按原位置映射且原审计数组保持', async () => {
  const before = JSON.stringify(working)
  const mapped = api.remapConversationImages(working, images, 4, indices)
  assert.deepEqual(
    mapped.images.map((image) => image.index),
    [1, 3]
  )
  assert.equal(mapped.turnStart, 3)
  let wire
  const send = api.withConversationImageInput(
    async (input) => {
      wire = input
    },
    images,
    4,
    prompt,
    () => true
  )
  await send(working, new AbortController().signal, { originalIndices: indices })
  assert.equal(JSON.stringify(working), before)
  assert.equal(wire[1].content[0].text, historicalPrompt)
  assert.equal(wire[3].content[0].text, prompt)
  assert.equal(wire[1].content[1].image_url, images[0].captured.dataUrl)
  assert.equal(wire[3].content[1].image_url, images[1].captured.dataUrl)
})
for (const [name, map] of [
  ['重复原位置拒绝', [-1, 2, 2, 4]],
  ['乱序原位置拒绝', [-1, 3, 2, 4]],
  ['原图组丢失拒绝', [-1, 1, 3, 4]],
  ['当前问题丢失拒绝', [-1, 2, 3, 5]],
  ['映射长度错误拒绝', [-1, 2, 4]],
  ['摘要伪用户位置拒绝', [-1, -1, 3, 4]]
])
  await check(name, () => assert.throws(() => api.remapConversationImages(working, images, 4, map)))
await check('图片文字错绑拒绝且未传输', async () => {
  let sends = 0
  const send = api.withConversationImageInput(
    async () => {
      sends++
    },
    images,
    4,
    prompt,
    () => true
  )
  const changed = structuredClone(working)
  changed[1].content = '另一张图片' + api.IMAGE_TURN_NOTICE
  await assert.rejects(async () =>
    send(changed, new AbortController().signal, { originalIndices: indices })
  )
  assert.equal(sends, 0)
})
await check('图片捕获失效拒绝且未传输', async () => {
  current = false
  let sends = 0
  const send = api.withConversationImageInput(
    async () => {
      sends++
    },
    images,
    4,
    prompt,
    () => true
  )
  await assert.rejects(async () =>
    send(working, new AbortController().signal, { originalIndices: indices })
  )
  assert.equal(sends, 0)
  current = true
})
await check('主与摘要固定同配置、空工具表、摘要流隔离', async () => {
  const originalFetch = globalThis.fetch
  const oldModel = process.env.MODEL_NAME
  const requests = []
  let deltas = 0,
    messages = 0
  try {
    globalThis.fetch = async (_url, request) => {
      requests.push(JSON.parse(request.body))
      const response = {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }
        ]
      }
      return new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"private summary"}\n\nevent: response.completed\ndata: ' +
          JSON.stringify({ type: 'response.completed', response }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const config = Object.freeze({
      endpoint: 'https://fixture.invalid/responses',
      model: 'fixed-model',
      apiKey: 'fictional-test-key'
    })
    const main = api.createLiveResponse([{ type: 'function', name: 'fixture' }], '业务指令', config)
    const summary = api.createContextSummaryResponse(config)
    assert.equal(requests.length, 0)
    process.env.MODEL_NAME = 'changed-after-preparation'
    const signal = new AbortController().signal
    await main([{ role: 'user', content: '明确任务' }], signal)
    await summary([{ role: 'user', content: '有界材料' }], signal, {
      onTextDelta: () => deltas++,
      onMessageEvent: () => messages++
    })
    assert.deepEqual(
      requests.map((request) => request.model),
      ['fixed-model', 'fixed-model']
    )
    assert.deepEqual(requests[1].tools, [])
    assert.equal(requests[1].store, false)
    assert.equal(deltas, 0)
    assert.equal(messages, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (oldModel === undefined) delete process.env.MODEL_NAME
    else process.env.MODEL_NAME = oldModel
  }
})
await check('缺配置明确拒绝', () => assert.throws(() => api.readModelConfiguration({})))
const result = {
  pass: checks.every((item) => item.pass),
  layer: 'synthetic transport and image captures; no live pixels or network',
  evidence,
  checks
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ pass: result.pass, checks: checks.length, evidence }))
if (!result.pass) process.exitCode = 1
