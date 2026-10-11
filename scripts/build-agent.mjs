/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone Node build script. */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, copyFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeFiles = [
  'host.exe',
  'codex.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt'
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function ordinary(path, directory = false) {
  const info = await lstat(path)
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
    (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()
  )
    throw new Error(`Build path must be ordinary and exclusive: ${path}`)
}
async function prepare(path) {
  await mkdir(path, { recursive: true })
  await ordinary(path, true)
}
async function target(path) {
  await ordinary(dirname(path), true)
  try {
    await ordinary(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
const outputs = [join(root, 'out', 'cli'), join(root, 'dist', 'agent')]
const builds = []
for (const [name, source] of [
  ['output-writer', 'src/cli/output-writer.ts'],
  ['agent', 'src/cli/agent-host.ts'],
  ['index', 'src/cli/index.ts']
]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [source],
    outfile: `${name}.cjs`,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define:
      name === 'index' ? { __OUTPUT_WRITER_SHA256__: JSON.stringify(hash(builds[0].bytes)) } : {},
    write: false,
    metafile: true,
    logLevel: 'silent'
  })
  const dependencies = Object.keys(result.metafile.inputs)
  if (
    dependencies.some((path) =>
      /node_modules|src\/main\/(?:agent\/agent-user-input|execution\/(?:action-authorization|execution-context))\.ts$/.test(
        path.replaceAll('\\', '/')
      )
    )
  )
    throw new Error('CLI runtime closure unexpectedly reaches a package or desktop broker.')
  for (const output of Object.values(result.metafile.outputs))
    if (output.imports.some((item) => item.path === 'electron'))
      throw new Error('CLI imports Electron.')
  builds.push({
    name: `${name}.cjs`,
    bytes: result.outputFiles[0].contents,
    sources: Object.fromEntries(
      await Promise.all(
        dependencies.map(async (path) => [
          path.replaceAll('\\', '/'),
          hash(await readFile(join(root, path)))
        ])
      )
    )
  })
}
const manifest = JSON.parse(
  await readFile(join(root, 'resources/windows-command-runtime/manifest.json'), 'utf8')
)
const runtime = []
for (const name of runtimeFiles) {
  const source = join(root, 'resources/windows-command-runtime', name)
  await ordinary(source)
  const sha256 = hash(await readFile(source))
  if (name.endsWith('.exe') && manifest.files[name] !== sha256)
    throw new Error(`Original runtime hash mismatch: ${name}`)
  runtime.push({ name, source, sha256 })
}
for (const output of outputs) {
  await prepare(output)
  await prepare(join(output, 'windows-command-runtime'))
  for (const build of builds) {
    const path = join(output, build.name)
    await target(path)
    await writeFile(path, build.bytes)
  }
  for (const item of runtime) {
    const path = join(output, 'windows-command-runtime', item.name)
    await target(path)
    await copyFile(item.source, path)
    if (hash(await readFile(path)) !== item.sha256)
      throw new Error(`Runtime copy drift: ${item.name}`)
  }
  const launcher = '@echo off\r\nnode "%~dp0index.cjs" %*\r\nexit /b %errorlevel%\r\n'
  await target(join(output, 'agent.cmd'))
  await writeFile(join(output, 'agent.cmd'), launcher)
  await target(join(output, 'README.md'))
  await writeFile(
    join(output, 'README.md'),
    `# ZoneCodex Agent\n\n需要安装 Node.js 22 或更高版本；本课在普通 Node 24.11.1 验收。Windows 命令需要随包固定的 windows-command-runtime 七份资源。\n\n从任意目录运行 agent.cmd --help，或 node <安装目录>/index.cjs --help。明确 --mode plan|execute 并选择 --prompt 或 --stdin。预先设置 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY；模型名无内建默认。JSONL 请直接使用 Node/启动器，避免 npm 自身日志混入 stdout。\n\n脚本使用 require('<安装目录>/agent.cjs').runAgentTask(input, options)。模块导入不读 stdin/argv、不发请求、不退出进程。输入及回调见项目第55课记录。\n\n请保留全部三份编译入口与 build-manifest.json。Windows CLI 输出到管道时使用固定 output-writer.cjs，身份由编译入口中的 SHA-256 与清单共同核验；它只写标准输出/错误，不具备模型或任务工具能力。输出阻塞时任务仍可取消，清理原模型/工具后回收输出进程。公共脚本和桌面入口不启动该输出进程。\n\n退出码：0 completed；1 任务/宿主/输出失败；2 输入/配置错误；3 缺交互/未解决批准；130 取消。循环完成须另核对业务测试。CLI 不保存、恢复桌面会话。\n`
  )
  await target(join(output, 'build-manifest.json'))
  await writeFile(
    join(output, 'build-manifest.json'),
    JSON.stringify(
      {
        protocol: 1,
        nodeMinimum: '22',
        builtWithNode: process.version,
        entries: builds.map((item) => ({
          name: item.name,
          sha256: hash(item.bytes),
          sources: item.sources
        })),
        runtime: runtime.map(({ name, sha256 }) => ({ name, sha256 })),
        launcher: { name: 'agent.cmd', sha256: hash(launcher) }
      },
      null,
      2
    ) + '\n'
  )
}
console.log(
  'Agent CLI, supervised output writer and public Node module built: out/cli and dist/agent; original seven runtime resources verified.'
)
