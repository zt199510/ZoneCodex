import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  isSkillId,
  isSkillName,
  type PreparedSkillSelection,
  type SkillDescriptor,
  type SkillListResult,
  type SkillPreparationResult,
  type SkillSnapshot
} from '../../shared/skills'
import {
  listSkillDirectories,
  readSkillMetadata,
  readSkillSnapshot,
  validateSkillSnapshotHash,
  type ReadSkillResult
} from './skill-reader'
import { checkWindowsSkillObjects } from './windows-skill-objects'
import type { ConversationLibrary } from '../../shared/conversation-library'

type Scope = {
  generation: string
  descriptors: Map<string, SkillDescriptor>
  listJob?: AbortController
  preparation?: AbortController
  prepared: Map<string, ReadSkillResult>
}
type SavedReference = { snapshot: SkillSnapshot; onDisk: boolean }
type WindowSkills = {
  scopes: Map<string, Scope>
  accepted: Map<string, SkillSnapshot>
  savedReferences: Map<string, SavedReference>
}
const windows = new Map<number, WindowSkills>()
const MAX_CONVERSATION_SCOPES = 64
const MAX_ACCEPTED_SNAPSHOTS = 128
const MAX_PREPARED_SELECTIONS = 4
const MAX_SAVED_REFERENCES = 128
let skillRoot: string | null = null

export function configureSkills(userData: string): void {
  if (typeof userData !== 'string' || !userData.trim()) throw new Error('应用技能目录无效')
  // Called by the desktop host only; the renderer never supplies a root.
  skillRoot = join(resolve(userData), 'skills')
}
export function getSkillsRoot(): string {
  if (!skillRoot) throw new Error('技能服务尚未初始化')
  return skillRoot
}
function windowState(windowId: number): WindowSkills {
  if (!Number.isSafeInteger(windowId) || windowId < 1) throw new Error('技能窗口无效')
  let state = windows.get(windowId)
  if (!state) {
    state = { scopes: new Map(), accepted: new Map(), savedReferences: new Map() }
    windows.set(windowId, state)
  }
  return state
}
function conversationScope(windowId: number, conversationId: string): Scope {
  if (!isSkillId(conversationId)) throw new Error('技能会话标识无效')
  const state = windowState(windowId)
  let scope = state.scopes.get(conversationId)
  if (!scope) {
    if (state.scopes.size >= MAX_CONVERSATION_SCOPES)
      throw new Error('技能待选会话过多，请移除不用的会话选择后刷新')
    scope = { generation: randomUUID(), descriptors: new Map(), prepared: new Map() }
    state.scopes.set(conversationId, scope)
  }
  return scope
}
function errorText(error: unknown): string {
  if (error instanceof Error && !('code' in error)) return error.message.slice(0, 800)
  return '无法读取本地技能，请检查目录和 SKILL.md 后重新选择'
}
export async function listSkills(
  windowId: number,
  conversationId: string
): Promise<SkillListResult> {
  const root = getSkillsRoot()
  try {
    const scope = conversationScope(windowId, conversationId)
    scope.listJob?.abort()
    scope.preparation?.abort()
    const controller = new AbortController()
    scope.listJob = controller
    const generation = randomUUID()
    scope.generation = generation
    scope.descriptors = new Map()
    const names = await listSkillDirectories(root, controller.signal)
    const paths = [
      root,
      ...names
        .filter(isSkillName)
        .flatMap((name) => [join(root, name), join(root, name, 'SKILL.md')])
    ]
    const proof = names.length ? await checkWindowsSkillObjects(paths, controller.signal) : null
    const skills: SkillDescriptor[] = []
    for (const directoryName of names) {
      if (controller.signal.aborted) throw new Error('技能刷新已取消')
      const base = { skillId: randomUUID(), generation, directoryName }
      try {
        const metadata = await readSkillMetadata(root, directoryName, controller.signal, proof)
        skills.push({ ...base, status: 'available', ...metadata })
      } catch (error) {
        if (controller.signal.aborted) throw new Error('技能刷新已取消')
        const label = Array.from(directoryName)
          .map((character) => {
            const code = character.charCodeAt(0)
            return code < 32 || code === 127
              ? `\\u${code.toString(16).padStart(4, '0')}`
              : character
          })
          .join('')
          .slice(0, 255)
        skills.push({
          ...base,
          directoryName: label,
          status: 'unavailable',
          error: errorText(error)
        })
      }
    }
    const finalProof = names.length
      ? await checkWindowsSkillObjects(paths, controller.signal)
      : null
    for (let index = 0; index < skills.length; index++) {
      const skill = skills[index]
      if (skill.status !== 'available' || !proof || !finalProof) continue
      if (
        [root, join(root, skill.name), join(root, skill.name, 'SKILL.md')].some(
          (filename) =>
            !finalProof.get(filename)?.ordinary ||
            proof.get(filename)?.identity !== finalProof.get(filename)?.identity
        )
      )
        skills[index] = {
          skillId: skill.skillId,
          generation,
          directoryName: skill.directoryName,
          status: 'unavailable',
          error: '技能对象或 Windows reparse 属性在发现期间已变化，请刷新'
        }
    }
    if (
      controller.signal.aborted ||
      scope.generation !== generation ||
      windows.get(windowId)?.scopes.get(conversationId) !== scope
    )
      throw new Error('技能列表已过期，请刷新')
    scope.descriptors = new Map(skills.map((skill) => [skill.skillId, skill]))
    scope.listJob = undefined
    return { status: 'ok', root, generation, skills }
  } catch (error) {
    return { status: 'error', root, error: errorText(error) }
  }
}
export async function prepareSkill(
  windowId: number,
  conversationId: string,
  skillId: string,
  generation: string
): Promise<SkillPreparationResult> {
  let scope: Scope | undefined
  let controller: AbortController | undefined
  try {
    scope = windows.get(windowId)?.scopes.get(conversationId)
    const descriptor = scope?.descriptors.get(skillId)
    if (
      !scope ||
      !descriptor ||
      descriptor.status !== 'available' ||
      scope.generation !== generation ||
      descriptor.generation !== generation
    )
      throw new Error('技能列表已过期或技能不可用，请刷新后选择')
    if (scope.prepared.size >= MAX_PREPARED_SELECTIONS)
      throw new Error('待选技能过多，请移除不用的选择后重试')
    scope.preparation?.abort()
    controller = new AbortController()
    scope.preparation = controller
    const result = await readSkillSnapshot(
      getSkillsRoot(),
      descriptor.directoryName,
      controller.signal
    )
    if (
      controller.signal.aborted ||
      scope.preparation !== controller ||
      scope.generation !== generation ||
      windows.get(windowId)?.scopes.get(conversationId) !== scope
    )
      throw new Error('技能选择已过期或已取消')
    const selectionId = randomUUID()
    scope.prepared.set(selectionId, result)
    const { name, description, sourceHash } = result.snapshot
    const selection: PreparedSkillSelection = { selectionId, name, description, sourceHash }
    return { status: 'prepared', selection }
  } catch (error) {
    return { status: 'error', error: errorText(error) }
  } finally {
    if (scope && scope.preparation === controller) scope.preparation = undefined
  }
}
/** Re-read exactly the chosen source before accepting its first message; subsequent rounds reuse the result. */
export async function freezePreparedSkill(
  windowId: number,
  conversationId: string,
  selectionId: string,
  signal: AbortSignal
): Promise<SkillSnapshot> {
  const scope = windows.get(windowId)?.scopes.get(conversationId)
  const selected = scope?.prepared.get(selectionId)
  if (!scope || !selected) throw new Error('技能选择不存在或不属于当前窗口与会话')
  if (signal.aborted) throw new Error('技能发送已取消')
  try {
    const current = await readSkillSnapshot(getSkillsRoot(), selected.snapshot.name, signal)
    if (
      signal.aborted ||
      scope.prepared.get(selectionId) !== selected ||
      windows.get(windowId)?.scopes.get(conversationId) !== scope
    )
      throw new Error('技能选择在发送期间已取消，请重新选择')
    if (
      current.snapshot.sourceHash !== selected.snapshot.sourceHash ||
      JSON.stringify(current.identity) !== JSON.stringify(selected.identity)
    )
      throw new Error('技能源文件在选择后已变化，请重新选择或移除技能')
    return { ...selected.snapshot }
  } catch (error) {
    throw new Error(`${errorText(error)}；请重新选择或移除技能后发送`)
  }
}
export function releaseSkill(
  windowId: number,
  conversationId: string,
  selectionId: string
): boolean {
  const scope = windows.get(windowId)?.scopes.get(conversationId)
  return scope?.prepared.delete(selectionId) ?? false
}
export function rememberAcceptedSkill(
  windowId: number,
  conversationId: string,
  messageId: string,
  snapshot: SkillSnapshot
): void {
  if (!isSkillId(conversationId) || !isSkillId(messageId) || !validateSkillSnapshotHash(snapshot))
    throw new Error('已接受技能快照无效')
  const state = windowState(windowId)
  const accepted = state.accepted
  const key = `${conversationId}:${messageId}`
  const original = accepted.get(key) ?? state.savedReferences.get(key)?.snapshot
  if (original && original.snapshotHash !== snapshot.snapshotHash)
    throw new Error('原消息已接受的技能快照不能替换，请发起新消息')
  if (!accepted.has(key) && accepted.size >= MAX_ACCEPTED_SNAPSHOTS)
    throw new Error('未保存的技能消息已达上限，请先成功保存会话后再发送')
  accepted.set(key, { ...snapshot })
}
/** Only a successful host-side save may retire an identical in-memory acceptance. */
export function releasePersistedSkills(
  windowId: number,
  saved: { conversationId: string; messageId: string; snapshotHash: string }[]
): void {
  const state = windows.get(windowId)
  if (!state) return
  const { accepted } = state
  const savedHashes = new Map(
    saved.map((item) => [`${item.conversationId}:${item.messageId}`, item.snapshotHash])
  )
  for (const [key, reference] of state.savedReferences)
    reference.onDisk = savedHashes.get(key) === reference.snapshot.snapshotHash
  for (const item of saved) {
    const key = `${item.conversationId}:${item.messageId}`
    const snapshot = accepted.get(key)
    if (snapshot?.snapshotHash === item.snapshotHash) {
      cacheSavedReference(state, key, snapshot)
      accepted.delete(key)
    }
  }
}
function cacheSavedReference(state: WindowSkills, key: string, snapshot: SkillSnapshot): boolean {
  if (!state.savedReferences.has(key) && state.savedReferences.size >= MAX_SAVED_REFERENCES) {
    const removable = [...state.savedReferences].find(([, reference]) => reference.onDisk)?.[0]
    if (!removable) return false
    state.savedReferences.delete(removable)
  }
  state.savedReferences.delete(key)
  state.savedReferences.set(key, { snapshot: { ...snapshot }, onDisk: true })
  return true
}
/** Store-backed prevalidation is remembered separately, preserving edit sources after history truncation. */
export function rememberSavedSkillReference(
  windowId: number,
  conversationId: string,
  messageId: string,
  snapshot: SkillSnapshot
): void {
  if (!isSkillId(conversationId) || !isSkillId(messageId) || !validateSkillSnapshotHash(snapshot))
    throw new Error('原已保存技能引用无效')
  if (!cacheSavedReference(windowState(windowId), `${conversationId}:${messageId}`, snapshot))
    throw new Error('待完成的原技能编辑引用过多，请完成已有编辑或关闭重开会话后再试')
}
export function getSavedSkillReference(
  windowId: number,
  conversationId: string,
  messageId: string
): SkillSnapshot | null {
  const state = windows.get(windowId)
  const key = `${conversationId}:${messageId}`
  const reference = state?.savedReferences.get(key)
  if (!state || !reference) return null
  state.savedReferences.delete(key)
  state.savedReferences.set(key, reference)
  return { ...reference.snapshot }
}
/** Runs inside the conversation-store write sequence with the exact existing library. */
export function assertConversationSkillSources(
  windowId: number,
  snapshot: ConversationLibrary,
  existing: ConversationLibrary | null
): void {
  const originals = new Map<string, { skill?: SkillSnapshot }>(
    (existing?.conversations ?? []).flatMap((conversation) =>
      conversation.messages.map((message) => [`${conversation.id}:${message.id}`, message] as const)
    )
  )
  const state = windows.get(windowId)
  for (const conversation of snapshot.conversations)
    for (const message of conversation.messages) {
      const key = `${conversation.id}:${message.id}`
      const original = originals.get(key)
      const preserved =
        original?.skill ?? state?.accepted.get(key) ?? state?.savedReferences.get(key)?.snapshot
      if (preserved && (!message.skill || message.skill.snapshotHash !== preserved.snapshotHash))
        throw new Error('原用户消息的技能快照不能删除或替换')
      if (!message.skill) continue
      const trusted =
        state?.accepted.get(key) ?? state?.savedReferences.get(key)?.snapshot ?? original?.skill
      if (
        message.role !== 'user' ||
        !trusted ||
        trusted.snapshotHash !== message.skill.snapshotHash ||
        !validateSkillSnapshotHash(message.skill)
      )
        throw new Error('技能快照未由当前窗口接受，也不属于同一条已保存用户消息')
    }
}
/** Never touches a skill directory or source file; failed and cancelled requests retain their accepted snapshot. */
export function getAcceptedSkill(
  windowId: number,
  conversationId: string,
  messageId: string
): SkillSnapshot | null {
  const snapshot = windows.get(windowId)?.accepted.get(`${conversationId}:${messageId}`)
  return snapshot ? { ...snapshot } : null
}
export function releaseConversationSkills(windowId: number, conversationId: string): boolean {
  const state = windows.get(windowId)
  if (!state) return true
  const scope = state.scopes.get(conversationId)
  scope?.listJob?.abort()
  scope?.preparation?.abort()
  state.scopes.delete(conversationId)
  return true
}
export function discardConversationSkills(windowId: number, conversationId: string): void {
  releaseConversationSkills(windowId, conversationId)
  const state = windows.get(windowId)
  if (!state) return
  for (const key of state.accepted.keys())
    if (key.startsWith(`${conversationId}:`)) state.accepted.delete(key)
  for (const key of state.savedReferences.keys())
    if (key.startsWith(`${conversationId}:`)) state.savedReferences.delete(key)
}
export function cleanupSkills(windowId: number): void {
  const state = windows.get(windowId)
  for (const scope of state?.scopes.values() ?? []) {
    scope.listJob?.abort()
    scope.preparation?.abort()
  }
  windows.delete(windowId)
}
