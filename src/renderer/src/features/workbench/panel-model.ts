import { emptyPanelState } from '../../../../shared/workbench'
import type { PanelState, PanelTab } from '../../../../shared/workbench'
export function addPanelTab(
  state: PanelState,
  tab: PanelTab,
  layout = state.layout === 'chat' ? 'split' : state.layout
): PanelState {
  const existing = ['files', 'sources', 'changes'].includes(tab.kind)
    ? state.tabs.find((item) => item.kind === tab.kind)
    : tab.kind === 'file'
      ? state.tabs.find(
          (item) =>
            item.kind === 'file' &&
            item.file.reference.path.toLowerCase() === tab.file.reference.path.toLowerCase() &&
            JSON.stringify(item.file.source) === JSON.stringify(tab.file.source)
        )
      : null
  if (existing)
    return {
      ...state,
      layout,
      selected: existing.id,
      tabs: state.tabs.map((item) =>
        item.id === existing.id && tab.kind === 'file'
          ? ({ ...existing, file: tab.file } as PanelTab)
          : item
      )
    }
  if (state.tabs.length >= 64) throw new Error('最多打开 64 个标签页，请先关闭部分标签')
  const blank = state.tabs.findIndex((item) => item.id === state.selected && item.kind === 'new')
  const tabs = [...state.tabs]
  if (blank >= 0 && tab.kind !== 'new') tabs.splice(blank, 1, tab)
  else tabs.push(tab)
  return { ...state, tabs, layout, selected: tab.id }
}
export function closePanelTab(state: PanelState, id: string, history = true): PanelState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return state
  const tab = state.tabs[index]
  const tabs = state.tabs.filter((item) => item.id !== id)
  const drafts = { ...state.drafts }
  delete drafts[id]
  const selected =
    state.selected === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? 'chat') : state.selected
  return {
    ...state,
    tabs,
    drafts,
    selected,
    layout: tabs.length ? state.layout : 'chat',
    closed:
      history && tab.kind !== 'new' ? [...state.closed, { tab, index }].slice(-20) : state.closed
  }
}
export function reopenPanelTab(state: PanelState): PanelState {
  const latest = state.closed.at(-1)
  if (!latest || state.tabs.length >= 64) return state
  if (state.tabs.some((tab) => tab.id === latest.tab.id))
    return { ...state, selected: latest.tab.id, closed: state.closed.slice(0, -1) }
  const tabs = [...state.tabs]
  tabs.splice(Math.min(latest.index, tabs.length), 0, latest.tab)
  return {
    ...state,
    tabs,
    selected: latest.tab.id,
    layout: state.layout === 'chat' ? 'split' : state.layout,
    closed: state.closed.slice(0, -1)
  }
}
export function movePanelTab(state: PanelState, from: string, target: string): PanelState {
  const first = state.tabs.findIndex((tab) => tab.id === from),
    second = state.tabs.findIndex((tab) => tab.id === target)
  if (first < 0 || second < 0 || first === second) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(first, 1)
  tabs.splice(second, 0, tab)
  return { ...state, tabs }
}
export function sanitizeRestoredPanel(state: PanelState | null): PanelState {
  if (!state) return emptyPanelState()
  return {
    ...state,
    selected:
      state.selected === 'chat' || state.tabs.some((tab) => tab.id === state.selected)
        ? state.selected
        : (state.tabs[0]?.id ?? 'chat'),
    layout: state.tabs.length ? state.layout : 'chat'
  }
}
