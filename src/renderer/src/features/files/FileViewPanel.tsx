import { useLayoutEffect, useMemo, useRef } from 'react'
import { Icon } from '../../components/ui/Icon'
import { highlightSourceLines } from './source-highlight'
import type { FileViewState } from './useFileView'

function languageFor(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        html: 'xml',
        htm: 'xml',
        xml: 'xml',
        svg: 'xml',
        css: 'css',
        py: 'python',
        sh: 'bash',
        ps1: 'powershell',
        sql: 'sql',
        yml: 'yaml',
        yaml: 'yaml',
        diff: 'diff',
        patch: 'diff'
      } as Record<string, string>
    )[extension] ?? ''
  )
}

export function FileViewPanel({
  state,
  onClose
}: {
  state: FileViewState
  onClose: () => void
}): React.JSX.Element | null {
  const scroll = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const result = state.status === 'ready' ? state.result : null
  const lines = useMemo(
    () => (result ? highlightSourceLines(result.text, languageFor(result.path)) : []),
    [result]
  )
  const lineEndings = useMemo(() => result?.text.match(/\r\n|\n|\r/g) ?? [], [result])
  const opened = state.status !== 'idle'
  const reference = opened ? state.reference : null
  const startLine = reference?.startLine
  const endLine = reference?.endLine ?? startLine
  const requestedLine = startLine ?? 1
  const outside = !!result && requestedLine > result.lineCount
  const clipped = !!result && !!endLine && endLine > result.lineCount && !outside

  useLayoutEffect(() => {
    if (opened) closeButton.current?.focus({ preventScroll: true })
  }, [opened, reference])

  useLayoutEffect(() => {
    const area = scroll.current
    if (!area || !result) return
    const line = area.querySelector<HTMLElement>(`[data-line="${outside ? 1 : requestedLine}"]`)
    area.scrollLeft = 0
    area.scrollTop = line
      ? line.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 24
      : 0
  }, [result, requestedLine, outside])

  if (state.status === 'idle') return null
  const path = result?.path ?? state.reference.path
  const fileName = result?.fileName ?? path.split(/[\\/]/).at(-1) ?? path
  return (
    <aside className="file-view-panel" aria-label="源码查看">
      <header className="file-view-header">
        <Icon name="file" size={16} />
        <strong title={path}>{fileName}</strong>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="关闭源码查看"
          title="关闭源码查看（Escape）"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="file-view-source">
        <span>
          {state.origin.source.kind === 'snapshot' ? '已选文件快照 · 只读' : '当前磁盘文件 · 只读'}
        </span>
        <span title={path}>{path}</span>
      </div>
      {state.status === 'loading' && (
        <p className="file-view-notice" role="status">
          正在读取文件…
        </p>
      )}
      {state.status === 'error' && (
        <p className="file-view-notice file-view-error" role="alert">
          {state.error}
        </p>
      )}
      {result && (
        <>
          {(outside || clipped) && (
            <p className="file-view-notice" role="status">
              {outside
                ? `引用的第 ${requestedLine} 行超出文件末尾（共 ${result.lineCount} 行）。`
                : `引用范围超出文件末尾，已标记到第 ${result.lineCount} 行。`}
            </p>
          )}
          <div className="file-view-scroll" ref={scroll} tabIndex={0} aria-label="源码内容">
            <pre className="file-view-code">
              <code>
                {lines.map((line, index) => {
                  const number = index + 1
                  const targeted =
                    !!startLine && number >= startLine && number <= (endLine ?? startLine)
                  return (
                    <span
                      key={number}
                      data-line={number}
                      className={`file-view-line${targeted ? ' file-view-line-target' : ''}`}
                    >
                      <span className="file-view-line-number" aria-hidden="true">
                        {number}
                      </span>
                      <span className="file-view-line-text">
                        {line}
                        {lineEndings[index]}
                      </span>
                    </span>
                  )
                })}
              </code>
            </pre>
          </div>
        </>
      )}
    </aside>
  )
}
