import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { browserDestination } from '../../../../shared/workbench'
import type { PanelTab } from '../../../../shared/workbench'

type BrowserView = HTMLElement & {
  loadURL: (url: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  getURL: () => string
  getTitle: () => string
}
export function BrowserTab({
  conversationId,
  tab,
  autoLoad,
  onChange
}: {
  conversationId: string
  tab: Extract<PanelTab, { kind: 'browser' }>
  autoLoad: boolean
  onChange: (patch: { url?: string; title?: string }) => void
}): React.JSX.Element {
  const [partition, setPartition] = useState('')
  const [address, setAddress] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [initialUrl] = useState(autoLoad ? tab.url : 'about:blank')
  const [url, setUrl] = useState(initialUrl)
  const pendingURL = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [navigation, setNavigation] = useState({ back: false, forward: false })
  const guest = useRef<BrowserView | null>(null)
  const [ready, setReady] = useState(false)
  const guestReady = useRef(false)
  const change = useRef(onChange)
  useLayoutEffect(() => {
    change.current = onChange
  }, [onChange])
  const attachGuest = useCallback((node: BrowserView | null): void => {
    guest.current = node
  }, [])
  useEffect(() => {
    let disposed = false
    void window.api
      .prepareBrowserTab(conversationId, tab.id)
      .then((result) => {
        if (!disposed) {
          if (result.ok) setPartition(result.data)
          else setError(result.error)
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason))
      })
    return () => {
      disposed = true
      void window.api.closeBrowserTab(conversationId, tab.id)
    }
  }, [conversationId, tab.id])
  useLayoutEffect(() => {
    const view = guest.current
    if (!partition || !view) return
    const sync = (): void => {
      const currentUrl = view.getURL()
      if (currentUrl !== 'about:blank') {
        setAddress(currentUrl)
        change.current({ url: currentUrl, title: view.getTitle() || '浏览器' })
      }
      setNavigation({ back: view.canGoBack(), forward: view.canGoForward() })
    }
    const domReady = (): void => {
      guestReady.current = true
      setReady(true)
      if (pendingURL.current) {
        const pending = pendingURL.current
        pendingURL.current = null
        void view.loadURL(pending).catch((reason) => setError(String(reason)))
      }
      sync()
    }
    const start = (): void => {
      setLoading(true)
      setError('')
    }
    const stop = (): void => {
      setLoading(false)
      sync()
    }
    const fail = (event: Event): void => {
      const detail = event as Event & {
        errorCode: number
        errorDescription: string
        isMainFrame: boolean
      }
      if (detail.errorCode !== -3 && detail.isMainFrame) {
        setLoading(false)
        setError(detail.errorDescription || '页面加载失败')
      }
    }
    view.addEventListener('dom-ready', domReady)
    view.addEventListener('did-start-loading', start)
    view.addEventListener('did-stop-loading', stop)
    view.addEventListener('did-navigate-in-page', sync)
    view.addEventListener('page-title-updated', sync)
    view.addEventListener('did-fail-load', fail)
    return () => {
      view.removeEventListener('dom-ready', domReady)
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-navigate-in-page', sync)
      view.removeEventListener('page-title-updated', sync)
      view.removeEventListener('did-fail-load', fail)
    }
  }, [partition])
  function navigate(value: string): void {
    try {
      const destination = browserDestination(value)
      setError('')
      setAddress(destination)
      setUrl(destination)
      change.current({ url: destination })
      if (guestReady.current && guest.current)
        void guest.current.loadURL(destination).catch((reason) => setError(String(reason)))
      else pendingURL.current = destination
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '网址无效')
    }
  }
  return (
    <div className="panel-browser">
      <form
        className="panel-browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          navigate(address)
        }}
      >
        <button
          type="button"
          aria-label="后退"
          disabled={!navigation.back}
          onClick={() => guest.current?.goBack()}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!navigation.forward}
          onClick={() => guest.current?.goForward()}
        >
          ›
        </button>
        <button
          type="button"
          aria-label="刷新"
          disabled={!ready}
          onClick={() => guest.current?.reload()}
        >
          ↻
        </button>
        <input
          aria-label="搜索或输入网址"
          placeholder="搜索或输入网址"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button type="submit" aria-label="访问网址">
          ↵
        </button>
        <button
          type="button"
          title="在外部浏览器打开"
          disabled={!/^https?:/.test(tab.url)}
          onClick={() => void window.api.openExternal(tab.url)}
        >
          ↗
        </button>
      </form>
      {loading && (
        <div className="panel-browser-progress" role="status">
          正在加载…
        </div>
      )}
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {url === 'about:blank' && (
        <div className="panel-browser-empty">
          <strong>{tab.url === 'about:blank' ? '浏览器' : '恢复网页'}</strong>
          <p>输入网址或关键词开始浏览。</p>
          {tab.url !== 'about:blank' && (
            <button type="button" onClick={() => navigate(tab.url)}>
              加载 {tab.url}
            </button>
          )}
        </div>
      )}
      {partition && (
        <webview
          ref={attachGuest}
          src={initialUrl}
          // React must serialize this native Electron boolean attribute as a string.
          // Popups are intercepted by the main process and become content tabs.
          // eslint-disable-next-line react/no-unknown-property
          allowpopups={'' as unknown as boolean}
          // Electron's isolated guest uses this native webview attribute.
          // eslint-disable-next-line react/no-unknown-property
          partition={partition}
          className={`panel-browser-webview${url === 'about:blank' ? ' empty' : ''}`}
        />
      )}
    </div>
  )
}
