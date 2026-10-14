import { useEffect, useRef, useState } from 'react'
import type { DirectoryEntry, WorkbenchContext } from '../../../../shared/workbench'
import { Icon } from '../../components/ui/Icon'
export function FilesTab({
  context,
  contextKey,
  active,
  onOpen
}: {
  context: WorkbenchContext
  contextKey: string
  active: boolean
  onOpen: (path: string) => void
}): React.JSX.Element {
  const [path, setPath] = useState('')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<DirectoryEntry[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sequence = useRef(0)
  useEffect(() => {
    if (!active) return
    const request = ++sequence.current
    const timer = setTimeout(
      () => {
        setBusy(true)
        setError('')
        void window.api
          .listPanelDirectory(context, search ? '' : path, search || undefined)
          .then((result) => {
            if (sequence.current !== request) return
            if (result.ok) setEntries(result.data)
            else {
              setEntries([])
              setError(result.error)
            }
          })
          .catch((reason) => {
            if (sequence.current === request) setError(String(reason))
          })
          .finally(() => {
            if (sequence.current === request) setBusy(false)
          })
      },
      search ? 200 : 0
    )
    return () => {
      clearTimeout(timer)
      sequence.current++
    }
  }, [contextKey, active, path, search])
  return (
    <div className="panel-files">
      <div className="panel-files-toolbar">
        <button
          type="button"
          disabled={!path}
          onClick={() => {
            setPath(path.split(/[\\/]/).slice(0, -1).join('/'))
            setSearch('')
          }}
        >
          上一级
        </button>
        <span>{path || '项目文件'}</span>
        <input
          aria-label="搜索项目文件"
          placeholder="搜索文件…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {busy && <p role="status">正在读取…</p>}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      <div className="panel-files-list">
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            onClick={() => {
              if (entry.directory) {
                setPath(entry.path)
                setSearch('')
              } else onOpen(entry.path)
            }}
          >
            <Icon name={entry.directory ? 'folder' : 'file'} size={17} />
            <span>{search ? entry.path : entry.name}</span>
            {entry.directory && <Icon name="chevron" size={12} />}
          </button>
        ))}
      </div>
    </div>
  )
}
