# 第 64 课：实施与本地验收记录（2026-10-16）

本课实现了可替换 ModelProvider / 固定 ModelSession、Responses SSE 与生产离线 Provider，以及桌面、CLI、公共 Node 脚本的统一接线。用户实测确认、八道自测和第 63.1 课整体收口仍独立保留。

## 实际产品行为

无模型配置自动离线，普通聊天只返回“当前为离线模式，未调用推理模型，也未执行本轮任务。”不自动连接 enabled MCP，不编造工具调用、摘要或任务完成。离线标题保留本地初始值，Git 生成不可用，图片与续接明确拒绝，独立风险复核回到人工审批。配置错误不会阻止查看设置或管理本地 MCP；远程错误保持原错误，不降级成功。

设置新增只读模型状态和 MCP 工具名称/描述查看。未加入登录、密钥表单、网络 MCP 或新的聊天输入区入口。会话 v9、设置 v1、checkpoint v1 保持；测试使用独立用户目录，未迁移或清空用户资料。

MCP 工具调用冻结集合、配置版本、连接 token 与 schema 指纹，调用前后及审批后校验；任务等待期间也检查冻结工具。原 MCP 续接证明只留在窗口内存。配置/schema/连接改变后拒绝续接；重启后含 MCP 调用的旧任务缺少原连接证明，也拒绝续接并要求核对工具效果后重新发送。正常无 MCP 任务保留原恢复流程。

## 已执行检查

| 检查 | 本轮结果与边界 |
|---|---|
| `npm run typecheck` | 通过，main / renderer / CLI |
| `npm run build` | 通过，重新编译 main / preload / renderer |
| `npm run build:unpack` | 通过；最后补充工具列表后一次 afterPack 版本探测超时，保留失败后重新打包、构建 CLI 并复验双版成功 |
| `test:lesson64:list` | 通过；说明真实/合成层，不自动构建 |
| `test:lesson64:offline` | 33 项通过：模型 12、真实 MCP 17、CLI 4；外部 HTTP 禁止，没有远程模型请求 |
| `test:lesson64:desktop` | 开发版、当前重建目录包各 11 项通过；生产离线 Provider，无模型替身 |
| `test:lesson63:offline` | 通过；原 fixture 验证，不能冒称完整产品验收 |
| `test:lesson63.1:offline` | 通过；原源码标记/fixture 检查；不结清第 63.1 整体欠账 |
| `test:workbench:core` | 文件/状态 7 项、IPC 7 项通过 |
| `test:lesson62:offline` | 56 项通过：Skills 18、存储 10、renderer 24、runtime 4 |
| `test:lesson60:offline` | 68 项通过：权限 32、renderer 23、CLI 13 |
| `npm test` | 第 58 课默认 11 组通过，包含历史/容量/取消/图片/续接等原断言 |
| `test:git:offline` | 8 组、103 项通过；含 Git 生成/来源/隔离，合成传输单独标注 |
| `test:lesson59:offline` | 4 组通过，终端生命周期与原生辅助程序准备逻辑 |
| `test:workbench:desktop` / `packaged` | 两版各 18 项通过；实际文件编辑、两个真实 shell、Git/来源、草稿/布局和重开 |
| `test:lesson61:offline` | 原历史套件未通过：IPC、依赖隔离及 renderer 三组仍假设扩展前 Git/工作面板结构，见独立欠账 |

上述“离线”表示不请求远程模型，不表示 Responses SSE 测试使用真实远程服务。构建工具可能读取 Electron 下载缓存/镜像，构建联网与模型测试联网分别记录。没有执行真实远程模型或认证请求。

## 桌面验收过程

两版均使用独立 userData、APPDATA、LOCALAPPDATA，并在应用初始化前清除 MODEL / OPENAI 环境配置。主进程模型网络调用被阻止和计数；检查均为零。主进程 inspector 只设置隔离与审计，不替换模型 Provider。页面操作使用实际 CDP 鼠标、键盘和输入事件。

1. 首次启动，无登录与模型配置，聊天输入正常；设置显示只读离线状态；不存在的 MCP 设置被初始化为空。
2. 在设置表单新增本地 stdio Server，使用实际 Node fixture 进程；连接后显示 10 个命名空间工具，展开可见工具名和描述。
3. 刷新产生实际 `tools/list` 请求；断开后核对实际子进程 PID 已退出。
4. 保留 enabled 设置，返回聊天并发送请求；仅显示固定离线说明，未自动连接 Server。记录写入 v9 会话库，标题保持本地初始文字。
5. 再次主动连接 Server，保留活跃子进程，然后请求正常退出；退出闸门完成，应用及观察到的子进程均真实退出。
6. 新进程重开同一隔离 userData，离线消息恢复，没有模型请求；在设置删除 Server，界面立即移除，磁盘配置为空。
7. 独立工作面板回归两版各 18 项，覆盖真实 UTF-8 文件保存/冲突、两个 shell 的独立输出与关闭、Git/来源、草稿、窄屏及新对话输入布局。

Windows 包内 main / preload / renderer 入口与当前编译产物的 SHA-256 一致；身份写入对应报告。截图只在忽略的本地证据目录，未加入 Git。

## 本地证据索引

相对仓库根目录，以下均位于忽略目录；完整结果保留各次失败，不以最后一次通过覆盖历史文件。

- 离线组：`.ui-check/test-runs/lesson64/offline-group-a2303d09-2077-4807-b666-3e9f5fb7617e/results.json`
- 模型：`.ui-check/test-runs/lesson64/model-8bf64722-181d-4172-b0a8-148017b74f6a/results.json`
- MCP：`.ui-check/test-runs/lesson64/mcp-c1bdff43-0588-499b-bc18-c2ca01151f28/results.json`
- CLI：`.ui-check/test-runs/lesson64/cli-78f0f6f2-9d81-4478-a619-c795805b5cfa/results.json`
- 最后工具列表 UI 开发版：`.ui-check/test-runs/lesson64/desktop-development-3d2c7a81-2fbc-4464-9b47-37c1a41521ea/results.json`
- 最后工具列表 UI 目录包：`.ui-check/test-runs/lesson64/desktop-packaged-3f5f258c-8271-4250-b180-fb009f90041b/results.json`
- 最终双版组（含退出闸门）：`.ui-check/test-runs/lesson64/desktop-group-13c05020-7817-4845-9e6e-9c4fbb1c554d/results.json`
- 工作面板两版：`.ui-check/workbench-ui/development-2c89358f-6b7e-41bb-8d71-cb82332076b4/results.json`、`.ui-check/workbench-ui/packaged-3d8410e8-5aa6-4838-a33d-186bed8d30ff/results.json`；工具列表补充后的复验另见本地 delivery 日志。
- 全量回归日志：`.ui-check/lesson64-default-final.log`、`lesson64-permissions-final.log`、`lesson64-skills-final.log`、`lesson64-git-final.log`、`lesson64-terminal-final.log`。

## 失败、修复与独立欠账

本轮发现并修复：旧客户端替身未接到新模型接口、工作面板 render prop 导致 Skills 测试找不到组件、MCP 表单在延迟更新中读取失效事件、启动中进程未及时登记、取消通知请求 ID 错误、损坏配置被后续读取绕过以及旧连接/工具结果覆盖新状态。测试适配继续使用实际 Session / 核心逻辑，未去掉原权限行为断言。

旧第 61 课历史套件有三组结构断言不适配已存在的 Git/工作面板扩展：新增仓库 IPC、Agent 的既有 Git turn 依赖，以及被工作面板替换的旧组件结构。失败日志保留在 `.ui-check/lesson64-terminal.log`；当前 Git 103 项和真实双版工作面板检查通过，不把它们等同于旧套件已通过。该历史套件维护仍待独立处理。

第 63.1 课原验收不能仅靠旧源码标记/手写 JSON-RPC fixture 宣称结清。本课提供真实产品模块与真实进程的补充，但不代填其用户验收，也不宣称完成所有 Windows 特殊文件/目录标签或任意恶意程序的 OS 沙箱证明。

未执行真实远程模型、真实 OpenAI 登录、外部 OAuth、远程 MCP 或远程 Git 发布。用户确认及八道自测仍待补。

补记：最终 `electron-builder --dir` 成功（`.ui-check/lesson64-package-retry.log`），随后 `build:agent` 成功；最终双版桌面各 11 项通过。包内 ASAR 清单没有 lesson64、测试 Provider 或 MCP fixture。类型检查再次通过（`.ui-check/lesson64-typecheck-delivery.log`）。最终断网检查另阻止原生 net/tls 连接和 DNS，33 项全部通过；截图和二进制均未加入提交。
### 后续诊断补丁：流式失败原因显示（2026-10-16）

用户本地测试应用持续出现“本轮失败 · 不计入后续上下文”。只读观察运行中的开发版发现，公开模型状态为 Responses 配置就绪，当前实际错误为“模型未完整完成回复，请重试”。该错误对应远程 `response.failed`、`response.incomplete` 或 `error` 事件；原实现合并事件，历史记录未保留具体服务端原因，不能据此认定是密钥、额度或模型问题。

补丁保留失败轮排除规则，新增安全事件分类和已知错误码的中文说明（额度、限流、密钥拒绝、模型不存在、上下文/输出长度、内容过滤、请求格式、内部错误）。不公开服务端 message、未知 code 或地址/凭据。编译后的真实 Responses Provider 合成 SSE 检查新增一项，模型组 13 项及完整类型检查通过，证据 `.ui-check/test-runs/lesson64/model-3d26891a-6c91-4a6f-852a-ffb5ec243a9b/results.json`。本次只读观察未发送真实模型请求；诊断补丁尚未重新打包，前文目录包验收属于补丁前版本。下一次实际请求才可显示服务返回的具体安全分类。
### 聊天系统提示收敛（2026-10-16）

按用户要求移除对话区常驻的长续接警告条和“本轮失败/已停止 · 不计入后续上下文”内部机制说明。续接操作保留为会话工具栏简短按钮；模型请求失败不再在顶部重复显示错误横幅，助手消息只显示“回复失败”，本轮错误原因通过该状态的悬停信息查看。输入校验、存储及工作区错误仍保留原反馈，底层失败轮隔离、目录/权限校验和续接安全指令不变。

只读核对用户正在运行的开发版：旧续接条不存在，旧机制文案不存在，顶部错误横幅为空，失败状态为简短文字，续接按钮位于工具栏；没有发送请求或修改用户会话记录。完整类型检查通过；本轮仅修改 renderer 和相关桌面验收选择器，没有重新打包。

用户随后明确要求删除“继续此任务”按钮，已从聊天工具栏移除该入口。renderer 类型检查通过，运行中的开发版只读核对确认按钮和文字均不存在；底层记录未删除。

### 实际模型故障排查（2026-10-22）

本轮排查时应用未运行。只读检查原会话库中两条模型首轮失败记录，均为旧通用错误，未保留服务端具体代码。使用现有本地模型配置和编译后的真实 Responses Provider 发起四次实际请求：最小文本、当前 Agent 7 项标准工具 schema，以及两条历史失败消息分别作为新请求。全部 HTTP 200、response.completed，耗时约 2.3/2.1/3.0/5.6 秒；未执行任何工具，未修改用户聊天记录。历史消息测试未精确复原原运行目录/完整历史/当时服务状态，因此只能说明当前未复现，不能宣称历史根因已确定。

发现旧 `out/main/index.js` 未包含后续源码中的安全错误分类。已重新执行 `npm run build`（包含三类类型检查），并确认新主进程产物包含分类；13 项断网模型测试通过。Windows 目录包本轮未重建，不把开发构建更新等同于目录包更新。启动新开发构建后的新错误才会显示安全事件类型和已知原因；旧历史错误不自动变化。

独立证据：`.ui-check/model-diagnosis-2026-10-22/summary.json` 及同目录各 probe / build / model-tests 记录。证据未保存地址、密钥、用户消息内容或完整响应；测试脚本留在 Git 忽略目录。此前“本课未真实联网”的描述为 2026-10-16 对应轮次事实，本次四个真实请求单独记录。
