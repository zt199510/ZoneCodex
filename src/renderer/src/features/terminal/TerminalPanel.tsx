import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalResult, TerminalSize } from '../../../../shared/terminal'
import '@xterm/xterm/css/xterm.css'

type Controls = { start: () => void; focus: () => void }

export function TerminalPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<Controls | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('未启动')
  const [size, setSize] = useState('等待测量')
  const [error, setError] = useState('')

  useEffect(() => {
    const element = hostRef.current
    if (!element) return
    const host = element
    let disposed = false
    let id: string | null = null
    let active = false
    let starting = false
    let frame: number | null = null
    let lastSize = ''
    let observer: ResizeObserver | null = null
    let input: { dispose: () => void } | null = null
    let unsubscribe: (() => void) | null = null
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      scrollback: 1000,
      theme: { background: '#18201c', foreground: '#e2e9e4' }
    })
    const fit = new FitAddon()

    function dimensions(): TerminalSize {
      return {
        cols: Math.max(2, Math.min(term.cols, 500)),
        rows: Math.max(1, Math.min(term.rows, 300))
      }
    }

    function report(request: Promise<TerminalResult>, sessionId: string): void {
      void request
        .then((result) => {
          if (!disposed && id === sessionId && !result.ok) setError(result.error)
        })
        .catch((reason: unknown) => {
          if (!disposed && id === sessionId) {
            setError(reason instanceof Error ? reason.message : '终端通信失败')
          }
        })
    }

    function scheduleFit(): void {
      if (disposed || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return
        try {
          fit.fit()
          const measured = dimensions()
          term.resize(measured.cols, measured.rows)
          const key = `${measured.cols}×${measured.rows}`
          setSize(`${measured.cols} 列 × ${measured.rows} 行`)
          if (id && active && !starting && key !== lastSize) {
            lastSize = key
            report(window.api.resizeTerminal(id, measured), id)
          }
        } catch {
          setError('终端尺寸调整失败，请关闭后重新打开。')
        }
      })
    }

    async function start(): Promise<void> {
      if (disposed || active || starting) return
      // 在 invoke 前确定 ID；启动输出可能比 invoke 的结果更早到。
      const sessionId = crypto.randomUUID()
      id = sessionId
      starting = true
      active = true
      setError('')
      setStatus('启动中')
      try {
        const result = await window.api.startTerminal(sessionId, dimensions())
        if (disposed) {
          // 卸载时的关闭可能早于结果到达，再按旧 ID 关闭一次。
          const closed = await window.api.closeTerminal(sessionId)
          if (!closed.ok) console.error('终端清理失败：', closed.error)
          return
        }
        if (id !== sessionId) return
        starting = false
        if (!result.ok) {
          active = false
          id = null
          setStatus('启动失败')
          setError(result.error)
          return
        }
        // shell 可能已快速退出，不能把 exit 事件覆盖为“运行中”。
        if (active) {
          setStatus('运行中')
          lastSize = ''
          scheduleFit()
          term.focus()
        }
      } catch (reason) {
        // 创建可能已成功，只是响应失败；尝试关闭这次 ID。
        void window.api
          .closeTerminal(sessionId)
          .then((result) => {
            if (!result.ok) console.error('终端清理失败：', result.error)
          })
          .catch(console.error)
        if (!disposed && id === sessionId) {
          starting = false
          active = false
          id = null
          setStatus('启动失败')
          setError(reason instanceof Error ? reason.message : '终端启动失败')
        }
      }
    }

    // 在浏览器布局帧中初始化外部终端，再把初始化结果同步给 React。
    const initializationFrame = requestAnimationFrame(() => {
      if (disposed) return
      try {
        term.loadAddon(fit)
        term.open(host)
        term.writeln('点击“启动 PowerShell”，工作目录固定为用户主目录。')
        // 先订阅，再允许按钮启动进程，避免丢掉最初的提示符。
        unsubscribe = window.api.onTerminalEvent((event) => {
          if (disposed || event.sessionId !== id) return
          if (event.type === 'data') {
            term.write(event.data)
          } else {
            active = false
            setStatus(`已退出（${event.exitCode}）`)
            term.writeln(`\r\n[PowerShell 已退出，退出码 ${event.exitCode}]`)
          }
        })
        input = term.onData((data) => {
          if (disposed || !id || !active || starting) return
          // 不自行回显、不 trim，也不把 Ctrl+C 转换成关闭整个终端。
          report(window.api.writeTerminal(id, data), id)
        })
        observer = new ResizeObserver(scheduleFit)
        observer.observe(host)
        controlsRef.current = {
          start: () => {
            void start()
          },
          focus: () => term.focus()
        }
        setReady(true)
        scheduleFit()
        void document.fonts.ready.then(() => {
          if (!disposed) scheduleFit()
        })
      } catch {
        setError('终端初始化失败，请核对依赖、桥接方法和样式。')
      }
    })

    return () => {
      disposed = true
      cancelAnimationFrame(initializationFrame)
      controlsRef.current = null
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      input?.dispose()
      unsubscribe?.()
      if (id) {
        void window.api
          .closeTerminal(id)
          .then((result) => {
            if (!result.ok) console.error('终端清理失败：', result.error)
          })
          .catch(console.error)
      }
      term.dispose()
    }
  }, [])

  const busy = status === '启动中' || status === '运行中'
  return (
    <section className="terminal-panel" aria-label="本地终端">
      <div className="terminal-toolbar">
        <strong>PowerShell · {status}</strong>
        <span>{size}</span>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => controlsRef.current?.start()}
        >
          启动 PowerShell
        </button>
        <button type="button" disabled={!ready} onClick={() => controlsRef.current?.focus()}>
          聚焦输入
        </button>
        <button type="button" onClick={onClose}>
          关闭面板并结束终端
        </button>
      </div>
      {error && (
        <p role="alert" className="terminal-error">
          {error}
        </p>
      )}
      <div className="terminal-host" ref={hostRef} />
      <p className="terminal-input-note">
        手动执行真实命令；Ctrl+C 中断当前命令，exit 退出 shell。
      </p>
    </section>
  )
}
