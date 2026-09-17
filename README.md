# ZoneCodex

第一版基础代码：使用 Electron、React 和 TypeScript 构建的个人 AI 桌面工作空间。

## 当前功能

- 多会话聊天、Markdown 展示、停止生成、本地自动保存和关闭保存保护。
- 统一输入框与「＋」附件浮层，支持多选文本/代码文件、移除附件；添加附件即允许在当前会话中使用其内容。
- 模型工具循环，支持时间查询、已授权文件读取与搜索。普通聊天使用工具循环，开发调试区保留流式与模拟模式。
- 基于 xterm 和 node-pty 的 PowerShell 终端，以及可调整的工作台布局。

当前附件上限为 8 个文件、单文件 32 KiB、合计 128 KiB。图片输入、目标/计划/绘图模式、文件写入、SSH 和 MCP 留待后续实现。

## 开发

安装 Node.js 与 npm，在项目根目录运行：

```sh
npm install
npm run dev
```

真实模型调用需要本地配置 `MODEL_ENDPOINT`、`MODEL_NAME` 和 `MODEL_API_KEY`。密钥仅用于主进程，不应写入源码或学习文档；`.env.local` 不纳入 Git。终端功能当前以 Windows PowerShell 为基础。

## 检查

```sh
npm run typecheck
npm run lint
npm run build
node scripts/check-attachments.cjs
npm run check:workspace
```

工作台检查使用真实 Electron 渲染器、正式 preload 和模拟业务接口，覆盖会话、保存、附件浮层与窄窗口布局。测试不连接真实模型或读取真实聊天记录，截图与临时数据保存在 `.ui-check/`。附件检查验证文件快照、读取限制和授权范围。

`scripts/check-conversation-library.cjs` 是第十三课历史练习脚本，依赖该课临时构建和旧数据格式，不属于当前版本的回归检查。

## 项目与课程

`src/main` 负责系统、模型、工具与存储；`src/preload` 暴露业务接口；`src/shared` 定义共享协议；`src/renderer` 负责工作台界面。`build/` 中的图标与打包资源属于源码，`out/`、`dist/`、本地备份及测试截图不纳入 Git。

- [学习计划](ZoneCodex学习计划/README.md)
- [项目结构地图](ZoneCodex学习计划/02-项目结构地图.md)
- [第十一至二十一课小结](ZoneCodex学习计划/29-第十一至二十一课小结.md)
- [工程整理与工作台布局](ZoneCodex学习计划/30-工程整理-项目上下文与工作台布局.md)
- [输入框交互整合](ZoneCodex学习计划/31-输入框交互整合-统一聊天与附件浮层.md)
