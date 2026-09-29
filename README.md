# ZoneCodex

第一版基础代码：使用 Electron、React 和 TypeScript 构建的个人 AI 桌面工作空间。

## 当前功能

- 多会话聊天、Markdown 展示、停止生成、本地自动保存和关闭保存保护。
- 会话首次发送自动标题、重命名、标题/消息搜索、置顶、归档和恢复；归档保留完整记录，不提供永久删除。
- 统一输入框与「＋」附件浮层，支持多选文本/代码文件、移除附件；添加附件即允许在当前会话中使用其内容。
- 模型工具循环，支持时间查询、已授权文件读取与搜索；正式聊天和工具调用统一使用真实模型流式响应。
- 基于 xterm 和 node-pty 的 PowerShell 终端，以及可调整的工作台布局。

当前附件上限为 8 个文件、单文件 32 KiB、合计 128 KiB。图片输入、目标/计划/绘图模式、文件写入、SSH 和 MCP 留待后续实现。

## 开发

安装 Node.js 与 npm，在项目根目录运行：

```sh
npm install
npm run dev
```

真实模型调用需要本地配置 `MODEL_ENDPOINT`、`MODEL_NAME` 和 `MODEL_API_KEY`。密钥仅用于主进程，不应写入源码或学习文档；`.env.local` 不纳入 Git。终端功能当前以 Windows PowerShell 为基础。

## 本地验证

```sh
npm run typecheck
npm run lint
npm run build
```

应用运行时只使用真实模型的 Responses SSE 流；仓库不再保留模拟模型、内存业务替身或桌面 fixture 检查脚本。真实模型调用需要配置 `MODEL_ENDPOINT`、`MODEL_NAME` 和 `MODEL_API_KEY`，端到端桌面结果需在可用网关和桌面环境中验收。

## 项目与课程

`src/main` 负责系统、模型、工具与存储；`src/preload` 暴露业务接口；`src/shared` 定义共享协议；`src/renderer` 负责工作台界面。`build/` 中的图标与打包资源属于源码，`out/`、`dist/`、本地备份及测试截图不纳入 Git。

- [学习计划](ZoneCodex学习计划/README.md)
- [项目结构地图](ZoneCodex学习计划/02-项目结构地图.md)
- [第十一至二十一课小结](ZoneCodex学习计划/29-第十一至二十一课小结.md)
- [工程整理与工作台布局](ZoneCodex学习计划/30-工程整理-项目上下文与工作台布局.md)
- [输入框交互整合](ZoneCodex学习计划/31-输入框交互整合-统一聊天与附件浮层.md)
