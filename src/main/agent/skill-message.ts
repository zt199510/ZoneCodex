import type { SkillSnapshot } from '../../shared/skills'
import {
  getAcceptedSkill,
  getSavedSkillReference,
  rememberSavedSkillReference
} from '../skills/skill-service'
import { validateSkillSnapshotHash } from '../skills/skill-reader'

type SavedSkillLookup = (conversationId: string, messageId: string) => Promise<SkillSnapshot | null>
let savedLookup: SavedSkillLookup | null = null

/** Registration is inert. Stored guidance never restores tool or directory grants. */
export function configureSavedSkillMessageLookup(lookup: SavedSkillLookup): void {
  savedLookup = lookup
}

export async function readSkillMessage(
  windowId: number,
  conversationId: string,
  messageId: string,
  assertCurrent: () => void = () => undefined
): Promise<SkillSnapshot | null> {
  const accepted =
    getAcceptedSkill(windowId, conversationId, messageId) ??
    getSavedSkillReference(windowId, conversationId, messageId)
  const snapshot = accepted ?? (await savedLookup?.(conversationId, messageId))
  assertCurrent()
  if (snapshot === undefined) throw new Error('原消息技能记录不可用，请重新选择技能发起新任务。')
  if (snapshot && !validateSkillSnapshotHash(snapshot))
    throw new Error('原技能快照已损坏，未开始任务。')
  if (snapshot && !accepted)
    rememberSavedSkillReference(windowId, conversationId, messageId, snapshot)
  return snapshot ? structuredClone(snapshot) : null
}
