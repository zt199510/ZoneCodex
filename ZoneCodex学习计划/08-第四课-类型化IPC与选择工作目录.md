# 第四课：类型化 IPC 与选择工作目录

## 1. 本课目标与起点

本课完成一个真实桌面功能：点击“选择工作目录”，打开系统文件夹选择器，选择后在 React 页面显示路径。取消选择时保留原路径，发生错误时显示提示。

已经核对你的代码：App 管理 messages，ChatInput 管理 input，并通过 onSend 调用父组件；App 仍保留第三课的 showInput 卸载实验。main 中有 ping 监听，preload 的 api 仍为空，Window.api 的类型仍是 unknown。

用户已反馈第三课完成；本课创建时只核对源码，没有执行第三课的交互验收。课程代码由你亲手实现，不增加依赖。

本课只选择并显示目录，不读取目录内容、不切换终端工作目录，也不保存到磁盘。“选中了路径”不代表其他功能已自动使用这个目录。

## 2. 先区分两种调用

第三课的 onSend 是同一渲染进程内的普通函数回调。第四课需要主进程调用 Electron 的 dialog，因此通过 IPC 跨进程请求结果。

```text
React 点击按钮
  → window.api.selectFolder()
  → preload：ipcRenderer.invoke('workspace:select-folder')
  → main：ipcMain.handle(...) 打开系统对话框
  → 主进程返回字符串路径或 null
  → invoke 的 Promise 完成
  → React 更新状态，显示路径
```

| 接口 | 本课如何理解 |
|---|---|
| send / on | 发事件；监听器 return 不会成为 send 的结果 |
| invoke / handle | 发请求并返回 Promise；等待处理器返回结果 |

invoke 的返回值不是路径本身，而是未来得到路径的 Promise，所以使用 await。

## 3. 本课文件地图

```text
src/
├── shared/
│   └── api.ts                       新增：共享 API 类型
├── main/
│   └── index.ts                     修改：注册目录选择处理器
├── preload/
│   ├── index.ts                     修改：实现 selectFolder 桥接
│   └── index.d.ts                   修改：声明 window.api 类型
└── renderer/src/
    └── App.tsx                      修改：路径状态、按钮与结果
```

shared 是本课新建的目录。这里先只放类型，不放凭据、文件操作或 Electron 运行时代码。使用相对导入，不新增路径别名。

## 4. 先约定返回值

创建 src/shared/api.ts：

```ts
export interface AppAPI {
  selectFolder: () => Promise<string | null>
}
```

含义：不接收参数；异步成功时得到路径字符串；用户取消时得到 null；执行异常则 Promise 拒绝，由调用方 catch。

取消是正常结果，不必抛异常。用 null 明确表示“这次没有选中目录”，不要把它与空字符串路径混在一起。

这份接口描述方法形状，不会创建方法，也不会自动校验进程间数据。后面还会做一次返回值检查。

## 5. 主进程：打开文件夹选择器

在 src/main/index.ts 顶部现有 Electron 导入中加入 dialog：

```ts
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
```

在现有 app.whenReady().then(...) 内、createWindow() 调用之前，加入下面的处理器。原有 ping 示例可以保留：

```ts
ipcMain.handle(
  'workspace:select-folder',
  async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)

    if (!owner || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('不支持的目录选择来源')
    }

    const result = await dialog.showOpenDialog(owner, {
      title: '选择工作目录',
      properties: ['openDirectory']
    })

    if (result.canceled) return null
    return result.filePaths[0] ?? null
  }
)
```

逐项理解：

- event.sender 表示发出请求的 WebContents；据此找到对应窗口。
- 这里限制请求来自窗口的主 frame，并让对话框归属于发起请求的窗口。当前是单窗口模板；将来加载外部页面或增加窗口时，还要按应用的可信页面策略验证来源。
- openDirectory 表示选择目录，没有启用多选。
- canceled 表示用户取消；filePaths 是选中的路径数组。
- `?? null` 只在取不到第一个路径时返回 null。
- async 处理器的结果会通过 IPC 传回 invoke 调用方。

只注册一次！不要放进 createWindow，也不要在按钮点击时注册。对同一个通道重复执行 ipcMain.handle 会报错。

## 6. preload：提供明确的业务方法

在 src/preload/index.ts 修改导入：

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'
```

把原来的 const api = {} 替换为：

```ts
const api: AppAPI = {
  selectFolder: async () => {
    const result: unknown = await ipcRenderer.invoke('workspace:select-folder')

    if (result === null || typeof result === 'string') {
      return result
    }

    throw new Error('目录选择结果格式不正确')
  }
}
```

保留已有的 contextBridge 暴露逻辑：

```ts
contextBridge.exposeInMainWorld('api', api)
```

这行本来就在你的文件中，不要再添加第二次。原来的 window.electron 示例接口和隔离判断先保留。本课新功能只通过 window.api.selectFolder() 使用固定能力，不再由界面随意传通道名。

为什么把 result 写为 unknown？来自 IPC 的值需要检查才能作为约定类型使用。直接写 `as string` 只是让 TypeScript 相信你，不会检查实际返回值。这里验证的是返回值形状，不证明目录一定存在或以后可读；真正访问文件时还需要处理这些问题。

## 7. 声明文件：让 React 认识接口

将 src/preload/index.d.ts 改成：

```ts
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppAPI
  }
}
```

现在在 App.tsx 输入 window.api.，编辑器应提示 selectFolder。

这里再次区分：shared/api.ts 描述接口；preload/index.ts 创建实际对象并暴露；index.d.ts 描述 Window 上可用的属性。声明文件不会在运行时“注册”方法。

当前模板的 tsconfig.node.json 和 tsconfig.web.json 均启用 composite。新增 shared/api.ts 后，需要在这两份配置各自已有的 include 数组里追加下面一项（保留其他条目，注意逗号）：

```json
"src/shared/**/*"
```

import 能让 TypeScript 找到共享文件，但 composite 项目还要求被纳入编译的实现文件明确列在 files 或被 include 覆盖；api.ts 即使只导出接口，也属于这里需要列入的 .ts 文件。Node 侧通过 preload 引用它，Web 侧通过 Window 的声明引用它，所以两份配置都要更新。无需关闭 composite，也无需复制两份接口。

如果出现 TS6307“文件不在项目的文件列表中”，优先检查此步骤。完成后运行 npm run typecheck 验证两组配置。

## 8. React：状态、等待、取消与错误

在现有 App 组件顶部、messages 状态附近添加：

```tsx
const [workspacePath, setWorkspacePath] = useState<string | null>(null)
const [isSelecting, setIsSelecting] = useState(false)
const [folderError, setFolderError] = useState<string | null>(null)
```

在 App 内新增函数，不要覆盖原来的 handleSend：

```tsx
async function handleSelectFolder(): Promise<void> {
  if (isSelecting) return

  setIsSelecting(true)
  setFolderError(null)

  try {
    const path = await window.api.selectFolder()
    if (path !== null) {
      setWorkspacePath(path)
    }
  } catch (error: unknown) {
    console.error('选择工作目录失败', error)
    setFolderError('无法选择工作目录，请重试。')
  } finally {
    setIsSelecting(false)
  }
}
```

在现有标题与 MessageList 之间添加：

```tsx
<section aria-label="工作目录">
  <button
    type="button"
    disabled={isSelecting}
    onClick={() => void handleSelectFolder()}
  >
    {isSelecting ? '正在选择…' : '选择工作目录'}
  </button>
  <p>当前目录：{workspacePath ?? '尚未选择'}</p>
  {folderError && <p role="alert">{folderError}</p>}
</section>
```

要点：

- await 暂停这一个 async 函数的后续部分，不是把整个 React 页面线程阻塞住。
- 取消后不调用 setWorkspacePath，所以保留之前的路径；首次取消则仍显示“尚未选择”。
- finally 在成功、取消或异常时都会执行，让按钮恢复可用。
- 按钮禁用减少用户重复提交；它不是跨窗口的全局并发锁。
- void 表示事件处理器不使用返回的 Promise，不会自动处理错误；这里的异步异常由函数内 try/catch 处理。
- 没有 useEffect，因为选择目录由用户点击触发。

路径状态放在 App，后面文件列表和终端可能都需要它。当前只是内存状态，重新启动应用后会重置，这是预期行为。选择目录不等于已经实现持久化。

你的 showInput 卸载实验可以先保留，本课目录区不放进 showInput 条件中。实验结束后可自行恢复固定显示 ChatInput。

## 9. 正确重启与断点

main 与 preload 改动后，停止当前 Debug All 调试，再按 F5 启动完整应用，避免只热更新 React 后仍使用旧桥接代码。

建议断点：

1. App.tsx 的 await window.api.selectFolder()。
2. main/index.ts 的 await dialog.showOpenDialog(...)。
3. App.tsx 的 if (path !== null)。

点击按钮，在 React 断点处继续，再在主进程断点处继续，让系统对话框显示。选好目录后回到 React 观察 path。

主进程与渲染进程有各自的调用栈。不同于第三课 onSend 普通函数调用，这次不应期待 F11 沿单个同步调用栈穿过两个进程。

## 10. 检查与验收

在项目根目录执行：

```powershell
npm run typecheck
```

本课涉及 main、preload 和 React，因此两组类型检查都要做。文档示例尚未写入你的应用或实际运行；以下结果由实践后确认。

- [ ] 编辑器能提示 window.api.selectFolder，类型为 Promise<string | null>。
- [ ] 点击按钮显示系统文件夹选择器，选中后显示完整路径。
- [ ] 首次取消仍显示“尚未选择”。
- [ ] 已选择 A，再打开并取消，仍保留 A。
- [ ] 再选择 B，显示更新为 B。
- [ ] 对话框关闭后按钮恢复可用，聊天发送功能仍正常。
- [ ] 类型检查通过。
- [ ] 通过断点观察到请求和结果分别到达两个进程。

错误分支实验：临时在主进程处理器的 dialog 调用前加 `throw new Error('学习用模拟失败')`，重启应用并点击按钮；应显示错误提示，按钮恢复可用。随后删除这行，重启并再次验证正常选择。不要把模拟异常留在最终代码中。

常见问题：

| 报错/现象 | 优先检查 |
|---|---|
| window.api 是 unknown | index.d.ts 是否改为 AppAPI |
| selectFolder is not a function | preload 是否实现、是否重启完整应用 |
| No handler registered | 主进程是否注册，通道名是否完全一致 |
| Attempted to register a second handler | 是否重复注册同一通道 |
| 取消后旧路径消失 | 是否无条件把 null 写入 workspacePath |
| 按钮一直禁用 | 是否在 finally 中恢复状态；是否仍暂停在断点 |

## 11. 自测与下一课

1. 为什么不能把本课的 onSend 回调方式直接当作跨进程调用？
2. invoke 与 send 的返回行为有什么不同？
3. 哪个文件实际打开对话框，哪个文件只描述类型？
4. 只添加 index.d.ts、不实现 preload 方法，会发生什么？
5. null 和抛异常分别代表什么？为什么取消后保留旧路径？
6. try/catch/finally 和 isSelecting 分别解决什么问题？
7. unknown 检查与 as string 有什么不同？
8. 重启后路径消失是否是本课 bug？为什么？

完成后反馈源码改动、类型检查结果、选择/取消/错误实验和自测回答。下一课计划接入一个模型服务，沿用本课的主进程请求与界面状态结构，学习真实异步请求，再逐步扩展流式输出。

