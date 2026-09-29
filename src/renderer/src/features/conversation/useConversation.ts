import { useChangeCommit, type CommitController } from '../review/useChangeCommit'
import {
  deriveMessageCommandProposal,
  type MessageCommandProposal
} from '../../../../shared/command-proposal'
import { useCommandReview } from '../review/useCommandReview'
import { useChangePreparation, type PreparationController } from '../review/useChangePreparation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { deriveMessageChangeProposal } from '../../../../shared/change-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import {
  createConversationTitle,
  getActiveConversation,
  isPlaceholderConversationTitle,
  maxConversationTitleLength
} from '../../../../shared/conversation-library'
import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'
import { useChatRequest, type AcceptedChatRequest, type ToolActivity } from '../chat/useChatRequest'
import { type ChatMode, resolveChatMode } from '../chat/chat-mode'
import { useProjectSelection } from '../project/useProjectSelection'
import { getCapacityError } from './capacity'
import type { ProjectSelection, SavedWorkspace } from '../../../../shared/project'
import { isTerminalTaskStatus, maxTaskRecords } from '../../../../shared/task'
import { useConversationStorage, ConversationStorage } from './useConversationStorage'
import { useOperation, Operation } from './useOperation'
import { useChangePreview, type ChangePreviewController } from '../review/useChangePreview'
import { useWorkspace, type WorkspaceController } from '../project/useWorkspace'

export type ChangeProposalStatus = 'available' | 'stale'

function proposalKey(proposal: MessageChangeProposal): string {
  return `${proposal.conversationId}\u0000${proposal.requestId}\u0000${proposal.callId}`
}

export type ConversationController = {
  commandProposals: Readonly<Record<string, MessageCommandProposal>>
  commandReview: ReturnType<typeof useCommandReview>
  conversations: Conversation[]
  visibleConversations: Conversation[]
  activeConversationId: string | null
  messages: ChatMessage[]
  canRetryMessage: (messageId: string) => boolean
  retryMessage: (messageId: string) => boolean
  operation: Operation
  canEdit: boolean
  canSend: boolean
  canNavigate: boolean
  storage: ConversationStorage
  chatError: string | null
  create: () => Promise<boolean>
  select: (id: string) => Promise<boolean>
  rename: (id: string, title: string) => boolean
  togglePinned: (id: string) => boolean
  archive: (id: string) => Promise<boolean>
  restore: (id: string) => Promise<boolean>
  search: string
  setSearch: (value: string) => void
  clear: () => Promise<boolean>
  selectProjectFiles: () => Promise<boolean>
  revokeProjectFiles: () => Promise<boolean>
  projectSelection: ProjectSelection | null
  contextSelection: ProjectSelection | null
  workspace: WorkspaceController
  send: (content: string) => boolean
  editAndSend: (messageId: string, content: string) => boolean
  stop: () => Promise<void>
  setClosePending: (value: boolean) => void
  getOperation: () => Operation
  chatMode: ChatMode
  toolActivity: ToolActivity
  removeFile: (path: string) => Promise<boolean>
  commit: CommitController
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
    version: 5,
    activeConversationId: null,
    conversations: []
  })
  const [closePending, setClosePendingState] = useState(false)
  const [capacityError, setCapacityError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const closePendingRef = useRef(false)
  const hiddenProposalKeysRef = useRef(new Set<string>())
  const [hiddenProposalKeys, setHiddenProposalKeys] = useState<ReadonlySet<string>>(new Set())
  const [openedProposal, setOpenedProposal] = useState<MessageChangeProposal | null>(null)
  const reconciledTasks = useRef(false)
  type TitleJob = {
    requestId: string
    conversationId: string
    messageId: string
    generation: number
    fallbackTitle: string
  }
  const titleJobsRef = useRef(new Map<string, TitleJob>())
  const titleGenerationRef = useRef(new Map<string, number>())
  const manuallyRenamedRef = useRef(new Set<string>())

  const invalidateTitle = useCallback((conversationId: string): void => {
    const generation = (titleGenerationRef.current.get(conversationId) ?? 0) + 1
    titleGenerationRef.current.set(conversationId, generation)
    const job = titleJobsRef.current.get(conversationId)
    if (!job) return
    titleJobsRef.current.delete(conversationId)
    void Promise.resolve()
      .then(() => window.api.cancelConversationTitle(job.requestId))
      .catch(() => undefined)
  }, [])

  useEffect(
    () => () => {
      for (const [conversationId, job] of titleJobsRef.current) {
        titleGenerationRef.current.set(
          conversationId,
          (titleGenerationRef.current.get(conversationId) ?? job.generation) + 1
        )
        void Promise.resolve()
          .then(() => window.api.cancelConversationTitle(job.requestId))
          .catch(() => undefined)
      }
      titleJobsRef.current.clear()
    },
    []
  )
  const setClosePending = useCallback(
    (value: boolean): void => {
      if (value) {
        for (const conversationId of titleJobsRef.current.keys()) {
          invalidateTitle(conversationId)
        }
      }
      closePendingRef.current = value
      setClosePendingState(value)
    },
    [invalidateTitle]
  )
  const isClosePending = useCallback(() => closePendingRef.current, [])
  const operations = useOperation()
  const storage = useConversationStorage({
    snapshot,
    setSnapshot,
    operations,
    closePending,
    isClosePending
  })
  useEffect(() => {
    if (!storage.ready || reconciledTasks.current) return
    let disposed = false
    async function reconcileTasks(): Promise<void> {
      const liveTasks = await window.api.listTasks()
      if (disposed) return
      const liveById = new Map(liveTasks.map((task) => [task.taskId, task]))
      setSnapshot((previous) => ({
        ...previous,
        conversations: previous.conversations.map((conversation) => {
          const merged = conversation.tasks.map((task) => {
            const live = liveById.get(task.taskId)
            if (live && live.conversationId === conversation.id) return live
            if (
              !isTerminalTaskStatus(task.status) &&
              (!live || live.conversationId !== conversation.id)
            ) {
              return {
                ...task,
                status: 'interrupted' as const,
                finishedAt: new Date().toISOString(),
                error: '页面重新加载，旧任务未继续运行'
              }
            }
            return task
          })
          const known = new Set(merged.map((task) => task.taskId))
          for (const task of liveTasks) {
            if (task.conversationId === conversation.id && !known.has(task.taskId)) {
              merged.push(task)
            }
          }
          return { ...conversation, tasks: merged.slice(-maxTaskRecords) }
        })
      }))
      reconciledTasks.current = true
    }
    void reconcileTasks()
    return () => {
      disposed = true
    }
  }, [storage.ready])
  const active = getActiveConversation(snapshot)
  const messages = active?.messages ?? []
  const canChange = useCallback(
    () => storage.ready && !closePendingRef.current && operations.isIdle(),
    [operations, storage.ready]
  )
  const canSubmitBase =
    storage.ready &&
    operations.operation === 'idle' &&
    !closePending &&
    !capacityError &&
    (active !== null || snapshot.conversations.length < 100)

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
  const activeConversationId = active?.id ?? null
  const workspace = useWorkspace({
    conversationId: activeConversationId,
    saved: active?.workspace ?? null,
    operations,
    canChange,
    onSavedChange: (next: SavedWorkspace | null): void => {
      if (!activeConversationId) return
      updateConversation(activeConversationId, (previous) => ({ ...previous, workspace: next }))
    }
  })
  // Persisted workspace metadata is only a display record. After a reload,
  // the directory grant must be selected again before sending with it.
  const canSubmit = canSubmitBase && (!active?.workspace || workspace.runtime !== null)
  const {
    projectSelection,
    pendingSelection,
    markSent,
    forgetSnapshot,
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
  const commandProposals: Record<string, MessageCommandProposal> = {}
  for (const run of active?.toolRuns ?? []) {
    const proposal = deriveMessageCommandProposal(
      active!.id,
      run,
      messages.find((message) => message.id === run.userId),
      messages.find((message) => message.id === run.assistantId)
    )
    if (proposal) commandProposals[proposal.assistantId] = proposal
  }
  const commandReview = useCommandReview(
    commandProposals,
    projectSelection?.snapshotId ?? null,
    storage.ready &&
      operations.operation === 'idle' &&
      !closePending &&
      changePreview.state.status === 'idle'
  )
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

  const commit = useChangeCommit(
    active?.id ?? null,
    preparation.available && preparation.state.status === 'ready' ? preparation.state : null,
    operations,
    canChange,
    (snapshotId, clearGrant) => {
      preparation.cancel()
      if (clearGrant) forgetSnapshot(snapshotId)
    }
  )

  const chatMode = resolveChatMode(projectSelection !== null)

  const request = useChatRequest({
    conversationId: active?.id ?? null,
    messages,
    updateMessages,
    updateConversation,
    toolRuns: active?.toolRuns ?? [],
    operations,
    mode: chatMode,
    projectSelection,
    workspace: workspace.runtime
  })

  function startTitleGeneration(accepted: AcceptedChatRequest, fallbackTitle: string): void {
    if (manuallyRenamedRef.current.has(accepted.conversationId)) return
    invalidateTitle(accepted.conversationId)
    const generation = titleGenerationRef.current.get(accepted.conversationId) ?? 0
    const job: TitleJob = {
      requestId: crypto.randomUUID(),
      conversationId: accepted.conversationId,
      messageId: accepted.messageId,
      generation,
      fallbackTitle
    }
    titleJobsRef.current.set(job.conversationId, job)
    void Promise.resolve()
      .then(() =>
        window.api.generateConversationTitle({
          requestId: job.requestId,
          conversationId: job.conversationId,
          messageId: job.messageId,
          content: accepted.content
        })
      )
      .then((result) => {
        if (titleJobsRef.current.get(job.conversationId) !== job) return
        if (
          result.status !== 'done' ||
          result.requestId !== job.requestId ||
          result.conversationId !== job.conversationId ||
          result.messageId !== job.messageId ||
          titleGenerationRef.current.get(job.conversationId) !== job.generation
        ) {
          titleJobsRef.current.delete(job.conversationId)
          return
        }
        setSnapshot((previous) => {
          const conversation = previous.conversations.find((item) => item.id === job.conversationId)
          const first = conversation?.messages.find((message) => message.role === 'user')
          if (
            !conversation ||
            conversation.archived ||
            manuallyRenamedRef.current.has(job.conversationId) ||
            conversation.title !== job.fallbackTitle ||
            !first ||
            first.role !== 'user' ||
            first.id !== job.messageId ||
            first.content !== accepted.content ||
            titleGenerationRef.current.get(job.conversationId) !== job.generation
          ) {
            return previous
          }
          return {
            ...previous,
            conversations: previous.conversations.map((item) =>
              item.id === job.conversationId ? { ...item, title: result.title } : item
            )
          }
        })
        titleJobsRef.current.delete(job.conversationId)
      })
      .catch(() => {
        if (titleJobsRef.current.get(job.conversationId) === job) {
          titleJobsRef.current.delete(job.conversationId)
        }
      })
  }

  const canRetryMessage = useCallback(
    (messageId: string): boolean => {
      if (!active || !canSubmit) return false
      const message = active.messages.find((item) => item.id === messageId)
      if (
        !message ||
        message.role !== 'assistant' ||
        (message.status !== 'failed' && message.status !== 'cancelled')
      )
        return false
      return request.canRetry(messageId)
    },
    [active, canSubmit, request]
  )

  const retryMessage = useCallback(
    (messageId: string): boolean => {
      if (!canRetryMessage(messageId)) return false
      const accepted = request.retry(messageId)
      if (accepted) markSent()
      return accepted
    },
    [canRetryMessage, markSent, request]
  )

  const editAndSend = useCallback(
    (messageId: string, rawContent: string): boolean => {
      if (!active || !canSubmit) return false
      const content = rawContent.trim()
      const index = active.messages.findIndex(
        (message) => message.id === messageId && message.role === 'user'
      )
      if (
        index < 0 ||
        !content ||
        active.messages.slice(index + 1).some((message) => message.role === 'user')
      ) {
        return false
      }
      const trimmedMessages = active.messages.slice(0, index)
      const keptIds = new Set(trimmedMessages.map((message) => message.id))
      const trimmedToolRuns = active.toolRuns.filter(
        (run) => keptIds.has(run.userId) && keptIds.has(run.assistantId)
      )
      const trimmedActive = { ...active, messages: trimmedMessages, toolRuns: trimmedToolRuns }
      const nextSnapshot = {
        ...snapshot,
        conversations: snapshot.conversations.map((conversation) =>
          conversation.id === active.id ? trimmedActive : conversation
        )
      }
      const capacityMessage = getCapacityError(nextSnapshot, trimmedActive, true)
      if (capacityMessage) {
        setCapacityError(capacityMessage)
        return false
      }
      preparation.cancel()
      commandReview.close()
      setCapacityError(null)
      setSnapshot(nextSnapshot)
      const accepted = request.send(content, trimmedMessages, trimmedToolRuns, undefined, undefined, undefined, workspace.runtime)
      if (accepted) markSent()
      return accepted
    },
    [active, canSubmit, commandReview, markSent, preparation, request, snapshot, workspace]
  )

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
    if (commit.isActive()) {
      commit.requestCancel()
      return false
    }
    preparation.cancel()
    setOpenedProposal(null)
    return changePreview.discard()
  }, [changePreview, preparation, commit])

  const discardProposal = useCallback((): boolean => {
    if (commit.isActive()) {
      commit.requestCancel()
      return false
    }
    preparation.cancel()
    const proposal = openedProposal
    const discarded = changePreview.discard()
    if (discarded && proposal) {
      hiddenProposalKeysRef.current.add(proposalKey(proposal))
      setHiddenProposalKeys(new Set(hiddenProposalKeysRef.current))
    }
    setOpenedProposal(null)
    return discarded
  }, [changePreview, preparation, openedProposal, commit])
  async function create(): Promise<boolean> {
    if (!canChange() || snapshot.conversations.length >= 100) return false
    if (!(await revokeSelectionForChange())) return false
    if (active) {
      if (!(await workspace.release())) return false
      invalidateTitle(active.id)
    }
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
            pinned: false,
            archived: false,
            messages: [],
            toolRuns: [],
            workspace: null,
            tasks: []
          }
        ]
      }
    })
    setCapacityError(null)
    setConversationError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  async function select(id: string): Promise<boolean> {
    if (!canChange() || !snapshot.conversations.some((item) => item.id === id && !item.archived)) {
      setConversationError('当前会话正在忙碌，或目标会话已归档。')
      return false
    }
    if (id === active?.id) return true
    if (active && !(await workspace.release())) return false
    if (!(await revokeSelectionForChange())) return false
    if (active) invalidateTitle(active.id)
    setSnapshot((previous) =>
      previous.activeConversationId === id
        ? previous
        : {
            ...previous,
            activeConversationId: id
          }
    )
    setCapacityError(null)
    setConversationError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  function rename(id: string, rawTitle: string): boolean {
    if (!canChange()) {
      setConversationError('生成、保存或关闭保护期间不能修改会话。')
      return false
    }
    const title = rawTitle.trim()
    if (!title) {
      setConversationError('会话标题不能为空。')
      return false
    }
    if (title.length > maxConversationTitleLength) {
      setConversationError(`会话标题不能超过 ${maxConversationTitleLength} 个字符。`)
      return false
    }
    if (!snapshot.conversations.some((item) => item.id === id)) return false
    manuallyRenamedRef.current.add(id)
    invalidateTitle(id)
    updateConversation(id, (conversation) => ({ ...conversation, title }))
    setConversationError(null)
    return true
  }

  function togglePinned(id: string): boolean {
    if (!canChange()) {
      setConversationError('生成、保存或关闭保护期间不能修改会话。')
      return false
    }
    if (!snapshot.conversations.some((item) => item.id === id)) return false
    updateConversation(id, (conversation) => ({ ...conversation, pinned: !conversation.pinned }))
    setConversationError(null)
    return true
  }

  async function archive(id: string): Promise<boolean> {
    if (!canChange()) {
      setConversationError('生成、保存或关闭保护期间不能修改会话。')
      return false
    }
    const target = snapshot.conversations.find((item) => item.id === id)
    if (!target || target.archived) return false
    if (id === active?.id) {
      if (!(await workspace.release())) return false
      if (!(await revokeSelectionForChange())) return false
    }
    invalidateTitle(id)
    setSnapshot((previous) => {
      const nextActive =
        previous.activeConversationId === id
          ? (previous.conversations.find((item) => item.id !== id && !item.archived)?.id ?? null)
          : previous.activeConversationId
      return {
        ...previous,
        activeConversationId: nextActive,
        conversations: previous.conversations.map((item) =>
          item.id === id ? { ...item, archived: true } : item
        )
      }
    })
    if (id === active?.id) setCapacityError(null)
    setConversationError(null)
    request.clearError()
    request.clearActivity()
    return true
  }

  async function restore(id: string): Promise<boolean> {
    if (!canChange()) {
      setConversationError('生成、保存或关闭保护期间不能修改会话。')
      return false
    }
    if (!snapshot.conversations.some((item) => item.id === id && item.archived)) return false
    if (active && !(await workspace.release())) return false
    if (id !== active?.id && !(await revokeSelectionForChange())) return false
    invalidateTitle(id)
    setSnapshot((previous) => ({
      ...previous,
      activeConversationId: id,
      conversations: previous.conversations.map((item) =>
        item.id === id ? { ...item, archived: false } : item
      )
    }))
    setCapacityError(null)
    setConversationError(null)
    request.clearError()
    request.clearActivity()
    return true
  }

  async function clear(): Promise<boolean> {
    if (!canChange() || !active) return false
    if (!(await revokeSelectionForChange())) return false
    invalidateTitle(active.id)
    updateConversation(active.id, (previous) => ({
      ...previous,
      messages: [],
      toolRuns: [],
      tasks: []
    }))
    setCapacityError(null)
    setConversationError(null)
    clearProjectError()
    request.clearError()
    request.clearActivity()
    return true
  }

  const canNavigate = storage.ready && operations.operation === 'idle' && !closePending
  const canEdit = canNavigate && active !== null
  // 满容量的新会话无法再创建；容量检查失败后也要让所有提交入口保持拒绝，
  // 直到用户新建、清理或归档记录后由对应操作清除错误。
  const canSend = canSubmit
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleConversations = normalizedSearch
    ? snapshot.conversations.filter((conversation) => {
        const haystack = [
          conversation.title,
          ...conversation.messages.map((message) => message.content)
        ]
          .join('\n')
          .toLocaleLowerCase()
        return haystack.includes(normalizedSearch)
      })
    : snapshot.conversations
  const savedActivity = Object.fromEntries(
    (active?.toolRuns ?? []).map((run) => [run.assistantId, run.trace])
  )
  const visibleActivity: ToolActivity = {
    ...savedActivity,
    ...request.toolActivity
  }
  return {
    commandProposals,
    commandReview,
    conversations: snapshot.conversations,
    activeConversationId: snapshot.activeConversationId,
    messages,
    canRetryMessage,
    retryMessage,
    operation: operations.operation,
    canNavigate,
    canEdit,
    canSend,
    storage,
    chatError: conversationError ?? capacityError ?? projectError ?? request.error,
    create,
    select,
    rename,
    togglePinned,
    archive,
    restore,
    search,
    setSearch: (value) => setSearch(value),
    visibleConversations,
    clear,
    stop: async () => {
      if (active) invalidateTitle(active.id)
      await request.stop()
    },
    selectProjectFiles: async () => {
      if (!canChange()) return false
      request.clearError()
      return selectFiles()
    },
    revokeProjectFiles,
    projectSelection: pendingSelection,
    contextSelection: projectSelection,
    workspace,
    setClosePending,
    getOperation: operations.getOperation,
    send: (content) => {
      if (!canSubmit) return false
      if (!active && snapshot.conversations.length >= 100) {
        setCapacityError('会话数量已达到上限，请整理已有会话后再发送。')
        return false
      }
      const target =
        active ??
        (() => {
          const id = crypto.randomUUID()
          return {
            id,
            title: `新会话 ${snapshot.conversations.length + 1}`,
            pinned: false,
            archived: false,
            messages: [],
            toolRuns: [],
            workspace: null,
            tasks: []
          }
        })()
      const nextSnapshot = active
        ? snapshot
        : {
            ...snapshot,
            activeConversationId: target.id,
            conversations: [...snapshot.conversations, target]
          }
      const capacityMessage = getCapacityError(nextSnapshot, target, true)
      if (capacityMessage) {
        setCapacityError(capacityMessage)
        return false
      }
      preparation.cancel()
      if (!active) setSnapshot(nextSnapshot)
      const hadUserMessage = target.messages.some((message) => message.role === 'user')
      const fallbackTitle =
        !hadUserMessage && isPlaceholderConversationTitle(target.title)
          ? createConversationTitle(content)
          : ''
      const accepted = request.send(
        content,
        target.messages,
        target.toolRuns,
        target.id,
        undefined,
        undefined,
        workspace.runtime,
        fallbackTitle
          ? (acceptedRequest) => startTitleGeneration(acceptedRequest, fallbackTitle)
          : undefined
      )
      if (!accepted && !active) setSnapshot(snapshot)
      if (accepted) {
        if (fallbackTitle) {
          updateConversation(target.id, (conversation) =>
            isPlaceholderConversationTitle(conversation.title)
              ? { ...conversation, title: fallbackTitle }
              : conversation
          )
        }
        commandReview.close()
        setCapacityError(null)
        setConversationError(null)
        markSent()
      }
      return accepted
    },
    editAndSend,
    chatMode,
    toolActivity: visibleActivity,
    removeFile,
    preparation,
    commit,
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
