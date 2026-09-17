import { useEffect, useRef, useState } from 'react'
import type { AgentMode, AgentResult } from '../../../shared/agent'

export function AgentPractice({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [prompt, setPrompt] = useState('请查询香港当前时间，并说明时区。')
  const [mode, setMode] = useState<AgentMode>('mock')
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<AgentResult | null>(null)
  const [error, setError] = useState('')
  const activeId = useRef<string | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const id = activeId.current
      activeId.current = null
      if (id) void window.api.cancelAgentPractice(id).catch(console.error)
    }
  }, [])

  async function start(): Promise<void> {
    if (activeId.current || !prompt.trim()) return
    const id = crypto.randomUUID()
    activeId.current = id
    setBusy(true)
    setStopping(false)
    setError('')
    setResult(null)
    try {
      const reply = await window.api.startAgentPractice(id, prompt, mode)
      if (mounted.current && activeId.current === id) setResult(reply)
    } catch {
      if (mounted.current && activeId.current === id) setError('工具练习通信失败')
    } finally {
      if (mounted.current && activeId.current === id) {
        activeId.current = null
        setBusy(false)
        setStopping(false)
      }
    }
  }

  async function stop(): Promise<void> {
    const id = activeId.current
    if (!id) return
    setStopping(true)
    try {
      const accepted = await window.api.cancelAgentPractice(id)
      if (mounted.current && activeId.current === id && !accepted) {
        setError('任务可能已结束，正在等待最终结果')
        setStopping(false)
      }
    } catch {
      if (mounted.current && activeId.current === id) {
        setError('取消请求未送达，可以重试停止')
        setStopping(false)
      }
    }
  }

  return (
    <section
      aria-label="AI 工具练习"
      style={{ maxHeight: 360, overflow: 'auto', padding: 16, flexShrink: 0 }}
    >
      <strong>AI 工具练习</strong>
      <p>模拟模式不联网，固定查询香港时间；真实模式会向已配置的模型服务发送问题和时间结果。</p>
      <label>
        模式
        <select
          disabled={busy}
          value={mode}
          onChange={(event) => setMode(event.target.value === 'live' ? 'live' : 'mock')}
        >
          <option value="mock">模拟响应</option>
          <option value="live">真实模型</option>
        </select>
      </label>
      <textarea
        aria-label="练习问题"
        value={prompt}
        disabled={busy}
        maxLength={2000}
        rows={2}
        style={{ display: 'block', width: '100%' }}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button
        type="button"
        disabled={busy || !prompt.trim()}
        onClick={() => {
          void start()
        }}
      >
        {busy ? '运行中…' : '开始练习'}
      </button>
      <button
        type="button"
        disabled={!busy || stopping}
        onClick={() => {
          void stop()
        }}
      >
        {stopping ? '停止中…' : '停止'}
      </button>
      <button type="button" onClick={onClose}>
        关闭练习
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <ol>
            {result.trace.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ol>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {result.status === 'done'
              ? result.answer
              : result.status === 'cancelled'
                ? '已停止'
                : result.error}
          </p>
        </>
      )}
    </section>
  )
}
