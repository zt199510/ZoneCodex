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
    agent.registerAgentPractice(prep.hasChangePreparation)
    access.registerProjectAccess({
      isAgentJobActive: (id) => agent.hasAgentJob(id) || prep.hasChangePreparation(id),
      abortProjectJob: agent.abortProjectJob,
      onAccessChanged: prep.cleanupChangePreparation
    })
    access.attachProjectAccessCleanup(window)
    require('../src/main/agent/change-preview-ipc.ts').registerChangePreview()
    prep.registerChangePreparation((id) => agent.hasAgentJob(id) || access.hasProjectSelection(id))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [greet] })
    await setMode('mock')
    await openAttachments()
    await click('.attachment-picker')
    await idle()
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
