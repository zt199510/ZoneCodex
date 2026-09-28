import type { PermissionStatus, TaskStatus } from './project'

export type WorkspaceRuntimeState = {
  task: TaskStatus
  permission: PermissionStatus
}

export const initialWorkspaceRuntimeState: WorkspaceRuntimeState = {
  task: 'idle',
  permission: 'unscoped'
}

export function beginTask(
  state: WorkspaceRuntimeState,
  task: Exclude<TaskStatus, 'idle' | 'completed' | 'cancelled' | 'failed'>
): WorkspaceRuntimeState {
  return { ...state, task }
}

export function finishTask(
  state: WorkspaceRuntimeState,
  task: Extract<TaskStatus, 'completed' | 'cancelled' | 'failed'>
): WorkspaceRuntimeState {
  return { ...state, task }
}

export function scopeWorkspace(state: WorkspaceRuntimeState): WorkspaceRuntimeState {
  return { ...state, permission: 'scoped' }
}

export function expireWorkspace(state: WorkspaceRuntimeState): WorkspaceRuntimeState {
  return { ...state, permission: 'expired' }
}

export function revokeWorkspace(state: WorkspaceRuntimeState): WorkspaceRuntimeState {
  return {
    ...state,
    permission: 'revoked',
    task: state.task === 'running' ? 'cancelled' : state.task
  }
}

export function resetWorkspaceRuntime(): WorkspaceRuntimeState {
  return { ...initialWorkspaceRuntimeState }
}
