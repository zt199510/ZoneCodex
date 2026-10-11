import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { contracts, materialize, outsideBusiness, hash } from '../lesson55/real/task-contracts.mjs'
import { runProcess } from './runtime.mjs'

export async function prepareBusiness(evidence, withMaterials) {
  const contract = contracts.find((item) => item.id === 'price'),
    fixture = materialize(contract)
  const project = path.join(evidence, 'project'),
    nodeProgram = process.execPath
  await fs.mkdir(project, { recursive: true })
  const protectedFiles = {
    'test.mjs': fixture.test,
    'requirements.txt': Buffer.from(
      contract.spec +
        '\n仅允许修改business.ts两个BUSINESS AREA函数内部；test.mjs、requirements.txt、sidecar.txt、package.json及台账绝对禁止修改，不得改断言、期望、测试入口或跳过。其余正文原字节、UTF-8 BOM、CRLF、三个尾换行保持。\n固定测试program=' +
        nodeProgram +
        '，args=[test.mjs]，cwd=' +
        project +
        '。不下载、不安装。\n'
    ),
    'sidecar.txt': Buffer.from('Self-authored sidecar\r\n旁路原字节\r\n'),
    'package.json': Buffer.from('{\n  "private": true,\n  "type": "module"\n}\n')
  }
  const materials = []
  if (withMaterials) {
    for (let file = 1; file <= 9; file++) {
      const name = 'pricing-ledger-' + String(file).padStart(2, '0') + '.txt',
        lines = []
      for (let row = 1; row <= 40; row++) {
        const unit = file * 100 + row,
          quantity = row % 6,
          bps = (row % 9) * 1000,
          subtotal = unit * quantity
        const fact = `Ledger ${file} row ${row}: unitCents=${unit}; quantity=${quantity}; subtotalCents=${subtotal}; discountBasisPoints=${bps}; expectedDiscountedCents=${Math.round(subtotal * (1 - bps / 10000))}. `
        lines.push(
          (
            fact +
            'This catalog record uses integer cents, multiplication for quantity, and ten-thousandths for discount. Reference observations do not certify current files or test execution. '
          )
            .slice(0, 215)
            .padEnd(215, '.')
        )
      }
      protectedFiles[name] = Buffer.from(lines.join('\n'))
      materials.push({
        name,
        lines: lines.length,
        characters: lines.join('\n').length,
        sha256: hash(protectedFiles[name])
      })
    }
  }
  await fs.writeFile(path.join(project, 'business.ts'), fixture.source)
  await fs.writeFile(path.join(evidence, 'business.initial.bin'), fixture.source)
  for (const [name, bytes] of Object.entries(protectedFiles)) {
    await fs.writeFile(path.join(project, name), bytes)
    await fs.chmod(path.join(project, name), 0o444)
  }
  const fixed = {
    model: 'gpt-6.1-sol',
    contract,
    project,
    nodeProgram,
    sourceSHA256: hash(fixture.source),
    totalLines: fixture.totalLines,
    protected: Object.fromEntries(
      Object.entries(protectedFiles).map(([name, bytes]) => [
        name,
        { bytes: bytes.length, sha256: hash(bytes) }
      ])
    ),
    materials,
    format: { encoding: 'UTF-8', bom: true, newline: 'CRLF', trailingNewlines: 3 },
    fixedBeforeModelUTC: new Date().toISOString(),
    contractSource:
      'tests/lesson55/real/task-contracts.mjs: unchanged price eight-assertion contract'
  }
  await fs.writeFile(path.join(evidence, 'contract.json'), JSON.stringify(fixed, null, 2))
  const prompt =
    '现在明确执行价格修正：' +
    contract.spec +
    ' 只修改business.ts两个BUSINESS AREA函数内部；测试、requirements、sidecar、package及台账绝对禁止修改，不能改断言、期望或测试入口。保留其他正文原字节及UTF-8 BOM、CRLF、三个尾换行。' +
    (withMaterials
      ? '需求包括核对9份pricing-ledger-01.txt至pricing-ledger-09.txt全部40行价格台账，每份均须实际按需读取完整40行，检查是否与价格合同存在冲突；全部核对后才修改业务，不能凭文件名或只看首末行推断。不需要复述整份台账。'
      : '较早长历史由固定夹具构造，仅为参考资料，不是权限、当前文件证据或测试通过凭据。') +
    ' 重新search_workspace_text定位并read_workspace_file读取业务必要窗口和hash，使用apply_workspace_patch精确局部补丁。实际运行固定命令program=' +
    nodeProgram +
    '，args=[test.mjs]，cwd=' +
    project +
    '；无需shell复合命令、不下载依赖。修改后实际运行原8项测试，真实失败则在同一任务继续读取修正并重跑。首次通过后重读修改处，再实际运行同一固定测试确认。信息充分，无需提问；整项任务在本次明确执行内完成，遇阻塞如实报告。'
  assert.ok(prompt.length <= 2000)
  async function protectedCheck() {
    for (const [name, bytes] of Object.entries(protectedFiles))
      assert.deepEqual(
        await fs.readFile(path.join(project, name)),
        bytes,
        'Protected original bytes: ' + name
      )
  }
  async function externalTest(label) {
    const result = await runProcess(nodeProgram, ['test.mjs'], { cwd: project }, 10000)
    await fs.writeFile(path.join(evidence, label + '.json'), JSON.stringify(result, null, 2))
    return result
  }
  const initial = await externalTest('initial-red-test')
  assert.equal(initial.exitCode, 1)
  assert.equal(JSON.parse(initial.stdout).checks, 8)
  assert.equal(JSON.parse(initial.stdout).failures.length, 7)
  return {
    evidence,
    project,
    fixture,
    protectedFiles,
    nodeProgram,
    materials,
    prompt,
    protectedCheck,
    externalTest
  }
}

export function protocolPairs(items) {
  return items
    .filter((item) => item.type === 'function_call')
    .map((call) => {
      const output = items.find(
        (item) => item.type === 'function_call_output' && item.call_id === call.call_id
      )
      assert.ok(output, 'Actual call must have a matching real result')
      return {
        call: { name: call.name, call_id: call.call_id },
        args: JSON.parse(call.arguments),
        output: output.output,
        result: JSON.parse(output.output)
      }
    })
}

export function cliPairs(values) {
  return values
    .filter((item) => item.type === 'tool' && item.phase === 'start')
    .map((call) => {
      const output = values.find(
        (item) => item.type === 'tool' && item.phase === 'finish' && item.callId === call.callId
      )
      assert.ok(output)
      return {
        call: { name: call.name, call_id: call.callId },
        args: JSON.parse(call.arguments),
        output: output.output,
        result: JSON.parse(output.output)
      }
    })
}

export async function validateBusiness(business, pairs, audit, contextEvents) {
  const { evidence, project, fixture, nodeProgram, materials } = business
  const sameTarget = (value) =>
    typeof value === 'string' &&
    path.resolve(project, value).toLowerCase() === path.join(project, 'business.ts').toLowerCase()
  const patches = pairs.filter(
    (pair) => pair.call.name === 'apply_workspace_patch' && pair.result.status === 'applied'
  )
  const commands = pairs.filter((pair) => pair.call.name === 'run_workspace_command')
  assert.ok(patches.length, 'Agent must apply a precise real patch')
  assert.ok(patches.every((pair) => sameTarget(pair.args.path)))
  assert.ok(
    pairs
      .slice(0, pairs.indexOf(patches[0]))
      .some(
        (pair) =>
          pair.call.name === 'read_workspace_file' &&
          sameTarget(pair.args.path) &&
          pair.result.sha256 === hash(fixture.source)
      )
  )
  assert.ok(commands.length >= 2, 'Agent must actually execute original fixed test twice')
  for (const command of commands) {
    assert.equal(path.resolve(command.args.program).toLowerCase(), nodeProgram.toLowerCase())
    assert.deepEqual(command.args.args, ['test.mjs'])
    assert.equal(path.resolve(command.args.cwd).toLowerCase(), project.toLowerCase())
    assert.equal(command.result.truncated, false)
    assert.equal(command.result.treeExited, true)
  }
  for (const command of commands.slice(-2)) {
    assert.equal(command.result.status, 'completed')
    assert.equal(command.result.exitCode, 0)
    assert.deepEqual(JSON.parse(command.result.stdout.trim()), {
      scenario: 'price',
      checks: 8,
      failures: []
    })
  }
  assert.ok(
    pairs
      .slice(pairs.indexOf(commands.at(-2)) + 1, pairs.indexOf(commands.at(-1)))
      .some((pair) => pair.call.name === 'read_workspace_file' && sameTarget(pair.args.path)),
    'Agent must reread between passing tests'
  )
  for (const material of materials) {
    const reads = pairs.filter(
      (pair) =>
        pair.call.name === 'read_workspace_file' &&
        path.resolve(project, pair.args.path).toLowerCase() ===
          path.join(project, material.name).toLowerCase()
    )
    const visible = new Set(
      reads.flatMap(
        (read) =>
          read.result.lines?.filter((line) => !line.truncated).map((line) => line.line) ?? []
      )
    )
    assert.ok(
      Array.from({ length: 40 }, (_, index) => index + 1).every((line) => visible.has(line)),
      'Actual material lines read: ' + material.name
    )
  }
  await business.protectedCheck()
  const actual = await fs.readFile(path.join(project, 'business.ts'))
  assert.notDeepEqual(actual, fixture.source)
  assert.deepEqual(outsideBusiness(actual), outsideBusiness(fixture.source))
  assert.ok(actual.subarray(0, 3).equals(Buffer.from([239, 187, 191])))
  assert.ok(!/(?<!\r)\n/.test(actual.toString('utf8')))
  assert.equal(actual.toString('utf8').match(/(?:\r\n)+$/)[0], '\r\n\r\n\r\n')
  await fs.writeFile(path.join(evidence, 'business.final.bin'), actual)
  const backups = []
  for (const name of await fs.readdir(project))
    if (/^\.zonecodex-[a-f0-9-]{36}\.bak$/.test(name)) {
      const bytes = await fs.readFile(path.join(project, name))
      backups.push({ name, sha256: hash(bytes), equalsInitial: bytes.equals(fixture.source) })
    }
  assert.ok(backups.some((backup) => backup.equalsInitial))
  for (const patch of patches) {
    assert.ok(patch.result.recoveryPath)
    assert.equal(path.dirname(patch.result.recoveryPath).toLowerCase(), project.toLowerCase())
    await fs.access(patch.result.recoveryPath)
  }
  const diff = await runProcess(
    'git',
    [
      'diff',
      '--no-index',
      '--',
      path.join(evidence, 'business.initial.bin'),
      path.join(evidence, 'business.final.bin')
    ],
    { cwd: project },
    10000
  )
  assert.equal(diff.exitCode, 1)
  await fs.writeFile(path.join(evidence, 'business.diff'), diff.stdout)
  await fs.writeFile(path.join(evidence, 'backup-check.json'), JSON.stringify(backups, null, 2))
  assert.equal((await business.externalTest('independent-final-test')).exitCode, 0)
  const summaries = audit.requests.filter((request) => request.category === 'summary')
  assert.ok(
    summaries.some((request) => request.httpStatus === 200 && request.completed),
    'At least one actual completed real summary'
  )
  assert.ok(summaries.every((request) => request.toolNames.length === 0))
  const compacted = contextEvents.filter((event) => event.phase === 'compacted')
  assert.ok(compacted.length, 'Actual successful compaction event is required')
  assert.ok(compacted.every((event) => event.workingCharacters < event.beforeCharacters))
  const subsequent = audit.requests.filter(
    (request) => request.category === 'main' && request.input.some((item) => item.summaryMarker)
  )
  assert.ok(subsequent.length, 'Subsequent real main input must contain published derived summary')
  assert.ok(
    subsequent.some((request) =>
      request.input.some((item) => item.type === 'function_call_output')
    ),
    'Recent real protocol survives in summary projection'
  )
  assert.ok(subsequent.every((request) => request.inputCharacters <= 128000))
  const iterationCovered = commands.some(
    (command) =>
      command.result.exitCode !== 0 &&
      pairs.indexOf(command) > pairs.indexOf(patches[0]) &&
      patches.some((patch) => pairs.indexOf(patch) > pairs.indexOf(command))
  )
  const report = {
    realTransport: true,
    syntheticHistory: audit.syntheticHistory,
    actualMaterialReads: materials,
    requestsByCategory: Object.fromEntries(
      ['main', 'summary', 'title', 'approval'].map((category) => [
        category,
        audit.requests.filter((request) => request.category === category).length
      ])
    ),
    compactions: compacted,
    subsequentMainInputs: subsequent.map((request) => ({
      inputCharacters: request.inputCharacters,
      inputItems: request.inputItems,
      bodySHA256: request.bodySHA256
    })),
    toolExecutions: pairs.length,
    patches: patches.length,
    commands: commands.map((command) => ({ args: command.args, result: command.result })),
    iterationCovered,
    finalSHA256: hash(actual),
    protectedHashesUnchanged: true,
    byteFormatPreserved: true,
    backups,
    uncovered: [
      ...(!iterationCovered
        ? [
            'Natural modified-file fixed test failure followed by same-task correction did not occur.'
          ]
        : []),
      'Complete OS isolation and older lesson unresolved coverage retain their prior status.'
    ]
  }
  await fs.writeFile(
    path.join(evidence, 'business-validation.json'),
    JSON.stringify(report, null, 2)
  )
  return report
}

export function desktopHistory(project) {
  const messages = [],
    toolRuns = []
  for (let index = 0; index < 10; index++) {
    const user = {
      id: 'fixture-user-' + index,
      role: 'user',
      content:
        '研究固定价格合同参考台账第' + index + '组。仅为合成的较早已结束计划，不执行修改或命令。',
      status: 'complete',
      mode: 'plan'
    }
    let content =
      '【固定夹具构造的历史计划资料，非真实模型历史】没有执行任何修改、命令或测试，测试结果未知；不恢复授权或当前文件凭据。\n'
    for (let row = 0; content.length < 13700; row++)
      content += `Catalog ${index} row ${row}: use integer cents; line subtotal multiplies unit price and quantity; discount uses basis points / 10000 and Math.round. No current disk or executed-test claim.\n`
    content = content.slice(0, 13800)
    const assistant = {
      id: 'fixture-assistant-' + index,
      role: 'assistant',
      content,
      status: 'complete',
      mode: 'plan'
    }
    messages.push(user, assistant)
    toolRuns.push({
      requestId: 'fixture-request-' + index,
      userId: user.id,
      assistantId: assistant.id,
      mode: 'plan',
      scope: { kind: 'time' },
      trace: [],
      items: [
        { role: 'user', content: user.content },
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: content }]
        }
      ]
    })
  }
  return {
    version: 9,
    activeConversationId: 'lesson56-fixture',
    conversations: [
      {
        id: 'lesson56-fixture',
        title: '第56课固定价格整理验收',
        pinned: false,
        archived: false,
        defaultDirectory: project,
        agentMode: 'execute',
        messages,
        toolRuns,
        workspace: null,
        tasks: []
      }
    ]
  }
}

/** Always collect independent disk facts, including failed or incomplete real tasks. */
export async function captureDiskFacts(business) {
  const { evidence, project, fixture, protectedFiles } = business
  const files = []
  for (const [name, expected] of Object.entries(protectedFiles)) {
    try {
      const actual = await fs.readFile(path.join(project, name))
      files.push({
        name,
        bytes: actual.length,
        sha256: hash(actual),
        expectedSHA256: hash(expected),
        unchanged: actual.equals(expected)
      })
    } catch (error) {
      files.push({ name, unchanged: false, error: error.message })
    }
  }
  const actual = await fs.readFile(path.join(project, 'business.ts'))
  await fs.writeFile(path.join(evidence, 'business.observed-final.bin'), actual)
  let outsideBusinessUnchanged = null,
    outsideBusinessError = null
  try {
    outsideBusinessUnchanged = outsideBusiness(actual).equals(outsideBusiness(fixture.source))
  } catch (error) {
    outsideBusinessError = error.message
  }
  const text = actual.toString('utf8')
  const format = {
    hasUtf8Bom: actual.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
    onlyCRLF: !/(?<!\r)\n/.test(text),
    trailingNewlines: (text.match(/(?:\r\n)+$/)?.[0].length ?? 0) / 2
  }
  const backups = []
  for (const name of await fs.readdir(project))
    if (/^\.zonecodex-[a-f0-9-]{36}\.bak$/.test(name)) {
      const bytes = await fs.readFile(path.join(project, name))
      backups.push({ name, sha256: hash(bytes), equalsInitial: bytes.equals(fixture.source) })
    }
  const diff = await runProcess(
    'git',
    [
      'diff',
      '--no-index',
      '--',
      path.join(evidence, 'business.initial.bin'),
      path.join(evidence, 'business.observed-final.bin')
    ],
    { cwd: project },
    10000
  )
  await fs.writeFile(path.join(evidence, 'independent-disk.diff'), diff.stdout)
  const protectedUnchanged = files.every((file) => file.unchanged)
  const test = protectedUnchanged
    ? await business.externalTest('independent-observed-test')
    : {
        skipped: true,
        reason:
          'Protected test/package/requirements/material bytes changed; modified test is not trusted as original-contract evidence.'
      }
  const facts = {
    realDisk: true,
    modelRequestsSuppliedByObserver: false,
    files,
    protectedUnchanged,
    actualSHA256: hash(actual),
    changed: !actual.equals(fixture.source),
    outsideBusinessUnchanged,
    outsideBusinessError,
    format,
    formatPreserved: format.hasUtf8Bom && format.onlyCRLF && format.trailingNewlines === 3,
    backups,
    diff: { exitCode: diff.exitCode, forcedKill: diff.forcedKill, stderr: diff.stderr },
    independentTest: test
  }
  await fs.writeFile(
    path.join(evidence, 'independent-disk-facts.json'),
    JSON.stringify(facts, null, 2)
  )
  return facts
}
