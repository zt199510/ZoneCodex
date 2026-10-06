import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ConversationLibrary } from '../../../../shared/conversation-library'
import type { AcceptedChatRequest } from '../chat/useChatRequest'

type TitleJob = {
  requestId: string
  conversationId: string
  messageId: string
  generation: number
  fallbackTitle: string
}

export function useConversationTitle(
  updateLibrary: Dispatch<SetStateAction<ConversationLibrary>>
): {
  invalidate: (conversationId: string) => void
  invalidateAll: () => void
  markRenamed: (conversationId: string) => void
  start: (accepted: AcceptedChatRequest, fallbackTitle: string) => void
} {
  const jobs = useRef(new Map<string, TitleJob>())
  const generations = useRef(new Map<string, number>())
  const manuallyRenamed = useRef(new Set<string>())

  const invalidate = useCallback((conversationId: string): void => {
    const generation = (generations.current.get(conversationId) ?? 0) + 1
    generations.current.set(conversationId, generation)
    const job = jobs.current.get(conversationId)
    if (!job) return
    jobs.current.delete(conversationId)
    void Promise.resolve()
      .then(() => window.api.cancelConversationTitle(job.requestId))
      .catch(() => undefined)
  }, [])

  const invalidateAll = useCallback((): void => {
    for (const conversationId of jobs.current.keys()) invalidate(conversationId)
  }, [invalidate])

  useEffect(() => () => invalidateAll(), [invalidateAll])

  const markRenamed = useCallback(
    (conversationId: string): void => {
      manuallyRenamed.current.add(conversationId)
      invalidate(conversationId)
    },
    [invalidate]
  )

  function start(accepted: AcceptedChatRequest, fallbackTitle: string): void {
    if (manuallyRenamed.current.has(accepted.conversationId)) return
    invalidate(accepted.conversationId)
    const generation = generations.current.get(accepted.conversationId) ?? 0
    const job: TitleJob = {
      requestId: crypto.randomUUID(),
      conversationId: accepted.conversationId,
      messageId: accepted.messageId,
      generation,
      fallbackTitle
    }
    jobs.current.set(job.conversationId, job)
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
        if (jobs.current.get(job.conversationId) !== job) return
        if (
          result.status !== 'done' ||
          result.requestId !== job.requestId ||
          result.conversationId !== job.conversationId ||
          result.messageId !== job.messageId ||
          generations.current.get(job.conversationId) !== job.generation
        ) {
          jobs.current.delete(job.conversationId)
          return
        }
        updateLibrary((previous) => {
          const conversation = previous.conversations.find((item) => item.id === job.conversationId)
          const first = conversation?.messages.find((message) => message.role === 'user')
          if (
            !conversation ||
            conversation.archived ||
            manuallyRenamed.current.has(job.conversationId) ||
            conversation.title !== job.fallbackTitle ||
            !first ||
            first.role !== 'user' ||
            first.id !== job.messageId ||
            first.content !== accepted.content ||
            generations.current.get(job.conversationId) !== job.generation
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
        jobs.current.delete(job.conversationId)
      })
      .catch(() => {
        if (jobs.current.get(job.conversationId) === job) jobs.current.delete(job.conversationId)
      })
  }

  return { invalidate, invalidateAll, markRenamed, start }
}
