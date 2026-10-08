import { parsePermissionMode } from './execution'
import type { PermissionMode } from './execution'

export type TerminalShell = 'powershell' | 'cmd'

export type AppSettings = {
  version: 1
  taskRoot: string
  defaultPermissionMode: PermissionMode
  terminalShell: TerminalShell
}

export type SettingsChange =
  { defaultPermissionMode: PermissionMode } | { terminalShell: TerminalShell }

export type TaskRootSelection =
  { status: 'selected'; settings: AppSettings } | { status: 'cancelled' }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(descriptors, key) && 'value' in descriptors[key])
  )
}

/** A local Windows path is metadata until the main process verifies and binds it. */
export function isAbsoluteLocalDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z]:[\\/]/.test(value))
    return false
  const rest = value.slice(3)
  if (!rest) return true
  return rest.split(/[\\/]/).every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !/[<>:"|?*]/.test(segment) &&
      !Array.from(segment).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      }) &&
      !/[. ]$/.test(segment)
  )
}

export function parseTerminalShell(value: unknown): TerminalShell | null {
  return value === 'powershell' || value === 'cmd' ? value : null
}

export function parseAppSettings(value: unknown): AppSettings | null {
  if (
    !record(value) ||
    !exact(value, ['version', 'taskRoot', 'defaultPermissionMode', 'terminalShell']) ||
    value.version !== 1 ||
    !isAbsoluteLocalDirectory(value.taskRoot)
  )
    return null
  const defaultPermissionMode = parsePermissionMode(value.defaultPermissionMode)
  const terminalShell = parseTerminalShell(value.terminalShell)
  return defaultPermissionMode && terminalShell
    ? { version: 1, taskRoot: value.taskRoot, defaultPermissionMode, terminalShell }
    : null
}

export function parseSettingsChange(value: unknown): SettingsChange | null {
  if (!record(value)) return null
  if (exact(value, ['defaultPermissionMode'])) {
    const mode = parsePermissionMode(value.defaultPermissionMode)
    return mode ? { defaultPermissionMode: mode } : null
  }
  if (exact(value, ['terminalShell'])) {
    const terminalShell = parseTerminalShell(value.terminalShell)
    return terminalShell ? { terminalShell } : null
  }
  return null
}

export function parseTaskRootSelection(value: unknown): TaskRootSelection | null {
  if (!record(value)) return null
  if (exact(value, ['status']) && value.status === 'cancelled') return { status: 'cancelled' }
  if (exact(value, ['status', 'settings']) && value.status === 'selected') {
    const settings = parseAppSettings(value.settings)
    return settings ? { status: 'selected', settings } : null
  }
  return null
}
