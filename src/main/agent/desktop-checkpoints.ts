import { app } from 'electron'
import { join } from 'node:path'
import { createTaskCheckpointStore } from '../storage/task-checkpoint-store'
import type { ResumableAgentTask } from '../../shared/agent-resume'

let checkpointStore: ReturnType<typeof createTaskCheckpointStore> | null = null

/** Lazy: importing the desktop adapter does not create a writer or load a task. */
export function desktopCheckpointStore(): ReturnType<typeof createTaskCheckpointStore> {
  checkpointStore ??= createTaskCheckpointStore(join(app.getPath('userData'), 'task-checkpoints'))
  return checkpointStore
}

export async function getResumableAgentTask(
  conversationId: string
): Promise<ResumableAgentTask | null> {
  const checkpoint = await desktopCheckpointStore().findByConversation(conversationId)
  if (!checkpoint || !['resumable', 'interrupted'].includes(checkpoint.progress)) return null
  return {
    taskId: checkpoint.taskId,
    mode: checkpoint.mode,
    updatedAt: checkpoint.updatedAt,
    prompt: checkpoint.prompt,
    requiresWorkspace: checkpoint.bindings.workspace !== null,
    ...(checkpoint.skill ? { skillName: checkpoint.skill.name } : {})
  }
}
