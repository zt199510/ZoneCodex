import { useChangePreparation, type PreparationController } from '../review/useChangePreparation'
import { useCallback, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { deriveMessageChangeProposal } from '../../../../shared/change-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import { getActiveConversation } from '../../../../shared/conversation-library'
import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'
import { useChatRequest, type ToolActivity } from '../chat/useChatRequest'
import { type ChatMode, type ChatEngine, resolveChatMode } from '../chat/chat-mode'
import { useProjectSelection } from '../project/useProjectSelection'
import { getCapacityError } from './capacity'
import type { ProjectSelection } from '../../../../shared/project'
import { useConversationStorage, ConversationStorage } from './useConversationStorage'
import { useOperation, Operation } from './useOperation'
import { useChangePreview, type ChangePreviewController } from '../review/useChangePreview'

export type ChangeProposalStatus = 'available' | 'stale'

function proposalKey(proposal: MessageChangeProposal): string {
  return `${proposal.conversationId}\u0000${proposal.requestId}\u0000${proposal.callId}`
}

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
  contextSelection: ProjectSelection | null
  send: (content: string) => boolean
  stop: () => Promise<void>
  setClosePending: (value: boolean) => void
  getOperation: () => Operation
  chatMode: ChatMode
  toolActivity: ToolActivity
  engine: ChatEngine
  setEngine: (engine: ChatEngine) => Promise<boolean>
  removeFile: (path: string) => Promise<boolean>
  preparation: PreparationController
  changePreview: ChangePreviewController
  changeProposals: Readonly<Record<string, MessageChangeProposal>>
  changeProposalStatus: Readonly<Record<string, ChangeProposalStatus>>
  openProposal: (proposal: MessageChangeProposal) => Promise<boolean>
  closePreview: () => boolean
  discardProposal: () => boolean
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
  const hiddenProposalKeysRef = useRef(new Set<string>())
  const [hiddenProposalKeys, setHiddenProposalKeys] = useState<ReadonlySet<string>>(new Set())
  const [openedProposal, setOpenedProposal] = useState<MessageChangeProposal | null>(null)
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
  const canChange = useCallback(
    () => storage.ready && !closePendingRef.current && operations.isIdle(),
    [operations, storage.ready]
  )

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
    pendingSelection,
    markSent,
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

  const changePreview = useChangePreview({
    conversationId: active?.id ?? null,
    selection: projectSelection,
    operations,
    canChange
  })

  const changeProposals: Record<string, MessageChangeProposal> = {}
  const changeProposalStatus: Record<string, ChangeProposalStatus> = {}
  if (active) {
    for (const run of active.toolRuns) {
      const proposal = deriveMessageChangeProposal(
        active.id,
        run,
        messages.find((message) => message.id === run.userId),
        messages.find((message) => message.id === run.assistantId)
      )
      if (!proposal || hiddenProposalKeys.has(proposalKey(proposal))) continue
      changeProposals[proposal.assistantId] = proposal
      changeProposalStatus[proposal.assistantId] =
        projectSelection?.snapshotId === proposal.snapshotId &&
        projectSelection.files.some((file) => file.path === proposal.path)
          ? 'available'
          : 'stale'
    }
  }

  const preview = changePreview.state.status === 'ready' ? changePreview.state.preview : null
  const source = openedProposal && changeProposals[openedProposal.assistantId]
  const preparation = useChangePreparation(
    source &&
      preview &&
      active?.id === source.conversationId &&
      changeProposalStatus[source.assistantId] === 'available' &&
      source.path === preview.path &&
      source.snapshotId === preview.snapshotId &&
      source.proposedText === preview.after &&
      source.requestId === openedProposal?.requestId &&
      source.callId === openedProposal?.callId
      ? {
          conversationId: source.conversationId,
          snapshotId: source.snapshotId,
          path: source.path,
          proposedText: source.proposedText,
          requestId: source.requestId,
          callId: source.callId
        }
      : null,
    operations,
    canChange
  )

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

  async function openProposal(proposal: MessageChangeProposal): Promise<boolean> {
    if (
      hiddenProposalKeysRef.current.has(proposalKey(proposal)) ||
      !active ||
      active.id !== proposal.conversationId ||
      !projectSelection ||
      projectSelection.snapshotId !== proposal.snapshotId ||
      !projectSelection.files.some((file) => file.path === proposal.path) ||
      !canChange()
    ) {
      return false
    }
    const current = changeProposals[proposal.assistantId]
    if (
      !current ||
      current.requestId !== proposal.requestId ||
      current.callId !== proposal.callId ||
      current.path !== proposal.path ||
      current.proposedText !== proposal.proposedText
    ) {
      return false
    }

    preparation.cancel()
    setOpenedProposal(null)
    const opened = await changePreview.requestPreview(proposal.path, proposal.proposedText)
    if (opened) setOpenedProposal(proposal)
    return opened
  }

  const closePreview = useCallback((): boolean => {
    preparation.cancel()
    setOpenedProposal(null)
    return changePreview.discard()
  }, [changePreview, preparation, openedProposal])

  const discardProposal = useCallback((): boolean => {
    preparation.cancel()
    const proposal = openedProposal
    const discarded = changePreview.discard()
    if (discarded && proposal) {
      hiddenProposalKeysRef.current.add(proposalKey(proposal))
      setHiddenProposalKeys(new Set(hiddenProposalKeysRef.current))
    }
    setOpenedProposal(null)
    return discarded
  }, [changePreview, preparation, openedProposal])
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
    if (id === active?.id) return true
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
    projectSelection: pendingSelection,
    contextSelection: projectSelection,
    setClosePending,
    getOperation: operations.getOperation,
    send: (content) => {
      if (!canChange() || !active) return false
      const capacityMessage = getCapacityError(snapshot, active, chatMode !== 'chat')
      if (capacityMessage) {
        setCapacityError(capacityMessage)
        return false
      }
      preparation.cancel()
      const accepted = request.send(content)
      if (accepted) {
        setCapacityError(null)
        markSent()
      }
      return accepted
    },
    chatMode,
    toolActivity: visibleActivity,
    engine,
    setEngine,
    removeFile,
    preparation,
    changePreview: {
      ...changePreview,
      requestPreview: async (path, proposedText) => {
        if (!canChange()) return false
        preparation.cancel()
        setOpenedProposal(null)
        return changePreview.requestPreview(path, proposedText)
      }
    },
    changeProposals,
    changeProposalStatus,
    openProposal,
    closePreview,
    discardProposal
  }
}
