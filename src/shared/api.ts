import type { SaveConversationResult } from './conversation'
import type { WindowAction, WindowState } from './window'
import type { ConversationLibrary, LoadLibraryResult } from './conversation-library'
import type { TerminalSize, TerminalResult, TerminalEvent } from './terminal'
import type { AgentMode, AgentResult, AgentProgress } from './agent'
import type { ProtocolItem } from './agent-history'
import type { AgentContext, ProjectSelectionResult } from './project'

// 模型消息类型
export type ModelMessage = {
  role: 'user' | 'assistant'
  content: string
}

// 模型回复类型
export type ModelReply = { ok: true; content: string } | { ok: false; error: string }

// 模型流增量事件
export type ModelStreamDelta = { requestId: string; delta: string }
// 模型请求结果类型
export type ModelStreamResult =
  { status: 'done' | 'cancelled' } | { status: 'error'; error: string }

// 应用 API 接口类型
export interface AppAPI {
  controlWindow: (action: WindowAction) => Promise<void>
  getWindowState: () => Promise<WindowState>
  onWindowStateChanged: (listener: (state: WindowState) => void) => () => void
  // 向模型发送消息并获取回复
  askModel: (history: ModelMessage[]) => Promise<ModelReply>
  // 模型流相关接口
  startModelStream: (requestId: string, history: ModelMessage[]) => Promise<ModelStreamResult>
  // 取消模型流请求
  cancelModelStream: (requestId: string) => Promise<void>
  // 监听模型流增量事件
  onModelDelta: (listener: (event: ModelStreamDelta) => void) => () => void
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
  // 练习工具相关接口
  startAgentPractice: (
    requestId: string,
    prompt: string,
    mode: AgentMode,
    history?: ProtocolItem[],
    context?: AgentContext
  ) => Promise<AgentResult>
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
  // 撤销当前窗口的指定项目快照授权
  revokeProjectFiles: (snapshotId: string) => Promise<boolean>
  //  取消练习工具任务
  cancelAgentPractice: (requestId: string) => Promise<boolean>
  // 监听练习工具进度事件
  onAgentProgress: (listener: (event: AgentProgress) => void) => () => void
}
