# Codex 风格工作面板交付与验收

参考版本：Codex App 26.1007.2314。采用统一标签栏、聊天／分屏／完整视图及“工具”新标签页。文件、网页和终端均接入真实本地能力。

## 已实现

- 三种布局、拖动分隔线、窄窗口自动完整视图与宽窗口恢复分屏。保留唯一聊天与输入框，切换设置、技能及内容页保留聊天草稿。
- 32px 标签，90–240px 宽度限制，长标题省略、横向滚动、选中态与关闭按钮；切换、双击布局、拖动排序、中键关闭、右键关闭／关闭其他／关闭右侧、关闭历史恢复。
- Windows 快捷键：Ctrl+T 新建浏览器，Ctrl+W／Ctrl+F4 关闭，Ctrl+Shift+T 恢复，Ctrl+Tab／Ctrl+Shift+Tab、Ctrl+PageUp／PageDown 切换，Alt+1…9 定位，Ctrl+Alt+W 关闭其他。标签支持方向键、Home／End、Delete。
- 点击标签栏加号打开工具页；右键加号可选择“以完整视图新建”。工具页提供聊天、文件、浏览器、改动、终端；不编造推荐或最近项目。
- CodeMirror 6 文件编辑、语法高亮、查找、撤销／重做、行号定位。相同文件与来源复用标签，历史快照独立且只读。
- 手动保存与未保存标记，关闭时保存／放弃／取消。保存核验上下文与原版本，外部冲突保留草稿并提供比较、重新读取；保留 UTF-8 BOM 和统一 CRLF。
- 原生 webview：网址或 Bing 搜索、导航、标题、错误、外部打开、新窗口转标签。切换保留页面实例，网页没有应用 preload、Node 或业务 IPC 权限。后台会话的弹窗归属原会话。
- 多终端真实 Shell，各有独立 sessionId、输出和进程；新建才启动，关闭等待清理，恢复终端等待手动启动。
- 现有 Git 工作台与真实来源列表接入内容宿主；聊天文件引用通过兼容入口打开统一标签。
- 会话库保持 v9；工作面板独立版本化存储，未保存草稿单独持久化且原子发布。恢复核验目录与文件，浏览器等待加载，终端等待启动。会话删除与窗口退出接入草稿和资源处理。

## 验证

| 检查           | 结果与范围                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 构建           | TypeScript 三个目标检查及生产构建通过；Windows NSIS 安装包已生成                                                                                      |
| 工作面板核心   | 7 项真实文件／状态检查、7 项模拟 Electron + 真实磁盘 IPC 检查通过                                                                                     |
| 开发版与打包版 | 各 17 项实际 Electron 检查通过：布局、菜单、分隔线、键盘、文件保存与冲突、快照、webview、多终端、窗口取消关闭、窄窗口长标题与重启恢复；目录见交付清单 |
| 新对话、Skills | 最终 Windows 包 16 项界面回归通过，居中输入框、Skills 进出、工具栏按钮不重叠与原聊天草稿保留                                                                            |
| 既有离线回归   | lesson58 默认 11 套、lesson59 4 套、lesson60、lesson62、Git 工作台 8 套通过                                                                           |
| 代码检查       | 新工作面板及相关终端模块 ESLint 0 错误、4 条 Hook 依赖警告；未把警告计作完全无诊断                                                                    |
| 网络与资源     | 界面验收模型请求为 0；本地 HTTP 站点与两个真实 PowerShell 验证；测试进程正常退出，无强制终止                                                          |

核心证据：`C:/Users/Administrator/AppData/Local/Temp/zonecodex-workbench-IykpyL`、`C:/Users/Administrator/AppData/Local/Temp/zonecodex-panel-ipc-cKeNSS`。

最终包的新对话回归：`.ui-check/new-chat-ui/packaged-8ef36172-2d91-4a29-b3e1-c04ce8572f63/results.json`。

Git 离线回归：`.ui-check/test-runs/git-workbench/offline-group-e68bcde7-a992-4348-b20f-584c6d580f82/results.json`。

其他离线回归的本轮报告：

- lesson58：`.ui-check/test-runs/lesson58/offline-group-214352cf-5668-443d-a319-988a28647f42/results.json`。
- lesson59：`.ui-check/test-runs/lesson59/offline-group-4fd9ebd2-010b-4d8a-8062-8d187f9fc78d/results.json`。
- lesson60：`.ui-check/test-runs/lesson60/offline-group-2dd11dea-ab81-4e3c-a13d-433ba742df30/results.json`。
- lesson62：`.ui-check/test-runs/lesson62/offline-group-ebbcb983-55c9-40c4-9a8a-41b99e9830f7/results.json`。

## 证据与限制

截图来自真实开发版及打包版窗口，使用独立、自编写会话与临时文件。完整结果、截图文件、产物 SHA256 和前后相同校验保存在 [交付清单](workbench-evidence/manifest.json)。安装包为 `dist/zonecodex-1.0.0-setup.exe`；验收运行的是同次生成的 `dist/win-unpacked/zonecodex.exe`，未在用户电脑安装或替换现有应用资料。

应用点击、文字输入、按键及分隔线使用 CDP 输入。标签拖动采用合成 DataTransfer；网页夹具动作使用带用户手势的 executeJavaScript；文件兼容入口通过组件真实控制器触发。附件选择测试使用独立文件及模拟选择器结果，原生选择对话框本身未验收。Git 内容宿主验证了真实入口及空状态，Git 操作另跑现有离线套件。本轮没有执行模型请求、公网网页、剪贴板或输入法验收，也没有宣称与原版逐像素相等。

MCP 页面、远程桌面、浏览器扩展与跨窗口拖移按计划留待能力接入。

验收截图仅在本地保留，已加入 Git 忽略规则；GitHub 提交材料使用纯文字记录。

