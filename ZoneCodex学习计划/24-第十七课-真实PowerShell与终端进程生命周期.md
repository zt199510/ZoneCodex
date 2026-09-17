# 第十七课：真实 PowerShell 与终端进程生命周期

本课接续[第十六课](22-第十六课-终端界面入门与生命周期.md)。目标：在现有终端面板中手动启动一个 PowerShell，输入 `Get-Location` 并看到真实结果，关闭面板时释放对应进程。按步骤亲手实现；下方代码是课程示例，尚未写入正式源码。

## 1. 本课目标与课前核对

完成后应能解释这条链：

```text
键盘 → xterm.onData → preload → IPC → node-pty.write → PowerShell
屏幕 ← xterm.write  ← preload ← IPC ← node-pty.onData ← PowerShell
```

xterm 是屏幕和键盘；node-pty 连接伪终端；PowerShell 解释命令。上一课的定时器和模拟 Ctrl+C 本课会移除，回显、历史记录与行编辑交给真实 shell。

2026-09-16 编写时核对：Windows 10.0.26200、x64、Node v24.11.1；package.json 声明 Electron ^39.2.6，实际安装为 **39.8.10**；xterm 5.5 系列和 FitAddon 已安装，node-pty 尚未安装。实际 Electron 版本与安装 Node 的版本是两回事。

本课范围：Windows、本地、每个窗口最多一个终端；固定使用 Windows PowerShell 和用户主目录。工作目录不跟随聊天会话，也不接入模型自动执行命令。暂不做多标签、SSH、输出持久化、后台任务和完整退出协调。

先复习第十六课第 11 节中的输入方向、Effect 和清理。遇到不理解的点可以边做边回看，不需要先背下所有 API。

## 2. 用 Vue 经验理解本课

| 熟悉的概念 | 本课 React / Electron 中的对应关系 |
|---|---|
| onMounted / onUnmounted 挂载与销毁第三方实例 | Effect 创建 xterm、注册订阅，cleanup 释放资源 |
| ref 控制按钮文字 | useState 保存“未启动 / 启动中 / 运行中 / 已退出” |
| 普通变量保存外部实例 | Effect 闭包保存 Terminal、sessionId 和同步活动标记 |
| emits 触发父组件移除面板 | onClose 改变 App 的 terminalOpen，触发 cleanup |
| 后端连接 ID | sessionId 标识一次 PTY 生命周期，与聊天 conversationId 无关 |

本课选择**点击按钮才启动 shell**。Effect 只准备界面和监听器，便于先看懂生命周期。StrictMode 的 setup → cleanup → setup 不会自动启动两个 PowerShell，但用户在启动请求尚未返回时关面板，仍然需要处理迟到结果。

## 3. 文件与实施顺序

| 文件 | 操作与职责 |
|---|---|
| package.json、package-lock.json | 安装 node-pty 运行时依赖，记录实际版本 |
| src/shared/terminal.ts | 新建：尺寸、事件、输入边界和结果解析 |
| src/shared/api.ts | 给 AppAPI 添加终端专用方法 |
| src/main/terminal/local-terminal.ts | 新建：固定 shell/cwd、窗口归属、进程和 IPC |
| src/main/index.ts | 注册一次 IPC，每个窗口挂载清理钩子 |
| src/preload/index.ts | 暴露业务方法、校验事件、返回取消订阅函数 |
| src/renderer/src/features/terminal/TerminalPanel.tsx | 替换模拟实现，连接真实进程 |
| src/renderer/src/App.tsx | 只将打开按钮文字改成“打开本地终端” |

preload/index.d.ts 已引用 AppAPI，不再复制一套 Window 接口。现有终端 CSS、App 的同级挂载和聊天保存逻辑沿用。路径以[结构地图](02-项目结构地图.md)为准。

## 4. 第一步：安装并理解原生依赖

在项目根目录先关闭开发中的 Electron，再执行：

```powershell
npm install node-pty
npx electron-builder install-app-deps
npm ls node-pty electron
```

node-pty 放在 dependencies，因为应用运行时要加载它。它包含原生模块，不能像纯 TypeScript 文件一样认为“能导入就是能运行”。根项目已有 postinstall，但本课仍显式执行一次 install-app-deps，核对安装日志和目标 Electron 架构。将成功安装的实际版本保留在锁文件里。

安装需要编译时，按 node-pty 的安装错误补齐 Python、Visual Studio Build Tools 的 C++ 桌面开发工具和 Windows SDK；缺少 Spectre 库时按日志安装对应组件。不要通过忽略安装脚本、关闭 StrictMode 或修改类型声明来掩盖原生加载失败。

现有 electron-builder.yml 设置了 npmRebuild: false。本课只验收开发环境；升级 Electron 后需重新准备原生依赖。后续打包课再验证目标架构、node-pty 的原生文件及辅助程序是否正确进入解包资源，不能把开发环境成功当成安装包成功。

资料：[node-pty 官方仓库](https://github.com/microsoft/node-pty)、[Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。本课不声称已在当前工程安装或运行这些依赖。

## 5. 第二步：先定义跨进程协议

新建 src/shared/terminal.ts：

```ts
export type TerminalSize = { cols: number; rows: number }
export type TerminalResult = { ok: true } | { ok: false; error: string }
export type TerminalEvent =
  | { sessionId: string; type: 'data'; data: string }
  | { sessionId: string; type: 'exit'; exitCode: number }

export function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

export function isTerminalSize(value: unknown): value is TerminalSize {
  if (typeof value !== 'object' || value === null) return false
  return (
    'cols' in value &&
    typeof value.cols === 'number' &&
    Number.isInteger(value.cols) &&
    value.cols >= 2 &&
    value.cols <= 500 &&
    'rows' in value &&
    typeof value.rows === 'number' &&
    Number.isInteger(value.rows) &&
    value.rows >= 1 &&
    value.rows <= 300
  )
}

export function parseTerminalResult(value: unknown): TerminalResult {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    if (value.ok === true) return { ok: true }
    if (value.ok === false && 'error' in value && typeof value.error === 'string') {
      return { ok: false, error: value.error }
    }
  }
  throw new Error('终端返回结果格式不正确')
}

export function parseTerminalEvent(value: unknown): TerminalEvent | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    !isTerminalId(value.sessionId) ||
    !('type' in value)
  ) {
    return null
  }
  if (value.type === 'data' && 'data' in value && typeof value.data === 'string') {
    return { sessionId: value.sessionId, type: 'data', data: value.data }
  }
  if (
    value.type === 'exit' &&
    'exitCode' in value &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode)
  ) {
    return { sessionId: value.sessionId, type: 'exit', exitCode: value.exitCode }
  }
  return null
}
```

在 shared/api.ts 导入类型，并在现有 AppAPI 内追加这些字段，不覆盖聊天和窗口方法：

```ts
import type { TerminalSize, TerminalResult, TerminalEvent } from './terminal'
```

```ts
  startTerminal: (sessionId: string, size: TerminalSize) => Promise<TerminalResult>
  writeTerminal: (sessionId: string, data: string) => Promise<TerminalResult>
  resizeTerminal: (sessionId: string, size: TerminalSize) => Promise<TerminalResult>
  closeTerminal: (sessionId: string) => Promise<TerminalResult>
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void
```

这里暂时出现 preload 缺少方法的类型错误是正常中间状态，完成第七节再检查。TypeScript 只约束写代码时的调用；主进程收到的参数仍按 unknown 校验。sessionId 是关联标识，真正的归属还要检查 IPC sender。

## 6. 第三步：主进程管理一个 PTY

新建 src/main/terminal/local-terminal.ts：

```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import { isTerminalId, isTerminalSize } from '../../shared/terminal'
import type { TerminalEvent, TerminalResult } from '../../shared/terminal'

type Session = {
  id: string
  process: pty.IPty
  subscriptions: Array<{ dispose: () => void }>
}

const sessions = new Map<number, Session>()

function ownerOf(event: IpcMainInvokeEvent): WebContents {
  if (!BrowserWindow.fromWebContents(event.sender) ||
      event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不支持的终端请求来源')
  }
  return event.sender
}

function emit(owner: WebContents, event: TerminalEvent): void {
  if (!owner.isDestroyed()) owner.send('terminal:event', event)
}

function failure(error: unknown): TerminalResult {
  return { ok: false, error: error instanceof Error ? error.message : '终端操作失败' }
}

function stop(ownerId: number, id?: string): TerminalResult {
  const session = sessions.get(ownerId)
  // 重复关闭和旧 ID 关闭都不能误伤新会话。
  if (!session || (id !== undefined && session.id !== id)) return { ok: true }
  try {
    session.process.kill()
  } catch (error) {
    return failure(error)
  }
  sessions.delete(ownerId)
  session.subscriptions.forEach((subscription) => subscription.dispose())
  return { ok: true }
}

export function attachTerminalCleanup(window: BrowserWindow): void {
  const owner = window.webContents
  const ownerId = owner.id
  const cleanup = (): void => {
    const result = stop(ownerId)
    if (!result.ok) console.error('终端清理失败：', result.error)
  }
  // 页面刷新不能依赖 renderer 的异步 cleanup 一定送达。
  owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanup()
  })
  owner.on('render-process-gone', cleanup)
  owner.once('destroyed', cleanup)
  // 不挂 window.close：关闭保护可能取消这次关闭。
}

export function registerLocalTerminal(): void {
  ipcMain.handle('terminal:start', (event, id: unknown, size: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || !isTerminalSize(size)) {
      return { ok: false, error: '终端 ID 或尺寸无效' }
    }
    if (sessions.has(owner.id)) return { ok: false, error: '当前窗口已有终端，请先关闭' }
    if (process.platform !== 'win32') return { ok: false, error: '本课仅支持 Windows' }

    try {
      const shell = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
      )
      if (!existsSync(shell)) return { ok: false, error: '未找到 Windows PowerShell' }
      const child = pty.spawn(shell, ['-NoLogo', '-NoProfile'], {
        name: 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: app.getPath('home'),
        env: process.env
      })
      const session: Session = { id, process: child, subscriptions: [] }
      sessions.set(owner.id, session)
      session.subscriptions.push(child.onData((data) => {
        if (sessions.get(owner.id) === session) emit(owner, { sessionId: id, type: 'data', data })
      }))
      session.subscriptions.push(child.onExit(({ exitCode }) => {
        if (sessions.get(owner.id) !== session) return
        sessions.delete(owner.id)
        session.subscriptions.forEach((subscription) => subscription.dispose())
        emit(owner, { sessionId: id, type: 'exit', exitCode })
      }))
      return { ok: true }
    } catch (error) {
      // 如果创建后订阅阶段失败，也尝试释放已经记录的资源。
      stop(owner.id, id)
      return failure(error)
    }
  })

  ipcMain.handle('terminal:write', (event, id: unknown, data: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || typeof data !== 'string' || data.length === 0 || data.length > 8192) {
      return { ok: false, error: '终端输入无效或过长（单次最多 8192 字符）' }
    }
    const session = sessions.get(owner.id)
    if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
    try {
      session.process.write(data)
      return { ok: true }
    } catch (error) { return failure(error) }
  })

  ipcMain.handle('terminal:resize', (event, id: unknown, size: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id) || !isTerminalSize(size)) return { ok: false, error: '终端尺寸无效' }
    const session = sessions.get(owner.id)
    if (!session || session.id !== id) return { ok: false, error: '终端已经关闭' }
    try {
      session.process.resize(size.cols, size.rows)
      return { ok: true }
    } catch (error) { return failure(error) }
  })

  ipcMain.handle('terminal:close', (event, id: unknown): TerminalResult => {
    const owner = ownerOf(event)
    if (!isTerminalId(id)) return { ok: false, error: '终端 ID 无效' }
    return stop(owner.id, id)
  })
}
```

再修改 main/index.ts，分两处接线：

```ts
import { registerLocalTerminal, attachTerminalCleanup } from './terminal/local-terminal'
```

- 在 createWindow 内 new BrowserWindow 完成后，紧接现有 attachCloseGuard(mainWindow)，加入 `attachTerminalCleanup(mainWindow)`，必须在 loadURL/loadFile 之前。
- 在 app.whenReady 内 registerModelStream() 附近加入 `registerLocalTerminal()`；它必须在 createWindow() 之前，且整个应用只注册一次，不能放进 createWindow。

先看三个设计点：

1. Map 的 key 是 webContents.id，value 里另有 sessionId。即使另一个窗口知道 ID，也不能控制你的 PTY。
2. start 的处理器同步创建并记录 PTY，没有中间 await。重复点击立即被 Map 拦住，不能只依靠按钮 disabled。
3. 关闭面板主动请求 kill；刷新、renderer 崩溃和窗口销毁由 main 兜底。普通 window.close 可能被聊天关闭保护取消，不能在那里提前杀终端。

kill 失败时保留记录并报告错误，不能把 Map 删除后假装清理成功。node-pty 对普通交互命令的退出行为要实际验收；本课不保证清除通过其他机制脱离终端创建的后台进程，也无法在整个应用被强杀时执行 JavaScript 清理。

## 7. 第四步：preload 桥接与事件订阅

在 preload/index.ts 增加导入：

```ts
import { parseTerminalEvent, parseTerminalResult } from '../shared/terminal'
```

在现有 const api: AppAPI 对象中追加以下属性，注意前一项末尾的逗号：

```ts
  startTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:start', sessionId, size)),
  writeTerminal: async (sessionId, data) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:write', sessionId, data)),
  resizeTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:resize', sessionId, size)),
  closeTerminal: async (sessionId) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:close', sessionId)),
  onTerminalEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const parsed = parseTerminalEvent(value)
      if (parsed) listener(parsed)
    }
    ipcRenderer.on('terminal:event', handler)
    return () => ipcRenderer.removeListener('terminal:event', handler)
  }
```

传给页面的是业务数据，不把 IpcRendererEvent 暴露出去。取消订阅只移除本次 handler，不能 removeAllListeners 误删其他面板的监听。

此时执行 `npm run typecheck`。如果主进程提示 node-pty 不存在，回到安装步骤；不要把 pty 改成 any。如果报 AppAPI 缺少方法，核对上面五个字段是否全部实现。

## 8. 第五步：把模拟面板替换为真实终端

替换 features/terminal/TerminalPanel.tsx。先通读 start、onTerminalEvent 和 return cleanup 三段，再输入代码：

```tsx
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
```

初始化补充：项目启用了 `react-hooks/set-state-in-effect`。将 xterm 的 DOM 初始化、订阅和初始化成功/失败结果一起放进 `requestAnimationFrame` 回调；Effect 本身安排初始化并返回清理函数。卸载时取消初始化帧，并用 disposed 防止旧回调运行，兼容 StrictMode。不要只把 setReady 单独塞进计时器，或关闭检查规则。

本次修正后，正式 TerminalPanel 的 ESLint 和项目 Node/Web 类型检查通过；真实窗口交互仍需按下方步骤验收。

App 仅改按钮文字，保持 TerminalPanel 与 ChatWorkspace 同级，不给它加 conversationId 作为 key。模拟输出、停止模拟、最近输入和 timer 已全部移除。

**为什么 ID 要在 start 前生成？** 输出事件和 invoke 返回结果是两条路径。PowerShell 可以先输出提示符，若等 await 返回才保存 ID，页面可能丢掉最早的数据。本课在点击时先保存 ID，而且监听器早已就绪。

**为什么清理需要两层？** React cleanup 发出的异步请求可能因页面刷新而来不及完成，所以主进程监听导航和销毁兜底。迟到的旧 close 只关闭自己的 sessionId，不能关闭新面板的 shell。

**为什么 fit 之后还要 resizeTerminal？** FitAddon 只调整屏幕；PTY 需要知道相同的行列，shell 才能正确换行。这里限制尺寸并去掉相同行列的重复请求，但未实现生产级高吞吐输出背压；scrollback 1000 只限制显示历史，不能限制 IPC 队列。本课用小量交互命令验收。

## 9. 分步验收：类型通过之后还要看真实进程

```powershell
npm run typecheck
npm run build
npm run dev
```

主进程/preload 变更后完整重启开发进程；仅等待 renderer 热更新不足以加载新桥接和原生模块。构建通过只证明编译接线，不证明 node-pty 能在 Electron 中加载。

启动 PowerShell 后，依次输入这些无文件修改的命令：

```powershell
Get-Location
$PID
$Host.UI.RawUI.WindowSize
Write-Output '你好，ZoneCodex'
1..5 | ForEach-Object { Write-Output $_; Start-Sleep -Seconds 1 }
```

记录 $PID，再开始下面的验收。要查进程是否还活着，在**独立的系统 PowerShell**中执行 `Get-Process -Id 记录的数字 -ErrorAction SilentlyContinue`；不要用刚被关闭的面板查自己，不要批量结束所有 powershell.exe。

| 操作 | 必须观察到的结果 |
|---|---|
| 打开面板但不点启动 | 只有说明文字，没有新 shell |
| 启动并输入 Get-Location | 显示用户主目录，而非假数据；有真实提示符 |
| 输入字母、退格、方向键、Enter | 不出现双重回显，shell 执行行编辑 |
| 执行中文输出 | 正常显示中文；不通过手工替换编码掩盖问题 |
| 五秒循环中按 Ctrl+C | 当前循环停止，shell 仍可运行 Get-Location |
| 调整窗口与侧栏后查询 WindowSize | xterm 行列与 shell 的尺寸同步变化 |
| 输入 exit 7 | 状态显示退出码 7，可再次点启动，产生新 PID |
| 连续点击启动 | 只有一个有效会话，正常输入不重复 |
| 记录 PID 后关闭面板 | 独立 PowerShell 查询不到对应 shell；无清理失败日志 |
| 关闭重开五次 | 每次旧 PID 消失，新面板没有旧输出或重复监听 |
| 点击启动后立刻关闭、再打开 | 旧结果不改变新状态，旧关闭请求不杀新 shell |
| 启动后刷新 renderer | 旧 PID 消失，刷新后的面板重新从未启动开始 |
| 终端运行中切换聊天 | PID 保持，聊天切换和保存仍正常 |
| 有未保存聊天时关闭应用，选择继续编辑 | 窗口保留，终端仍可输入 |
| 正常放行关闭应用 | 记录的 shell PID 消失；聊天关闭保护仍按原行为运行 |

错误路径也要做一次：临时将课程主进程 shell 路径末尾改为不存在的程序名，重启，确认显示“未找到 Windows PowerShell”且按钮恢复；恢复正确路径并重启后应能成功启动。该实验验证路径失败，不代表全部原生加载/进程错误已覆盖。

输入过长会明确拒绝，本课不自动拆分大段粘贴。退出前停止课程练习中的命令。本课关闭应用会结束终端，没有“存在运行任务时再确认”的新弹窗；全局任务退出协调后续再学。

现有 check:workspace 使用业务替身，尚未补齐终端 API，不能当作本课 PTY 验收。不要为了让替身回归通过而绕过正式终端代码。本课不新增测试文件，以已有类型/构建命令、实际窗口观察和 PID 检查记录结果。

## 10. 常见错误与定位顺序

| 现象 | 先查什么 |
|---|---|
| 主进程启动即报 .node、ABI 或模块加载错误 | Electron 实际版本、架构、install-app-deps 日志；普通 node 成功不等于 Electron 成功 |
| 页面报 startTerminal is not a function | preload 是否完整重启、方法是否追加到 api 对象 |
| 有界面没有提示符 | 有没有点击启动、主进程是否注册、事件订阅是否先于 start |
| 输入 a 显示 aa | 是否在 onData 中自行 term.write 回显 |
| Ctrl+C 关闭了整个 PowerShell | 是否错误调用 closeTerminal，而非原样传递 \x03 |
| 换行位置异常 | 是否只调用 FitAddon，没有同步 PTY 行列 |
| 关闭聊天确认框后终端已经死了 | 是否在可取消的 window.close 上清理 |
| 面板关闭后仍有旧 PID | 查看清理失败日志、导航钩子和迟到 start 分支；不能只看 DOM 已消失 |
| 重新打开后收到旧数据 | sessionId 过滤、订阅清理以及 Map 的当前实例判断是否齐全 |

不要记录用户输入和整段终端输出作为调试日志，它们可能包含个人路径或凭据。shell 继承应用进程环境；不要把模型密钥塞进终端启动参数。本课固定 cwd 只是启动位置，**不是文件访问沙箱**：手动终端使用当前用户权限。

## 11. 自测题

1. 输入 Get-Location 时，数据经过哪些文件？哪一层真正解释命令？
2. 为什么 startTerminal 返回 ok 后仍要继续监听事件？它的成功是否代表 shell 永远正常？
3. sessionId 和 webContents.id 分别解决什么问题？为什么不能只校验 ID 是字符串？
4. 为什么先订阅、先确定 ID，再发启动请求？反过来可能漏掉什么？
5. fit.fit() 与 process.resize() 分别调整哪一层？为什么还需要 ResizeObserver？
6. Ctrl+C、exit、关闭面板分别影响什么？它们能否都调用同一个 stop？
7. 为什么主进程不在 window.close 时立即杀 shell？页面刷新又为什么不能只依赖 Effect cleanup？
8. 为什么 TypeScript、构建以及普通 Node 中的 require 成功，都不能单独证明 Electron PTY 可用？

先用自己的话讲清输入、输出、退出三条路径。回答不了就反馈题号，不把代码抄完当成原理已经掌握。

## 12. 学习记录与下一步

最新反馈（2026-09-16）：用户确认第十七课完成，自测八题尚不理解，讲解见第 13 节。已在此前安装 Spectre 库，并完成 node-pty 1.1.0 对 Electron 39.8.10 x64 的重建；修正格式与初始化 Effect 后，面板 ESLint 和 Node/Web 类型检查通过。真实交互、PID 清理等专项没有在本轮独立重跑，不能将完成反馈扩展为全部专项已验证。下方“本课创建时”保留历史状态。

完成后反馈：node-pty 实际版本、安装/重建结果、类型/构建结果、Get-Location 与尺寸表现、Ctrl+C 和 exit 的行为，以及关闭/刷新后的旧 PID 是否消失。日志只保留必要报错，不提供密钥或整份环境变量。

本课创建时：已核对当前源码与环境，示例尚未安装 node-pty 后做完整类型检查或真实 Electron 交互验收。学习进度只记“课程已创建、待实践”，不标记本地终端阶段完成。

文档检查：8 个 TS/TSX 片段语法检查通过（局部字段补齐接口/对象外层后检查），学习目录内 Markdown 文件链接有效。此检查不验证 node-pty 类型兼容性或原生运行行为。

下一课优先进入**最小 AI 工具循环**，先从受控的只读工具认识模型工具请求、参数校验、执行结果和继续回答。交互式 PTY 与 AI 命令工具不是同一个接口；后者还需要任务归属、授权、退出码、超时、取消和输出限制，之后再接项目文件修改、差异审查、命令授权以及 MCP/SSH。

## 13. 自测 1–8 讲解

### 1. 输入命令经过哪些文件，谁解释命令？

TerminalPanel.tsx 中的 xterm.onData 收到键盘数据，调用 window.api.writeTerminal。preload/index.ts 将参数通过 terminal:write IPC 交给 main/terminal/local-terminal.ts；主进程检查窗口、ID 和输入，再调用 session.process.write(data)，由 node-pty 送给 PowerShell。最终是 PowerShell 解释 Get-Location，返回当前目录。

输出走反方向：node-pty 的 onData → 主进程 terminal:event → preload 的事件监听 → 面板 term.write → 屏幕。注意两个 write 的接收对象不同：PTY 的 write 送输入，xterm 的 write 显示输出。shared/terminal.ts 与 shared/api.ts 提供协议、类型和校验，不负责执行命令。输入通常按字符或片段传递，按 Enter 后由 shell 处理完整命令。

### 2. start 返回 ok 后为什么还要监听？

startTerminal 的返回值只报告本次创建和接线是否成功。PowerShell 是持续运行的进程，未来还会有输出，也可能正常退出或异常结束。这些后续变化由 data 和 exit 事件报告，不能塞进已经结束的启动请求里。启动成功也不等于某条命令执行成功；本课 exitCode 是 shell 进程退出码，不是每条命令的结果。

### 3. 两种 ID 分别做什么？

webContents.id 标识 Electron 的页面容器，本课用它定位终端属于哪个窗口；sessionId 标识一次终端会话。一个窗口关闭终端 A 再开启 B 时，窗口 ID 可以不变，但 sessionId 必须变化。

主进程先根据 IPC 自带的 sender 找到归属，再比较传入 sessionId。这样其他窗口不能控制你的终端，旧 A 的迟到关闭请求也不会杀掉新 B。字符串校验只能证明参数格式合理，不能证明会话存在、仍有效或属于调用者。两个 ID 都不同于操作系统的 PID，PID 用于查询实际 PowerShell 进程。

### 4. 为什么先订阅、先确定 ID，再启动？

启动请求的回复与输出事件是两条消息路径。PowerShell 启动后可能立即输出欢迎信息或提示符，事件可能早于 await startTerminal 的返回结果到达。如果还未订阅，数据会漏掉；如果未保存 ID，面板会把数据当成不属于当前会话而忽略。

因此本课先注册监听，点击启动时生成并保存 sessionId，最后发送 start。等结果回来时，还要考虑 shell 已快速退出，不能无条件把状态覆盖成“运行中”。

### 5. fit、PTY resize 和 ResizeObserver 的区别？

fit.fit() 根据终端 DOM 容器大小和字体测量，计算屏幕放得下多少列、多少行，并调整 xterm。session.process.resize(cols, rows) 通知后台 PTY 使用同样的行列，shell 和终端程序才知道在哪里换行。

只改 xterm 会出现前后台尺寸不一致。ResizeObserver 则负责发现容器变化，触发重新测量：例如展开侧栏，浏览器窗口没变，终端可用宽度却缩小了，仅监听 window.resize 会漏掉这次变化。这里的 process 是保存的 PTY 实例，不是 Node 的全局 process 对象。

### 6. Ctrl+C、exit 和关闭面板有什么区别？

Ctrl+C 在本课被作为控制字符 \x03 送给 PTY，由终端/前台程序处理，通常中断当前命令而保留 PowerShell。例如停止一个循环后还能输入下一条命令；并非所有程序都按完全相同的方式响应。

exit 是让 PowerShell 自己退出的命令；exit 7 会产生 shell 退出码 7。面板收到退出事件后显示状态，屏幕仍在，可以再启动新 shell。

关闭面板会卸载 React 组件：清理订阅、动画帧、观察器和 xterm，同时请求主进程 kill 对应 PTY。不能把 Ctrl+C、exit 和关闭按钮都变成 stop，因为本课 stop 会结束整个终端进程，会把“中断当前任务”错误变成“结束整个会话”。

### 7. 为什么不用 window.close 清理，刷新又需要 main 兜底？

window.close 表示正在尝试关闭，关闭保护可以取消它。比如用户点关闭后选择“继续编辑”，窗口仍然保留；如果一收到 close 就杀 shell，用户留下来时终端已经断了。

关闭面板时由 React cleanup 主动通知 main；窗口真正销毁时由 webContents 的 destroyed 兜底。刷新会替换整份页面，React cleanup 不保证运行，其中发出的异步 IPC 也不保证送达。所以 main 另外监听主框架导航与 render-process-gone，在页面离开或崩溃时释放进程。正常卸载与页面整体消失是不同情况，不能只依赖前端自觉清理。

### 8. 为什么类型、构建和普通 Node 加载成功还不够？

TypeScript 检查代码类型和接口接线；构建检查源码能否转换成应用产物。它们都不保证实际启动原生模块或 PowerShell。

node-pty 包含 C++ 编译出的原生模块，需要匹配 Electron 的运行时接口和 CPU 架构。系统安装的 Node v24 与 Electron 自带的 Node/V8 运行时不是同一个环境，所以普通 Node 能 require，并不等于 Electron 能加载。

这次补装 Spectre 库解决的是 C++ 编译条件，install-app-deps 成功证明针对目标 Electron 的原生依赖重建成功。还要在真实 Electron 中验收启动、输入、输出、尺寸和退出，才能确认整条终端链路可用。类型通过、原生重建成功和实际交互正常是三类不同证据。
