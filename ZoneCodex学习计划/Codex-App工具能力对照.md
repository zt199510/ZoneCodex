# Codex App 工具能力对照

此表依据 OpenAI 官方文档梳理可观察的 Codex App 能力，用于确定 ZoneCodex 的接入范围；两者不是同一产品，也不因界面或提示词相似而具有相同权限。

| 能力 | Codex App 官方说明 | ZoneCodex 状态 |
| --- | --- | --- |
| 工作区文件搜索、读取和修改 | 本地项目可附加文件夹；Codex 可在附加文件夹内搜索、读取和修改文件。[项目与聊天](https://learn.chatgpt.com/docs/projects) | 本轮接入目标：对选定工作区提供搜索、读取、新建文件和基于已读文件 SHA-256 基线的编辑；每次写入须经用户确认。 |
| 命令、测试和 Git 操作 | 本地命令受沙箱与审批约束；集成终端可运行项目检查和 Git 命令。[权限模式](https://learn.chatgpt.com/docs/permission-modes)、[集成终端](https://learn.chatgpt.com/docs/integrated-terminal) | 本轮接入目标：执行工作区命令和检查；每次命令执行须经用户确认。 |
| 变更审阅 | 审阅面板可查看未暂存、已暂存、提交、分支及最近一次操作的差异；`/review` 可报告问题。[代码审阅](https://learn.chatgpt.com/docs/code-review) | 未接入/可选：不把现有修改建议等同于完整的审阅面板或 `/review`。 |
| 权限与审批 | 沙箱限定文件和网络边界，审批决定越界操作何时暂停；审批方式本身不会扩展沙箱。[权限模式](https://learn.chatgpt.com/docs/permission-modes) | 本轮接入目标：对每次写入和命令执行取得用户确认；尚不具备 Codex 的沙箱。 |
| 网页搜索 | 官方提供一方网页搜索工具；本地 Codex 可配置索引、实时或禁用模式。[网页搜索](https://learn.chatgpt.com/docs/web-search) | 未接入/可选。 |
| 内置浏览器 | 桌面端浏览器可打开网站、交互、截图和验证页面，并对网站访问及敏感操作实施授权。[浏览器](https://learn.chatgpt.com/docs/browser) | 未接入/可选。 |
| 图像与附件输入 | 聊天可附加文件和图像作为本轮上下文。[项目与聊天](https://learn.chatgpt.com/docs/projects)、[图像输入](https://learn.chatgpt.com/docs/image-inputs) | 未接入/可选：不把现有文件快照能力表述为完整的图像输入能力。 |
| MCP、Skills 与插件 | 插件可组合 Skills、连接器和 MCP 工具；外部服务还需安装、认证与授权。[插件](https://learn.chatgpt.com/docs/plugins) | 未接入/可选。 |
| Computer Use | 这是需要安装和启用的插件，另受操作系统、地区和逐应用授权限制；文件与命令仍遵循原有权限边界。[Computer Use](https://learn.chatgpt.com/docs/computer-use) | 未接入/可选。 |

本轮核心仅为工作区搜索/读写、命令执行及每次写入或命令的确认流程。正式实现和验证结果应以代码、测试及桌面验收记录为准，不能仅凭此清单宣称已具备 Codex App 的全部工具能力。
