# 第三课：拆分 ChatInput，理解回调 Props

## 1. 目标与当前代码

你已反馈第二课完成，并纠正了 useState 与浏览器缓存的混淆：同一个组件实例重新渲染时保留状态，页面重新加载或组件卸载后重新挂载通常会重置。

本次实际读取到：App.tsx 已有输入状态、消息状态、提交处理；MessageList.tsx 已提取，使用稳定消息 ID。第三课继续这个实现，不新增依赖、不接入模型。

完成后，App 管理对话，ChatInput 管理草稿，MessageList 显示消息。界面行为与第二课一致，但职责更清楚。

本课由你亲手修改代码。下面的示例是学习用对照，尚未自动写入应用。

```text
src/renderer/src/
├── App.tsx                    修改：保留消息状态与发送业务
└── components/
    ├── ChatInput.tsx          新增：输入状态与表单提交
    └── MessageList.tsx        保留：列表显示，补齐角色标签
```

## 2. 先决定状态属于谁

| 数据/行为 | 所在组件 | 原因 |
|---|---|---|
| messages | App | 发送处理要更新它，列表要显示它 |
| input 草稿 | ChatInput | 当前只有输入组件需要它 |
| 创建用户消息与模拟回复 | App | 属于聊天业务，不属于输入框本身 |
| 阻止表单默认行为、清空输入 | ChatInput | 属于表单交互 |
| 展示消息 | MessageList | 根据 Props 渲染 |

状态放在需要它的最近共同父组件，或者唯一使用它的组件。本课把草稿放在 ChatInput；以后如果切换会话要保存各自草稿，就重新评估它的位置。

不要把 input 在 App 和 ChatInput 各存一份再用 Effect 同步。

## 3. 从 Vue 的 emit 理解函数 Props

Vue 里，你可能通过 emit('send', content) 把事件交给父组件处理。

本课 React 使用父组件传入的函数：

```tsx
// 父组件
<ChatInput onSend={handleSend} />

// 子组件内部
onSend(content)
```

onSend 是我们自己命名的普通函数属性，不是 React 自动生成的事件总线。子组件调用的就是父组件传进来的 handleSend。

与第一课 IPC 的区别：这里的调用发生在同一个渲染进程，是普通 JavaScript 函数调用；没有跨进程消息。

## 4. 定义 ChatInput 的接口

创建 components/ChatInput.tsx，先写：

```tsx
type ChatInputProps = {
  onSend: (content: string) => void
}
```

解释：

- onSend 是必传属性。
- 它接收一个 string 参数。
- 调用方不使用它的返回值。本课约定它同步处理消息。
- 它不是字符串属性，也不是 handleSend() 的执行结果。

将来接入异步请求时，要单独设计返回契约、加载状态和错误处理，不能因为这里写 void 就假定网络请求已完成。

## 5. 实现 ChatInput

把第二课输入框的 state、form 和提交相关逻辑迁移到这里。完整对照：

```tsx
import { useState } from 'react'
import type { FormEvent } from 'react'

type ChatInputProps = {
  onSend: (content: string) => void
}

function ChatInput({ onSend }: ChatInputProps): React.JSX.Element {
  const [input, setInput] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const content = input.trim()
    if (!content) return

    onSend(content)
    setInput('')
  }

  return (
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
  )
}

export default ChatInput
```

这里仍然是受控输入：input 的状态现在属于 ChatInput。它不直接修改 messages，也不需要知道消息 ID 或助手回复如何生成。

本课假定页面只有一个 ChatInput，因此沿用固定 input id；以后同页多个实例时再用 useId 保证标签关联不冲突。

## 6. 修改 App：从表单事件变为业务参数

原来的函数接收 DOM 表单事件：

```tsx
handleSubmit(event: FormEvent<HTMLFormElement>)
```

现在改成只接收消息内容：

```tsx
handleSend(rawContent: string)
```

这样 App 不需要知道文字来自表单、快捷操作还是其他组件。完整 App.tsx 对照：

```tsx
import { useState } from 'react'
import ChatInput from './components/ChatInput'
import MessageList from './components/MessageList'
import type { Message } from './components/MessageList'

function App(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([])

  function handleSend(rawContent: string): void {
    const content = rawContent.trim()
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
  }

  return (
    <main>
      <h1>ZoneCodex · 聊天练习</h1>
      <p>本课使用模拟回复，没有连接模型。</p>
      <MessageList messages={messages} />
      <ChatInput onSend={handleSend} />
    </main>
  )
}

export default App
```

清理 App 中原来的 FormEvent 导入、input 状态、form JSX、setInput 和 console.log(input)。App 不再拥有 input，因此保留旧引用会报错。

两层空内容检查用途不同：子组件负责表单交互，父组件守住聊天业务入口，避免其他调用方未来传来空消息。

注意写法：

```tsx
<ChatInput onSend={handleSend} /> // 传入函数
```

不要写 onSend={handleSend('你好')}：这会在渲染时执行函数，传入的是返回值，还可能触发渲染期间更新。

## 7. 用调用链和断点看明白

```text
在 ChatInput 中输入
  → setInput 更新子组件的草稿
提交表单
  → 子组件 handleSubmit
  → onSend(content)
  → 父组件 handleSend(content)
  → setMessages 请求更新对话
  → 返回子组件，setInput('') 请求清空草稿
React 应用状态更新
  → MessageList 收到新的 messages 并显示
```

React 可能批量处理这次事件中的状态更新；这张图表达调用和数据关系，不表示每次 setter 都立即完成一次屏幕绘制。

使用 Debug All，在子组件 onSend(content) 行设置断点，发送“第三课”。按 F11 进入父组件函数，观察 content；也可以在父组件 handleSend 内另设断点。

观察到跨组件函数调用后，与第一课跨进程 IPC 对比：这里可以沿普通调用栈跟踪，IPC 的两个进程调用栈则分开。

## 8. 修正你代码中的一个角色显示问题

你在第二课给 Message.role 加入了 'system'，但当前显示逻辑为：

```tsx
message.role === 'user' ? '我' : '助手'
```

所以 system 消息也会显示为“助手”。目前发送逻辑没创建 system 消息，问题尚未被触发。

保留你的类型扩展，在 MessageList.tsx 的组件外新增：

```tsx
const roleLabels: Record<Message['role'], string> = {
  user: '我',
  assistant: '助手',
  system: '系统'
}
```

把 strong 内部替换为：

```tsx
<strong>{roleLabels[message.role]}：</strong>
```

Message['role'] 提取角色联合类型；Record 要求为每个角色提供字符串标签。试着删掉 system 字段，观察 TypeScript 报错，再恢复。

本课只用它练习角色映射。后续真正的模型 system 指令是否在聊天列表显示，需要另行设计。

## 9. 用草稿实验复习状态生命周期

完成核心拆分后，可以临时在 App 中加以下状态和按钮：

```tsx
const [showInput, setShowInput] = useState(true)
```

```tsx
<button type="button" onClick={() => setShowInput((previous) => !previous)}>
  切换输入框
</button>
{showInput && <ChatInput onSend={handleSend} />}
```

临时替换原来的 ChatInput JSX，避免出现两个实例。

先输入草稿但不发送，再隐藏和显示输入框。条件为 false 时组件被卸载，所以草稿重置；App 仍在，消息列表状态保留。这个过程没有重新整理整个页面。

实验完成后移除临时 state 和按钮，恢复固定 ChatInput。注意：仅用 CSS 隐藏并不会卸载组件，因此不能用 CSS 隐藏来代替本实验。

## 10. 验收

在项目根目录运行 npm run typecheck:web。本课示例未替你运行，完成后以实际检查结果为准。

- [ ] App 只保留 messages；ChatInput 只保留草稿 input。
- [ ] 点击发送和回车均有效，空白内容不可发送。
- [ ] 连续三次发送得到六条消息，输入框每次清空。
- [ ] 子组件通过 onSend 传递字符串，父组件创建消息。
- [ ] 角色映射能处理 user、assistant、system。
- [ ] 类型检查通过，没有用 any 绕过 Props 类型。
- [ ] 用断点观察过子组件调用父组件函数。
- [ ] 能解释卸载输入组件与重新渲染的不同。

常见问题：Cannot find name input 表示 App 残留旧引用；onSend is not a function 优先检查父组件是否正确传函数；重复出现输入框则检查是否保留了旧 form 或实验代码。

## 11. 自测与下一步

1. onSend 的值是什么？它是自动广播的事件吗？
2. 为什么 handleSend 不再接收 FormEvent？
3. 草稿 input 为什么暂时适合放在 ChatInput？
4. 子组件是否直接修改了父组件的 messages？实际如何更新？
5. 同一实例重新渲染后草稿如何变化？卸载再挂载呢？
6. roleLabels 的 Record 类型帮我们避免了什么遗漏？

完成后反馈验收结果和自测回答。下一课计划在保留此组件结构的基础上学习 Electron 类型化 IPC，完成选择工作目录；暂不加入模拟网络延迟，异步加载和取消与真实模型请求一起学习。
