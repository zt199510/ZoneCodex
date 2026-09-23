// Uses the existing workspace harness, real Electron IPC, production services and a disposable file.
module.exports = async function ({
  window,
  evaluate,
  dom,
  click,
  input,
  idle,
  setMode,
  openAttachments,
  screenshot
}) {
  const { ipcMain, dialog } = require('electron')
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const assert = require('node:assert/strict')
  const ts = require('typescript')
  require.extensions['.ts'] = (module, filename) =>
    module._compile(
      ts.transpileModule(require('node:fs').readFileSync(filename, 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        }
      }).outputText,
      filename
    )
  const base = path.resolve(__dirname, 'fixtures')
  const directory = await fs.mkdtemp(path.join(base, 'preparation-'))
  const greet = path.join(directory, 'greet.ts')
  const original = 'export function greet(name: string): string {\n  return `你好，${name}`\n}\n'
  const originalPicker = dialog.showOpenDialog
  const access = require('../src/main/agent/project-access.ts')
  const agent = require('../src/main/agent/agent-ipc.ts')
  const prep = require('../src/main/agent/change-preparation-ipc.ts')
  const commit = require('../src/main/agent/change-commit-ipc.ts')
  let dropReply = false
  let rejectBeforeClaim = false
  let rejectedRequest
  const realHandle = ipcMain.handle.bind(ipcMain)
  try {
    await fs.writeFile(greet, original)
    for (const channel of [
      'agent:start',
      'agent:cancel',
      'project:select',
      'project:remove',
      'project:revoke',
      'preview:change'
    ])
      ipcMain.removeHandler(channel)
    agent.registerAgentPractice((id) => prep.hasChangePreparation(id) || commit.hasChangeCommit(id))
    access.registerProjectAccess({
      isAgentJobActive: (id) =>
        agent.hasAgentJob(id) || prep.hasChangePreparation(id) || commit.hasChangeCommit(id),
      abortProjectJob: agent.abortProjectJob,
      onAccessChanged: (id) => {
        prep.cleanupChangePreparation(id)
        commit.cancelChangeCommit(id)
      }
    })
    access.attachProjectAccessCleanup(window)
    commit.attachCommitCleanup(window)
    require('../src/main/agent/change-preview-ipc.ts').registerChangePreview(commit.hasChangeCommit)
    prep.registerChangePreparation(
      (id) => agent.hasAgentJob(id) || access.hasProjectSelection(id) || commit.hasChangeCommit(id)
    )
    ipcMain.handle = (channel, handler) =>
      realHandle(
        channel,
        channel === 'commit:apply'
          ? async (...args) => {
              if (rejectBeforeClaim) {
                rejectedRequest = args[1]
                throw new Error('Injected pre-claim transport failure')
              }
              const response = await handler(...args)
              if (dropReply) throw new Error('Injected lost acknowledgement')
              return response
            }
          : handler
      )
    try {
      commit.registerChangeCommit(
        (id) =>
          agent.hasAgentJob(id) || access.hasProjectSelection(id) || prep.hasChangePreparation(id)
      )
    } finally {
      ipcMain.handle = realHandle
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [greet] })
    await setMode('mock')
    await openAttachments()
    await click('.attachment-picker')
    await idle()
    await require('./check-command-ui.cjs')({
      window,
      evaluate,
      dom,
      click,
      input,
      idle,
      openAttachments,
      screenshot
    })
    assert.equal(await fs.readFile(greet, 'utf8'), original)
    await input('模拟修改 greet')
    await click('button[aria-label="发送消息"]')
    await dom(
      '!!document.querySelector(".message-change-proposal-action")',
      'real mock proposal card'
    )
    await idle()
    await click('.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")', 'production preview IPC')
    const check = () =>
      evaluate(
        '[...document.querySelectorAll(".change-preview-footer button")].find(b => b.textContent.includes("检查写入条件")).click()'
      )
    await dom(
      '[...document.querySelectorAll(".change-preview-footer button")].some(b => b.textContent.includes("检查写入条件"))'
    )
    await check()
    await dom('document.querySelector(".change-preview-panel")?.textContent.includes("检查通过")')
    window.setContentSize(680, 560)
    await screenshot('preparation-ready-680.png')
    assert(
      await evaluate(`(() => {
      const panel = document.querySelector('.change-preview-panel').getBoundingClientRect()
      const composer = document.querySelector('#chat-input').getBoundingClientRect()
      return panel.bottom <= innerHeight && panel.top >= 0 && composer.bottom <= innerHeight && !document.querySelector('#chat-input').disabled
    })()`)
    )
    assert.equal(await fs.readFile(greet, 'utf8'), original)
    await click('button[aria-label="关闭修改预览"]')
    await dom('!document.querySelector(".change-preview-panel")')
    await click('.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    await fs.writeFile(greet, original.replace('你好', '您好'))
    await check()
    await dom(
      'document.querySelector(".change-preview-panel")?.textContent.includes("文件在生成建议后发生变化")'
    )
    await screenshot('preparation-conflict-680.png')
    assert.equal(await fs.readFile(greet, 'utf8'), original.replace('你好', '您好'))
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
    await dom('!document.querySelector(".change-preview-panel")')
    await click('.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    // A manual preview must detach the message source; discarding it preserves the card.
    await openAttachments()
    await evaluate('document.querySelector(".composer-debug").open = true')
    await click('.change-preview-practice-submit')
    await dom('!!document.querySelector(".diff-row-add")')
    assert(
      !(await evaluate(
        'document.querySelector(".change-preview-footer").textContent.includes("检查写入条件")'
      ))
    )
    await evaluate(
      '[...document.querySelectorAll(".change-preview-footer button")].find(b => b.textContent.includes("丢弃建议")).click()'
    )
    await dom('!document.querySelector(".change-preview-panel")')
    assert(await evaluate('!!document.querySelector(".message-change-proposal-action")'))
    await fs.writeFile(greet, original)
    await click('.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    await check()
    await click('button[aria-label="关闭修改预览"]')
    await idle()
    await dom('!document.querySelector(".change-preview-panel")')
    assert.equal(await fs.readFile(greet, 'utf8'), original)
    await click('.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    await check()
    await dom('!!document.querySelector(".commit-confirm")')
    assert.equal(await fs.readFile(greet, 'utf8'), original, 'ready does not write')
    await screenshot('commit-confirm-680.png')
    await evaluate(
      'document.querySelector(".commit-confirm").click(); document.querySelector(".commit-confirm")?.click()'
    )
    await dom(
      'document.querySelector(".commit-receipt")?.textContent.includes("已提交")',
      'commit receipt survives snapshot cleanup'
    )
    await idle()
    assert.equal(
      await fs.readFile(greet, 'utf8'),
      original.replace('你好，' + '$' + '{name}', '欢迎，' + '$' + '{name}！')
    )
    const backups = (await fs.readdir(directory)).filter((name) => name.endsWith('.bak'))
    assert.equal(backups.length, 1, 'double click produces one backup and one commit')
    assert.equal(await fs.readFile(path.join(directory, backups[0]), 'utf8'), original)
    assert(
      !(await evaluate('!!document.querySelector("button.message-change-proposal-action")')),
      'historical suggestion no longer authorized'
    )
    assert(!(await evaluate('!!document.querySelector(".change-preview-panel")')))
    assert(
      await evaluate(
        'document.querySelector(".commit-receipt").getBoundingClientRect().bottom <= innerHeight && document.querySelector("#chat-input").getBoundingClientRect().bottom <= innerHeight'
      )
    )
    await screenshot('commit-applied-680.png')
    await evaluate(
      '[...document.querySelectorAll(".commit-receipt button")].find(b => b.textContent.includes("关闭结果")).click()'
    )
    await dom('!document.querySelector(".commit-receipt")')
    // A lost acknowledgement after an actual commit must never look like a no-op failure.
    await fs.writeFile(greet, original)
    await openAttachments()
    await click('.attachment-picker')
    await idle()
    await input('模拟修改 greet')
    await click('button[aria-label="发送消息"]')
    await dom('!!document.querySelector("button.message-change-proposal-action")')
    await idle()
    await click('button.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    await check()
    await dom('!!document.querySelector(".commit-confirm")')
    dropReply = true
    await click('.commit-confirm')
    await dom('document.querySelector(".commit-receipt")?.textContent.includes("未收到提交结果")')
    await idle()
    assert.equal(
      await fs.readFile(greet, 'utf8'),
      original.replace('你好，' + '$' + '{name}', '欢迎，' + '$' + '{name}！')
    )
    assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.bak')).length, 2)
    assert(!(await evaluate('!!document.querySelector("button.message-change-proposal-action")')))
    await screenshot('commit-uncertain-680.png')
    await evaluate(
      '[...document.querySelectorAll(".commit-receipt button")].find(b => b.textContent.includes("关闭结果")).click()'
    )
    await dom('!document.querySelector(".commit-receipt")')
    await fs.writeFile(greet, original)
    await openAttachments()
    await click('.attachment-picker')
    await idle()
    await input('模拟修改 greet')
    await click('button[aria-label="发送消息"]')
    await dom('!!document.querySelector("button.message-change-proposal-action")')
    await idle()
    await click('button.message-change-proposal-action')
    await dom('!!document.querySelector(".diff-row-add")')
    await check()
    await dom('!!document.querySelector(".commit-confirm")')
    rejectBeforeClaim = true
    await click('.commit-confirm')
    await dom('document.querySelector(".commit-receipt")?.textContent.includes("未收到提交结果")')
    await idle()
    assert.equal(await fs.readFile(greet, 'utf8'), original)
    assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.bak')).length, 2)
    assert.equal(
      access.captureProjectAccess(
        window.id,
        rejectedRequest.conversationId,
        rejectedRequest.snapshotId
      ),
      null,
      'transport failure before claim must not orphan the grant'
    )
    console.log(
      'Lesson 25 UI passed: explicit confirmation, one actual commit, exact backup, persistent receipt after authorization cleanup, stale card, lost acknowledgement and 680×560 layout.'
    )
    console.log(
      'Preparation UI passed: production mock → proposal → preview IPC → ready/conflict, manual source reset, close/cancel, 680×560 and unchanged source.'
    )
  } finally {
    dialog.showOpenDialog = originalPicker
    access.cleanupProjectAccess(window.id)
    assert(path.dirname(directory) === base && path.basename(directory).startsWith('preparation-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
