import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalResult, TerminalSize } from '../../../../shared/terminal'
import { terminalThemeFor } from './terminal-theme'
import type { WorkbenchContext } from '../../../../shared/workbench'

export type TerminalPanelHandle = { close: () => Promise<boolean> }
type Controls = TerminalPanelHandle & { start: () => void; focus: () => void; fit: () => void }

function boundedError(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : reason
  return typeof message === 'string' && message ? message.slice(0, 300) : fallback
}

export function TerminalPanel({
  onClose,
  visible = true,
  context,
  autoStart = false,
  embedded = false,
  ref
}: {
  onClose: () => void
  visible?: boolean
  context?: WorkbenchContext
  autoStart?: boolean
  embedded?: boolean
  ref?: Ref<TerminalPanelHandle>
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<Controls | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('未启动')
  const [size, setSize] = useState('等待测量')
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const [cleanupRequired, setCleanupRequired] = useState(false)
  const onCloseRef = useRef(onClose)
  const initialContext = useRef(context)
  const initialAutoStart = useRef(autoStart)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
    initialContext.current = context
  }, [onClose, context])

  useImperativeHandle(
    ref,
    () => ({
      close: () => {
        if (controlsRef.current) return controlsRef.current.close()
        onCloseRef.current()
        return Promise.resolve(true)
      }
    }),
    []
  )

  useEffect(() => {
    // 设置只隐藏面板；恢复可见时重新测量，不抢设置页的返回焦点。
    if (visible) controlsRef.current?.fit()
  }, [visible])

  useEffect(() => {
    const element = hostRef.current
    if (!element) return
    const host = element
    let disposed = false
    let id: string | null = null
    let active = false
    let starting = false
    let closePending = false
    let requiresCleanup = false
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
      theme: terminalThemeFor(host)
    })
    const fit = new FitAddon()

    function interactive(): boolean {
      return (
        !disposed &&
        host.isConnected &&
        host.clientWidth > 0 &&
        host.clientHeight > 0 &&
        !host.closest('[hidden], [inert]') &&
        !document.querySelector('dialog[open], [popover]:popover-open')
      )
    }

    function focus(): void {
      if (interactive()) term.focus()
    }

    function dimensions(): TerminalSize {
      return {
        cols: Math.max(2, Math.min(term.cols, 500)),
        rows: Math.max(1, Math.min(term.rows, 300))
      }
    }

    function report(request: Promise<TerminalResult>, sessionId: string): void {
      void request
        .then((result) => {
          if (!disposed && id === sessionId && !result.ok)
            setError(boundedError(result.error, '终端通信失败'))
        })
        .catch((reason: unknown) => {
          if (!disposed && id === sessionId) {
            setError(boundedError(reason, '终端通信失败'))
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

    async function failedStart(sessionId: string, reason: unknown): Promise<void> {
      const startupError = boundedError(reason, '终端启动失败')
      let cleanupError = ''
      try {
        const result = await window.api.closeTerminal(sessionId)
        if (!result.ok) cleanupError = boundedError(result.error, '终端清理失败')
      } catch (cause: unknown) {
        cleanupError = boundedError(cause, '终端清理失败')
      }
      if (disposed) {
        if (cleanupError) console.error('终端清理失败：', cleanupError)
        return
      }
      if (id !== sessionId) return
      starting = false
      active = false
      requiresCleanup = Boolean(cleanupError)
      setCleanupRequired(requiresCleanup)
      if (requiresCleanup) {
        // 关闭未确认成功时保留旧 ID；不得新建会话而丢失可重试的清理句柄。
        setStatus('清理失败')
        setError(`${startupError.slice(0, 180)}；${cleanupError.slice(0, 80)}。请重试关闭终端。`)
      } else {
        id = null
        setStatus('启动失败')
        setError(startupError)
      }
    }

    async function start(): Promise<void> {
      if (!interactive() || active || starting || closePending || requiresCleanup) return
      // 在 invoke 前确定 ID；启动输出可能比 invoke 的结果更早到。
      const sessionId = crypto.randomUUID()
      id = sessionId
      starting = true
      active = true
      setError('')
      setStatus('启动中')
      try {
        const result = await window.api.startTerminal(
          sessionId,
          dimensions(),
          initialContext.current
        )
        if (disposed) {
          // 卸载时的关闭可能早于结果到达，再按旧 ID 关闭一次。
          const closed = await window.api.closeTerminal(sessionId)
          if (!closed.ok) console.error('终端清理失败：', closed.error)
          return
        }
        if (id !== sessionId) return
        starting = false
        if (!result.ok) {
          await failedStart(sessionId, result.error)
          return
        }
        // shell 可能已快速退出，不能把 exit 事件覆盖为“运行中”。
        if (active) {
          setStatus('运行中')
          lastSize = ''
          scheduleFit()
          focus()
        }
      } catch (reason) {
        // 创建可能已成功，只是响应失败；尝试关闭这次 ID。
        await failedStart(sessionId, reason)
      }
    }

    async function close(): Promise<boolean> {
      if (disposed || closePending) return false
      closePending = true
      setClosing(true)
      setError('')
      try {
        if (id) {
          const result = await window.api.closeTerminal(id)
          if (disposed) return false
          if (!result.ok) throw new Error(result.error)
        }
        active = false
        id = null
        onCloseRef.current()
        return true
      } catch (reason: unknown) {
        if (!disposed) {
          closePending = false
          setClosing(false)
          setError(boundedError(reason, '终端关闭失败，请重试。'))
        }
        return false
      }
    }

    // 在浏览器布局帧中初始化外部终端，再把初始化结果同步给 React。
    const initializationFrame = requestAnimationFrame(() => {
      if (disposed) return
      try {
        term.loadAddon(fit)
        term.open(host)
        if (!initialAutoStart.current) term.writeln('点击“启动终端”开始本地 Shell。')
        // 先订阅，再允许按钮启动进程，避免丢掉最初的提示符。
        unsubscribe = window.api.onTerminalEvent((event) => {
          if (disposed || event.sessionId !== id) return
          if (event.type === 'data') {
            term.write(event.data)
          } else {
            active = false
            starting = false
            id = null
            requiresCleanup = false
            setCleanupRequired(false)
            setStatus(`已退出（${event.exitCode}）`)
            term.writeln(`\r\n[Shell 已退出，退出码 ${event.exitCode}]`)
          }
        })
        input = term.onData((data) => {
          if (!interactive() || !id || !active || starting || closePending) return
          // 不自行回显、不 trim，也不把 Ctrl+C 转换成关闭整个终端。
          report(window.api.writeTerminal(id, data), id)
        })
        observer = new ResizeObserver(scheduleFit)
        observer.observe(host)
        controlsRef.current = {
          start: () => {
            void start()
          },
          focus,
          fit: scheduleFit,
          close
        }
        setReady(true)
        scheduleFit()
        if (initialAutoStart.current) void start()
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
    <section
      className={`terminal-panel${embedded ? ' terminal-tab-panel' : ''}`}
      aria-label="本地终端"
    >
      <div className="terminal-toolbar">
        <strong role="status">本地 Shell · {closing ? '关闭中' : status}</strong>
        <span>{size}</span>
        <button
          type="button"
          disabled={!ready || busy || closing || cleanupRequired}
          onClick={() => controlsRef.current?.start()}
        >
          启动终端
        </button>
        <button
          type="button"
          disabled={!ready || closing}
          onClick={() => controlsRef.current?.focus()}
        >
          聚焦输入
        </button>
        <button
          id="terminal-panel-close"
          type="button"
          disabled={closing}
          onClick={() => {
            if (controlsRef.current) controlsRef.current.close()
            else onClose()
          }}
        >
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
