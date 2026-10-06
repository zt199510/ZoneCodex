import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type { CommandSource } from '../shared/command-preparation'
import { decideCommandPermission } from '../shared/permission-policy'
import { registerWindowControls, observeWindowState } from './window/window-controls'
import { registerCloseGuard, attachCloseGuard } from './window/close-guard'
import { registerExternalLinks } from './window/external-links'
import { registerConversationStorage } from './storage/conversation-ipc'
import { registerLocalTerminal, attachTerminalCleanup } from './terminal/local-terminal'
import { registerAgentRequest } from './agent/agent-ipc'
import { abortProjectJob, hasAgentJob, isAgentBusy } from './agent/agent-runner'
import {
  cancelConversationTitleJob,
  registerConversationTitleRequest
} from './agent/conversation-title-ipc'
import { hasProjectSelection, hasProjectSnapshot } from './project/attachment-access'
import { hasWorkspaceSelection } from './project/workspace-access'
import { registerProjectAccess, attachProjectAccessCleanup } from './project/project-ipc'
import { registerExecutionContext } from './execution/execution-ipc'
import { clearExecutionPermissionState } from './execution/permission-state'
import { approveStandaloneCommand } from './execution/action-authorization'
import { clearExecutionApproval, registerExecutionApproval } from './execution/execution-approval'
import {
  registerChangeCommit,
  hasChangeCommit,
  cancelChangeCommit,
  attachCommitCleanup
} from './execution/change-commit-ipc'
import { registerChangePreview } from './execution/change-preview-ipc'
import {
  registerChangePreparation,
  hasChangePreparation,
  cleanupChangePreparation
} from './execution/change-preparation-ipc'
import {
  cleanupCommandPreparation,
  registerCommandPreparation
} from './execution/command-preparation-ipc'
import {
  cleanupCommandExecution,
  hasCommandExecution,
  registerCommandExecution
} from './execution/command-execution-ipc'
import {
  cleanupTaskWindow,
  cleanupTasksForSnapshot,
  discardTaskWindow,
  registerTaskLifecycle
} from './execution/task-registry'

function isAgentPreparationActive(windowId: number): boolean {
  return (
    hasChangePreparation(windowId) ||
    hasChangeCommit(windowId) ||
    hasCommandExecution(windowId) ||
    hasWorkspaceSelection(windowId)
  )
}

function isLegacyCommandSourceAllowed(windowId: number, source: CommandSource): boolean {
  const snapshotId = hasProjectSnapshot(windowId, source.snapshotId) ? source.snapshotId : ''
  return decideCommandPermission(
    { template: source.template, reason: '已通过提案解析' },
    { kind: 'project', snapshotId }
  ).allowed
}

function isProjectAccessBusy(windowId: number): boolean {
  return (
    hasAgentJob(windowId) ||
    hasChangePreparation(windowId) ||
    hasChangeCommit(windowId) ||
    hasCommandExecution(windowId)
  )
}

function isChangePreviewBusy(windowId: number): boolean {
  return hasAgentJob(windowId) || hasProjectSelection(windowId) || hasChangeCommit(windowId)
}

function isChangePreparationBusy(windowId: number): boolean {
  return (
    hasAgentJob(windowId) ||
    hasProjectSelection(windowId) ||
    hasWorkspaceSelection(windowId) ||
    hasChangeCommit(windowId) ||
    hasCommandExecution(windowId)
  )
}

function isChangeCommitBusy(windowId: number): boolean {
  return (
    hasAgentJob(windowId) ||
    hasProjectSelection(windowId) ||
    hasWorkspaceSelection(windowId) ||
    hasChangePreparation(windowId) ||
    hasCommandExecution(windowId)
  )
}

function onProjectAccessChanged(windowId: number, snapshotId?: string): void {
  cleanupChangePreparation(windowId)
  cleanupCommandPreparation(windowId)
  cleanupCommandExecution(windowId)
  cancelChangeCommit(windowId)
  if (snapshotId) cleanupTasksForSnapshot(windowId, snapshotId)
}

/** Cross-feature cleanup retains the original listener order and per-resource owners. */
export function attachWindowRuntime(window: BrowserWindow): void {
  // 观察窗口状态变化
  observeWindowState(window)
  // 注册关闭确认处理器
  attachCloseGuard(window)
  // 注册终端清理处理器
  attachTerminalCleanup(window)
  // 注册项目快照授权清理处理器
  attachProjectAccessCleanup(window)
  window.webContents.on('did-start-loading', () => {
    clearExecutionApproval(window.id)
    cancelConversationTitleJob(window.id)
    cleanupTaskWindow(window.id)
    cleanupCommandExecution(window.id)
    cleanupCommandPreparation(window.id)
  })
  window.on('closed', () => {
    clearExecutionApproval(window.id)
    clearExecutionPermissionState(window.id)
    cancelConversationTitleJob(window.id)
    discardTaskWindow(window.id)
    cleanupCommandExecution(window.id)
    cleanupCommandPreparation(window.id)
  })
  attachCommitCleanup(window)
}

export function registerAppRuntime(): void {
  registerWindowControls()
  registerTaskLifecycle()
  registerExecutionApproval()
  // 注册关闭确认处理器
  registerCloseGuard(hasChangeCommit)
  // 注册本地终端接口
  registerLocalTerminal()
  // 注册真实 Agent 请求接口
  registerExecutionContext((id) => isAgentBusy(id, isAgentPreparationActive))
  registerAgentRequest(isAgentPreparationActive)
  registerConversationTitleRequest()
  registerCommandPreparation(isLegacyCommandSourceAllowed)
  registerCommandExecution(isLegacyCommandSourceAllowed, approveStandaloneCommand)
  // 注册项目文件选择与撤销接口
  registerProjectAccess({
    isAgentJobActive: isProjectAccessBusy,
    abortProjectJob,
    onAccessChanged: onProjectAccessChanged
  })
  registerChangePreview(isChangePreviewBusy)
  registerChangePreparation(isChangePreparationBusy)
  registerChangeCommit(isChangeCommitBusy)

  registerConversationStorage(app.getPath('userData'))
  registerExternalLinks()
}
