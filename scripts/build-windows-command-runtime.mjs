/* eslint-disable @typescript-eslint/explicit-function-return-type -- This build script runs directly as Node JavaScript. */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliVersion = '0.160.1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'resources', 'windows-command-runtime')
const manifestPath = join(output, 'manifest.json')
const officialFiles = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
const executableFiles = ['host.exe', ...officialFiles]
const maximumExecutableBytes = 1024 * 1024 * 1024
const maximumManifestBytes = 16 * 1024
const queryEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(?:PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA)$/i.test(
      name
    )
  )
)

function samePath(left, right) {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

async function ordinaryDirectory(directory) {
  const info = await lstat(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(await realpath(directory), directory)
  ) {
    throw new Error(`Runtime directory is not an ordinary canonical directory: ${directory}`)
  }
}

async function ordinaryFile(path, maximumBytes) {
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size === 0 ||
    info.size > maximumBytes ||
    !samePath(await realpath(path), path)
  )
    throw new Error(`Runtime resource is not an ordinary nonempty file: ${path}`)
  return info
}

/** A replacement never writes through a previously generated link or shared file. */
async function replacementTarget(path) {
  await ordinaryDirectory(dirname(path))
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !samePath(await realpath(path), path)
  ) {
    throw new Error(`Runtime replacement target is not an ordinary exclusive file: ${path}`)
  }
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
}

async function unchangedReplacementTarget(path, previous) {
  if ((await replacementTarget(path)) !== previous) {
    throw new Error(`Runtime replacement target changed before replacement: ${path}`)
  }
}

async function copyRuntimeFile(source, destination, expectedHash) {
  const previous = await replacementTarget(destination)
  const temporaryPath = `${destination}.${randomUUID()}.tmp`
  try {
    await copyFile(source, temporaryPath, constants.COPYFILE_EXCL)
    if ((await hashFile(temporaryPath)) !== expectedHash) {
      throw new Error(`Runtime source changed before it was copied: ${source}`)
    }
    await unchangedReplacementTarget(destination, previous)
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function validManifest(manifest) {
  return (
    manifest &&
    typeof manifest === 'object' &&
    !Array.isArray(manifest) &&
    manifest.protocol === 1 &&
    manifest.cliVersion === cliVersion &&
    manifest.files &&
    typeof manifest.files === 'object' &&
    !Array.isArray(manifest.files) &&
    executableFiles.every(
      (name) =>
        typeof manifest.files[name] === 'string' && /^[a-f0-9]{64}$/.test(manifest.files[name])
    ) &&
    typeof manifest.hostSourceHash === 'string' &&
    /^[a-f0-9]{64}$/.test(manifest.hostSourceHash)
  )
}

/** Unique exclusive temporary files avoid following stale manifest links. */
async function writeManifest(path, manifest) {
  const previous = await replacementTarget(path)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let temporary
  try {
    temporary = await open(temporaryPath, 'wx')
    await temporary.writeFile(JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await temporary.close()
    await unchangedReplacementTarget(path, previous)
    await rename(temporaryPath, path)
  } finally {
    if (temporary) {
      await temporary.close().catch(() => undefined)
      await rm(temporaryPath, { force: true })
    }
  }
}

function query(path, argument) {
  return execFileSync(path, [argument], {
    cwd: dirname(path),
    env: queryEnvironment,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024,
    encoding: 'utf8'
  }).trim()
}

async function hashFile(path) {
  const before = await ordinaryFile(path, maximumExecutableBytes)
  const file = await open(path, 'r')
  try {
    const opened = await file.stat()
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size) {
      throw new Error(`Runtime resource changed before it was opened: ${path}`)
    }
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({
      highWaterMark: 256 * 1024,
      autoClose: false
    }))
      hash.update(chunk)
    const after = await ordinaryFile(path, maximumExecutableBytes)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(`Runtime resource changed while it was being read: ${path}`)
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}

async function sourceAt(directory, manifest) {
  await ordinaryDirectory(directory)
  const files = {}
  for (const name of officialFiles) {
    const path = join(directory, name)
    const hash = await hashFile(path)
    files[name] = hash
    if (manifest && manifest.files[name] !== hash) {
      throw new Error(`Generated runtime integrity check failed: ${name}`)
    }
  }
  const version = query(join(directory, 'codex.exe'), '--version')
  if (version !== `codex-cli ${cliVersion}`) {
    throw new Error(`Expected codex-cli ${cliVersion}; found ${version || 'an unknown version'}`)
  }
  return { directory, files }
}

async function existingManifest() {
  try {
    await ordinaryFile(manifestPath, maximumManifestBytes)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    return validManifest(manifest) ? manifest : null
  } catch {
    return null
  }
}

async function discoverSource(manifest) {
  if (process.env.CODEX_WINDOWS_RUNTIME_DIR !== undefined) {
    const explicit = process.env.CODEX_WINDOWS_RUNTIME_DIR
    if (!explicit.trim() || !isAbsolute(explicit)) {
      throw new Error('CODEX_WINDOWS_RUNTIME_DIR must name an absolute runtime directory.')
    }
    // An explicit source is authoritative: invalid input does not select another installation.
    return sourceAt(resolve(explicit))
  }
  const failures = []
  if (manifest) {
    try {
      if ((await hashFile(join(output, 'host.exe'))) !== manifest.files['host.exe']) {
        throw new Error('Generated host integrity check failed.')
      }
      return await sourceAt(output, manifest)
    } catch (error) {
      failures.push(error.message)
    }
  }
  const candidates = []
  if (process.env.LOCALAPPDATA) {
    const installations = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
    try {
      const entries = await readdir(installations, { withFileTypes: true })
      const directories = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map(async (entry) => {
            const directory = join(installations, entry.name)
            return { directory, modified: (await lstat(directory)).mtimeMs }
          })
      )
      directories.sort((left, right) => right.modified - left.modified)
      candidates.push(...directories.map((entry) => entry.directory))
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(error.message)
    }
  }
  if (process.env.APPDATA) {
    const packages = join(process.env.APPDATA, 'npm', 'node_modules', '@openai')
    for (const name of ['codex', 'codex-win32-x64']) {
      candidates.push(join(packages, name, 'vendor', 'x86_64-pc-windows-msvc', 'codex'))
    }
  }
  for (const candidate of candidates) {
    try {
      return await sourceAt(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(error.message)
    }
  }
  throw new Error(
    `A complete Codex ${cliVersion} Windows runtime was not found. ` +
      'Set CODEX_WINDOWS_RUNTIME_DIR to the directory containing codex.exe, ' +
      'codex-command-runner.exe and codex-windows-sandbox-setup.exe. ' +
      'This build does not download or install the runtime.' +
      (failures.length ? ` Details: ${failures.join('; ')}` : '')
  )
}

async function buildRuntime() {
  if (process.platform !== 'win32') {
    console.log(
      'Windows command runtime: skipped on this platform; native Windows builds require it.'
    )
    return
  }
  await ordinaryDirectory(output)
  for (const name of [...executableFiles, 'host.obj', 'manifest.json']) {
    await replacementTarget(join(output, name))
  }
  const sourceFiles = await Promise.all(
    ['native/windows-command-host/main.cpp', 'scripts/build-windows-command-host.ps1'].map((path) =>
      readFile(join(root, path))
    )
  )
  const hostSourceHash = createHash('sha256')
    .update(sourceFiles[0])
    .update('\0')
    .update(sourceFiles[1])
    .digest('hex')
  const manifest = await existingManifest()
  const source = await discoverSource(manifest)
  let rebuildHost = manifest?.hostSourceHash !== hostSourceHash
  if (!rebuildHost) {
    try {
      rebuildHost = (await hashFile(join(output, 'host.exe'))) !== manifest.files['host.exe']
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      rebuildHost = true
    }
  }
  if (rebuildHost) {
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'scripts/build-windows-command-host.ps1')
      ],
      { cwd: root, windowsHide: true, stdio: 'inherit' }
    )
  }
  for (const name of officialFiles) {
    if (!samePath(source.directory, output)) {
      await copyRuntimeFile(join(source.directory, name), join(output, name), source.files[name])
    }
    if ((await hashFile(join(output, name))) !== source.files[name]) {
      throw new Error(`Runtime resource changed before version checks: ${name}`)
    }
  }
  const capabilities = JSON.parse(query(join(output, 'host.exe'), '--capabilities'))
  if (capabilities.protocol !== 1 || capabilities.atomicJob !== true) {
    throw new Error('The generated command host does not implement protocol 1 with atomic jobs.')
  }
  if (query(join(output, 'codex.exe'), '--version') !== `codex-cli ${cliVersion}`) {
    throw new Error('The copied Codex runtime does not match the required version.')
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    await ordinaryFile(join(output, name), 1024 * 1024)
    if (!(await readFile(join(output, name), 'utf8')).trim()) {
      throw new Error(`The runtime distribution is missing ${name}.`)
    }
  }
  const files = Object.fromEntries(
    await Promise.all(
      executableFiles.map(async (name) => [name, await hashFile(join(output, name))])
    )
  )
  for (const name of officialFiles) {
    if (files[name] !== source.files[name]) {
      throw new Error(`Runtime resource changed before its manifest was written: ${name}`)
    }
  }
  await writeManifest(manifestPath, { protocol: 1, cliVersion, files, hostSourceHash })
  console.log(
    `Windows command runtime: Codex ${cliVersion}, protocol 1, four executable hashes verified.`
  )
}

/** Runtime resources retain their build bytes; the app and installer sign separately. */
export default async function finalizePackagedRuntime(context, stage = 'signed') {
  if (context.electronPlatformName !== 'win32') return
  if (typeof context.appOutDir !== 'string' || !isAbsolute(context.appOutDir))
    throw new Error('Packaged runtime output must be an absolute directory.')
  const packagedRoot = join(context.appOutDir, 'resources', 'windows-command-runtime')
  await ordinaryDirectory(packagedRoot)
  const packagedManifest = join(packagedRoot, 'manifest.json')
  await ordinaryFile(packagedManifest, maximumManifestBytes)
  const previous = JSON.parse(await readFile(packagedManifest, 'utf8'))
  if (!validManifest(previous)) throw new Error('Packaged runtime manifest version mismatch.')
  const files = Object.fromEntries(
    await Promise.all(
      executableFiles.map(async (name) => [name, await hashFile(join(packagedRoot, name))])
    )
  )
  for (const name of executableFiles) {
    if (files[name] !== previous.files[name]) {
      throw new Error(`Packaged runtime integrity drift at ${stage}: ${name}`)
    }
  }
  const capabilities = JSON.parse(query(join(packagedRoot, 'host.exe'), '--capabilities'))
  if (capabilities.protocol !== 1 || capabilities.atomicJob !== true)
    throw new Error('Packaged command host protocol mismatch.')
  if (query(join(packagedRoot, 'codex.exe'), '--version') !== `codex-cli ${cliVersion}`)
    throw new Error('Packaged CLI version mismatch.')
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    await ordinaryFile(join(packagedRoot, name), 1024 * 1024)
    if (!(await readFile(join(packagedRoot, name), 'utf8')).trim())
      throw new Error(`The packaged runtime distribution is missing ${name}.`)
  }
  await writeManifest(packagedManifest, {
    protocol: 1,
    cliVersion,
    files,
    hostSourceHash: previous.hostSourceHash
  })
  console.log(`Packaged Windows command runtime: ${stage} executable hashes verified.`)
}

/** Verify copied resources even when code signing is disabled and afterSign is skipped. */
export async function afterPack(context) {
  await finalizePackagedRuntime(context, 'copied')
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  await buildRuntime().catch((error) => {
    console.error(`Windows command runtime build failed: ${error.message}`)
    process.exitCode = 1
  })
}
