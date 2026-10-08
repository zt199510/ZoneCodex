import { useCallback, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { getMessageImages } from '../../../../shared/conversation'
import type { ToolRun } from '../../../../shared/agent-history'
import {
  createConversationTitle,
  getActiveConversation,
  isPlaceholderConversationTitle,
  maxConversationTitleLength
} from '../../../../shared/conversation-library'
import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'
import { useChatRequest, type ToolActivity } from '../chat/useChatRequest'
import { useProjectSelection } from '../project/useProjectSelection'
import { useImageSelection, type ImageSelectionController } from '../project/useImageSelection'
import {
  appendImageTurnNotice,
  hasImageTurnNotice,
  stripImageTurnNotice
} from '../../../../shared/image-input'
import { getCapacityError } from './capacity'
import type { ProjectSelection, SavedWorkspace } from '../../../../shared/project'
import { useConversationStorage, type ConversationStorage } from './useConversationStorage'
import { useOperation, type Operation } from './useOperation'
import { useWorkspace, type WorkspaceController } from '../project/useWorkspace'
import {
  useExecutionPermissions,
  type ExecutionPermissionsController
} from '../execution/useExecutionPermissions'
import { useConversationTitle } from './useConversationTitle'
import { useConversationTasks } from './useConversationTasks'
import {
  useConversationReview,
  type ConversationReviewController
} from '../review/useConversationReview'

export type ConversationController = ConversationReviewController & {
  conversations: Conversation[]
  visibleConversations: Conversation[]
  activeConversationId: string | null
  draftInheritanceTarget: string | null
  messages: ChatMessage[]
  canRetryMessage: (messageId: string) => boolean
  retryMessage: (messageId: string) => boolean | Promise<boolean>
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
  executionPermissions: ExecutionPermissionsController
  images: ImageSelectionController
  send: (content: string) => boolean | Promise<boolean>
  editAndSend: (messageId: string, content: string) => boolean | Promise<boolean>
  stop: () => Promise<void>
  setClosePending: (value: boolean) => void
  getOperation: () => Operation
  toolActivity: ToolActivity
  toolRuns: readonly ToolRun[]
  removeFile: (path: string) => Promise<boolean>
}

export function useConversation(): ConversationController {
  const [snapshot, setSnapshot] = useState<ConversationLibrary>({
    version: 6,
    activeConversationId: null,
    conversations: []
  })
  const [closePending, setClosePendingState] = useState(false)
  const [capacityError, setCapacityError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draftInheritanceTarget, setDraftInheritanceTarget] = useState<string | null>(null)
  const closePendingRef = useRef(false)
  const {
    invalidate: invalidateTitle,
    invalidateAll: invalidateTitles,
    markRenamed: markRenamedTitle,
    start: startTitleGeneration
  } = useConversationTitle(setSnapshot)
  const setClosePending = useCallback(
    (value: boolean): void => {
      if (value) invalidateTitles()
      closePendingRef.current = value
      setClosePendingState(value)
    },
    [invalidateTitles]
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
  useConversationTasks(storage.ready, setSnapshot)
  const active = getActiveConversation(snapshot)
  const messages = active?.messages ?? []
  const canChange = useCallback(
    () => storage.ready && !closePendingRef.current && operations.isIdle(),
    [operations, storage.ready]
  )
  const executionPermissions = useExecutionPermissions(operations, canChange)
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
  // Saved project metadata does not restore a grant. Without a live project,
  // main resolves this request against the conversation's default directory.
  const canSubmit =
    canSubmitBase && executionPermissions.state !== null && !executionPermissions.loading
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
  const images = useImageSelection({
    conversationId: activeConversationId,
    messages,
    operations,
    canChange,
    ensureConversation: async () => activeConversationId ?? createId(true)
  })

  const {
    commandProposals,
    commandReview,
    changePreview,
    preparation,
    commit,
    changeProposals,
    changeProposalStatus,
    openProposal,
    closePreview,
    discardProposal
  } = useConversationReview({
    active,
    projectSelection,
    operations,
    canChange,
    ready: storage.ready,
    closePending,
    forgetSnapshot
  })

  const request = useChatRequest({
    conversationId: active?.id ?? null,
    messages,
    updateMessages,
    updateConversation,
    toolRuns: active?.toolRuns ?? [],
    operations,
    projectSelection,
    workspace: workspace.runtime,
    getPermissions: executionPermissions.getState,
    observeExecution: executionPermissions.observe,
    isImageAvailable: images.isAvailable,
    getImageDescriptor: (imageId) => images.getImage(imageId)?.image ?? null,
    onImagesAccepted: (messageId, imageIds) => {
      const group = imageIds.flatMap((imageId) => {
        const image = images.getImage(imageId)
        return image ? [image] : []
      })
      if (group.length === imageIds.length) images.bind(messageId, group)
    }
  })

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
    (messageId: string): boolean | Promise<boolean> => {
      if (!canRetryMessage(messageId)) return false
      const submit = (): boolean => {
        const accepted = request.retry(messageId)
        if (accepted) markSent()
        return accepted
      }
      const imageIds = request.getRetryImages(messageId)
      if (!imageIds.length) return submit()
      const group = imageIds.flatMap((imageId) => {
        const image = images.getImage(imageId)
        return image ? [image] : []
      })
      if (group.length !== imageIds.length) return false
      return images.withPrepared(group, submit)
    },
    [canRetryMessage, images, markSent, request]
  )

  const editAndSend = useCallback(
    (messageId: string, rawContent: string): boolean | Promise<boolean> => {
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
      const editedMessage = active.messages[index]
      const descriptors = getMessageImages(editedMessage)
      const imageTurn = descriptors.length > 0 || hasImageTurnNotice(editedMessage.content)
      const group = imageTurn ? images.getMessage(messageId) : null
      if (imageTurn && !group) {
        images.setError(
          descriptors.length > 0 && !Object.keys(images.messageErrors[messageId] ?? {}).length
            ? '图片组正在恢复，请稍后再试。'
            : '原图片组不可用，请重新添加图片后发送，原消息已保留。'
        )
        return false
      }
      const checkedContent = group ? stripImageTurnNotice(content).trim() : content
      if (
        !checkedContent ||
        (group ? appendImageTurnNotice(checkedContent, group.length) : checkedContent).length > 2000
      ) {
        images.setError('消息过长或为空，请缩短问题后再发送。')
        return false
      }
      const messageAttachments = editedMessage.attachments ?? pendingSelection?.files ?? []
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
      const submit = (): boolean => {
        preparation.cancel()
        setCapacityError(null)
        updateConversation(active.id, (previous) => ({
          ...previous,
          messages: trimmedMessages,
          toolRuns: trimmedToolRuns
        }))
        let acceptedMessageId: string | null = null
        const accepted = request.send(
          checkedContent,
          trimmedMessages,
          trimmedToolRuns,
          undefined,
          undefined,
          workspace.runtime,
          (acceptedRequest) => {
            acceptedMessageId = acceptedRequest.messageId
          },
          messageAttachments,
          undefined,
          group?.map((image) => image.image.imageId)
        )
        if (accepted) {
          commandReview.close()
          markSent()
          const keep = new Set([...keptIds])
          if (acceptedMessageId) keep.add(acceptedMessageId)
          images.retainMessages(
            keep,
            group?.map((image) => image.image.imageId)
          )
        } else {
          updateConversation(active.id, (previous) => ({
            ...previous,
            messages: active.messages,
            toolRuns: active.toolRuns
          }))
        }
        return accepted
      }
      return group ? images.withPrepared(group, submit) : submit()
    },
    [
      active,
      canSubmit,
      images,
      commandReview,
      markSent,
      pendingSelection,
      preparation,
      request,
      snapshot,
      updateConversation,
      workspace
    ]
  )

  async function createId(inheritDraft = false): Promise<string | null> {
    if (!canChange() || snapshot.conversations.length >= 100) return null
    if (!(await revokeSelectionForChange())) return null
    if (!(await images.release())) return null
    if (active) {
      if (!(await workspace.release())) return null
      invalidateTitle(active.id)
    }
    const id = crypto.randomUUID()
    if (inheritDraft) setDraftInheritanceTarget(id)
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
    return id
  }

  async function create(): Promise<boolean> {
    return (await createId()) !== null
  }

  async function select(id: string): Promise<boolean> {
    if (!canChange() || !snapshot.conversations.some((item) => item.id === id && !item.archived)) {
      setConversationError('当前会话正在忙碌，或目标会话已归档。')
      return false
    }
    if (id === active?.id) return true
    if (!(await images.release())) return false
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
    markRenamedTitle(id)
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
      if (!(await images.release())) return false
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
    if (id !== active?.id && !(await images.release())) return false
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
    if (!(await images.release())) return false
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
    (active?.toolRuns ?? []).map((run) => [
      run.assistantId,
      // 旧版本 trace 可能包含协议 call_id；展示层清理它，历史协议本身保持不变。
      run.trace.map((line) => line.replace(/(?:；|;)\s*call_id\s*=\s*[^\s；;]+/giu, ''))
    ])
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
    draftInheritanceTarget,
    messages,
    canRetryMessage,
    retryMessage,
    operation: operations.operation,
    canNavigate,
    canEdit,
    canSend,
    storage,
    chatError:
      conversationError ??
      capacityError ??
      images.error ??
      projectError ??
      executionPermissions.error ??
      request.error,
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
    executionPermissions,
    images,
    setClosePending,
    getOperation: operations.getOperation,
    send: (content) => {
      if (!canSubmit) return false
      const group = [...images.pending]
      const question = group.length ? stripImageTurnNotice(content).trim() : content.trim()
      if (
        !question ||
        (group.length ? appendImageTurnNotice(question, group.length) : question).length > 2000
      ) {
        setConversationError('消息为空或超过长度上限，请缩短问题后再发送。')
        return false
      }
      const submit = (): boolean => {
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
            ? createConversationTitle(question)
            : ''
        const accepted = request.send(
          question,
          target.messages,
          target.toolRuns,
          target.id,
          undefined,
          workspace.runtime,
          fallbackTitle
            ? (acceptedRequest) => startTitleGeneration(acceptedRequest, fallbackTitle)
            : undefined,
          pendingSelection?.files ?? [],
          undefined,
          group.map((image) => image.image.imageId)
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
      }
      return group.length ? images.withPrepared(group, submit) : submit()
    },
    editAndSend,
    toolActivity: visibleActivity,
    toolRuns: active?.toolRuns ?? [],
    removeFile,
    preparation,
    commit,
    changePreview,
    changeProposals,
    changeProposalStatus,
    openProposal,
    closePreview,
    discardProposal
  }
}
