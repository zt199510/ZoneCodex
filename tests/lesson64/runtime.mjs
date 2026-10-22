import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

export const root = path.resolve(import.meta.dirname, '../..')
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export async function until(action, label, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const result = await action(); if (result) return result; await delay(25) }
  throw Error('Timed out: ' + label)
}
export const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
export async function evidenceFor(name) {
  const directory = path.join(root, '.ui-check/test-runs/lesson64', name + '-' + randomUUID())
  await fs.mkdir(directory, { recursive: true }); return directory
}
export async function compileProduct(evidence, entries = [], userData = path.join(evidence, 'user-data')) {
  await fs.mkdir(userData, { recursive: true })
  const handlers = new Map(), owners = new Map(), events = []
  const fixture = {
    app: { getPath: () => userData },
    ipcMain: { handle: (name, handler) => { assert(!handlers.has(name)); handlers.set(name, handler) } },
    BrowserWindow: { fromId: (id) => owners.get(id), fromWebContents: (sender) => [...owners.values()].find((owner) => owner.webContents === sender) },
    shell: {}, dialog: {}
  }
  const key = '__lesson64_' + randomUUID().replaceAll('-', '')
  globalThis[key] = fixture
  const output = path.join(evidence, 'product-' + randomUUID() + '.cjs')
  const files = entries.length ? entries : [
    'src/main/model/model-configuration.ts', 'src/main/model/model-session.ts',
    'src/main/model/response-client.ts', 'src/main/model/model-ipc.ts', 'src/main/model/offline-provider.ts',
    'src/main/model/title-response.ts', 'src/main/agent/agent-runtime.ts', 'src/main/agent/agent-core.ts',
    'src/main/agent/context-manager.ts', 'src/main/mcp/mcp-manager.ts', 'src/main/mcp/mcp-client.ts',
    'src/main/execution/execution-approval.ts', 'src/main/execution/approval-reviewer.ts',
    'src/main/execution/workspace-authorization.ts', 'src/main/git/git-workbench-generation.ts',
    'src/shared/mcp.ts', 'src/shared/model.ts', 'src/shared/conversation-title.ts'
  ]
  const result = await build({
    stdin: { contents: files.map((file) => `export * from ${JSON.stringify('./' + file)};`).join('\n'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', outfile: output, metafile: true, logLevel: 'silent',
    plugins: [{ name: 'electron-boundary-only', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'boundary' }))
      builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: `export const { app, ipcMain, BrowserWindow, shell, dialog } = globalThis[${JSON.stringify(key)}]`, loader: 'js' }))
    } }]
  })
  const sources = Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).filter((name) => name !== '<stdin>' && !name.startsWith('boundary:')).map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])))
  await fs.writeFile(output + '.identity.json', JSON.stringify({ sources, compiledSHA256: hash(await fs.readFile(output)), substituted: ['electron host boundary only'] }, null, 2))
  const api = createRequire(import.meta.url)(output)
  const owner = (id = 1) => {
    if (owners.has(id)) return owners.get(id)
    const window = new EventEmitter(), contents = new EventEmitter()
    window.id = id; window.webContents = contents; window.isDestroyed = () => false
    contents.mainFrame = {}; contents.isDestroyed = () => false
    contents.send = (channel, value) => { events.push({ windowId: id, channel, value }); contents.emit('send', channel, value) }
    owners.set(id, window); return window
  }
  const invoke = (channel, args = [], id = 1) => {
    const window = owner(id)
    return handlers.get(channel)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args)
  }
  return { api, owner, invoke, events, handlers, userData, sources, output }
}
export function suite(evidence) {
  const checks = []
  return {
    async check(name, action) {
      try { const details = await action(); checks.push({ name, pass: true, details }); console.log('PASS ' + name) }
      catch (error) { checks.push({ name, pass: false, error: error.stack }); console.error('FAIL ' + name, error) }
    },
    async finish(extra = {}) {
      const report = { pass: checks.length > 0 && checks.every((check) => check.pass), evidence, checks, ...extra }
      await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
      if (!report.pass) process.exitCode = 1
      console.log(JSON.stringify({ pass: report.pass, checks: checks.length, evidence }))
      return report
    }
  }
}
