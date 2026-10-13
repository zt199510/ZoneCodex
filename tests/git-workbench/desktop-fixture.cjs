/* Synthetic native chooser/model replies only; actual Electron IPC/Git/PTY/disk remain unchanged. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  require(config.root + '/tests/lesson61/desktop-fixture.cjs').install(config)
  const fs = require('node:fs')
  const { app, dialog, ipcMain } = require('electron')
  const originalFetch = globalThis.fetch
  const candidates = []
  const completion = {
    actualInvalidationEvents: true,
    syntheticDirectoryReplies: true,
    multiDirectoryReplies: [],
    invalidations: [],
    cacheRoots: [
      require('node:path').join(app.getPath('temp'), 'ZoneCodex-git-view-' + process.pid),
      require('node:path').join(app.getPath('temp'), 'ZoneCodex-git-turn-' + process.pid)
    ]
  }
  const saveCompletion = () =>
    fs.writeFileSync(config.completionAuditFile, JSON.stringify(completion, null, 2))
  let nextDirectories = null
  const singleDirectoryDialog = dialog.showOpenDialog.bind(dialog)
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1)
    if (!nextDirectories || !options?.properties?.includes('multiSelections'))
      return singleDirectoryDialog(...args)
    const directories = nextDirectories
    nextDirectories = null
    completion.multiDirectoryReplies.push({ directories, options, atUTC: new Date().toISOString() })
    saveCompletion()
    return { canceled: !directories.length, filePaths: directories }
  }
  app.on('browser-window-created', (_event, window) => {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => {
      if (channel === 'git:invalidated') {
        completion.invalidations.push({
          windowId: window.id,
          event: args[0],
          atUTC: new Date().toISOString()
        })
        saveCompletion()
      }
      return send(channel, ...args)
    }
  })
  ipcMain.handle('workbench:configure-completion', (_event, value) => {
    if (
      !value ||
      !Array.isArray(value.directories) ||
      !value.directories.every((directory) => typeof directory === 'string')
    )
      throw Error('Invalid synthetic multi-directory fixture')
    nextDirectories = [...value.directories]
    return true
  })
  ipcMain.handle('workbench:observe-completion', () => completion)
  const save = () =>
    fs.writeFileSync(config.candidateAuditFile, JSON.stringify(candidates, null, 2))
  globalThis.fetch = async (url, init = {}) => {
    let body
    try {
      body = JSON.parse(init.body)
    } catch {
      return originalFetch(url, init)
    }
    if (
      String(url) !== process.env.MODEL_ENDPOINT ||
      !String(body.instructions).includes('根据用户明确选择的 Git 差异')
    )
      return originalFetch(url, init)
    if (body.tools.length !== 0) throw Error('Git candidate unexpectedly declared tools')
    const record = {
      category: 'git-candidate',
      actualModel: false,
      syntheticModel: true,
      instructions: body.instructions,
      input: body.input,
      tools: body.tools,
      atUTC: new Date().toISOString()
    }
    candidates.push(record)
    save()
    const text = JSON.stringify({
      subject: '桌面生成候选',
      body: '合成模型仅起草，用户随后手工编辑与确认。'
    })
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
                phase: 'final_answer',
                content: [{ type: 'output_text', text }]
              }
            ]
          }
        }) +
        '\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
  }
  ipcMain.handle('workbench:observe-candidates', () => candidates)
  globalThis.__workbenchReady = true
  save()
  saveCompletion()
}
module.exports = { install }
