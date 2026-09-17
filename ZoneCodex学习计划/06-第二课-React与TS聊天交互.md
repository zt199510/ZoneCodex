# 第二课：React + TypeScript 实现最小聊天交互

本课面向已有 Vue 经验的你。目标是在自己的 Electron 窗口里实现输入、发送、消息列表和模拟回复，同时理解 React 的状态更新。没有模型请求，也不新增依赖。

## 1. 起点与完成效果

2026-09-15 核对：App.tsx 仍是模板首页，IPC 按钮已改为“发送IPC”。你已反馈 VS Code 调试正常，并完成第一课概念讨论。

本课完成后：输入文字 → 点击发送或按回车 → 显示一条用户消息和一条模拟助手回复 → 清空输入框。全空格输入不能发送。

本课按“先单文件理解，再拆一个组件”进行。输入组件、异步模拟和真实模型接入放到后续课程。

修改的源码：

```text
src/renderer/src/
├── App.tsx                      修改：状态、输入与发送逻辑
└── components/
    └── MessageList.tsx           后半课新建：消息列表及消息类型
```

只修改上述 React 文件；main、preload、本地接口和依赖保持当前状态。模板原有的 Versions.tsx 与图片可以保留，但本课页面不再导入它们。

启动调试：VS Code 打开项目根目录 → Ctrl+Shift+D → 选择 Debug All → F5。不要选择“Node.js 运行当前文件”。

## 2. Vue 到 React 的重点差异

| Vue 中的经验 | 本课 React 写法 |
|---|---|
| template | 函数组件 return 中的 JSX |
| ref('') | const [input, setInput] = useState('') |
| v-model | value={input} 与 onChange 配合 |
| v-for | messages.map(...) |
| :key | key={message.id} |
| @submit.prevent | onSubmit 中调用 event.preventDefault() |
| defineProps | 函数参数 Props 的 TypeScript 类型 |

React 函数组件会在渲染时重新执行。useState 保存跨渲染的状态；setter 请求下一次更新，当前事件函数里的变量仍是这次渲染的快照。

不要直接 messages.push(...) 后期待 React 重新渲染。应创建新数组交给 setter。useState 要放在组件顶层，不能放在 if 或点击事件里。

## 3. 先定义消息类型

在 App.tsx 中定义类型，放在 App 函数外：

```ts
type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}
```

- id：消息的稳定标识，创建消息时生成。
- role：字符串字面量联合类型，只接受两个指定值。
- content：正文。
- 类型在编译时检查数据形状，不会生成消息，也不是接口返回数据的运行时校验器。

练习：试着给 role 写 'robot'，观察类型提示，再改回合法值。

## 4. 新建状态，先实现受控输入

App.tsx 的导入改为：

```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'
```

在组件顶部添加：

```tsx
const [input, setInput] = useState('')
const [messages, setMessages] = useState<Message[]>([])
```

input 能根据初值推断为 string。空消息数组没有元素可供推断，因此明确指定 Message[]。

输入框写法：

```tsx
<input
  value={input}
  onChange={(event) => setInput(event.currentTarget.value)}
  placeholder="输入你的问题"
/>
```

onChange 的内联参数可以由 JSX 上下文推断类型。value 由 React 状态控制，onChange 更新状态，再渲染出新值。

临时加一句 `<p>当前输入：{input}</p>`，验证文字随输入变化，理解后再删除。

## 5. 实现一次发送

在组件内部定义事件处理函数：

```tsx
function handleSubmit(event: FormEvent<HTMLFormElement>): void {
  event.preventDefault()

  const content = input.trim()
  if (!content) return

  const userMessage: Message = {
    id: crypto.randomUUID(),
    role: 'user',
    content
  }

  const assistantMessage: Message = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `模拟回复：我收到了“${content}”`
  }

  setMessages((previous) => [...previous, userMessage, assistantMessage])
  setInput('')
}
```

关键理解：

1. preventDefault 阻止表单默认提交导航，避免当前页面和状态被重新加载。
2. trim 和空值判断保护发送逻辑；按钮禁用只是界面层的辅助。
3. 两条消息在事件函数中创建。不要在 state 更新函数内生成随机 ID 或调用外部接口，要保持更新函数纯粹。
4. previous 是 React 在处理更新队列时提供的待更新状态，适合根据旧状态追加数据。
5. 展开运算符创建新数组，保留旧消息并追加新消息。
6. 此处模拟回复是立即生成的固定逻辑，没有 AI、网络和异步请求。

思考：setInput('') 后立刻 console.log(input)，为何仍可能打印发送前的内容？因为当前函数读取的是本次渲染的状态快照。

## 6. 单文件完整对照

先按前面步骤尝试组装，遇到困难再对照以下完整 App.tsx。替换模板内容后要清理不再使用的 Versions、图片导入和 ipcHandle。

```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

function App(): React.JSX.Element {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<Message[]>([])

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const content = input.trim()
    if (!content) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content
    }
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `模拟回复：我收到了“${content}”`
    }

    setMessages((previous) => [...previous, userMessage, assistantMessage])
    setInput('')
  }

  return (
    <main>
      <h1>ZoneCodex · 聊天练习</h1>
      <p>本课使用模拟回复，没有连接模型。</p>

      {messages.length === 0 ? (
        <p>还没有消息，发送第一句话吧。</p>
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message.id}>
              <strong>{message.role === 'user' ? '我' : '助手'}：</strong>
              <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit}>
        <label htmlFor="chat-input">消息</label>
        <input
          id="chat-input"
          value={input}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="输入你的问题"
        />
        <button type="submit" disabled={!input.trim()}>
          发送
        </button>
      </form>
    </main>
  )
}

export default App
```

这里用 form 统一按钮点击和回车提交，避免同时绑定 onClick 和 onSubmit 导致重复发送。onSubmit={handleSubmit} 传递函数，不是立即执行。

key 帮助 React 跟踪列表项身份。ID 在创建消息时生成，不要在 map 渲染中临时生成随机 key。

保留现有 CSS 即可验证功能，视觉上可能仍带模板布局。你可以自行调整样式；本课不以样式完成度验收。

## 7. 拆出第一个组件，学习 Props

单文件版本验证通过后，新建 `components/MessageList.tsx`：

```tsx
export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

type MessageListProps = {
  messages: readonly Message[]
}

function MessageList({ messages }: MessageListProps): React.JSX.Element {
  if (messages.length === 0) {
    return <p>还没有消息，发送第一句话吧。</p>
  }

  return (
    <ul>
      {messages.map((message) => (
        <li key={message.id}>
          <strong>{message.role === 'user' ? '我' : '助手'}：</strong>
          <span style={{ whiteSpace: 'pre-wrap' }}>{message.content}</span>
        </li>
      ))}
    </ul>
  )
}

export default MessageList
```

接着修改 App.tsx：

1. 删除原来的 Message 类型定义，统一从新文件导入。
2. 添加以下导入：

```tsx
import MessageList from './components/MessageList'
import type { Message } from './components/MessageList'
```

3. 把原来的整个 `messages.length === 0 ? ... : ...` JSX 表达式替换为：

```tsx
<MessageList messages={messages} />
```

App 保留状态和发送逻辑，MessageList 只根据 Props 展示。readonly 约束子组件不能通过该数组引用 push/splice，但它不是深度不可变，也不是运行时冻结。

小项目先就近放类型，后面多个模块共享消息结构时再提取 types 文件。

## 8. 断点观察

Debug All 启动后，在 `const content = input.trim()` 和 `setMessages(...)` 行设置断点，输入“你好”后提交。

观察 input、content 和新建的消息对象。setMessages 调用后，不要期待当前栈帧中的 messages 立即改变；按 F5 继续执行后观察界面。

刷新或重启后消息丢失是当前预期：useState 是内存状态，尚未实现持久化。

## 9. 验收与常见问题

在项目根目录运行：

```powershell
npm run typecheck:web
```

本课文档中的示例尚未替你写入项目或运行验证；完成代码后以本地检查和实际交互为准。

- [ ] 输入文字能够正常显示。
- [ ] 空输入和全空格输入均不能产生消息。
- [ ] 一次提交产生一条用户消息和一条模拟回复，输入框清空。
- [ ] 按回车也可提交，页面不会刷新。
- [ ] 连续发送三次得到六条消息，历史不丢失。
- [ ] 拆分 MessageList 后行为一致，列表使用稳定 ID。
- [ ] TypeScript 检查通过，没有用 any 绕过消息类型。
- [ ] 在调试器中观察过发送流程，并能解释状态快照。

常见问题：

| 现象 | 优先检查 |
|---|---|
| 输入框无法输入 | value 绑定后是否提供了正确的 onChange |
| 提交后页面刷新 | 是否调用 preventDefault |
| 每次发送两遍用户消息 | 是否同时在 onClick 和 onSubmit 里发送 |
| 消息不更新 | 是否直接修改原数组、是否只修改普通变量 |
| 类型重复或导入报错 | 拆分时是否删除旧 Message 定义、路径是否正确 |
| 仍显示模板首页 | 是否保存了正确项目的 App.tsx，是否运行了另一个实例 |

## 10. 自测与反馈

1. 普通 let 变量和 useState 在组件里有什么区别？
2. 受控输入为什么同时需要 value 和 onChange？
3. Message 的 role 为什么不用宽泛的 string？
4. 为什么根据旧列表追加时使用函数式更新？
5. 为什么不在渲染时生成列表 key？
6. 为什么 MessageList 不自己保存第二份 messages 状态？
7. 为什么本课没有用 useEffect，也没有发送 IPC？

反馈时请提供：是否通过验收、两个 React 文件的修改、自测回答、遇到的问题。之后更新学习进度，下一课再拆分 ChatInput 并学习回调 Props；根据掌握情况决定是否加入模拟异步状态。
