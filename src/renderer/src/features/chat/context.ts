import type { ToolRun } from '../../../../shared/agent-history'
import type { ModelMessage } from '../../../../shared/api'
import type { ChatMessage as Message } from '../../../../shared/conversation'

/// 构建模型请求上下文，返回 ModelMessage 数组
export function buildContext(messages: readonly Message[], currentContent: string): ModelMessage[] {
  const history: ModelMessage[] = [{ role: 'user', content: currentContent }]
  let total = currentContent.length

  for (let index = messages.length - 1; index >= 1; index--) {
    const assistant = messages[index]
    const user = messages[index - 1]
    if (
      assistant.role !== 'assistant' ||
      assistant.status !== 'complete' ||
      user.role !== 'user' ||
      user.status !== 'complete'
    )
      continue

    const pairLength = user.content.length + assistant.content.length
    if (history.length + 2 > 9 || total + pairLength > 24000) break
    history.unshift(
      { role: 'user', content: user.content },
      { role: 'assistant', content: assistant.content }
    )
    total += pairLength
    index--
  }
  return history
}

export function messagesAfterProjectBoundary(
  messages: readonly Message[],
  toolRuns: readonly ToolRun[]
): readonly Message[] {
  let boundary = -1
  for (const run of toolRuns) {
    if (run.scope.kind !== 'project') continue
    const index = messages.findIndex((message) => message.id === run.assistantId)
    if (index > boundary) boundary = index
  }
  return boundary >= 0 ? messages.slice(boundary + 1) : messages
}
