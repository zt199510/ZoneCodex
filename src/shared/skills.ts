// 技能是有界的任务指导材料；这些结构不携带路径、工具权限或执行凭据。
export const MAX_SKILL_DIRECTORIES = 64
export const MAX_SKILL_HEADER_BYTES = 4096
export const MAX_SKILL_FILE_BYTES = 64 * 1024
export const MAX_SKILL_BODY_CHARS = 12000
export const MAX_SKILL_SNAPSHOT_CHARS = 20000

export type SkillSnapshot = {
  name: string
  description: string
  body: string
  sourceHash: string
  snapshotHash: string
}
export type SkillReference =
  { kind: 'selection'; selectionId: string } | { kind: 'message'; messageId: string }
export type SkillDescriptor = {
  skillId: string
  generation: string
  directoryName: string
} & (
  | { status: 'available'; name: string; description: string }
  | { status: 'unavailable'; error: string }
)
export type PreparedSkillSelection = {
  selectionId: string
  name: string
  description: string
  sourceHash: string
}
export type SkillListResult =
  | { status: 'ok'; root: string; generation: string; skills: SkillDescriptor[] }
  | { status: 'error'; root: string; error: string }
export type SkillPreparationResult =
  { status: 'prepared'; selection: PreparedSkillSelection } | { status: 'error'; error: string }
export type SkillDirectoryResult =
  { status: 'opened'; root: string } | { status: 'error'; root: string; error: string }
export type SkillMessageResult =
  { status: 'ready'; snapshot: SkillSnapshot | null } | { status: 'error'; error: string }
export type SkillAcceptedEvent = {
  requestId: string
  conversationId: string
  messageId: string
  snapshot: SkillSnapshot | null
}

function record(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' || !descriptors[key].enumerable || !('value' in descriptors[key])
      )
    )
      return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  const own = Object.keys(value)
  return own.length === names.length && own.every((key) => names.includes(key))
}
export function isSkillId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}
export function isSkillName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|conin|conout)$/.test(value)
  )
}
export function isSkillDescription(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 500 &&
    value === value.trim() &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || [127, 133, 8232, 8233].includes(code)
    })
  )
}
function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}
function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
}
export function parseSkillSnapshot(value: unknown): SkillSnapshot | null {
  const v = record(value)
  if (
    !v ||
    !keys(v, ['name', 'description', 'body', 'sourceHash', 'snapshotHash']) ||
    !isSkillName(v.name) ||
    !isSkillDescription(v.description) ||
    typeof v.body !== 'string' ||
    !v.body.trim() ||
    v.body.length > MAX_SKILL_BODY_CHARS ||
    v.body.includes('\0') ||
    !isHash(v.sourceHash) ||
    !isHash(v.snapshotHash)
  )
    return null
  const result: SkillSnapshot = {
    name: v.name,
    description: v.description,
    body: v.body,
    sourceHash: v.sourceHash,
    snapshotHash: v.snapshotHash
  }
  return JSON.stringify(result).length <= MAX_SKILL_SNAPSHOT_CHARS ? result : null
}
// 固定字段顺序，指纹本身不参加规范 JSON；共享模块不导入 Node 或读文件。
export function canonicalSkillSnapshot(snapshot: Omit<SkillSnapshot, 'snapshotHash'>): string {
  return JSON.stringify({
    name: snapshot.name,
    description: snapshot.description,
    body: snapshot.body,
    sourceHash: snapshot.sourceHash
  })
}
export function parseSkillReference(value: unknown): SkillReference | null {
  const v = record(value)
  if (v?.kind === 'selection' && keys(v, ['kind', 'selectionId']) && isSkillId(v.selectionId))
    return { kind: 'selection', selectionId: v.selectionId }
  if (v?.kind === 'message' && keys(v, ['kind', 'messageId']) && isSkillId(v.messageId))
    return { kind: 'message', messageId: v.messageId }
  return null
}
export function parsePreparedSkillSelection(value: unknown): PreparedSkillSelection | null {
  const v = record(value)
  return v &&
    keys(v, ['selectionId', 'name', 'description', 'sourceHash']) &&
    isSkillId(v.selectionId) &&
    isSkillName(v.name) &&
    isSkillDescription(v.description) &&
    isHash(v.sourceHash)
    ? {
        selectionId: v.selectionId,
        name: v.name,
        description: v.description,
        sourceHash: v.sourceHash
      }
    : null
}
export function parseSkillDescriptor(value: unknown): SkillDescriptor | null {
  const v = record(value)
  if (!v || !isSkillId(v.skillId) || !isSkillId(v.generation) || !text(v.directoryName, 255))
    return null
  const base = { skillId: v.skillId, generation: v.generation, directoryName: v.directoryName }
  if (
    v.status === 'available' &&
    keys(v, ['skillId', 'generation', 'directoryName', 'status', 'name', 'description']) &&
    isSkillName(v.name) &&
    v.name === v.directoryName &&
    isSkillDescription(v.description)
  )
    return { ...base, status: 'available', name: v.name, description: v.description }
  if (
    v.status === 'unavailable' &&
    keys(v, ['skillId', 'generation', 'directoryName', 'status', 'error']) &&
    text(v.error, 1000)
  )
    return { ...base, status: 'unavailable', error: v.error }
  return null
}
export function parseSkillListResult(value: unknown): SkillListResult | null {
  const v = record(value)
  if (!v || !text(v.root, 4096)) return null
  if (v.status === 'error' && keys(v, ['status', 'root', 'error']) && text(v.error, 1000))
    return { status: 'error', root: v.root, error: v.error }
  if (
    v.status !== 'ok' ||
    !keys(v, ['status', 'root', 'generation', 'skills']) ||
    !isSkillId(v.generation) ||
    !Array.isArray(v.skills) ||
    v.skills.length > MAX_SKILL_DIRECTORIES
  )
    return null
  const skills = v.skills.map(parseSkillDescriptor)
  if (
    skills.some((skill) => !skill || skill.generation !== v.generation) ||
    new Set(skills.map((skill) => skill?.skillId)).size !== skills.length
  )
    return null
  return {
    status: 'ok',
    root: v.root,
    generation: v.generation,
    skills: skills as SkillDescriptor[]
  }
}
export function parseSkillPreparationResult(value: unknown): SkillPreparationResult | null {
  const v = record(value)
  if (v?.status === 'error' && keys(v, ['status', 'error']) && text(v.error, 1000))
    return { status: 'error', error: v.error }
  if (v?.status !== 'prepared' || !keys(v, ['status', 'selection'])) return null
  const selection = parsePreparedSkillSelection(v.selection)
  return selection ? { status: 'prepared', selection } : null
}
export function parseSkillDirectoryResult(value: unknown): SkillDirectoryResult | null {
  const v = record(value)
  if (!v || !text(v.root, 4096)) return null
  if (v.status === 'opened' && keys(v, ['status', 'root']))
    return { status: 'opened', root: v.root }
  return v.status === 'error' && keys(v, ['status', 'root', 'error']) && text(v.error, 1000)
    ? { status: 'error', root: v.root, error: v.error }
    : null
}
export function parseSkillAcceptedEvent(value: unknown): SkillAcceptedEvent | null {
  const v = record(value)
  if (
    !v ||
    !keys(v, ['requestId', 'conversationId', 'messageId', 'snapshot']) ||
    !isSkillId(v.requestId) ||
    !isSkillId(v.conversationId) ||
    !isSkillId(v.messageId)
  )
    return null
  const snapshot = v.snapshot === null ? null : parseSkillSnapshot(v.snapshot)
  return v.snapshot !== null && !snapshot
    ? null
    : { requestId: v.requestId, conversationId: v.conversationId, messageId: v.messageId, snapshot }
}
export function parseSkillMessageResult(value: unknown): SkillMessageResult | null {
  const v = record(value)
  if (v?.status === 'error' && keys(v, ['status', 'error']) && text(v.error, 1000))
    return { status: 'error', error: v.error }
  if (v?.status !== 'ready' || !keys(v, ['status', 'snapshot'])) return null
  const snapshot = v.snapshot === null ? null : parseSkillSnapshot(v.snapshot)
  return v.snapshot !== null && !snapshot ? null : { status: 'ready', snapshot }
}
