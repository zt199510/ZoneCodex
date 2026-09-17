# 第十五课：消息 Markdown 展示与安全渲染

## 1. 本课目标与前置条件

让助手回复中的标题、列表、加粗、引用、表格和代码块变成可读的排版，同时保留流式生成、会话保存和切换行为。继续由你亲手实现，不创建测试文件；通过现有类型检查和页面观察验收。

课前核对（2026-09-16）：

- 你反馈第十四课完成，八题自测答案已讲解，理解程度继续通过复述确认。
- `useModelStream` 已解构 conversationId、在请求对象中保存它，并在三处消息更新中传入会话 ID。
- `api.ts` 的旧类型导入已清理，`ChatWorkspace` 的清草稿与滚动两个 Effect 已保留。
- 当前项目 `npm run typecheck` 的 Node、Web 两组检查通过。
- 自动保存仍为 `10000`；若不再用于观察退出弹窗，先在 `useConversationStorage.ts` 恢复 `800`。这不是 Markdown 功能所需改动。

本课只渲染 **assistant** 消息；user、system 继续显示原始纯文本。暂不做语法高亮、代码复制按钮、数学公式、原生 HTML、远程图片加载和外链打开。这些功能需要分别设计，不随 Markdown 一起默认开启。

本课不改会话版本，不改 main/preload 接口，不改变模型上下文，也不安装全局状态库。

## 2. 从 Vue 经验理解：文本是数据，排版是派生结果

Vue 模板的文本插值和 React 的 `{message.content}` 都会把字符串当文字显示。字符串中的 `<script>` 不会因此变成脚本，但 `**加粗**` 也不会自动变成粗体。

本课增加一个渲染组件，调用链是：

```text
模型增量 → 拼接 message.content（原始字符串）
                     ├─ 保存 JSON / 构造下一轮上下文
                     └─ Markdown 解析 → React 元素 → 页面排版
```

不要用 `dangerouslySetInnerHTML` 填入模型返回的 HTML；它类似 Vue 的 `v-html`，会绕过普通文本插值的行为。也不要把渲染出的 HTML 再写回 content，否则 Markdown 原文、代码围栏和后续上下文都会被污染。

无需为解析结果增加 state 或 Effect。文本变化时，组件从新字符串重新计算展示即可。

## 3. 文件与新增依赖

| 文件 | 操作与职责 |
|---|---|
| `package.json`、`package-lock.json` | 安装并记录两个运行依赖 |
| `src/renderer/src/features/chat/MarkdownContent.tsx` | 新建，解析 Markdown 并限制展示元素 |
| `src/renderer/src/features/chat/MessageList.tsx` | 按角色选择 Markdown 或纯文本，保留状态提示 |
| `src/renderer/src/assets/main.css` | 追加只影响 Markdown 区域的样式 |

在项目根目录执行：

```powershell
npm install react-markdown@10 remark-gfm@4
```

- `react-markdown`：把 Markdown 转成 React 元素，不需要手动生成 HTML 字符串。
- `remark-gfm`：增加表格、删除线、任务列表和自动链接等 GitHub 风格语法。

它们供 renderer 使用，加入 dependencies；不需要装进 Electron 主进程。安装产生的 lockfile 一起保留，不手工改版本来“消除报错”。本课以 react-markdown 10、remark-gfm 4 的接口编写，不套用旧版本带 `inline` 参数的代码高亮示例。

参考：[react-markdown 文档](https://github.com/remarkjs/react-markdown)、[remark-gfm 文档](https://github.com/remarkjs/remark-gfm)。

预期：安装成功后编辑器能识别两个导入；若提示找不到模块，先确认命令是在当前项目根目录执行并且安装成功。

## 4. 新建 MarkdownContent

新建 `src/renderer/src/features/chat/MarkdownContent.tsx`，填写：

```tsx
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

// 不传 base URL：相对路径、锚点和 //example.com 都不作为外链接受。
function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

const components: Components = {
  // 本课只显示可选择复制的地址，不创建 a 标签，不打开网页。
  a: ({ href, children }) => (
    <span className="markdown-link">
      {children}
      {href ? <span className="markdown-url">（{href}）</span> : '（链接不可用）'}
    </span>
  ),
  // 不输出 img 标签，所以不会请求模型文本里的图片地址。
  img: ({ alt }) => (
    <span className="markdown-image-placeholder">[图片未加载：{alt || '无说明'}]</span>
  ),
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="消息表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  )
}

export function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={displayUrl}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
}
```

逐项理解：

1. `content` 是普通 Props。不要在组件内再复制成 `useState(content)`，否则后续流式文本可能与这份初始状态脱节。
2. `skipHtml` 跳过原生 HTML 节点。不安装 `rehype-raw`；不用 HTML 字符串注入页面。代码围栏里的 HTML 则是代码文字，应当能看见。
3. `urlTransform` 自定义 URL 规则，只接受没有用户名密码的绝对 HTTP(S) 地址。`javascript:`、`data:`、`file:` 和相对路径得到空字符串。
4. `components.a` 返回 span，不是可点击的 a。用户能看见并自行复制地址，本课不会触发窗口导航或 Electron 的外链打开逻辑。合法协议不代表网站可信。
5. `components.img` 返回占位文字，不输出真实 img，不自动请求远程资源。即便 URL 是 HTTPS，也不自动加载。
6. GFM 的任务列表是展示内容，默认复选框不可编辑；它不是应用的任务管理状态。

`components` 定义在组件外，不捕获本次消息内容。自定义组件只使用需要的属性，没有把解析树里的 `node` 或整包 Props 展开到 DOM 上。

当前 main/index.ts 有直接把新窗口 URL 交给 `shell.openExternal` 的模板逻辑。本课不生成可点击外链，不使用那条路径。将来开放点击时，要先在主进程限制协议并处理失败，不能只加一个 `target="_blank"` 就算完成。

## 5. 接入 MessageList：只替换内容区域

在 `MessageList.tsx` 顶部增加：

```ts
import { MarkdownContent } from './MarkdownContent'
```

找到原来的 `div.message-content`，整块替换为：

```tsx
<div className="message-content">
  {message.content ? (
    message.role === 'assistant' ? (
      <MarkdownContent content={message.content} />
    ) : (
      message.content
    )
  ) : (
    message.status === 'pending' ? '正在思考…' : '未收到回复文字'
  )}
</div>
```

以下代码都保留：

- 作者和角色标签，包括 system 的映射。
- `li` 的 `key={message.id}`，不要用数组下标或 content 作为 key。
- pending 的“正在生成”和动画。
- failed、cancelled 的状态说明。

预期：用户输入的 `**你好**` 仍显示星号；助手回复的同样字符串显示粗体。失败或停止后的部分回复仍可以排版，状态仍由 `message.status` 决定；Markdown 不能把失败消息改成成功。

## 6. 样式：保留纯文本换行，限制代码块宽度

现有 `.message-content` 使用 `white-space: pre-wrap`，适合纯文本。Markdown 有自己的段落、列表和代码块，需要在内部改回 normal；代码块再使用 pre。

将下面内容追加到 `src/renderer/src/assets/main.css` 末尾。不要全局修改所有 p、pre、table，避免影响侧栏和弹窗。

```css
.markdown-body {
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}

.markdown-body > :first-child { margin-top: 0; }
.markdown-body > :last-child { margin-bottom: 0; }
.markdown-body p { margin: 0 0 12px; }
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin: 20px 0 10px;
  line-height: 1.4;
  font-weight: 650;
}
.markdown-body h1 { font-size: 22px; }
.markdown-body h2 { font-size: 19px; }
.markdown-body h3 { font-size: 17px; }
.markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 15px; }
.markdown-body ul, .markdown-body ol {
  margin: 0 0 12px;
  padding-left: 24px;
}
.markdown-body li { margin: 4px 0; }
.markdown-body li > p { margin-bottom: 4px; }
.markdown-body blockquote {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body code {
  font-family: Consolas, 'Cascadia Code', monospace;
  font-size: 0.9em;
}
.markdown-body :not(pre) > code {
  padding: 2px 5px;
  border-radius: 4px;
  background: #f0f1ed;
  white-space: break-spaces;
}
.markdown-body pre {
  max-width: 100%;
  overflow-x: auto;
  margin: 12px 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f7f8f5;
  line-height: 1.6;
  white-space: pre;
  overflow-wrap: normal;
}
.markdown-body pre code { white-space: inherit; }
.markdown-table-scroll {
  max-width: 100%;
  overflow-x: auto;
  margin: 12px 0;
}
.markdown-body table { border-collapse: collapse; font-size: 13px; }
.markdown-body th, .markdown-body td {
  border: 1px solid var(--border);
  padding: 7px 12px;
  text-align: left;
}
.markdown-body th { background: #f3f4f0; }
.markdown-body hr { border: 0; border-top: 1px solid var(--border); margin: 16px 0; }
.markdown-link { color: var(--accent); }
.markdown-url, .markdown-image-placeholder { color: var(--muted); font-size: 0.9em; }
```

预期：长代码行在代码块内部横向滚动，宽表格在表格区域内滚动；整页不被长代码撑宽。代码缩进保留，用户消息的原有换行也保留。

Markdown 中普通单换行通常按段落内空白处理；空一行才分段。不要为了复刻纯文本换行而把整个 Markdown 区域重新改成 pre-wrap。本课不额外安装 remark-breaks。

## 7. 流式内容为什么不需要额外 Effect

现有流式 Hook 在每次增量到达后，以不可变更新追加 content。React 收到新字符串，MarkdownContent 自然重新解析。

生成途中可能只有半个标题、未完成链接或尚未闭合的代码围栏。解析器按当前文本展示，后续文本到达后排版可能变化，这是增量文本的正常情况。不补造代码围栏、不删除半截文字，不将“语法暂未完成”记为请求失败。

`ChatWorkspace` 的两个 Effect 继续保留原顺序：先处理切换清草稿和跟随标志，再在 messages 变化后滚动。Markdown 本课同步渲染，而且不加载图片，没有新增的图片加载后滚动流程。

先保证正确性；本课不额外加入缓存、节流和复杂 Markdown 分段算法。超长流式回复若明显卡顿，记录具体文本长度和现象，之后单独学习性能优化。

## 8. 不写测试文件的页面验收

先执行现有检查：

```powershell
npm run typecheck
```

通过后执行 `npm run dev` 观察页面。为了不依赖模型是否恰好返回指定格式，可以临时在 **现有 MessageList.tsx** 中放一份预览数据；不用新建脚本或测试文件。

在 `MessageList` 函数内部、return 前临时加入以下代码，并将 JSX 中唯一的 `messages.map` 改为 `displayedMessages.map`：

```ts
const sample = [
  '# 排版检查',
  '',
  '**加粗**、*斜体*、~~删除线~~、`const count = 1`。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 这是一段引用。',
  '',
  '| 会话 | 状态 |',
  '| --- | --- |',
  '| A | 已保存 |',
  '| B | 生成中 |',
  '',
  '- [x] 已完成',
  '- [ ] 待完成',
  '',
  '```ts',
  'function greet(name: string) {',
  '  return `你好，${name}`',
  '}',
  '```',
  '',
  '[说明](https://example.com/guide)',
  '',
  '[无效协议](javascript:alert%281%29)',
  '',
  '![示例图片](https://example.com/image.png)',
  '',
  '<img src="https://example.com/raw.png" onerror="alert(1)">',
  '',
  '```html',
  '<img src="demo.png" onerror="alert(1)">',
  '```'
].join('\n')

const previewMessages: ChatMessage[] = [
  { id: 'preview-user', role: 'user', content: '**用户原文**\n第二行', status: 'complete' },
  { id: 'preview-assistant', role: 'assistant', content: sample, status: 'complete' },
  { id: 'preview-pending', role: 'assistant', content: '', status: 'pending' },
  { id: 'preview-stopped', role: 'assistant', content: '```ts\nconst partial =', status: 'cancelled' }
]
const displayedMessages = import.meta.env.DEV ? previewMessages : messages
```

选择一条已有消息的会话，让当前 ChatWorkspace 挂载 MessageList（空会话走 EmptyState，不会显示这份预览）。以上数据只用于该组件展示，不调用 setSnapshot，不写入会话库；正式应用原来的加载/保存机制仍在运行。

按下面表格检查后，**删除预览代码，将 map 改回 messages.map**。不清理预览就无法看到真实消息更新，不能用这种状态验收流式功能。

| 观察项 | 应看到的结果 |
|---|---|
| 用户消息 | 星号保留，换行保留 |
| 助手标题、列表、引用 | 正常排版，有段落间距 |
| GFM 表格、删除线、任务列表 | 正常显示；复选框不能操作 |
| 代码块 | 缩进保留；此时没有语法高亮 |
| 普通链接 | 显示文字和 HTTP(S) 地址，点击不导航 |
| javascript 链接 | 不执行，不生成可点击链接 |
| Markdown 图片 | 显示“图片未加载”占位，不出现 img 元素 |
| 原生 HTML img | 被跳过，不加载图片、不触发事件 |
| 代码块中的 HTML | 作为可见代码显示，不创建 img 元素 |
| 空 pending | “正在思考…”和生成状态仍显示 |
| 未闭合代码块且 cancelled | 部分代码可见，仍显示“已停止” |

再给代码样例加一条很长的单行，缩窄窗口，检查只在代码区域横向滚动。可在开发者工具 Elements 中查看 DOM，确认链接没有 a、图片没有 img；不要仅凭“没看到弹窗”判断安全行为。

清理临时预览后，再验收：

1. 发送一次要求包含列表和代码块的普通问题，观察生成途中内容和最终排版。
2. 生成时手动向上滚动，确认新内容不会强行拉回底部；切换会话后恢复自动跟随。
3. 停止一次生成，检查部分内容保留且 cancelled 提示存在。
4. 等待保存、切换会话、重启应用，确认 Markdown 排版可恢复，正文原始字符串和会话 ID 没有被改成 HTML。
5. 再运行 `npm run typecheck`；需要打包前验证时运行现有 `npm run build`，无需为本课新增测试脚本。

## 9. 常见错误

- **标题、星号仍显示原样**：先确认这是 assistant 消息；用户消息本来就保留原文。再确认 MessageList 已使用新组件。
- **排版出现奇怪空行**：检查 `.markdown-body` 是否覆盖继承的 `white-space: pre-wrap`。
- **表格不生效**：检查 remark-gfm 是否安装、导入并传入 remarkPlugins；表格必须有分隔行。
- **流式文字不更新**：检查是否遗留本节临时预览，或错误地把 content 复制到本地 state。
- **代码块挤宽页面**：检查 pre 的 max-width、overflow-x、white-space 和表格滚动容器。
- **图片不显示、链接不能点**：这是本课明确的行为，不要通过启用原生 HTML 来“修复”。
- **HTML 标签不显示**：普通 Markdown 里的原生 HTML被跳过；要展示标签本身，应把它放入代码围栏。

## 10. 自测题

1. 为什么保存的是原始 Markdown，而不是渲染后的 HTML？下一轮模型上下文应使用哪一份？
2. React 的 `{content}`、本课 Markdown 组件、dangerouslySetInnerHTML 分别做了什么？
3. react-markdown 与 remark-gfm 各负责什么？为什么只装前者不一定显示 GFM 表格？
4. 为什么 user 消息保持纯文本？为什么失败、停止后的回复仍可渲染 Markdown？
5. skipHtml、URL 规则、图片占位分别处理什么？为什么 HTTPS 地址也不代表内容可信？
6. 为什么流式增量到达后不需要另一个 Effect 来同步 Markdown？围栏没写完时应该修改原文吗？
7. 为什么 Markdown 使用 normal，而代码块使用 pre？如果全局修改 white-space 会影响什么？
8. 为什么预览看起来正常后还要删除临时数据，再检查真实流式、保存和重启？

用页面现象和实际变量回答，不要求背库的定义。

收到，第十五课实践已完成；自测题我们逐题理解，实践完成和原理掌握分开记录。

**1. 为什么保存原始 Markdown，而不是 HTML？模型上下文用哪份？**

原始 Markdown 是消息内容，HTML 是展示结果。

例如原文：

```md
**你好**
```

页面显示为 **你好**，但保存和下一轮模型上下文仍使用 `**你好**`。这样不会把页面标签混进聊天内容，也方便以后更换展示方式。

**2. `{content}`、Markdown 组件、`dangerouslySetInnerHTML` 有什么区别？**

| 方式 | 行为 |
|---|---|
| `{content}` | 当作纯文字显示，星号和 HTML 标签也是文字 |
| 本课 Markdown 组件 | 解析 Markdown，生成标题、列表等 React 元素，并跳过原生 HTML |
| `dangerouslySetInnerHTML` | 将字符串作为 HTML 插入页面，不能直接信任模型输出 |

例如 `**你好**`：第一种显示星号，第二种显示粗体。第三种解析的是 HTML，本身不会识别 Markdown 加粗语法。

**3. 两个依赖各负责什么？**

- `react-markdown`：负责解析并展示 Markdown。
- `remark-gfm`：扩展表格、删除线、任务列表等语法。

可以理解为：前者提供基本能力，后者增加一种 Markdown 方言。GFM 表格需要安装扩展，并通过 `remarkPlugins` 启用。

**4. 为什么用户消息保持纯文本？失败、停止后的回复为什么还能排版？**

用户消息保留纯文本，是本课的展示选择：让用户看见自己实际输入的内容，包括星号、标签和换行。

消息状态与排版是两件事。回复虽然停止或失败，已收到的部分内容仍然可以排版；同时继续显示“已停止”或“本轮失败”。

**能排版不等于生成成功，也不会改变它是否计入后续上下文。**

**5. HTML、URL 和图片分别怎么处理？HTTPS 为什么不代表可信？**

- `skipHtml`：跳过原生 HTML，避免把模型给出的标签直接变成页面元素。
- URL 规则：只接受符合本课规则的绝对 HTTP(S) 地址，拒绝 `javascript:`、`file:` 等。
- 图片占位：显示说明文字，不创建实际图片元素，不自动请求图片地址。

本课链接最终也是 `span`，因此不能点击打开。

HTTPS 表示连接使用加密传输，**不保证网站内容可靠**，钓鱼网站也可以使用 HTTPS。

**6. 为什么流式更新不需要额外 Effect？围栏没写完要修改原文吗？**

已有流程就是：

```text
收到增量 → 更新 content → React 重新渲染 → Markdown 解析新文本
```

因此不需要再建一份 Markdown state，也不需要 Effect 同步它。

代码围栏没写完时，按当前文本显示，等待后续增量即可。不要擅自补围栏或删除文字，否则保存和模型上下文中的原始内容都会被改变。

**7. 为什么普通 Markdown 用 `normal`，代码块用 `pre`？**

- `normal`：让普通段落按 HTML 的排版规则处理空白，由段落、列表等元素控制布局。
- `pre`：保留代码的空格、缩进和换行，让代码格式完整。

如果全局改成 `normal`，用户纯文本的换行可能丢失；全局改成 `pre-wrap`，又可能让 Markdown 区域出现多余空白。因此样式要限制在对应区域内。

**8. 为什么预览正常后，还要删除临时数据再检查真实聊天？**

临时预览只能说明：**这些固定样例能正确显示。**

它不能证明真实增量会更新、切换会话不会串消息、保存后能恢复。尤其预览数据覆盖真实消息展示时，即使后台正在生成，页面仍然显示固定样例。

所以必须删除预览、恢复 `messages.map`，再检查真实流式、停止、切换以及保存重启。
## 11. 学习记录与下一步

- 实践日期：
- 依赖安装结果：
- 类型检查结果：
- 排版、长代码和表格观察结果：
- 原生 HTML、链接和图片行为：
- 临时预览是否清理：
- 真实流式、切换、停止、重启结果：
- 尚不理解的自测题：

下一课根据本课反馈安排本地终端入门：先理解终端界面与 shell 进程的分工，再确定当前 Windows/Electron 版本的依赖与原生模块安装方式。Markdown 的代码复制和高亮可后续单独扩展，不在本课预先堆入功能。

### 编写时的验证边界

已读取实际 MessageList、样式、流式 Hook 和第十四课收尾代码，并运行当前正式项目 Node/Web 类型检查，均通过。本次只创建课程文档，没有替学习者安装新依赖或修改正式应用，也没有创建测试文件。

第十五课示例尚未安装依赖后编译或在窗口中运行；本课的类型检查、页面排版和安全行为验收由学习者按上述步骤完成。第十四课真实窗口、磁盘迁移、模型交互的逐项结果仍以用户反馈为准。
