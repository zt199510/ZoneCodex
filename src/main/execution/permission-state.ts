import type { PermissionMode, PermissionsState } from '../../shared/execution'
import { getAppSettings } from '../settings/settings-service'

const settings = new Map<number, PermissionsState>()

export function getExecutionPermissionState(windowId: number): PermissionsState {
  const current = settings.get(windowId)
  if (current) return { ...current }
  const initial = { mode: getAppSettings().defaultPermissionMode, revision: 0 }
  settings.set(windowId, initial)
  return { ...initial }
}

export function initializeExecutionPermissionState(windowId: number): void {
  getExecutionPermissionState(windowId)
}

export function setExecutionPermissionMode(
  windowId: number,
  mode: PermissionMode
): PermissionsState {
  const current = getExecutionPermissionState(windowId)
  if (current.mode !== mode) {
    settings.set(windowId, { mode, revision: current.revision + 1 })
  }
  return getExecutionPermissionState(windowId)
}

export function clearExecutionPermissionState(windowId: number): void {
  settings.delete(windowId)
}
