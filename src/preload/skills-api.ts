import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AppAPI } from '../shared/api'
import {
  isSkillId,
  parseSkillAcceptedEvent,
  parseSkillDirectoryResult,
  parseSkillListResult,
  parseSkillMessageResult,
  parseSkillPreparationResult
} from '../shared/skills'

function identifiers(...values: unknown[]): void {
  if (!values.every(isSkillId)) throw new Error('技能操作标识无效')
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('技能操作结果格式不正确')
  return value
}
export const skillsAPI: Pick<
  AppAPI,
  | 'listSkills'
  | 'prepareSkill'
  | 'releaseSkill'
  | 'releaseConversationSkills'
  | 'discardConversationSkills'
  | 'openSkillsDirectory'
  | 'validateSkillMessage'
  | 'onAgentSkillAccepted'
> = {
  listSkills: async (conversationId) => {
    identifiers(conversationId)
    const result = parseSkillListResult(await ipcRenderer.invoke('skills:list', conversationId))
    if (!result) throw new Error('技能列表格式不正确')
    return result
  },
  prepareSkill: async (conversationId, skillId, generation) => {
    identifiers(conversationId, skillId, generation)
    const result = parseSkillPreparationResult(
      await ipcRenderer.invoke('skills:prepare', conversationId, skillId, generation)
    )
    if (!result) throw new Error('技能选择结果格式不正确')
    return result
  },
  releaseSkill: async (conversationId, selectionId) => {
    identifiers(conversationId, selectionId)
    return boolean(await ipcRenderer.invoke('skills:release', conversationId, selectionId))
  },
  releaseConversationSkills: async (conversationId) => {
    identifiers(conversationId)
    return boolean(await ipcRenderer.invoke('skills:release-conversation', conversationId))
  },
  discardConversationSkills: async (conversationId) => {
    identifiers(conversationId)
    return boolean(await ipcRenderer.invoke('skills:discard-conversation', conversationId))
  },
  openSkillsDirectory: async () => {
    const result = parseSkillDirectoryResult(await ipcRenderer.invoke('skills:open-directory'))
    if (!result) throw new Error('技能目录打开结果格式不正确')
    return result
  },
  validateSkillMessage: async (conversationId, messageId) => {
    identifiers(conversationId, messageId)
    const result = parseSkillMessageResult(
      await ipcRenderer.invoke('agent:skill-message', conversationId, messageId)
    )
    if (!result) throw new Error('原消息技能校验结果格式不正确')
    return result
  },
  onAgentSkillAccepted: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const event = parseSkillAcceptedEvent(value)
      if (event) listener(event)
    }
    ipcRenderer.on('agent:skill-accepted', handler)
    return () => ipcRenderer.removeListener('agent:skill-accepted', handler)
  }
}
