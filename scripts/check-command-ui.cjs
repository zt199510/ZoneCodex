module.exports = async function ({
  window,
  evaluate,
  dom,
  click,
  input,
  idle,
  openAttachments,
  screenshot
}) {
  const assert = require('node:assert/strict')
  const { ipcMain, utilityProcess } = require('electron')
  const cp = require('node:child_process')
  const pty = require('node-pty')
  let processes = 0
  let terminalWrites = 0
  const restores = []
  for (const [target, names] of [
    [cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    [pty, ['spawn']],
    [utilityProcess, ['fork']]
  ]) {
    for (const name of names) {
      const original = target[name]
      target[name] = () => {
        processes++
        throw Error('Unexpected proposal process')
      }
      restores.push(() => {
        target[name] = original
      })
    }
  }
  const originalEmit = ipcMain.emit
  ipcMain.emit = function (channel, ...args) {
    if (channel === 'terminal:write') terminalWrites++
    return originalEmit.call(this, channel, ...args)
  }
  // Observe invoke too, before existing terminal handlers run.
  const originalHandler = ipcMain._invokeHandlers.get('terminal:write')
  ipcMain._invokeHandlers.set('terminal:write', (...args) => {
    terminalWrites++
    return originalHandler?.(...args)
  })
  try {
    window.setSize(680, 560)
    await input('模拟命令提案')
    await click('button[aria-label="发送消息"]')
    await dom('!!document.querySelector(".message-command-proposal button")')
    await idle()
    await click('.message-command-proposal button')
    await dom('!!document.querySelector(".command-review-panel")')
    assert(
      await evaluate(
        'document.querySelector(".command-review-panel").textContent.includes("尚未选择并授权")'
      )
    )
    assert(
      await evaluate(
        'document.querySelector(".command-review-panel").textContent.includes("可能写文件、联网或启动子进程")'
      )
    )
    assert(
      await evaluate(
        'document.querySelector(".command-review-panel > button").getBoundingClientRect().bottom <= innerHeight'
      )
    )
    assert(
      await evaluate(
        'document.querySelector(".command-review-body").scrollHeight >= document.querySelector(".command-review-body").clientHeight && getComputedStyle(document.querySelector(".command-review-body")).overflowY === "auto"'
      )
    )
    await screenshot('command-review-680.png')
    await evaluate(
      'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))'
    )
    await dom('!document.querySelector(".command-review-panel")')
    await dom(
      'document.activeElement === document.querySelector(".message-command-proposal button")'
    )
    await click('.message-command-proposal button')
    await dom('!!document.querySelector(".command-review-panel")')
    await input('模拟命令提案')
    await click('button[aria-label="发送消息"]')
    await dom('!document.querySelector(".command-review-panel")')
    await idle()
    await dom('document.querySelectorAll(".message-command-proposal").length === 2')
    await click('.message-command-proposal button')
    await dom('!!document.querySelector(".command-review-panel")')
    await openAttachments()
    await click('.attachment-picker')
    await idle()
    await dom('!document.querySelector(".command-review-panel")')
    assert(await evaluate('!document.querySelector(".message-command-proposal button")'))
    assert(
      await evaluate(
        'document.querySelector(".message-command-proposal").textContent.includes("历史提案，需重新生成")'
      )
    )
    assert.equal(processes, 0)
    assert.equal(terminalWrites, 0)
    console.log(
      'Lesson 26 UI passed: real mock/IPC, review, Escape/focus, new-task closure, replacement invalidation, 680×560 scrolling; process starts=0, terminal writes=0.'
    )
  } finally {
    restores.reverse().forEach((restore) => restore())
    ipcMain.emit = originalEmit
    if (originalHandler) ipcMain._invokeHandlers.set('terminal:write', originalHandler)
    else ipcMain._invokeHandlers.delete('terminal:write')
  }
}
