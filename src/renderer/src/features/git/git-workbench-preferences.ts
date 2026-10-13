export type GitWorkbenchPreferences = {
  forceWithLease: boolean
  draftPR: boolean
  branchPrefix: string
  commitGuidance: string
  prGuidance: string
  mergeMethod: 'merge' | 'squash'
}
const preferenceKey = 'zonecodex.git-ui.v1'
export const defaultGitWorkbenchPreferences: GitWorkbenchPreferences = {
  forceWithLease: false,
  draftPR: true,
  branchPrefix: 'codex/',
  commitGuidance: '',
  prGuidance: '',
  mergeMethod: 'squash'
}
export function validGitBranchPrefix(prefix: string): boolean {
  return (
    prefix === '' ||
    (prefix.length <= 100 &&
      prefix.endsWith('/') &&
      !prefix.startsWith('/') &&
      ![...prefix].some(
        (character) =>
          /\s/.test(character) ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127 ||
          '~^:?*[\\'.includes(character)
      ) &&
      !/\.\.|\/\/|@\{|(?:^|\/)\.|\.lock\//.test(prefix))
  )
}
/** Only Git UI defaults live here. They never grant a host, Agent, or command authority. */
export function loadGitWorkbenchPreferences(
  storage?: Pick<Storage, 'getItem'>
): GitWorkbenchPreferences {
  try {
    const raw = storage?.getItem(preferenceKey)
    if (!raw || raw.length > 20000) return { ...defaultGitWorkbenchPreferences }
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { ...defaultGitWorkbenchPreferences }
    return {
      forceWithLease: typeof value.forceWithLease === 'boolean' ? value.forceWithLease : false,
      draftPR: typeof value.draftPR === 'boolean' ? value.draftPR : true,
      branchPrefix:
        typeof value.branchPrefix === 'string' && validGitBranchPrefix(value.branchPrefix)
          ? value.branchPrefix
          : 'codex/',
      commitGuidance:
        typeof value.commitGuidance === 'string' ? value.commitGuidance.slice(0, 4000) : '',
      prGuidance: typeof value.prGuidance === 'string' ? value.prGuidance.slice(0, 4000) : '',
      mergeMethod: value.mergeMethod === 'merge' ? 'merge' : 'squash'
    }
  } catch {
    return { ...defaultGitWorkbenchPreferences }
  }
}
export function saveGitWorkbenchPreferences(
  storage: Pick<Storage, 'setItem'>,
  value: GitWorkbenchPreferences
): void {
  if (!validGitBranchPrefix(value.branchPrefix))
    throw new Error('分支前缀请使用有效名称并以 / 结尾，或留空。')
  storage.setItem(
    preferenceKey,
    JSON.stringify({
      forceWithLease: value.forceWithLease,
      draftPR: value.draftPR,
      branchPrefix: value.branchPrefix,
      commitGuidance: value.commitGuidance.slice(0, 4000),
      prGuidance: value.prGuidance.slice(0, 4000),
      mergeMethod: value.mergeMethod
    })
  )
}
