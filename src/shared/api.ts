import type { CommitRequest, CommitResult } from './change-commit'
import type { PreparationRequest, PreparationResult } from './change-preparation'
import type { SaveConversationResult } from './conversation'
import type { FileViewRequest, FileViewResult } from './file-view'
import type {
  ImageImportRequest,
  ImageImportResult,
  ImageSelectionResult,
  ImagePreviewResult,
  ImagePreparationResult
} from './image-input'
import type { WindowAction, WindowState } from './window'
import type { ConversationLibrary, LoadLibraryResult } from './conversation-library'
import type { TerminalSize, TerminalResult, TerminalEvent } from './terminal'
import type {
  AgentDelta,
  AgentResult,
  AgentProgress,
  AgentToolEvent,
  AgentMessageEvent,
  AgentRetryEvent,
  AgentContextEvent
} from './agent'
import type { ConversationTitleOutcome, ConversationTitleRequest } from './conversation-title'
import type { ProtocolItem } from './agent-history'
import type {
  AgentRequestContext,
  ProjectSelectionResult,
  WorkspaceInstructionResult,
  WorkspaceSelectionResult
} from './project'
import type { PreviewChangeRequest, PreviewChangeResult } from './change-preview'
import type {
  CommandSource,
  CommandPreparationResult,
  CommandExecutionRequest,
  CommandExecutionEvent
} from './command-preparation'
import type { TaskRecord } from './task'
import type { AppSettings, SettingsChange, TaskRootSelection } from './settings'
import type {
  ExecutionApproval,
  ExecutionInfo,
  PermissionMode,
  PermissionsState
} from './execution'
import type { AgentUserInputRequest, AgentUserInputResponse } from './agent-user-input'

// 正式聊天与 Agent 共用的流式文字增量事件。
export type StreamDelta = AgentDelta

// 应用 API 接口类型
export interface AppAPI {
  getSettings: () => Promise<AppSettings>
  updateSettings: (change: SettingsChange) => Promise<AppSettings>
  selectTaskRoot: () => Promise<TaskRootSelection>
  bindConversationDirectory: (conversationId: string) => Promise<string>
  selectImage: (conversationId: string) => Promise<ImageSelectionResult>
  importImage: (conversationId: string, request: ImageImportRequest) => Promise<ImageImportResult>
  readImagePreview: (conversationId: string, imageId: string) => Promise<ImagePreviewResult>
  prepareImage: (conversationId: string, imageId: string) => Promise<ImagePreparationResult>
  revokeImage: (conversationId: string, imageId: string) => Promise<boolean>
  revokeConversationImages: (conversationId: string) => Promise<boolean>
  readFileView: (request: FileViewRequest) => Promise<FileViewResult>
  listTasks: () => Promise<TaskRecord[]>
  cancelTask: (taskId: string) => Promise<boolean>
  onTaskState: (listener: (record: TaskRecord) => void) => () => void
  selectCommandDirectory: (
    source: CommandSource,
    operationId: string
  ) => Promise<CommandPreparationResult>
  prepareCommand: (
    source: CommandSource,
    grantId: string,
    checkId: string
  ) => Promise<CommandPreparationResult>
  releaseCommandDirectory: (grantId: string) => Promise<boolean>
  cancelCommandPreparation: (operationId: string) => Promise<boolean>
  startCommandExecution: (
    request: CommandExecutionRequest
  ) => Promise<{ status: 'started'; executionId: string } | { status: 'error'; error: string }>
  cancelCommandExecution: (executionId: string) => Promise<boolean>
  onCommandExecutionEvent: (listener: (event: CommandExecutionEvent) => void) => () => void
  commitChange: (request: CommitRequest) => Promise<CommitResult>
  cancelCommit: (commitId: string) => Promise<boolean>
  revealBackup: (recoveryId: string) => Promise<boolean>
  prepareChange: (request: PreparationRequest) => Promise<PreparationResult>
  cancelPreparation: (checkId: string) => Promise<boolean>
  controlWindow: (action: WindowAction) => Promise<void>
  getWindowState: () => Promise<WindowState>
  onWindowStateChanged: (listener: (state: WindowState) => void) => () => void
  // 监听正式聊天与 Agent 的流式增量
  onModelDelta: (listener: (event: StreamDelta) => void) => () => void
  // 加载和保存会话
  loadConversation: () => Promise<LoadLibraryResult>
  // 保存会话
  saveConversation: (snapshot: ConversationLibrary) => Promise<SaveConversationResult>
  // 监听关闭请求
  onCloseRequested: (listener: (requestId: string) => void) => () => void
  // 完成关闭操作
  finishClose: (requestId: string, allow: boolean) => Promise<boolean>
  // 终端相关接口
  startTerminal: (sessionId: string, size: TerminalSize) => Promise<TerminalResult>
  // 向终端发送数据
  writeTerminal: (sessionId: string, data: string) => Promise<TerminalResult>
  // 调整终端大小
  resizeTerminal: (sessionId: string, size: TerminalSize) => Promise<TerminalResult>
  // 关闭终端
  closeTerminal: (sessionId: string) => Promise<TerminalResult>
  // 监听终端事件
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
  // 真实 Agent 请求接口
  resolveAgentExecution: (context: AgentRequestContext) => Promise<ExecutionInfo>
  getExecutionPermissions: () => Promise<PermissionsState>
  setExecutionPermissions: (mode: PermissionMode) => Promise<PermissionsState>
  getPendingExecutionApproval: () => Promise<ExecutionApproval | null>
  respondToExecutionApproval: (approvalId: string, approved: boolean) => Promise<boolean>
  onExecutionApprovalChange: (listener: (approval: ExecutionApproval | null) => void) => () => void
  getPendingAgentUserInput: () => Promise<AgentUserInputRequest | null>
  respondToAgentUserInput: (response: AgentUserInputResponse) => Promise<boolean>
  onAgentUserInputChange: (listener: (request: AgentUserInputRequest | null) => void) => () => void
  startAgentRequest: (
    requestId: string,
    prompt: string,
    history: ProtocolItem[],
    context: AgentRequestContext,
    taskId?: string
  ) => Promise<AgentResult>
  // 由主进程校验并在系统外部浏览器中打开 http/https 地址。
  openExternal: (url: string) => Promise<boolean>
  // 选择当前窗口与会话绑定的项目文件快照
  selectProjectFiles: (
    conversationId: string,
    replaceExisting?: boolean
  ) => Promise<ProjectSelectionResult>
  removeProjectFile: (
    conversationId: string,
    snapshotId: string,
    path: string
  ) => Promise<ProjectSelectionResult>
  // 选择、清除和读取当前会话的工作区；运行时目录授权只存在于主进程。
  selectWorkspace: (
    conversationId: string,
    operationId: string
  ) => Promise<WorkspaceSelectionResult>
  clearWorkspace: (conversationId: string) => Promise<boolean>
  readWorkspaceInstruction: (conversationId: string) => Promise<WorkspaceInstructionResult>
  // 从当前已授权快照生成只读修改预览
  previewChange: (request: PreviewChangeRequest) => Promise<PreviewChangeResult>
  // 撤销当前窗口的指定项目快照授权
  revokeProjectFiles: (snapshotId: string) => Promise<boolean>
  // 取消真实 Agent 请求
  cancelAgentRequest: (requestId: string) => Promise<boolean>
  // 监听 Agent 进度事件
  onAgentProgress: (listener: (event: AgentProgress) => void) => () => void
  onAgentToolEvent: (listener: (event: AgentToolEvent) => void) => () => void
  onAgentMessageEvent: (listener: (event: AgentMessageEvent) => void) => () => void
  onAgentRetryEvent: (listener: (event: AgentRetryEvent) => void) => () => void
  onAgentContextEvent: (listener: (event: AgentContextEvent) => void) => () => void
  // 生成会话元数据标题；结果不进入聊天消息、工具记录或任务记录
  generateConversationTitle: (
    request: ConversationTitleRequest
  ) => Promise<ConversationTitleOutcome>
  cancelConversationTitle: (requestId: string) => Promise<boolean>
}
