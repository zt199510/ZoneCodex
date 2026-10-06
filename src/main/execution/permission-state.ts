import type { PermissionMode, PermissionsState } from '../../shared/execution'

const settings = new Map<number, PermissionsState>()

export function getExecutionPermissionState(windowId: number): PermissionsState {
  return { ...(settings.get(windowId) ?? { mode: 'default', revision: 0 }) }
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
