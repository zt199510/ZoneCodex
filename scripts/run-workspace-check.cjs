const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [join(__dirname, 'check-workspace.cjs')], {
  env,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 120000
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
