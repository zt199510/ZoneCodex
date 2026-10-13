import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('turn-host')
const outfile = path.join(evidence, 'turn-host.cjs')
const bundle = await build({
  entryPoints: ['src/main/git/git-turn-host.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'silent'
})
const api = createRequire(import.meta.url)(outfile)
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [...Object.keys(bundle.metafile.inputs), 'src/main/agent/desktop-agent-host.ts'].map(
      async (file) => [file, hash(await fs.readFile(path.join(root, file)))]
    )
  )
)
const suite = checksFor(evidence, {
  sourceHashes,
  syntheticLifecycle: true,
  actualAgent: false,
  actualGit: false,
  actualElectron: false,
  realNetworking: false
})
await suite.check('unconfigured desktop observation starts no work', async () => {
  assert.equal(await api.beginSelectedGitTurn(7), undefined)
})
await suite.check(
  'only a window identity reaches observation; immutable finish survives replacement and is once-only',
  async () => {
    const received = [],
      completions = []
    api.configureGitTurnHost(async (...args) => {
      received.push(args)
      return async (...values) => completions.push(values)
    })
    const finish = await api.beginSelectedGitTurn(19)
    api.configureGitTurnHost(async () => {
      throw Error('unrelated replacement')
    })
    await Promise.all([finish('interrupted'), finish('completed')])
    assert.deepEqual(received, [[19]])
    assert.deepEqual(completions, [['interrupted']])
  }
)
await suite.check(
  'capture and retirement failures stay outside Agent result/trace and do not retry',
  async () => {
    assert.equal(await api.beginSelectedGitTurn(1), undefined)
    let calls = 0
    api.configureGitTurnHost(async () => async () => {
      calls++
      throw Error('Git fixture failure')
    })
    const finish = await api.beginSelectedGitTurn(1)
    await finish('failed')
    await finish('completed')
    assert.equal(calls, 1)
  }
)
await suite.check(
  'desktop host observes before its unique core call and retires in finally without passing Agent or PTY data',
  async () => {
    const source = await fs.readFile(
      path.join(root, 'src/main/agent/desktop-agent-host.ts'),
      'utf8'
    )
    const ast = ts.createSourceFile('desktop-agent-host.ts', source, ts.ScriptTarget.Latest, true)
    const starts = [],
      finishes = [],
      cores = []
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast)
        if (name === 'beginSelectedGitTurn') starts.push(node)
        if (name === 'finishGitTurn') finishes.push(node)
        if (name === 'runAgentCore') cores.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.equal(starts.length, 1)
    assert.deepEqual(
      starts[0].arguments.map((node) => node.getText(ast)),
      ['windowId']
    )
    assert.equal(cores.length, 1)
    assert(starts[0].pos < cores[0].pos)
    assert.equal(finishes.length, 1)
    assert.equal(finishes[0].arguments.length, 1)
    assert.match(finishes[0].arguments[0].getText(ast), /gitTurnStatus/)
    let parent = finishes[0].parent
    while (parent && !ts.isTryStatement(parent)) parent = parent.parent
    assert(
      parent?.finallyBlock &&
        parent.finallyBlock.pos < finishes[0].pos &&
        parent.finallyBlock.end > finishes[0].end
    )
    assert.deepEqual(Object.keys(bundle.metafile.inputs), ['src/main/git/git-turn-host.ts'])
  }
)
await suite.finish()
