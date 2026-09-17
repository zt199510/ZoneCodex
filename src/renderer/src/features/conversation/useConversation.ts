import { useCallback, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { getActiveConversation } from '../../../../shared/conversation-library'
import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'
import { useChatRequest, type ToolActivity } from '../chat/useChatRequest'
import { type ChatMode, type ChatEngine, resolveChatMode } from '../chat/chat-mode'
import { useProjectSelection } from '../project/useProjectSelection'
import { getCapacityError } from './capacity'
import type { ProjectSelection } from '../../../../shared/project'
import { useConversationStorage, ConversationStorage } from './useConversationStorage'
import { useOperation, Operation } from './useOperation'

export type ConversationController = {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: ChatMessage[]
  operation: Operation
  canEdit: boolean
  canSend: boolean
  canNavigate: boolean
  storage: ConversationStorage
  chatError: string | null
  create: () => Promise<boolean>
  select: (id: string) => Promise<boolean>
  clear: () => Promise<boolean>
  selectProjectFiles: () => Promise<boolean>
  revokeProjectFiles: () => Promise<boolean>
  projectSelection: ProjectSelection | null
  send: (content: string) => boolean
  stop: () => Promise<void>
  setClosePending: (value: boolean) => void
  getOperation: () => Operation
  chatMode: ChatMode
  toolActivity: ToolActivity
  engine: ChatEngine
  setEngine: (engine: ChatEngine) => Promise<boolean>
  removeFile: (path: string) => Promise<boolean>
}

export function useConversation(): ConversationController {
  const [snapshot, setSnapshot] = useState<ConversationLibrary>({
    version: 4,
    activeConversationId: null,
    conversations: []
  })
  const [closePending, setClosePendingState] = useState(false)
  const [capacityError, setCapacityError] = useState<string | null>(null)
  const closePendingRef = useRef(false)
  const setClosePending = useCallback((value: boolean): void => {
    closePendingRef.current = value
    setClosePendingState(value)
  }, [])
  const isClosePending = useCallback(() => closePendingRef.current, [])
  const operations = useOperation()
  const storage = useConversationStorage({
    snapshot,
    setSnapshot,
    operations,
    closePending,
    isClosePending
  })
  const active = getActiveConversation(snapshot)
  const messages = active?.messages ?? []

  const updateMessages = useCallback(
    (conversationId: string, update: (previous: ChatMessage[]) => ChatMessage[]): void => {
      setSnapshot((previous) => ({
        ...previous,
        conversations: previous.conversations.map((item) =>
          item.id === conversationId ? { ...item, messages: update(item.messages) } : item
        )
      }))
    },
    []
  )
  const updateConversation = useCallback(
    (conversationId: string, update: (previous: Conversation) => Conversation): void => {
      setSnapshot((previous) => ({
        ...previous,
        conversations: previous.conversations.map((item) =>
          item.id === conversationId ? update(item) : item
        )
      }))
    },
    []
  )
  const [engine, setEngineState] = useState<ChatEngine>('live')

  const {
    projectSelection,
    projectError,
    clearError: clearProjectError,
    selectProjectFiles: selectFiles,
    revokeProjectFiles,
    revokeSelectionForChange,
    removeFile
  } = useProjectSelection({
    conversationId: active?.id ?? null,
    operations,
    canChange
  })

  const chatMode = resolveChatMode(engine, projectSelection !== null)

  const request = useChatRequest({
    conversationId: active?.id ?? null,
    messages,
    updateMessages,
    updateConversation,
    toolRuns: active?.toolRuns ?? [],
    operations,
    mode: chatMode,
    projectSelection
  })

  function canChange(): boolean {
    return storage.ready && !closePendingRef.current && operations.isIdle()
  }
  async function setEngine(next: ChatEngine): Promise<boolean> {
    if (next === engine) return true
    if (!canChange()) return false
    if (next === 'stream') {
      if (!(await revokeSelectionForChange())) return false
    }
    setEngineState(next)
    setCapacityError(null)
    clearProjectError()
    request.clearError()
    return true
  }

  async function create(): Promise<boolean> {
    if (!canChange() || snapshot.conversations.length >= 100) return false
    if (!(await revokeSelectionForChange())) return false
    const id = crypto.randomUUID()
    setSnapshot((previous) => {
      if (previous.conversations.length >= 100) return previous
      return {
        ...previous,
        activeConversationId: id,
        conversations: [
          ...previous.conversations,
          {
            id,
            title: `新会话 ${previous.conversations.length + 1}`,
            messages: [],
            toolRuns: []
          }
        ]
      }
    })
    setCapacityError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  async function select(id: string): Promise<boolean> {
    if (!canChange() || !snapshot.conversations.some((item) => item.id === id)) return false
    if (!(await revokeSelectionForChange())) return false
    setSnapshot((previous) =>
      previous.activeConversationId === id
        ? previous
        : {
            ...previous,
            activeConversationId: id
          }
    )
    setCapacityError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  async function clear(): Promise<boolean> {
    if (!canChange() || !active) return false
    if (!(await revokeSelectionForChange())) return false
    updateConversation(active.id, (previous) => ({
      ...previous,
      messages: [],
      toolRuns: []
    }))
    setCapacityError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  const canNavigate = storage.ready && operations.operation === 'idle' && !closePending
  const canEdit = canNavigate && active !== null
  const savedActivity = Object.fromEntries(
    (active?.toolRuns ?? []).map((run) => [run.assistantId, run.trace])
  )
  const visibleActivity: ToolActivity = {
    ...savedActivity,
    ...request.toolActivity
  }
  return {
    conversations: snapshot.conversations,
    activeConversationId: snapshot.activeConversationId,
    messages,
    operation: operations.operation,
    canNavigate,
    canEdit,
    canSend: canEdit,
    storage,
    chatError: capacityError ?? projectError ?? request.error,
    create,
    select,
    clear,
    stop: request.stop,
    selectProjectFiles: async () => {
      if (!canChange()) return false
      if (engine === 'stream') setEngineState('live')
      request.clearError()
      return selectFiles()
    },
    revokeProjectFiles,
    projectSelection,
    setClosePending,
    getOperation: operations.getOperation,
    send: (content) => {
      if (!canChange() || !active) return false
      const capacityMessage = getCapacityError(snapshot, active, chatMode !== 'chat')
      if (capacityMessage) {
        setCapacityError(capacityMessage)
        return false
      }
      const accepted = request.send(content)
      if (accepted) setCapacityError(null)
      return accepted
    },
    chatMode,
    toolActivity: visibleActivity,
    engine,
    setEngine,
    removeFile
  }
}
