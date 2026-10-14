import { isAgentId } from './agent'
import { parseFileViewRequest, type FileReference, type FileViewSource } from './file-view'

export type PanelLayout = 'chat' | 'split' | 'full'
export type PanelFile = { reference: FileReference; source: FileViewSource; messageId?: string }
export type PanelTab = { id: string; title: string } & (
  | { kind: 'new' | 'files' | 'sources' | 'changes' }
  | { kind: 'file'; file: PanelFile }
  | { kind: 'browser'; url: string }
  | { kind: 'terminal' }
)
export type EditorDraft = { text: string; baseline: string; fingerprint: string }
export type PanelState = {
  version: 1
  layout: PanelLayout
  width: number
  selected: string
  tabs: PanelTab[]
  closed: Array<{ tab: PanelTab; index: number }>
  drafts: Record<string, EditorDraft>
}
export type WorkbenchContext = { conversationId: string; workspaceId?: string }
export type DirectoryEntry = { name: string; path: string; directory: boolean }
export type EditorDocument = {
  path: string
  text: string
  fingerprint: string
  receipt: string
  writable: boolean
}
export type WorkbenchResult<T> =
  { ok: true; data: T } | { ok: false; error: string; conflict?: boolean }
export interface WorkbenchAPI {
  loadPanelState: (conversationId: string) => Promise<WorkbenchResult<PanelState | null>>
  savePanelState: (conversationId: string, state: PanelState) => Promise<WorkbenchResult<null>>
  removePanelState: (conversationId: string) => Promise<WorkbenchResult<null>>
  listPanelDirectory: (
    context: WorkbenchContext,
    path: string,
    search?: string
  ) => Promise<WorkbenchResult<DirectoryEntry[]>>
  readEditorFile: (
    context: WorkbenchContext,
    path: string
  ) => Promise<WorkbenchResult<EditorDocument>>
  saveEditorFile: (
    context: WorkbenchContext,
    receipt: string,
    fingerprint: string,
    text: string
  ) => Promise<WorkbenchResult<EditorDocument>>
  releaseEditorFile: (receipt: string) => Promise<void>
  prepareBrowserTab: (conversationId: string, tabId: string) => Promise<WorkbenchResult<string>>
  closeBrowserTab: (conversationId: string, tabId: string) => Promise<void>
  onBrowserKey: (
    listener: (event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) => void
  ) => () => void
  onBrowserNewTab: (
    listener: (event: { conversationId: string; url: string }) => void
  ) => () => void
}
export const emptyPanelState = (): PanelState => ({
  version: 1,
  layout: 'chat',
  width: 600,
  selected: 'chat',
  tabs: [],
  closed: [],
  drafts: {}
})
export function browserDestination(input: string): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/]|$)/i.test(text)) return `http://${text}`
  if (/^[\w.-]+\.[a-z]{2,}([/:]|$)/i.test(text)) return `https://${text}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('只支持 http / https 网址')
    if (url.username || url.password) throw new Error('网址不能包含登录凭据')
    return url.href
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`
}
export function validContext(value: unknown): value is WorkbenchContext {
  if (!value || typeof value !== 'object') return false
  const item = value as WorkbenchContext
  return (
    isAgentId(item.conversationId) &&
    (item.workspaceId === undefined || isAgentId(item.workspaceId))
  )
}
export function parsePanelState(value: unknown): PanelState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as PanelState
  if (
    state.version !== 1 ||
    !['chat', 'split', 'full'].includes(state.layout) ||
    !Number.isFinite(state.width) ||
    state.width < 320 ||
    state.width > 4000 ||
    typeof state.selected !== 'string' ||
    !Array.isArray(state.tabs) ||
    state.tabs.length > 64 ||
    !Array.isArray(state.closed) ||
    state.closed.length > 20 ||
    !state.drafts ||
    typeof state.drafts !== 'object'
  )
    return null
  const tabValid = (tab: PanelTab): boolean => {
    if (!tab || !isAgentId(tab.id) || typeof tab.title !== 'string' || tab.title.length > 512)
      return false
    if (['new', 'files', 'sources', 'changes', 'terminal'].includes(tab.kind)) return true
    if (tab.kind === 'browser') {
      try {
        return (
          typeof tab.url === 'string' &&
          tab.url.length <= 8192 &&
          (tab.url === 'about:blank' || browserDestination(tab.url) === new URL(tab.url).href)
        )
      } catch {
        return false
      }
    }
    if (tab.kind === 'file')
      return (
        !!tab.file &&
        !!parseFileViewRequest({
          requestId: tab.id,
          conversationId: tab.id,
          reference: tab.file.reference,
          source: tab.file.source
        })
      )
    return false
  }
  if (
    !state.tabs.every(tabValid) ||
    new Set(state.tabs.map((tab) => tab.id)).size !== state.tabs.length ||
    !state.closed.every(
      (entry) => !!entry && tabValid(entry.tab) && Number.isInteger(entry.index) && entry.index >= 0
    )
  )
    return null
  if (
    Object.entries(state.drafts).some(
      ([id, draft]) =>
        !isAgentId(id) ||
        !draft ||
        typeof draft.text !== 'string' ||
        draft.text.length > 1048576 ||
        typeof draft.baseline !== 'string' ||
        draft.baseline.length > 1048576 ||
        !/^[a-f0-9]{64}$/.test(draft.fingerprint)
    )
  )
    return null
  if (JSON.stringify(state).length > 8 * 1024 * 1024) return null
  const projectTab = (tab: PanelTab): PanelTab =>
    ({
      id: tab.id,
      title: tab.title,
      kind: tab.kind,
      ...(tab.kind === 'browser' ? { url: tab.url } : {}),
      ...(tab.kind === 'file'
        ? {
            file: {
              reference: { ...tab.file.reference },
              source: { ...tab.file.source },
              ...(typeof tab.file.messageId === 'string'
                ? { messageId: tab.file.messageId.slice(0, 512) }
                : {})
            }
          }
        : {})
    }) as PanelTab
  const drafts: Record<string, EditorDraft> = {}
  for (const tab of state.tabs)
    if (tab.kind === 'file' && tab.file.source.kind === 'local' && state.drafts[tab.id]) {
      const draft = state.drafts[tab.id]
      drafts[tab.id] = {
        text: draft.text,
        baseline: draft.baseline,
        fingerprint: draft.fingerprint
      }
    }
  return {
    version: 1,
    layout: state.layout,
    width: state.width,
    selected: state.selected,
    tabs: state.tabs.map(projectTab),
    closed: state.closed.map((entry) => ({ tab: projectTab(entry.tab), index: entry.index })),
    drafts
  }
}
