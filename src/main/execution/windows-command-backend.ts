import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync
} from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const PROTOCOL = 1
const CLI_VERSION = '0.160.1'
const RUNTIME_DIRECTORY = 'windows-command-runtime'
const EXECUTABLE_NAMES = [
  'host.exe',
  'codex.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe'
] as const
const HASH_CHUNK_BYTES = 256 * 1024
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024

type ExecutableName = (typeof EXECUTABLE_NAMES)[number]
type RuntimeManifest = {
  protocol: number
  cliVersion?: string
  files: Partial<Record<ExecutableName, string>>
}

export type CommandHost = Readonly<{ path: string; hash: string; identity: string }>
export type WindowsCommandBackend = Readonly<{
  host: CommandHost
  hostPath: string
  hostHash: string
  cliPath: string
  cliHash: string
  codexHome: string
  networkReady: boolean
  networkReason: string
  identity: string
  files: readonly Readonly<{ path: string; hash: string }>[]
}>

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

/** Only application resources are candidates; neither PATH nor the command cwd is searched. */
function runtimeRoot(): string | null {
  const runtime = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
  const resourcesPath = runtime.resourcesPath
  const candidates =
    resourcesPath && runtime.defaultApp !== true
      ? isAbsolute(resourcesPath)
        ? [join(resourcesPath, RUNTIME_DIRECTORY)]
        : []
      : [
          resolve(__dirname, '..', '..', 'resources', RUNTIME_DIRECTORY),
          resolve(__dirname, '..', '..', '..', 'resources', RUNTIME_DIRECTORY)
        ]
  for (const candidate of candidates) {
    let info
    try {
      info = lstatSync(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return null
    }
    // An existing but invalid preferred resource directory must not select another binary.
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    try {
      return samePath(realpathSync(candidate), candidate) ? candidate : null
    } catch {
      return null
    }
  }
  return null
}

function regularResource(path: string, maximumBytes: number): boolean {
  try {
    const info = lstatSync(path)
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size > 0 &&
      info.size <= maximumBytes &&
      samePath(realpathSync(path), path)
    )
  } catch {
    return false
  }
}

function manifestAt(root: string): RuntimeManifest | null {
  const path = join(root, 'manifest.json')
  if (!regularResource(path, MAX_MANIFEST_BYTES)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const manifest = value as RuntimeManifest
    if (
      manifest.protocol !== PROTOCOL ||
      !manifest.files ||
      typeof manifest.files !== 'object' ||
      Array.isArray(manifest.files)
    ) {
      return null
    }
    for (const name of EXECUTABLE_NAMES) {
      const hash = manifest.files[name]
      if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
        return null
      }
    }
    return manifest
  } catch {
    return null
  }
}

/** Chunked reads bound memory even for the bundled CLI, which is several hundred MB. */
async function fileHash(path: string): Promise<string | null> {
  if (!regularResource(path, MAX_EXECUTABLE_BYTES)) return null
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    const before = await file.stat()
    if (!before.isFile() || before.size <= 0 || before.size > MAX_EXECUTABLE_BYTES) return null
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position
      )
      if (bytesRead === 0) return null
      hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await file.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !regularResource(path, MAX_EXECUTABLE_BYTES)
    ) {
      return null
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function fileHashSync(path: string): string | null {
  if (!regularResource(path, MAX_EXECUTABLE_BYTES)) return null
  let file: number | undefined
  try {
    file = openSync(path, 'r')
    const before = fstatSync(file)
    if (!before.isFile() || before.size <= 0 || before.size > MAX_EXECUTABLE_BYTES) return null
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
    let position = 0
    while (position < before.size) {
      const bytesRead = readSync(
        file,
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position
      )
      if (bytesRead === 0) return null
      hash.update(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = fstatSync(file)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      !regularResource(path, MAX_EXECUTABLE_BYTES)
    ) {
      return null
    }
    return hash.digest('hex')
  } catch {
    return null
  } finally {
    if (file !== undefined) closeSync(file)
  }
}

function identity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hostIdentity(path: string, hash: string): string {
  return identity({ protocol: PROTOCOL, host: resolve(path).toLowerCase(), hash })
}

function backendIdentity(backend: Omit<WindowsCommandBackend, 'identity'>): string {
  return identity({ protocol: PROTOCOL, cliVersion: CLI_VERSION, ...backend })
}

function queryExecutable(path: string, argument: string): Promise<string | null> {
  return new Promise((resolveResult) => {
    execFile(
      path,
      [argument],
      {
        cwd: dirname(path),
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) =>
            /^(?:path|pathext|systemroot|windir|temp|tmp|userprofile|homedrive|homepath|appdata|localappdata)$/i.test(
              key
            )
          )
        ),
        windowsHide: true,
        timeout: 5000,
        maxBuffer: MAX_MANIFEST_BYTES,
        encoding: 'utf8'
      },
      (error, stdout) => resolveResult(error ? null : stdout.trim())
    )
  })
}

function currentCodexHome(): string | null {
  const override = process.env.CODEX_HOME
  if (override !== undefined && (!override.trim() || !isAbsolute(override))) return null
  const path = resolve(override ?? join(homedir(), '.codex'))
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink() ? realpathSync(path) : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
  }
  try {
    const parent = dirname(path)
    const info = lstatSync(parent)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    // The official elevated launcher prepares missing setup artifacts itself, including UAC.
    // Inspection does not create directories or read authentication/account credentials.
    return join(realpathSync(parent), basename(path))
  } catch {
    return null
  }
}

async function inspectHostAt(root: string, manifest: RuntimeManifest): Promise<CommandHost | null> {
  const path = join(root, 'host.exe')
  const expected = manifest.files['host.exe']
  if (!expected || (await fileHash(path)) !== expected) return null
  const response = await queryExecutable(path, '--capabilities')
  if (!response) return null
  try {
    const capabilities = JSON.parse(response) as { protocol?: unknown; atomicJob?: unknown }
    if (capabilities.protocol !== PROTOCOL || capabilities.atomicJob !== true) return null
  } catch {
    return null
  }
  return Object.freeze({ path, hash: expected, identity: hostIdentity(path, expected) })
}

export async function inspectCommandHost(): Promise<CommandHost | null> {
  if (process.platform !== 'win32') return null
  const root = runtimeRoot()
  const manifest = root ? manifestAt(root) : null
  return root && manifest ? inspectHostAt(root, manifest) : null
}

/** Native readiness is fail closed; setup markers and COM rules alone cannot prove containment. */
export async function inspectOfflineNetworkIsolation(
  host: CommandHost
): Promise<Readonly<{ available: boolean; reason: string }>> {
  const unavailable = Object.freeze({ available: false, reason: 'network-policy-query-failed' })
  if (!verifyCommandHost(host)) return unavailable
  const response = await queryExecutable(host.path, '--network-capability')
  if (!response || !verifyCommandHost(host)) return unavailable
  try {
    const value = JSON.parse(response) as Record<string, unknown>
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['protocol', 'offlineNetwork', 'reason', 'rulesReady'].includes(key)
      ) ||
      value.protocol !== PROTOCOL ||
      typeof value.offlineNetwork !== 'boolean' ||
      (value.rulesReady !== undefined && typeof value.rulesReady !== 'boolean') ||
      typeof value.reason !== 'string' ||
      value.reason.length === 0 ||
      value.reason.length > 200
    )
      return unavailable
    return Object.freeze({ available: value.offlineNetwork, reason: value.reason })
  } catch {
    return unavailable
  }
}

export async function inspectWindowsCommandBackend(): Promise<WindowsCommandBackend | null> {
  if (process.platform !== 'win32') return null
  const root = runtimeRoot()
  const manifest = root ? manifestAt(root) : null
  const codexHome = currentCodexHome()
  if (!root || !manifest || manifest.cliVersion !== CLI_VERSION || !codexHome) return null
  const host = await inspectHostAt(root, manifest)
  if (!host) return null
  const files: Readonly<{ path: string; hash: string }>[] = []
  for (const name of EXECUTABLE_NAMES) {
    const path = join(root, name)
    const expected = manifest.files[name]
    if (!expected || (name !== 'host.exe' && (await fileHash(path)) !== expected)) return null
    files.push(Object.freeze({ path, hash: expected }))
  }
  const cliPath = join(root, 'codex.exe')
  if ((await queryExecutable(cliPath, '--version')) !== `codex-cli ${CLI_VERSION}`) return null
  const network = await inspectOfflineNetworkIsolation(host)
  const backend = {
    host,
    hostPath: host.path,
    hostHash: host.hash,
    cliPath,
    cliHash: manifest.files['codex.exe']!,
    codexHome,
    networkReady: network.available,
    networkReason: network.reason,
    files: Object.freeze(files)
  }
  return Object.freeze({ ...backend, identity: backendIdentity(backend) })
}

/** Rehash immediately before launch; changed resources invalidate the exact approved plan. */
export function verifyCommandHost(host: CommandHost): boolean {
  if (process.platform !== 'win32') return false
  const root = runtimeRoot()
  const manifest = root ? manifestAt(root) : null
  if (!root || !manifest) return false
  const path = join(root, 'host.exe')
  const expected = manifest.files['host.exe']
  return (
    !!expected &&
    samePath(host.path, path) &&
    host.hash === expected &&
    host.identity === hostIdentity(host.path, host.hash) &&
    fileHashSync(path) === expected
  )
}

export function verifyWindowsCommandBackend(backend: WindowsCommandBackend): boolean {
  if (process.platform !== 'win32') return false
  const root = runtimeRoot()
  const manifest = root ? manifestAt(root) : null
  const codexHome = currentCodexHome()
  if (
    !root ||
    !manifest ||
    manifest.cliVersion !== CLI_VERSION ||
    !codexHome ||
    !samePath(backend.codexHome, codexHome) ||
    !samePath(backend.hostPath, join(root, 'host.exe')) ||
    !samePath(backend.cliPath, join(root, 'codex.exe')) ||
    !samePath(backend.host.path, backend.hostPath) ||
    backend.host.hash !== backend.hostHash ||
    backend.host.identity !== hostIdentity(backend.host.path, backend.host.hash) ||
    backend.hostHash !== manifest.files['host.exe'] ||
    backend.cliHash !== manifest.files['codex.exe'] ||
    backend.files.length !== EXECUTABLE_NAMES.length
  ) {
    return false
  }
  const { identity: expectedIdentity, ...snapshot } = backend
  if (expectedIdentity !== backendIdentity(snapshot)) return false
  return EXECUTABLE_NAMES.every((name, index) => {
    const file = backend.files[index]
    const path = join(root, name)
    const expected = manifest.files[name]
    return (
      !!expected &&
      samePath(file.path, path) &&
      file.hash === expected &&
      fileHashSync(path) === expected
    )
  })
}
