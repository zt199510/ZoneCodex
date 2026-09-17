import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
/// 真实流练习组件
function ModelStreamPractice(): React.JSX.Element {
  // 组件状态
  const [input, setInput] = useState('请用三句话介绍 TypeScript')
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState('尚未开始')
  const [error, setError] = useState<string | null>(null)
  const currentId = useRef<string | null>(null)
  const subscribed = useRef(false)

  // 组件挂载时注册模拟流增量事件监听器，并在卸载时取消订阅和清理
  useEffect(() => {
    const unsubscribe = window.api.onModelDelta((event) => {
      if (event.requestId !== currentId.current) return
      setOutput((previous) => previous + event.delta)
    })
    subscribed.current = true
    setReady(true)

    return () => {
      subscribed.current = false
      unsubscribe()
      const id = currentId.current
      currentId.current = null
      if (id !== null) {
        void window.api.cancelModelStream(id).catch(() => {
          // 组件已卸载，不再更新它的 UI；页面加载/窗口退出另有主进程清理。
        })
      }
    }
  }, [])

  // 开始模拟流生成
  async function start(): Promise<void> {
    const content = input.trim()
    if (!subscribed.current || currentId.current !== null || !content) return
    if (content.length > 200) {
      setError('请输入不超过 200 个字符的内容。')
      return
    }
    const id = crypto.randomUUID()
    currentId.current = id
    setOutput('')
    setError(null)
    setStatus('正在生成')
    setRunning(true)

    try {
      const result = await window.api.startModelStream(id, [{ role: 'user', content }])
      if (currentId.current !== id) return
      if (result.status === 'error') {
        setError(result.error)
        setStatus('生成失败')
      } else {
        setStatus(result.status === 'done' ? '已完成' : '已停止')
      }
    } catch {
      if (currentId.current === id) {
        setError('真实流通信失败，请重试。')
        setStatus('生成失败')
      }
    } finally {
      if (currentId.current === id) {
        currentId.current = null
        setRunning(false)
      }
    }
  }
  // 停止模拟流生成
  async function stop(): Promise<void> {
    const id = currentId.current
    if (id === null) return
    try {
      await window.api.cancelModelStream(id)
    } catch {
      if (currentId.current === id) setError('停止请求失败，请等待任务结束。')
    }
  }
  // 处理表单提交事件
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void start()
  }

  return (
    <section aria-label="模拟流练习">
      <h2>真实流练习</h2>
      <p>本区域发送单轮真实请求，可能产生费用。</p>
      <form onSubmit={handleSubmit}>
        <label htmlFor="model-stream-input">练习内容</label>
        <input
          id="model-stream-input"
          value={input}
          maxLength={200}
          disabled={running}
          onChange={(event) => setInput(event.currentTarget.value)}
        />
        <button type="submit" disabled={!ready || running || !input.trim()}>
          开始请求
        </button>
        <button
          type="button"
          disabled={!running}
          onClick={() => {
            void stop()
          }}
        >
          停止生成
        </button>
      </form>
      <p role="status">{status}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{output || '这里将显示分段回复。'}</p>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

export default ModelStreamPractice
