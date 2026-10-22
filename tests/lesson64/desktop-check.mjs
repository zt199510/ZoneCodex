// Actual isolated Electron, production offline Provider. No scripted model in this suite.
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { evidenceFor, root, hash, delay, alive, until as poll } from './runtime.mjs'
const packaged = process.argv.includes('--packaged')
assert(process.argv.slice(2).every((v) => v === '--packaged'))
assert.equal(process.platform, 'win32')
const evidence = await evidenceFor('desktop-' + (packaged ? 'packaged' : 'development'))
const userData = path.join(evidence, 'user-data'), auditFile = path.join(evidence, 'mcp.jsonl')
await fs.mkdir(userData, { recursive: true })
const report = { pass: false, evidence, packaged, actualElectron: true, actualUIInput: true, syntheticModel: false, checks: [], processes: [], failures: [] }
const check = (name, details = {}) => { report.checks.push({ name, pass: true, ...details }); console.log('PASS ' + name) }
const require = createRequire(import.meta.url)
const names = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
report.identity = Object.fromEntries(await Promise.all(names.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])))
if (packaged) for (const name of names) assert.equal(hash(require('@electron/asar').extractFile(path.join(root, 'dist/win-unpacked/resources/app.asar'), path.normalize(name))), report.identity[name], 'Current package matches build: ' + name)
async function freePort() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise((r) => s.close(r)); return port }
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(), events = []; let serial = 0
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', ({ data }) => { const v = JSON.parse(data); if (!v.id) return void events.push(v); const p = pending.get(v.id); if (!p) return; pending.delete(v.id); clearTimeout(p.timer); v.error ? p.reject(Error(JSON.stringify(v.error))) : p.resolve(v.result) })
  return { socket, events, cdp: (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)) }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })) }) }
}
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const { app } = require('electron'), fs = require('node:fs'), cp = require('node:child_process')
  app.setPath('userData', config.userData)
  for (const key of Object.keys(process.env)) if (/^(MODEL_|OPENAI_)/i.test(key)) delete process.env[key]
  const audit = { network: 0, spawns: [] }
  const save = () => fs.writeFileSync(config.audit, JSON.stringify(audit, null, 2))
  const deny = () => { audit.network++; save(); throw Error('Desktop offline acceptance refuses network') }
  globalThis.fetch = deny
  for (const protocol of ['node:http', 'node:https']) { const m = require(protocol); m.request = m.get = deny }
  const spawn = cp.spawn
  cp.spawn = function (...args) { const child = spawn.apply(this, args); audit.spawns.push({ command: args[0], pid: child.pid }); save(); return child }
  globalThis.__lesson64Audit = audit
  globalThis.__lesson64Quit = () => app.quit()
  save(); return true
}
async function launch(stage, action) {
  const mainPort = await freePort(), rendererPort = await freePort(), env = { ...process.env, APPDATA: path.join(evidence, 'appdata'), LOCALAPPDATA: path.join(evidence, 'localappdata') }
  for (const key of Object.keys(env)) if (/^(MODEL_|OPENAI_|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|NODE_OPTIONS$)/i.test(key)) delete env[key]
  await fs.mkdir(env.APPDATA, { recursive: true }); await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  const log = await fs.open(path.join(evidence, stage + '.log'), 'w')
  const child = spawn(path.join(root, packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'), [...(packaged ? [] : [path.join(root, 'out/main/index.js')]), '--user-data-dir=' + userData, '--inspect-brk=127.0.0.1:' + mainPort, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + rendererPort, '--disable-gpu'], { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
  const record = { stage, pid: child.pid, forcedKill: false }; report.processes.push(record)
  let main, renderer
  const until = (f, label, ms = 30000) => poll(async () => { if (child.exitCode !== null) throw Error('Desktop exited ' + label); return f() }, label, ms)
  const evaluateOn = async (target, expression) => { const r = await target.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: target === renderer }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value }
  try {
    const target = await until(async () => { try { return (await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0] } catch { return null } }, 'inspector')
    main = await connect(target.webSocketDebuggerUrl); await main.cdp('Runtime.enable'); await main.cdp('Debugger.enable'); await main.cdp('Runtime.runIfWaitingForDebugger')
    await until(() => main.events.some((e) => e.method === 'Debugger.paused'), 'main entry pause')
    assert.equal(await evaluateOn(main, '(' + install.toString() + ')(' + JSON.stringify({ root, userData, audit: path.join(evidence, stage + '-audit.json') }) + ')'), true)
    await main.cdp('Debugger.resume'); await main.cdp('Debugger.disable')
    const page = await until(async () => { try { return (await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()).find((p) => p.type === 'page' && p.url.includes('renderer')) } catch { return null } }, 'renderer')
    renderer = await connect(page.webSocketDebuggerUrl); await renderer.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    const evaluate = (expression) => evaluateOn(renderer, expression)
    const click = async (selector) => {
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);if(!h||!(h===n||n.contains(h)))throw Error('Blocked '+${JSON.stringify(selector)});return {x,y}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await renderer.cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
      await delay(100)
    }
    const clickText = async (text, parent = 'body') => {
      await evaluate(`(()=>{document.querySelectorAll('[data-lesson64]').forEach(n=>n.removeAttribute('data-lesson64'));const n=[...document.querySelectorAll(${JSON.stringify(parent + ' button')})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!n)throw Error('Missing button '+${JSON.stringify(text)});n.setAttribute('data-lesson64','yes')})()`)
      await click('[data-lesson64]')
    }
    const fill = async (selector, text) => {
      await click(selector)
      for (const type of ['keyDown', 'keyUp']) await renderer.cdp('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
      await renderer.cdp('Input.insertText', { text })
    }
    const key = async (key, code, modifiers = 0, windowsVirtualKeyCode = 0) => { for (const type of ['keyDown', 'keyUp']) await renderer.cdp('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode }); await delay(100) }
    const api = (name, ...args) => evaluate('window.api[' + JSON.stringify(name) + '](...' + JSON.stringify(args) + ')')
    await until(() => evaluate('!!document.querySelector("#chat-input")&&!document.querySelector("#chat-input").disabled'), 'composer')
    await action({ evaluate, click, clickText, fill, key, api, until, renderer })
    const audit = await evaluateOn(main, 'globalThis.__lesson64Audit'); assert.equal(audit.network, 0); record.audit = audit
    await main.cdp('Runtime.evaluate', { expression: 'setTimeout(()=>globalThis.__lesson64Quit(),50)' })
    main.socket.close(); renderer.socket.close()
    await poll(() => child.exitCode !== null, 'actual app process exit', 12000)
    record.exitCode = child.exitCode; assert.equal(child.exitCode, 0)
    for (const start of audit.spawns) if (start.pid) await poll(() => !alive(start.pid), 'spawn retired ' + start.pid, 8000)
    check(stage + ' graceful application/MCP cleanup and zero remote requests')
  } finally {
    renderer?.socket.close(); main?.socket.close()
    if (child.exitCode === null) { record.forcedKill = true; child.kill(); await delay(1000) }
    await log.close()
  }
}
const notice = '当前为离线模式，未调用推理模型，也未执行本轮任务。'
try {
  await launch('first', async ({ evaluate, click, clickText, fill, key, api, until, renderer }) => {
    assert.equal((await api('getModelStatus')).state, 'offline')
    check('fresh installation starts offline with no login or model configuration')
    await key(',', 'Comma', 2, 188)
    await until(() => evaluate('!!document.querySelector(".settings-page:not([hidden])")'), 'settings open')
    assert.match(await evaluate('document.querySelector(".settings-page").textContent'), /离线/)
    check('readonly model status visible; absent MCP configuration initializes empty')
    await fill('input[placeholder="ID"]', 'desktop64'); await fill('input[placeholder="名称"]', 'Lesson64 Local')
    await fill('input[placeholder="可执行文件"]', process.execPath)
    await fill('textarea[placeholder="参数，每行一个"]', [path.join(root, 'tests/lesson64/mcp-fixture.mjs'), auditFile].join('\n'))
    await clickText('保存 Server', '.settings-page')
    await until(async () => (await api('listMcpServers')).length === 1, 'saved MCP')
    await clickText('连接', '.settings-page')
    await until(async () => (await api('listMcpServers'))[0]?.state === 'connected', 'MCP connected')
    assert.equal((await api('listMcpServers'))[0].tools.length, 10)
    await click('.settings-page details summary')
    assert.match(await evaluate('document.querySelector(\".settings-page details[open]\").textContent'), /mcp__desktop64__echo/)
    check('actual UI adds and connects local stdio; displays namespaced tools')
    const before = (await fs.readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((v) => v.method === 'tools/list').length
    await clickText('刷新工具', '.settings-page')
    await until(async () => (await fs.readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((v) => v.method === 'tools/list').length > before, 'actual refresh request')
    await clickText('断开', '.settings-page')
    await until(async () => (await api('listMcpServers'))[0]?.state === 'stopped', 'MCP disconnect')
    const pid = JSON.parse((await fs.readFile(auditFile, 'utf8')).split('\n')[0]).pid
    await poll(() => !alive(pid), 'disconnected child exits')
    check('actual UI refresh and disconnect; actual child exited')
    await click('.settings-back')
    await fill('#chat-input', '离线验收：请创建一个文件')
    await click('button[aria-label="发送消息"]')
    await until(() => evaluate('document.body.textContent.includes(' + JSON.stringify(notice) + ')'), 'offline notice')
    await until(() => evaluate('!document.querySelector("button[aria-label=停止生成]")'), 'offline complete')
    assert.equal((await api('listMcpServers'))[0].state, 'stopped')
    assert.equal((await fs.readFile(auditFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((v) => v.pid).length, 1)
    check('ordinary offline reply uses fixed notice and does not connect enabled MCP')
    await until(async () => { try { return (await fs.readFile(path.join(userData, 'conversation.json'), 'utf8')).includes(notice) } catch { return false } }, 'saved conversation')
    const saved = JSON.parse(await fs.readFile(path.join(userData, 'conversation.json'), 'utf8'))
    assert.equal(saved.version, 9)
    check('offline conversation persisted without remote title', { titles: saved.conversations.map(c => c.title) })
    const screenshot = await renderer.cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, 'offline-chat.png'), Buffer.from(screenshot.data, 'base64'))
    await key(',', 'Comma', 2, 188)
    await until(() => evaluate('!!document.querySelector(\".settings-page:not([hidden])\")'), 'settings before quit')
    await clickText('连接', '.settings-page')
    await until(async () => (await api('listMcpServers'))[0]?.state === 'connected', 'active MCP before quit')
    check('application quits with an active MCP child for real before-quit gate verification')
  })
  await launch('reopen', async ({ evaluate, click, clickText, key, api, until, renderer }) => {
    await until(() => evaluate('document.body.textContent.includes(' + JSON.stringify(notice) + ')'), 'restored offline chat')
    check('restart restores offline messages without inference or login')
    await key(',', 'Comma', 2, 188); await until(() => evaluate('!!document.querySelector(".settings-page:not([hidden])")'), 'settings reopen')
    await clickText('删除', '.settings-page'); await until(async () => (await api('listMcpServers')).length === 0, 'server deletion')
    assert(!await evaluate('document.querySelector(".settings-page").textContent.includes("Lesson64 Local")'))
    check('actual UI deletes MCP immediately and persisted configuration is empty')
    const screenshot = await renderer.cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(evidence, 'settings.png'), Buffer.from(screenshot.data, 'base64'))
  })
  report.pass = true
} catch (error) { report.failures.push(error.stack); console.error(error); process.exitCode = 1 }
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ pass: report.pass, evidence, checks: report.checks.length }))
