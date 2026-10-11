import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { contracts, materialize, outsideBusiness, hash } from './task-contracts.mjs'
import { root, createEvidence } from '../runtime.mjs'

const packaged = process.argv.includes('--packaged')
const scenario = process.argv.find((s) => s.startsWith('--scenario='))?.split('=')[1] ?? 'price'
assert.equal(
  scenario,
  'price',
  'This desktop regression runs only the fixed price contract; no sampling other scenes'
)
const contract = contracts.find((c) => c.id === scenario)
assert.ok(contract)
assert.ok(process.argv.slice(2).every((s) => s === '--packaged' || s === '--scenario=' + scenario))
const runDirectory = await createEvidence(
  `real-task-${packaged ? 'packaged' : 'development'}-${scenario}`
)
const project = path.join(runDirectory, 'project'),
  userData = path.join(runDirectory, 'user-data')
const controlFile = path.join(runDirectory, 'control.json'),
  auditFile = path.join(runDirectory, 'audit.json')
const nodeProgram = process.execPath
const fixture = materialize(contract)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
await fs.mkdir(project, { recursive: true })
await fs.mkdir(userData, { recursive: true })
try {
  const requirements =
    contract.spec +
    '\n测试 test.mjs、旁路 sidecar.txt、requirements.txt、package.json 不得修改，禁止删断言、改期望、跳过检查、改测试入口或其他文件。business.ts 两个BUSINESS AREA范围之外全部原字节保持；UTF-8 BOM、CRLF、三个尾换行保持。先计划只读，明确执行后在同一次任务内自行修正并验证。\n固定命令 program=' +
    nodeProgram +
    '，args=["test.mjs"]，cwd=' +
    project +
    '。程序与测试无需安装依赖或下载。\n'
  const protectedFiles = {
    'package.json': Buffer.from('{\n  "private": true,\n  "type": "module"\n}\n'),
    'test.mjs': fixture.test,
    'sidecar.txt': Buffer.from('Self-authored sidecar\r\n旁路原字节\r\n'),
    'requirements.txt': Buffer.from(requirements)
  }
  await fs.writeFile(path.join(project, 'business.ts'), fixture.source)
  await fs.writeFile(path.join(runDirectory, 'business.initial.bin'), fixture.source)
  for (const [name, b] of Object.entries(protectedFiles)) {
    await fs.writeFile(path.join(project, name), b)
    await fs.chmod(path.join(project, name), 0o444)
  }
  const fixed = {
    scenario,
    model: 'gpt-6.1-sol',
    nodeProgram,
    project,
    totalLines: fixture.totalLines,
    initialBytes: fixture.source.length,
    sourceSHA256: hash(fixture.source),
    protected: Object.fromEntries(
      Object.entries(protectedFiles).map(([n, b]) => [n, { bytes: b.length, sha256: hash(b) }])
    ),
    contract,
    format: { encoding: 'UTF-8', bom: true, newline: 'CRLF', trailingNewlines: 3 },
    fixedBeforeModelUTC: new Date().toISOString()
  }
  await fs.writeFile(path.join(runDirectory, 'contract.json'), JSON.stringify(fixed, null, 2))
  async function externalTest(label) {
    const start = Date.now(),
      child = spawn(nodeProgram, ['test.mjs'], {
        cwd: project,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (b) => (stdout += b))
    child.stderr.on('data', (b) => (stderr += b))
    const exitCode = await new Promise((r, j) => {
      child.on('error', j)
      child.on('exit', r)
    })
    const result = {
      label,
      program: nodeProgram,
      args: ['test.mjs'],
      cwd: project,
      exitCode,
      stdout,
      stderr,
      elapsedMs: Date.now() - start
    }
    await fs.writeFile(path.join(runDirectory, label + '.json'), JSON.stringify(result, null, 2))
    return result
  }
  assert.notEqual((await externalTest('initial-red-test')).exitCode, 0)
  await fs.writeFile(controlFile, JSON.stringify({ id: 'plan' }))
  // Standalone test-only observer: real streams and tool outputs are passed through unchanged.
  const observer = await fs.readFile(
    fileURLToPath(new URL('./desktop-real-observer.cjs', import.meta.url)),
    'utf8'
  )
  await fs.writeFile(path.join(runDirectory, 'observer-source.js'), observer)

  async function port() {
    return new Promise((r, j) => {
      const s = net.createServer()
      s.once('error', j)
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port
        s.close(() => r(p))
      })
    })
  }
  async function connect(url) {
    const socket = new WebSocket(url)
    await new Promise((r, j) => {
      socket.addEventListener('open', r, { once: true })
      socket.addEventListener('error', j, { once: true })
    })
    const pending = new Map(),
      events = []
    let serial = 0
    socket.addEventListener('message', ({ data }) => {
      const v = JSON.parse(data)
      if (v.id) {
        const p = pending.get(v.id)
        if (p) {
          pending.delete(v.id)
          clearTimeout(p.timer)
          v.error ? p.reject(Error(JSON.stringify(v.error))) : p.resolve(v.result)
        }
      } else events.push(v)
    })
    return {
      socket,
      events,
      cdp: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++serial,
            timer = setTimeout(() => {
              pending.delete(id)
              reject(Error('CDP timeout ' + method))
            }, 15000)
          pending.set(id, { resolve, reject, timer })
          socket.send(JSON.stringify({ id, method, params }))
        })
    }
  }
  const executable = path.join(
    root,
    packaged ? 'dist/win-unpacked/zonecodex.exe' : 'node_modules/electron/dist/electron.exe'
  )
  const artifactNames = packaged
    ? ['dist/win-unpacked/zonecodex.exe', 'dist/win-unpacked/resources/app.asar']
    : ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
  const artifactHashes = Object.fromEntries(
    await Promise.all(
      artifactNames.map(async (n) => [n, hash(await fs.readFile(path.join(root, n)))])
    )
  )
  async function filesUnder(relative) {
    const output = []
    async function visit(name) {
      for (const entry of await fs.readdir(path.join(root, name), { withFileTypes: true })) {
        const next = path.join(name, entry.name)
        if (entry.isDirectory()) await visit(next)
        else if (entry.isFile()) output.push(next)
      }
    }
    await visit(relative)
    return output.sort()
  }
  const productNames = [
    ...(await filesUnder('src')),
    ...(await filesUnder('scripts')),
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'electron-builder.yml',
    'tsconfig.cli.json',
    ...(await filesUnder('resources/windows-command-runtime')),
    ...(await filesUnder('out')),
    ...(await filesUnder('dist/agent')),
    ...(await filesUnder('dist/win-unpacked'))
  ]
  const productHashes = Object.fromEntries(
    await Promise.all(
      productNames.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  await fs.writeFile(
    path.join(runDirectory, 'source-artifact-before.json'),
    JSON.stringify(productHashes, null, 2)
  )
  const scriptHashes = Object.fromEntries(
    await Promise.all(
      ['desktop-real-task-check.mjs', 'desktop-real-observer.cjs', 'task-contracts.mjs'].map(
        async (name) => [
          name,
          hash(await fs.readFile(fileURLToPath(new URL('./' + name, import.meta.url))))
        ]
      )
    )
  )
  await fs.writeFile(
    path.join(runDirectory, 'test-provenance.json'),
    JSON.stringify(
      {
        synthetic: false,
        originalEntry: true,
        modelAndToolResultsUnchanged: true,
        scriptHashes,
        contractSource:
          'Copied byte-for-byte from lesson53 task-contracts.mjs. Price eight assertions unchanged; test-only package.json fixed before model.',
        runtime: process.version
      },
      null,
      2
    )
  )
  const checks = [],
    stages = [],
    processExits = []
  let stored,
    executionCounts,
    iterationCovered = false
  const check = (name, details = {}) => checks.push({ name, pass: true, ...details })
  const protectedCheck = async () => {
    for (const [name, b] of Object.entries(protectedFiles))
      assert.deepEqual(await fs.readFile(path.join(project, name)), b, 'Protected ' + name)
  }
  const currentSource = () => fs.readFile(path.join(project, 'business.ts'))
  const sameTarget = (p) =>
    typeof p === 'string' &&
    path.resolve(project, p).toLowerCase() === path.join(project, 'business.ts').toLowerCase()
  const pairs = (run) =>
    run.items
      .filter((x) => x.type === 'function_call')
      .map((call) => {
        const out = run.items.find(
          (x) => x.type === 'function_call_output' && x.call_id === call.call_id
        )
        assert.ok(out)
        return {
          call,
          args: JSON.parse(call.arguments),
          result: JSON.parse(out.output),
          output: out.output
        }
      })
  for (const stage of ['create', 'reopen']) {
    const rendererPort = await port(),
      mainPort = await port(),
      log = await fs.open(path.join(runDirectory, stage + '.log'), 'w')
    const env = {
      ...process.env,
      APPDATA: path.join(runDirectory, 'appdata'),
      LOCALAPPDATA: path.join(runDirectory, 'localappdata')
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    await fs.mkdir(env.APPDATA, { recursive: true })
    await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
    const args = [
      ...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
      '--user-data-dir=' + userData,
      '--inspect-brk=127.0.0.1:' + mainPort,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + rendererPort,
      '--disable-gpu'
    ]
    const child = spawn(executable, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd]
    })
    console.log(
      JSON.stringify({
        runDirectory,
        stage,
        scenario,
        packaged,
        pid: child.pid,
        synthetic: false,
        originalEntry: true
      })
    )
    let main,
      client,
      evaluate,
      stageAudit,
      stageSucceeded = false
    try {
      const until = async (fn, label, ms = 25000) => {
        for (const end = Date.now() + ms; Date.now() < end;) {
          if (child.exitCode !== null) throw Error('App exited ' + child.exitCode)
          const v = await fn()
          if (v) return v
          await delay(100)
        }
        throw Error('Wait exceeded ' + label)
      }
      const mainTarget = await until(async () => {
        try {
          return (await (await fetch('http://127.0.0.1:' + mainPort + '/json/list')).json())[0]
        } catch {
          // Retry the local inspector lookup while the owned Electron process becomes ready.
        }
      }, 'main inspector')
      main = await connect(mainTarget.webSocketDebuggerUrl)
      await main.cdp('Runtime.enable')
      await main.cdp('Debugger.enable')
      await main.cdp('Runtime.runIfWaitingForDebugger')
      await until(() => main.events.find((v) => v.method === 'Debugger.paused'), 'entry paused')
      const install = await main.cdp('Runtime.evaluate', {
        expression:
          '(' +
          observer +
          ')(' +
          JSON.stringify({ root, userData, project, controlFile, auditFile, stage }) +
          ');globalThis.__lesson55ObserverReady',
        returnByValue: true
      })
      assert.equal(
        install.exceptionDetails,
        undefined,
        install.exceptionDetails?.exception?.description
      )
      assert.equal(install.result.value, true)
      const compiled = await fs.readFile(path.join(root, 'out/main/index.js'), 'utf8')
      const catchLine = compiled
        .split('\n')
        .findIndex((line) =>
          line.includes('const hasEffectRisk = effects.approved || effects.started;')
        )
      assert.ok(catchLine >= 0)
      const breakpoint = await main.cdp('Debugger.setBreakpointByUrl', {
        lineNumber: catchLine,
        urlRegex: 'out/main/index[.]js$',
        condition: 'globalThis.__lesson55RecordCoreError(error),false'
      })
      await fs.writeFile(
        path.join(runDirectory, stage + '-core-error-observer.json'),
        JSON.stringify(
          {
            lineNumber: catchLine,
            breakpoint,
            behavior:
              'Transparent debugger conditional breakpoint records caught real exception; returns false, no pause or product result replacement.'
          },
          null,
          2
        )
      )
      await main.cdp('Debugger.resume')
      const page = await until(async () => {
        try {
          return (
            await (await fetch('http://127.0.0.1:' + rendererPort + '/json/list')).json()
          ).find((v) => v.type === 'page' && v.url.includes('renderer'))
        } catch {
          // Retry the local renderer lookup while the owned Electron process becomes ready.
        }
      }, 'actual renderer')
      await until(
        () =>
          breakpoint.locations.length ||
          main.events.find(
            (e) =>
              e.method === 'Debugger.breakpointResolved' &&
              e.params.breakpointId === breakpoint.breakpointId
          ),
        'caught-error observation resolved to original application entry'
      )
      await fs.writeFile(
        path.join(runDirectory, stage + '-main-source-identities.json'),
        JSON.stringify(
          main.events
            .filter(
              (e) =>
                e.method === 'Debugger.scriptParsed' || e.method === 'Debugger.breakpointResolved'
            )
            .map((e) => ({
              method: e.method,
              scriptId: e.params.scriptId,
              url: e.params.url,
              breakpointId: e.params.breakpointId,
              location: e.params.location
            })),
          null,
          2
        )
      )
      client = await connect(page.webSocketDebuggerUrl)
      await client.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
      evaluate = async (expression) => {
        const r = await client.cdp('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true
        })
        if (r.exceptionDetails)
          throw Error(r.exceptionDetails.exception?.description ?? 'Renderer error')
        return r.result.value
      }
      const click = async (expression) => {
        await evaluate('(' + expression + ').click()')
        await delay(80)
      }
      const audit = async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            return JSON.parse(await fs.readFile(auditFile, 'utf8'))
          } catch (error) {
            if (attempt === 29) throw Error('Observation read failed: ' + error.message)
            await delay(40)
          }
        }
      }
      const idle = () =>
        until(
          () =>
            evaluate(
              '!!document.getElementById("chat-input")&&!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成]")'
            ),
          'idle'
        )
      const mode = async (next) => {
        await click('document.querySelector(".agent-mode-trigger")')
        await click(
          '[...document.querySelectorAll(".agent-mode-popover [role=menuitemradio]")].find(n=>n.textContent.includes(' +
            JSON.stringify(next === 'plan' ? '计划' : '执行') +
            '))'
        )
      }
      const draft = async (text) => {
        await evaluate(
          '(()=>{const n=document.getElementById("chat-input");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(n,' +
            JSON.stringify(text) +
            ');n.dispatchEvent(new Event("input",{bubbles:true}));})()'
        )
        await delay(80)
      }
      const send = async (text, isPlan) => {
        const before = (await audit()).ipc.filter((v) => v.channel === 'agent:start').length,
          start = Date.now()
        await draft(text)
        await evaluate('document.querySelector(".composer").requestSubmit()')
        await until(
          async () =>
            (await audit()).ipc.filter((v) => v.channel === 'agent:start').length > before,
          'agent accepted'
        )
        await until(
          async () => {
            const a = await audit()
            if (isPlan) {
              assert.deepEqual(await currentSource(), fixture.source)
              await protectedCheck()
              assert.equal(a.commandStarts, 0)
              assert.equal(
                a.tools.some((t) => /apply_|create_|command|propose_/.test(t.name)),
                false
              )
            }
            return evaluate(
              '!document.getElementById("chat-input").disabled&&!document.querySelector("button[aria-label=停止生成]")'
            )
          },
          'single explicit task finished',
          480000
        )
        return { elapsedMs: Date.now() - start }
      }
      const save = async () => {
        await click('document.querySelector(".chat-header .quiet-button")')
        await until(
          () =>
            evaluate('document.querySelector(".save-status").textContent.includes("已同步到本地")'),
          'saved'
        )
        const v = await evaluate('window.api.loadConversation()')
        assert.ok(v.ok)
        return v.snapshot
      }
      const active = (s) => s.conversations.find((c) => c.id === s.activeConversationId)
      await idle()
      assert.equal((await audit()).modelMatches, true)
      if (stage === 'create') {
        await click('document.querySelector(".conversation-create")')
        await idle()
        await click(
          '[...document.querySelectorAll(".workspace-status button")].find(n=>n.textContent.includes("选择工作区"))'
        )
        await idle()
        await click('document.querySelector(".attachment-add")')
        await click('document.querySelector(".attachment-picker")')
        await idle()
        await mode('plan')
        await click('document.querySelector(".composer-permissions .permissions-trigger")')
        await click(
          '[...document.querySelectorAll(".composer-permissions .permissions-popover [role=menuitemradio]")].find(n=>n.textContent.includes("完全访问权限"))'
        )
        await idle()
        assert.equal((await audit()).requests.length, 0)
        const planPrompt =
          '研究requirements.txt与business.ts并形成简洁计划：' +
          contract.spec +
          ' 信息已充分，先search_workspace_text定位、read_workspace_file按需读取相关片段，无需全文。测试test.mjs只读可查看；计划不修改也不运行命令。等我明确执行。'
        const planTiming = await send(planPrompt, true)
        let snapshot = await save(),
          conversation = active(snapshot)
        assert.equal(conversation.messages.at(-1).status, 'complete')
        assert.equal(conversation.messages.at(-1).mode, 'plan')
        const planPairs = pairs(
          conversation.toolRuns.find((r) => r.userId === conversation.messages[0].id)
        )
        assert.ok(planPairs.some((p) => p.call.name === 'search_workspace_text'))
        assert.ok(
          planPairs.some((p) => p.call.name === 'read_workspace_file' && sameTarget(p.args.path))
        )
        await protectedCheck()
        assert.deepEqual(await currentSource(), fixture.source)
        check(
          'real plan searches and reads while source protected files and commands stay unchanged',
          { planTiming }
        )
        const before = (await audit()).requests.length
        await mode('execute')
        await delay(300)
        assert.equal((await audit()).requests.length, before)
        check('mode switch alone sends no model request')
        await fs.writeFile(controlFile, JSON.stringify({ id: 'execute' }))
        const prompt =
          '现在明确执行上述全部业务要求；只修改business.ts两个BUSINESS AREA内部，保留其余原字节及BOM/CRLF/三个尾换行。测试/旁路/requirements/package.json绝对禁止修改，不能删断言、改期望、跳过或改入口。本执行请求重新按需读取相关片段与hash，用apply_workspace_patch局部补丁。实际调用run_workspace_command，program=' +
          nodeProgram +
          '，args=["test.mjs"]，cwd=' +
          project +
          '；不需要shell复合命令或下载。修改后运行固定测试，收到实际失败则自行继续读取修正同一业务文件并重跑同一测试，直到满足要求或如实报告阻塞。成功后重读修改处，再运行同一固定测试确认。整个任务在这一次执行内完成，不依赖后续人工追加提示。'
        const executeTiming = await send(prompt, false)
        snapshot = await save()
        conversation = active(snapshot)
        stored = conversation
        await fs.writeFile(
          path.join(runDirectory, 'conversation-snapshot.json'),
          JSON.stringify(snapshot, null, 2)
        )
        const run = conversation.toolRuns.find((r) => r.userId === conversation.messages.at(-2).id)
        assert.ok(run)
        const ps = pairs(run),
          patches = ps.filter(
            (p) => p.call.name === 'apply_workspace_patch' && p.result.status === 'applied'
          ),
          commands = ps.filter((p) => p.call.name === 'run_workspace_command')
        const a = await audit(),
          starts = a.ipc.filter((v) => v.channel === 'agent:start')
        assert.equal(starts.length, 2)
        assert.equal(starts[1].requestId, run.requestId)
        const executionRequests = a.requests.filter(
          (r) => !r.title && !r.approval && r.fixture === 'execute'
        )
        executionCounts = {
          requestId: run.requestId,
          toolExecutions: ps.length,
          completedModelRounds: executionRequests.filter((r) => r.httpStatus === 200 && r.completed)
            .length,
          modelAttempts: executionRequests.length,
          transportRetries:
            executionRequests.length -
            new Set(executionRequests.map((r) => r.requestBodySHA256)).size,
          planRequests: a.requests.filter((r) => !r.title && !r.approval && r.fixture === 'plan')
            .length,
          toolNames: ps.map((p) => p.call.name),
          planTiming,
          executeTiming,
          commands: commands.map((p) => ({ args: p.args, result: p.result }))
        }
        await fs.writeFile(
          path.join(runDirectory, 'execution-counts.json'),
          JSON.stringify(executionCounts, null, 2)
        )
        assert.equal(
          conversation.messages.at(-1).status,
          'complete',
          conversation.messages.at(-1).content
        )
        assert.ok(patches.length)
        assert.ok(
          ps
            .slice(0, ps.indexOf(patches[0]))
            .some(
              (p) =>
                p.call.name === 'read_workspace_file' &&
                sameTarget(p.args.path) &&
                p.result.sha256 === hash(fixture.source)
            )
        )
        for (const p of patches) assert.ok(sameTarget(p.args.path))
        assert.ok(
          commands.length >= 2,
          'Agent must perform actual initial verification and final retest'
        )
        for (const p of commands) {
          assert.equal(
            path.resolve(p.args.program).toLowerCase(),
            path.resolve(nodeProgram).toLowerCase()
          )
          assert.deepEqual(p.args.args, ['test.mjs'])
          assert.equal(path.resolve(p.args.cwd).toLowerCase(), project.toLowerCase())
          assert.equal(p.result.truncated, false)
          assert.equal(p.result.treeExited, true)
        }
        const last = commands.at(-1)
        assert.equal(last.result.exitCode, 0)
        assert.equal(last.result.status, 'completed')
        const previous = commands.at(-2)
        assert.equal(previous.result.exitCode, 0)
        assert.equal(previous.result.status, 'completed')
        for (const p of [previous, last]) {
          const report = JSON.parse(p.result.stdout.trim())
          assert.equal(report.scenario, 'price')
          assert.equal(report.checks, 8)
          assert.deepEqual(report.failures, [])
        }
        assert.ok(
          ps
            .slice(ps.indexOf(previous) + 1, ps.indexOf(last))
            .some((p) => p.call.name === 'read_workspace_file' && sameTarget(p.args.path)),
          'Agent must reread modified file after passing test and before final passing retest'
        )
        assert.ok(
          ps
            .slice(ps.indexOf(patches.at(-1)) + 1)
            .some((p) => p.call.name === 'read_workspace_file' && sameTarget(p.args.path))
        )
        const failures = commands.filter(
          (p) =>
            p.result.status === 'failed' &&
            p.result.exitCode !== 0 &&
            ps.indexOf(p) > ps.indexOf(patches[0])
        )
        iterationCovered = failures.some((f) =>
          patches.some(
            (p) =>
              ps.indexOf(p) > ps.indexOf(f) &&
              commands.some((t) => ps.indexOf(t) > ps.indexOf(p) && t.result.exitCode === 0)
          )
        )
        check(
          'single explicit execute obtains fresh evidence applies business patch runs real tests rereads and retests',
          { executionCounts, iterationCovered }
        )
        await protectedCheck()
        const actual = await currentSource()
        assert.notDeepEqual(actual, fixture.source)
        assert.deepEqual(outsideBusiness(actual), outsideBusiness(fixture.source))
        assert.ok(actual.subarray(0, 3).equals(Buffer.from([239, 187, 191])))
        assert.ok(!/(?<!\r)\n/.test(actual.toString('utf8')))
        assert.equal(actual.toString('utf8').match(/(?:\r\n)+$/)[0], '\r\n\r\n\r\n')
        const reads = ps.filter(
          (p) => p.call.name === 'read_workspace_file' && sameTarget(p.args.path)
        )
        const visible = new Set(
          [...planPairs, ...ps]
            .filter((p) => p.call.name === 'read_workspace_file' && sameTarget(p.args.path))
            .flatMap((p) => p.result.lines.filter((l) => !l.truncated).map((l) => l.line))
        )
        assert.ok(visible.size < fixture.totalLines)
        assert.ok(reads.every((p) => p.result.fullText == null))
        await fs.writeFile(path.join(runDirectory, 'business.final.bin'), actual)
        const backups = []
        for (const name of await fs.readdir(project))
          if (/^\.zonecodex-[a-f0-9-]{36}\.bak$/.test(name)) {
            const bytes = await fs.readFile(path.join(project, name))
            backups.push({ name, sha256: hash(bytes), equalsInitial: bytes.equals(fixture.source) })
          }
        assert.ok(
          backups.some((b) => b.equalsInitial),
          'Actual initial-byte recovery backup must exist'
        )
        for (const p of patches) {
          assert.ok(p.result.recoveryPath)
          assert.equal(path.dirname(p.result.recoveryPath).toLowerCase(), project.toLowerCase())
          await fs.access(p.result.recoveryPath)
        }
        await fs.writeFile(
          path.join(runDirectory, 'backup-check.json'),
          JSON.stringify(backups, null, 2)
        )
        const diffChild = spawn(
          'git',
          [
            'diff',
            '--no-index',
            '--',
            path.join(runDirectory, 'business.initial.bin'),
            path.join(runDirectory, 'business.final.bin')
          ],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        let diff = '',
          diffError = ''
        diffChild.stdout.on('data', (b) => (diff += b))
        diffChild.stderr.on('data', (b) => (diffError += b))
        const diffExit = await new Promise((r, j) => {
          diffChild.on('error', j)
          diffChild.on('exit', r)
        })
        assert.equal(diffExit, 1)
        await fs.writeFile(path.join(runDirectory, 'business.diff'), diff)
        await fs.writeFile(
          path.join(runDirectory, 'diff-result.json'),
          JSON.stringify({ exitCode: diffExit, stderr: diffError }, null, 2)
        )
        const delivered = executionRequests.flatMap((r) =>
          r.input.filter((i) => i.type === 'function_call_output').map((i) => i.output)
        )
        for (const p of reads)
          assert.ok(
            delivered.includes(p.output),
            'Exact persisted execute read result must have been delivered to real model'
          )
        check('actual backups exact diff and execute-visible evidence independently verified', {
          backups,
          modelOutputMatchesHistory: true
        })
        await fs.writeFile(
          path.join(runDirectory, 'source-change.txt'),
          actual
            .toString('utf8')
            .split('\r\n')
            .filter((l) => !l.startsWith('// Reference'))
            .join('\n')
        )
        check('independent protected hashes unread exterior and byte format preserved', {
          finalSHA256: hash(actual),
          visibleLines: [...visible].sort((a, b) => a - b),
          visibleCount: visible.size,
          totalLines: fixture.totalLines,
          reads: reads.map((p) => ({
            args: p.args,
            hash: p.result.sha256,
            lines: p.result.lines,
            format: p.result.format
          }))
        })
        assert.equal((await externalTest('independent-final-test')).exitCode, 0)
        check('external fixed business tests pass independently')
      } else {
        await delay(5000)
        const loaded = await evaluate('window.api.loadConversation()')
        assert.ok(loaded.ok)
        const c = active(loaded.snapshot)
        assert.deepEqual(c.messages, stored.messages)
        assert.deepEqual(c.toolRuns, stored.toolRuns)
        assert.equal(c.defaultDirectory, stored.defaultDirectory)
        assert.equal(await evaluate('window.api.getPendingAgentUserInput()'), null)
        assert.equal(
          await evaluate('window.electron.ipcRenderer.invoke("execution:approval-get")'),
          null
        )
        assert.equal(
          (await evaluate('window.api.listTasks()')).some((t) =>
            ['waiting_input', 'running', 'waiting_approval'].includes(t.status)
          ),
          false
        )
        const a = await audit()
        assert.equal(a.requests.length, 0)
        assert.equal(a.allFetches.length, 0)
        assert.equal(a.unexpectedFetches.length, 0)
        assert.equal(a.commandStarts, 0)
        assert.equal(a.spawns.length, 0)
        assert.equal(a.ipc.filter((i) => i.channel === 'agent:start').length, 0)
        await protectedCheck()
        assert.deepEqual(
          await currentSource(),
          await fs.readFile(path.join(runDirectory, 'business.final.bin'))
        )
        assert.equal((await externalTest('reopen-independent-test')).exitCode, 0)
        check(
          'full process reopen retains bytes messages tools and directory with zero main title approval requests',
          {
            observationMs: 5000,
            totalModelRequests: 0,
            mainRequests: 0,
            titleRequests: 0,
            approvalRequests: 0,
            commandStarts: 0,
            agentStarts: 0,
            restoredPendingInputs: 0,
            restoredPendingApprovals: 0,
            restoredRunningTasks: 0
          }
        )
      }
      stageAudit = await evaluate('window.electron.ipcRenderer.invoke("lesson55:observation")')
      assert.equal(stageAudit.stage, stage)
      await fs.writeFile(
        path.join(runDirectory, stage + '-audit.json'),
        JSON.stringify(stageAudit, null, 2)
      )
      stages.push({ stage, audit: stageAudit, completeInMemoryObservation: true })
      await fs.writeFile(
        path.join(runDirectory, stage + '.png'),
        Buffer.from((await client.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64')
      )
      stageSucceeded = true
    } catch (error) {
      let diagnostic
      try {
        diagnostic = await evaluate('document.body.innerText')
      } catch {
        // The renderer may be unavailable after failure; retain the original failure below.
      }
      try {
        stageAudit = evaluate
          ? await evaluate('window.electron.ipcRenderer.invoke("lesson55:observation")')
          : JSON.parse(await fs.readFile(auditFile, 'utf8'))
        await fs.writeFile(
          path.join(runDirectory, stage + '-audit.json'),
          JSON.stringify(stageAudit, null, 2)
        )
      } catch {
        // Audit capture is best effort after failure and cannot replace the original error.
      }
      await fs.writeFile(
        path.join(runDirectory, 'results.json'),
        JSON.stringify(
          {
            pass: false,
            synthetic: false,
            packaged,
            scenario,
            runDirectory,
            project,
            stage,
            checks,
            executionCounts,
            iterationCovered,
            error: error.stack,
            diagnostic,
            audit: stageAudit,
            artifactHashes,
            productHashCount: productNames.length,
            scriptHashes,
            processExits
          },
          null,
          2
        )
      )
      throw error
    } finally {
      if (evaluate)
        try {
          await evaluate('window.electron.ipcRenderer.invoke("lesson55:quit")')
        } catch {
          // An already exited renderer cannot accept quit; the owned process is checked below.
        }
      client?.socket.close()
      main?.socket.close()
      let forcedKill = false
      if (child.exitCode === null) {
        await Promise.race([new Promise((r) => child.once('exit', r)), delay(2000)])
        if (child.exitCode === null) {
          forcedKill = true
          child.kill()
          await Promise.race([new Promise((r) => child.once('exit', r)), delay(2000)])
        }
      }
      processExits.push({
        stage,
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        forcedKill,
        stageSucceeded,
        observedAtUTC: new Date().toISOString()
      })
      await fs.writeFile(
        path.join(runDirectory, 'process-exits.json'),
        JSON.stringify(processExits, null, 2)
      )
      await log.close()
      if (stageSucceeded) {
        assert.equal(forcedKill, false, 'Entire application must exit normally before next stage')
        assert.equal(child.exitCode, 0)
      }
    }
  }
  for (const [name, h] of Object.entries(artifactHashes))
    assert.equal(hash(await fs.readFile(path.join(root, name))), h)
  for (const [name, h] of Object.entries(productHashes))
    assert.equal(
      hash(await fs.readFile(path.join(root, name))),
      h,
      'Source/artifact preserved throughout real regression: ' + name
    )
  check('all product source runtime and both artifact sets preserved during real tasks', {
    fileCount: productNames.length
  })
  await fs.writeFile(
    path.join(runDirectory, 'source-artifact-after.json'),
    JSON.stringify({ pass: true, fileCount: productNames.length, hashes: productHashes }, null, 2)
  )
  const requests = stages.flatMap((s) => s.audit.requests)
  const outcomes = Object.fromEntries(
    ['main', 'title', 'approval'].map((kind) => {
      const rs = requests.filter((r) =>
        kind === 'title' ? r.title : kind === 'approval' ? r.approval : !r.title && !r.approval
      )
      return [
        kind,
        {
          attempts: rs.length,
          completed: rs.filter((r) => r.httpStatus === 200 && r.completed).length,
          failures: rs
            .filter((r) => r.httpStatus !== 200 || !r.completed)
            .map((r) => ({ fixture: r.fixture, httpStatus: r.httpStatus, error: r.error }))
        }
      ]
    })
  )
  await fs.writeFile(
    path.join(runDirectory, 'results.json'),
    JSON.stringify(
      {
        pass: true,
        synthetic: false,
        packaged,
        scenario,
        runDirectory,
        project,
        checks,
        executionCounts,
        iterationCovered,
        outcomes,
        artifactHashes,
        productHashCount: productNames.length,
        scriptHashes,
        processExits,
        entry:
          'Original production out/main or original directory exe/asar, no replacement entry or disk modification',
        boundary:
          'At initial debugger pause install transparent fetch/IPC/event/spawn observers, load existing env without logging secrets, set UUID userData and replace native file-selector return with self-authored project/requirements; renderer input via CDP. Original model HTTP responses and byte streams, tool and test results unchanged. Full-access real task; other authorization/stop/error checks separately synthetic.'
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      pass: true,
      packaged,
      scenario,
      runDirectory,
      checks: checks.length,
      executionCounts,
      iterationCovered,
      outcomes
    })
  )
} catch (error) {
  const failure = {
    pass: false,
    synthetic: false,
    packaged,
    scenario,
    runDirectory,
    project,
    error: error.stack,
    atUTC: new Date().toISOString(),
    boundary:
      'Real run/harness failure preserved; no replacement model/tool result or business fix by validator.'
  }
  await fs.writeFile(
    path.join(runDirectory, 'harness-failure.json'),
    JSON.stringify(failure, null, 2)
  )
  try {
    await fs.access(path.join(runDirectory, 'results.json'))
  } catch {
    await fs.writeFile(path.join(runDirectory, 'results.json'), JSON.stringify(failure, null, 2))
  }
  throw error
}
