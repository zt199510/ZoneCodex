import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'
import { isTerminalTaskStatus, maxTaskRecords } from '../../../../shared/task'
import type { TaskRecord } from '../../../../shared/task'

function mergeTaskRecords(
  conversationId: string,
  previous: readonly TaskRecord[],
  incoming: readonly TaskRecord[],
  options: { allowNew: boolean; preserveTerminal: boolean }
): TaskRecord[] {
  const current = incoming.filter((task) => task.conversationId === conversationId)
  const byId = new Map(current.map((task) => [task.taskId, task]))
  const merged = previous.map((task) => {
    if (options.preserveTerminal && isTerminalTaskStatus(task.status)) return task
    return byId.get(task.taskId) ?? task
  })
  if (options.allowNew) {
    const known = new Set(merged.map((task) => task.taskId))
    for (const task of current) {
      if (!known.has(task.taskId)) {
        merged.push(task)
        known.add(task.taskId)
      }
    }
  }
  return options.allowNew ? merged.slice(-maxTaskRecords) : merged
}

export function reconcileConversationTasks(
  conversation: Conversation,
  liveTasks: readonly TaskRecord[]
): Conversation {
  const current = new Set(
    liveTasks.filter((task) => task.conversationId === conversation.id).map((task) => task.taskId)
  )
  const previous = conversation.tasks.map((task) =>
    !isTerminalTaskStatus(task.status) && !current.has(task.taskId)
      ? {
          ...task,
          status: 'interrupted' as const,
          finishedAt: new Date().toISOString(),
          error: '页面重新加载，旧任务未继续运行'
        }
      : task
  )
  return {
    ...conversation,
    tasks: mergeTaskRecords(conversation.id, previous, liveTasks, {
      allowNew: true,
      preserveTerminal: false
    })
  }
}

export function applyConversationTaskEvent(
  conversation: Conversation,
  record: TaskRecord,
  activeTaskId: string | null
): Conversation {
  if (record.conversationId !== conversation.id) return conversation
  const existing = conversation.tasks.find((task) => task.taskId === record.taskId)
  // Removed tasks cannot be resurrected by a late event, and an orphan closed
  // during reload cannot be reopened by an event queued before that reload.
  if (
    (!existing && activeTaskId !== record.taskId) ||
    (existing && isTerminalTaskStatus(existing.status))
  ) {
    return conversation
  }
  return {
    ...conversation,
    tasks: mergeTaskRecords(conversation.id, conversation.tasks, [record], {
      allowNew: !existing && activeTaskId === record.taskId,
      preserveTerminal: true
    })
  }
}

export function useConversationTasks(
  ready: boolean,
  updateLibrary: Dispatch<SetStateAction<ConversationLibrary>>
): void {
  const reconciled = useRef(false)
  useEffect(() => {
    if (!ready || reconciled.current) return
    let disposed = false
    async function reconcileTasks(): Promise<void> {
      const liveTasks = await window.api.listTasks()
      if (disposed) return
      updateLibrary((previous) => ({
        ...previous,
        conversations: previous.conversations.map((conversation) =>
          reconcileConversationTasks(conversation, liveTasks)
        )
      }))
      reconciled.current = true
    }
    void reconcileTasks()
    return () => {
      disposed = true
    }
  }, [ready, updateLibrary])
}
