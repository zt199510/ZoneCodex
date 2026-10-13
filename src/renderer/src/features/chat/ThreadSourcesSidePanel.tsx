import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { FileViewPanel } from '../files/FileViewPanel'
import type { FileViewState } from '../files/useFileView'
import type { OpenFileView } from '../files/file-view-origin'
import { ThreadSummaryIcon } from './ThreadSummaryIcon'
import type { ThreadSummarySource } from './thread-summary-sources'

export function ThreadSourcesSidePanel({
  sources,
  sourcesOpen,
  selected,
  fileState,
  active,
  onSelect,
  onCloseSources,
  onCloseFile,
  onOpenFile
}: {
  sources: ThreadSummarySource[]
  sourcesOpen: boolean
  selected: 'sources' | 'file'
  fileState: FileViewState
  active: boolean
  onSelect: (tab: 'sources' | 'file') => void
  onCloseSources: () => void
  onCloseFile: () => void
  onOpenFile: OpenFileView
}): React.JSX.Element | null {
  const sourcesTab = useRef<HTMLButtonElement>(null)
  const fileTab = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(600)
  const fileOpen = fileState.status !== 'idle'
  const sourcesSelected = sourcesOpen && (selected === 'sources' || !fileOpen)
  const filePath = fileOpen ? fileState.reference.path : ''
  const fileName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath

  useLayoutEffect(() => {
    const container = panel.current?.parentElement
    const shell = panel.current?.closest<HTMLElement>('.app-shell')
    if (!container || !shell) return
    const measure = (): void => {
      const mainWidth = container.clientWidth
      if (!mainWidth) return
      setWidth(
        Math.max(
          320,
          Math.min(shell.clientHeight * 1.6, mainWidth - 500),
          Math.min(640, mainWidth - 352)
        )
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [sourcesOpen, fileOpen])

  useLayoutEffect(() => {
    if (!active) return
    ;(sourcesSelected ? sourcesTab : fileTab).current?.focus({ preventScroll: true })
  }, [active, sourcesSelected, filePath, sourcesOpen])

  useEffect(() => {
    if (!active || (!sourcesOpen && !fileOpen)) return
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      const closeShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === 'w' || event.key === 'F4')
      const closeFileWithEscape = event.key === 'Escape' && fileOpen && !sourcesSelected
      if (
        (!closeShortcut && !closeFileWithEscape) ||
        event.isComposing ||
        event.defaultPrevented ||
        document.activeElement?.closest(
          '#thread-summary-panel, .change-preview-panel, .command-review-panel'
        ) ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (sourcesSelected) onCloseSources()
      else onCloseFile()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, sourcesOpen, sourcesSelected, fileOpen, onCloseSources, onCloseFile])

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (
      !sourcesOpen ||
      !fileOpen ||
      !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return
    event.preventDefault()
    onSelect(
      event.key === 'Home'
        ? 'sources'
        : event.key === 'End'
          ? 'file'
          : sourcesSelected
            ? 'file'
            : 'sources'
    )
  }

  if (!sourcesOpen && !fileOpen) return null

  return (
    <aside
      ref={panel}
      className="conversation-sources-side-panel"
      aria-label="侧面板"
      style={{ flexBasis: width }}
    >
      <header className="conversation-side-panel-header">
        <div className="conversation-side-panel-tabs" role="tablist" aria-label="打开的标签页">
          {sourcesOpen && (
            <div className="conversation-side-panel-tab">
              <button
                type="button"
                id="thread-sources-tab"
                ref={sourcesTab}
                role="tab"
                aria-selected={sourcesSelected}
                aria-controls="thread-sources-viewport"
                tabIndex={sourcesSelected ? 0 : -1}
                onClick={() => onSelect('sources')}
                onKeyDown={moveTab}
              >
                <span>来源</span>
              </button>
              <button
                type="button"
                className="conversation-side-panel-close"
                aria-label="关闭来源"
                title="关闭来源"
                onClick={onCloseSources}
              >
                <ThreadSummaryIcon name="close" size={14} />
              </button>
            </div>
          )}
          {fileOpen && (
            <div className="conversation-side-panel-tab">
              <button
                type="button"
                id="thread-source-file-tab"
                ref={fileTab}
                role="tab"
                aria-selected={!sourcesSelected}
                aria-controls="thread-source-file-viewport"
                tabIndex={sourcesSelected ? -1 : 0}
                title={filePath}
                onClick={() => onSelect('file')}
                onKeyDown={moveTab}
              >
                <ThreadSummaryIcon name="file" size={16} />
                <span>{fileName}</span>
              </button>
              <button
                type="button"
                className="conversation-side-panel-close"
                aria-label="关闭源码查看"
                title="关闭源码查看"
                onClick={onCloseFile}
              >
                <ThreadSummaryIcon name="close" size={14} />
              </button>
            </div>
          )}
        </div>
      </header>
      <div
        id="thread-sources-viewport"
        className="thread-sources-viewport"
        role="tabpanel"
        aria-labelledby="thread-sources-tab"
        hidden={!sourcesSelected}
        inert={!sourcesSelected}
        tabIndex={0}
      >
        <ul className="thread-sources-list" aria-label="来源">
          {sources.map((source) => {
            const path = source.reference.path
            const label = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
            return (
              <li className="thread-source-details" key={source.key}>
                <button
                  type="button"
                  className="thread-source-open"
                  aria-label={label}
                  onClick={(event) =>
                    onOpenFile(source.reference, source.origin, event.currentTarget)
                  }
                >
                  <span className="thread-source-leading">
                    <ThreadSummaryIcon name="file" size={18} />
                  </span>
                  <span className="thread-source-labels">
                    <span className="thread-source-name">{label}</span>
                    <span className="thread-source-path">{path}</span>
                  </span>
                </button>
                <div className="thread-source-description">已附加到此会话</div>
              </li>
            )
          })}
        </ul>
      </div>
      <div
        id="thread-source-file-viewport"
        className="thread-source-file-viewport"
        role="tabpanel"
        aria-labelledby="thread-source-file-tab"
        hidden={sourcesSelected}
        inert={sourcesSelected}
      >
        <FileViewPanel
          state={fileState}
          onClose={onCloseFile}
          embedded
          active={active && !sourcesSelected}
        />
      </div>
    </aside>
  )
}
