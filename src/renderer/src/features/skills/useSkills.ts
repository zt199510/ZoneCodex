import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  parseSkillDirectoryResult,
  parseSkillListResult,
  parseSkillPreparationResult,
  type PreparedSkillSelection,
  type SkillDescriptor
} from '../../../../shared/skills'

type SkillsState = {
  conversationId: string | null
  root: string
  generation: string | null
  items: SkillDescriptor[]
  pending: PreparedSkillSelection | null
  error: string | null
  busy: boolean
}
export type SkillsController = Omit<SkillsState, 'conversationId' | 'generation'> & {
  refresh: () => Promise<boolean>
  select: (item: SkillDescriptor) => Promise<boolean>
  remove: () => Promise<boolean>
  release: () => Promise<boolean>
  openDirectory: () => Promise<boolean>
  markAccepted: (selectionId: string) => void
}
const emptyState = (conversationId: string | null): SkillsState => ({
  conversationId,
  root: '',
  generation: null,
  items: [],
  pending: null,
  error: null,
  busy: false
})

export function useSkills({
  conversationId,
  canChange,
  ensureConversation
}: {
  conversationId: string | null
  canChange: () => boolean
  ensureConversation: () => Promise<string | null>
}): SkillsController {
  const [state, setState] = useState<SkillsState>(() => emptyState(conversationId))
  const latest = useRef(state)
  const currentConversation = useRef(conversationId)
  const allowed = useRef(canChange)
  const ensure = useRef(ensureConversation)
  const epoch = useRef(0)
  const invalidate = useCallback(() => {
    epoch.current++
  }, [])
  const mounted = useRef(true)

  function update(next: SkillsState): void {
    latest.current = next
    if (mounted.current) setState(next)
  }
  useLayoutEffect(() => {
    allowed.current = canChange
    ensure.current = ensureConversation
    if (currentConversation.current === conversationId) return
    const previous = currentConversation.current
    currentConversation.current = conversationId
    epoch.current++
    update(emptyState(conversationId))
    if (previous) void window.api.releaseConversationSkills(previous).catch(() => undefined)
  }, [conversationId, canChange, ensureConversation])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      invalidate()
      const id = currentConversation.current
      if (id) void window.api.releaseConversationSkills(id).catch(() => undefined)
    }
  }, [invalidate])
  const current = (id: string, token: number): boolean =>
    mounted.current && currentConversation.current === id && epoch.current === token

  async function refresh(): Promise<boolean> {
    if (!allowed.current() || latest.current.busy) return false
    let id = currentConversation.current
    let token = ++epoch.current
    update({ ...latest.current, busy: true, error: null })
    try {
      if (!id) {
        id = await ensure.current()
        if (
          !id ||
          !mounted.current ||
          (currentConversation.current && currentConversation.current !== id)
        )
          return false
        currentConversation.current = id
        update({ ...emptyState(id), busy: true })
      }
      token = ++epoch.current
      const previous = latest.current.pending
      if (previous && !(await window.api.releaseSkill(id, previous.selectionId)))
        throw new Error('技能移除未获确认，请重试。')
      if (!current(id, token)) return false
      update({ ...latest.current, items: [], generation: null, pending: null })
      const result = parseSkillListResult(await window.api.listSkills(id))
      if (!current(id, token)) return false
      if (!result) throw new Error('技能列表格式无效，请刷新重试。')
      update({
        ...latest.current,
        root: result.root,
        busy: false,
        error: result.status === 'error' ? result.error : null,
        items: result.status === 'ok' ? result.skills : [],
        generation: result.status === 'ok' ? result.generation : null
      })
      return result.status === 'ok'
    } catch (cause) {
      if (id && current(id, token))
        update({
          ...latest.current,
          busy: false,
          error: cause instanceof Error ? cause.message : '读取技能失败，请重试。'
        })
      return false
    } finally {
      if (
        mounted.current &&
        epoch.current === token &&
        currentConversation.current === id &&
        latest.current.busy
      )
        update({ ...latest.current, busy: false })
    }
  }

  async function select(item: SkillDescriptor): Promise<boolean> {
    const id = currentConversation.current
    if (
      !id ||
      !allowed.current() ||
      latest.current.busy ||
      item.status !== 'available' ||
      item.generation !== latest.current.generation ||
      !latest.current.items.some((candidate) => candidate.skillId === item.skillId)
    )
      return false
    const token = ++epoch.current
    update({ ...latest.current, busy: true, error: null })
    try {
      const result = parseSkillPreparationResult(
        await window.api.prepareSkill(id, item.skillId, item.generation)
      )
      if (!current(id, token)) {
        if (result?.status === 'prepared')
          await window.api.releaseSkill(id, result.selection.selectionId).catch(() => false)
        return false
      }
      if (!result) throw new Error('技能准备结果格式无效，请重新选择。')
      if (result.status === 'error') throw new Error(result.error)
      const previous = latest.current.pending
      if (
        previous &&
        previous.selectionId !== result.selection.selectionId &&
        !(await window.api.releaseSkill(id, previous.selectionId))
      ) {
        await window.api.releaseSkill(id, result.selection.selectionId).catch(() => false)
        throw new Error('原技能移除未获确认，请重试。')
      }
      if (!current(id, token)) {
        await window.api.releaseSkill(id, result.selection.selectionId).catch(() => false)
        return false
      }
      update({ ...latest.current, pending: result.selection, busy: false })
      return true
    } catch (cause) {
      if (current(id, token))
        update({
          ...latest.current,
          busy: false,
          error: cause instanceof Error ? cause.message : '技能准备失败，请重新选择。'
        })
      return false
    }
  }

  async function remove(): Promise<boolean> {
    const id = currentConversation.current
    const selection = latest.current.pending
    if (!id || !selection || !allowed.current() || latest.current.busy) return false
    const token = ++epoch.current
    update({ ...latest.current, busy: true, error: null })
    try {
      if (!(await window.api.releaseSkill(id, selection.selectionId)))
        throw new Error('技能移除未获确认，请重试。')
      if (!current(id, token)) return false
      update({ ...latest.current, pending: null, busy: false })
      return true
    } catch (cause) {
      if (current(id, token))
        update({
          ...latest.current,
          busy: false,
          error: cause instanceof Error ? cause.message : '移除技能失败，请重试。'
        })
      return false
    }
  }

  async function release(): Promise<boolean> {
    const id = currentConversation.current
    epoch.current++
    update(emptyState(id))
    if (!id) return true
    try {
      if (await window.api.releaseConversationSkills(id)) return true
      throw new Error('清理待选技能未获确认，请重试。')
    } catch (cause) {
      if (mounted.current && currentConversation.current === id)
        update({
          ...latest.current,
          error: cause instanceof Error ? cause.message : '清理待选技能失败。'
        })
      return false
    }
  }

  async function openDirectory(): Promise<boolean> {
    if (!allowed.current() || latest.current.busy) return false
    const token = epoch.current
    update({ ...latest.current, busy: true, error: null })
    try {
      const result = parseSkillDirectoryResult(await window.api.openSkillsDirectory())
      if (!mounted.current || epoch.current !== token) return false
      if (!result) throw new Error('打开技能目录的结果无效。')
      update({
        ...latest.current,
        root: result.root,
        busy: false,
        error: result.status === 'error' ? result.error : null
      })
      return result.status === 'opened'
    } catch (cause) {
      if (mounted.current && epoch.current === token)
        update({
          ...latest.current,
          busy: false,
          error: cause instanceof Error ? cause.message : '打开技能目录失败。'
        })
      return false
    }
  }
  return {
    root: state.root,
    items: state.items,
    pending: state.pending,
    error: state.error,
    busy: state.busy,
    refresh,
    select,
    remove,
    release,
    openDirectory,
    markAccepted: (selectionId) => {
      if (latest.current.pending?.selectionId === selectionId) {
        update({ ...latest.current, pending: null, error: null })
      }
    }
  }
}
