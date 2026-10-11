# 第五十七课：跨进程可恢复的 Agent 任务续接

创建日期：2026-10-11。状态：**课程已创建，产品实现与本课运行验收待进行；八道自测均待作答。**本轮只编写课稿并做最小导航同步，没有实现 checkpoint/resume、调用模型或构建应用。

前置：[第54课](69-第五十四课-UI与Agent逻辑拆分.md)已提供普通 Node 可调用的 `runAgentCore` 与唯一工具循环；[第55课](70-第五十五课-命令行与脚本入口.md)已由用户确认完成单次 CLI/脚本入口（空初始历史、无 resume）；[第56课](71-第五十六课-上下文整理与容量管理.md)已有条件通过原记录/工作投影分离与请求内整理（见第9/10节证据）。第56课**不得默认全部验收通过**：用户实测确认、八道自测、原生资源符号链接 EPERM、真实多图整理回归、自然「改坏→同任务再修」分支仍为 open，本课继承为后置，不改写其结论。

维护入口见[tests/README.md](../tests/README.md)。会话版本9、设置版本1及第56冻结容量合同保持。

## 1. 本课目标与前置条件

在保持**原记录完整**、**请求内/可持久化摘要边界清晰**、且**不复活权限票据**的前提下，实现**跨进程可恢复的 Agent 任务续接**：桌面「显式继续」与 CLI `--resume`（或等价脚本 API）共用同一核心合同。

本课要让学习者能回答：

1. 中断后磁盘上到底保存了什么（任务指针 / 可选摘要），什么故意不保存？
2. 新进程如何校验指针、装载 raw、可选装载摘要，再交给 `runAgentCore`？
3. 为什么恢复记录不等于恢复批准、读取凭据或命令票据？
4. 桌面默认重开为何仍应「被动零请求」，而「继续任务」必须用户明确发起？

### 1.1 一句话目标

在保持原记录完整、请求内/可持久化摘要边界清晰、且不复活权限票据的前提下，实现跨进程可恢复的 Agent 任务续接（桌面会话恢复与 CLI resume 共用核心合同）。

### 1.2 前置能力清单

| 课 | 必须带走 | 本课用法 |
| -- | -------- | -------- |
| 第54课 | `runAgentCore` + `tool-loop`；窗口/材料/审批在宿主 | 续接编排仍走同一核心，不复制第二套循环 |
| 第55课 | 一次输入→一次终态的 CLI/脚本；公开事件与退出码 | 默认行为保持；新增显式 resume，无 resume 时与第55一致 |
| 第56课（有条件通过） | raw ≠ working；请求内整理；双宿主整理后业务有证据 | 续接后从可信 raw + 可选已校验摘要再准备 working；过期摘要须重算 |

### 1.3 明确不做

- MCP、Skills、SSH、远程执行、并发多 Agent、完整自动更新产品化
- 恢复旧批准、旧读取凭据、旧命令票据、旧窗口材料句柄
- 静默自动续跑（打开应用/切换会话/导入模块不得自动发主请求或摘要）
- 抬高第56字符/项预算或取消 raw 当轮保存合同来「换」续接成功
- 把第56 open 项改写成已通过；不承诺无限长任务

## 2. 用 Vue 经验理解本课

| Vue 中的经验 | 本课对应 | 要理解的区别 |
| ------------ | -------- | ------------ |
| 路由里带 `id`，页面按 id 拉详情再渲染 | checkpoint 带任务身份，新进程按 id 装载再跑 | 装载的是记录与指针，不是登录态/权限 cookie |
| `keep-alive` 缓存组件实例 | 会话库保留聊天与工具展示 | 缓存 UI 状态 ≠ 后台请求仍在跑 |
| 表单草稿 localStorage，提交前再校验 | 可选持久摘要落盘，resume 前校验源指纹 | 草稿损坏就丢弃重算，不能当权威指令 |
| service 无 session 时拒绝写操作 | 新进程无票据则必须重新审批 | 「继续」不是「沿用上次批准」 |
| 列表页与编辑页共用同一 API | 桌面与 CLI 共用装载/校验模块 | 禁止两边各写一套 resume 语义 |

例如：CLI 在整理后、补丁前被 Ctrl+C 打断。磁盘留下 checkpoint（指向完整 raw、可选摘要指纹、目录绑定）。用户新开终端 `--resume`：宿主校验目录与指纹 → 核心拿到 history → 新 requestId 继续；任何写入仍走当前三权限与真实读取 hash，不会读出「上次已批准」的票据。

## 3. 当前实际文件与最小新增边界

以下按创建时源码核对；实施前必须重读当前版本。表中现有文件已存在；候选新增只表达职责，不预先当成已实现。

| 当前文件 | 已有职责 | 本课复用或必要调整 |
| -------- | -------- | ------------------ |
| [agent-core.ts](../src/main/agent/agent-core.ts)、[agent-core-contract.ts](../src/main/agent/agent-core-contract.ts) | 唯一核心、固定输入、事件、副作用事实 | 接受宿主已校验的 history/续接元数据；新 requestId；不从 checkpoint 取授权 |
| [tool-loop.ts](../src/main/agent/tool-loop.ts)、[context-manager.ts](../src/main/agent/context-manager.ts) | 模型/工具循环、raw/working、整理水位 | resume 后仍用同一整理合同；call_id 防重从 raw 重建；不因恢复丢失防重 |
| [agent-history.ts](../src/shared/agent-history.ts) | 协议轮严格解析与模式/scope 选取 | checkpoint 引用的 raw 必须先过同一解析；坏历史拒绝恢复 |
| [agent-runner.ts](../src/main/agent/agent-runner.ts)、[agent-ipc.ts](../src/main/agent/agent-ipc.ts) | 桌面来源、材料、生命周期 | 显式「继续」入口；默认重开仍被动；材料/权限宿主重新准备 |
| [task-registry.ts](../src/main/execution/task-registry.ts) | 进程内任务状态与句柄 | 进程内句柄不可跨进程；checkpoint 不保存 Job/PTY/批准 map |
| [agent-host.ts](../src/cli/agent-host.ts)、[arguments.ts](../src/cli/arguments.ts)、[host-contract.ts](../src/cli/host-contract.ts) | 单次任务、空历史、公开输出 | 增加 `--resume`；无该参数时行为与第55一致；帮助/导入仍零启动 |
| [conversation-library.ts](../src/shared/conversation-library.ts)、[conversation-store.ts](../src/main/storage/conversation-store.ts) | 会话库版本9 | 可引用会话 raw；若增 checkpoint 存储须独立版本与坏文件保护，不 silently 改 v9 语义 |
| [agent-context.ts](../src/shared/agent-context.ts)、[context-summary.ts](../src/main/model/context-summary.ts) | 有界整理状态、无工具摘要适配 | 可选持久摘要仍为低信任；恢复后可再整理，不得把摘要当工具结果 |
| [useChatRequest.ts](../src/renderer/src/features/chat/useChatRequest.ts)、会话/侧栏相关 | 发送、停止、重开展示 | 「继续任务」与普通发送分开；非明确动作不发起整理/主请求 |
| [tests/README.md](../tests/README.md)、[package.json](../package.json) | 离线/原生/真实分组 | 新增本课最少维护源与明确 suite；默认 `npm test` 仍断网 |

**建议新增（实施时择最少文件，名称可调整）：**

- 共享：`task-checkpoint.ts`（或同级）— schema、状态枚举、指纹、装载/校验纯函数
- 主进程或存储：checkpoint 读写（串行临时写盘、坏文件保留）
- CLI：resume 参数解析与宿主装载路径
- 桌面：显式继续 API + 最小 UI 入口

完整 CLI 可达闭包继续无 Electron 运行时依赖；公共模块导入不得启动模型、工具或 writer。

## 4. 按依赖顺序实施与练习

整课一次交付，但步骤按依赖拆成两阶段，避免一次改炸。两阶段共用同一课号与同一验收总表。

### §4A 阶段：任务指针合同与安全再水合（先冻结合同）

#### 步骤一：冻结 TaskCheckpoint 合同

先核对 Git、未提交改动、当前源码/产物与第56相关证据身份，用新 UUID 建本课基线。不能覆盖用户库、工作目录或旧证据。

定义至少包含：

1. `schemaVersion`（本课新增，与会话库 v9 分开说明）
2. 任务身份：`taskId` / 可选 `conversationId` / 创建与更新时间
3. 执行意图：`mode`、scope 指纹、工作目录/workspace 绑定方式（存可复核路径，不存授权）
4. 原记录锚点：如何引用完整 raw（内嵌有界片段或指向会话库稳定位置）
5. 可选摘要：源指纹、内容哈希、形成时的 working 字符统计；允许缺失
6. 进度状态：如 `interrupted` / `resumable` / `completed` / `abandoned`（实施时冻结枚举）
7. 中断原因：用户取消、宿主退出、预算停止、失败等（公开、有界）

**明确不写入 checkpoint：** 批准决定、读取凭据、命令票据、windowId、Job 句柄、PTY、密钥、隐藏推理、原图 dataURL、完整 HTTP 正文。

**预期效果：** 任何人只看 schema 就知道「能恢复什么、不能恢复什么」。  
**常见错误：** 把会话消息 JSON 整包当作 resume 权限；或把第56请求内摘要直接当永久权威。

#### 步骤二：共享装载 / 校验 / 拒绝路径

实现纯函数（建议放 shared 或 main 无 Electron 依赖层）：

1. 读 checkpoint → 严格字段/版本校验  
2. 装载 raw → `agent-history` 同类解析；模式/scope 不一致则拒绝  
3. 若有持久摘要：核对源指纹与哈希；失败则**降级为无摘要**（仅 raw）或整单拒绝（行为写死并测，禁止静默篡改 raw）  
4. 产出可交给核心的 `AgentCoreInput` 字段：`history`、新 `requestId`、续接元数据；`scope` 只描述工具范围，不授予访问  

目录漂移、文件消失、版本不支持必须有明确错误码/公开事件，不能半加载后开跑。

**预期效果：** 坏指针在发模型前失败。  
**常见错误：** 先 `runAgentCore` 再校验；或校验失败仍留下半写状态。

#### 步骤三：核心最小接线（不复活票据）

在唯一 `runAgentCore` / `tool-loop` 上：

1. 续接请求使用**新** `requestId`；宿主 `assertCurrent` 仍有效  
2. 从完整 raw 重建已见 `call_id`，防止恢复后重放同一调用副作用  
3. 私有读取凭据、批准 map、命令计划一律空启动；需要副作用时走原三权限与准备链  
4. 第56 `RequestContextManager` 继续管理 working；resume 后触顶仍可整理，规则不放宽  

此步骤可先用普通 Node + 合成传输验证，不要求先做完 CLI 旗标。

**预期效果：** 「恢复后的第一次工具写入」必须重新过批准（在 default 等需要批准的模式下可测）。  
**常见错误：** 为了测通业务把上次 approval 序列化进 checkpoint。

### §4B 阶段：双宿主显式续接与真实业务

#### 步骤四：桌面显式「继续任务」

1. 在合适生命周期写入/更新 checkpoint（例如用户停止、可恢复失败、或明确「保存以便继续」——实施时选一种主路径并写清）  
2. 应用重开 / 切会话：默认仍只恢复展示记录，**主/摘要/标题/批准请求为 0**（与第56重开精神一致）  
3. 提供明确 UI/IPC「继续此任务」：用户点击后才装载 checkpoint 并启动核心  
4. 继续过程中的计划问答、审批、停止、关闭保护沿用原桌面适配，不新开旁路  

**预期效果：** 重开安静；继续吵闹且可观察。  
**常见错误：** 启动时自动 resume 上次 interrupted 任务。

#### 步骤五：CLI / 脚本 `--resume`

1. `arguments` 增加 resume 入口（id 或文件路径，实施时冻结）；与 `--prompt`/`--stdin` 互斥规则写清  
2. 无 resume：保持第55「一次任务、空历史」  
3. 有 resume：宿主装载 → 核心续接 → 文本/JSONL 增加有界 resume 公开事件（不含协议全文）  
4. 帮助、模块导入、无任务新进程：仍零模型/工具/writer  
5. 缺少交互时的退出码精神与第55一致（不能因 resume 默认同意批准）  

**预期效果：** 脚本可 `resume` 接上一次中断的受控任务。  
**常见错误：** resume 时忽略 `--cwd`/`workspace` 复核，或允许用旧目录外的票据。

#### 步骤六：与第56摘要指纹联动

1. 若 checkpoint 含持久摘要：resume 成功后，后续主请求的 working 可包含该低信任块，但仍受 96000/128000 等原限额  
2. 源组变化、raw 增长导致指纹失效：必须重整理或明确失败，禁止「摘要说过已读」替代当前 hash/可见行  
3. 不把持久摘要放进 instructions 躲预算；不恢复已取消的跨轮 300 项/64000 字符门槛  

**预期效果：** 续接后整理合同与第56同族，而不是第二套压缩器。  
**常见错误：** resume 专用「无限摘要」旁路。

#### 步骤七：分层检查与双宿主真实续接

1. 断网：schema、坏指纹、降级、call_id 防重、批准 map 为空等  
2. 开发桌面 + Windows 目录包：中断 → 新 PID → 显式继续 → 固定业务可核对  
3. 开发 CLI + 分发 CLI：同任务真实或夹具中断 → `--resume` → 固定业务可核对  
4. 合成历史 / 真实摘要 / 真实工具 / 独立磁盘分记；新 UUID，不覆盖第56证据  

**预期效果：** 四入口对「续接」有独立证据。  
**常见错误：** 只用桌面重开零请求冒充 CLI resume 通过。

#### 步骤八：文档与证据收口

追加本课第9节（实施后）：实际 schema、文件迁移、用户用法、各层结果、失败/未覆盖、产物身份、复跑命令。同步结构地图与编写约定中的**一行**当前指向即可。八题保持待答，直到用户明确掌握反馈。

## 5. 验收条件与方法

创建时以下全部**待验收**。实现完成、自动分层、用户实测确认、八题掌握分别记录。第56 open 项即使本课通过也仍标 open。

| 层级 | 必须核对 | 创建时状态 |
| ---- | -------- | --------- |
| Checkpoint 合同 | 字段/版本严格；禁止项未入库；坏文件不覆盖 | 待验收 |
| 装载校验 | raw 解析、模式/scope、摘要指纹失败路径 | 待验收 |
| 安全再水合 | 新 requestId；无批准/凭据/票据；call_id 防重 | 待验收 |
| 第56衔接 | 限额不放宽；摘要低信任；失效则重算或失败 | 待验收 |
| 桌面默认重开 | 恢复展示；相关请求分类计 0 | 待验收 |
| 桌面显式继续 | 用户动作后才跑；开发+目录包 | 待验收 |
| CLI 无 resume | 与第55行为一致 | 待验收 |
| CLI resume | 开发+分发；公开事件有界；帮助/导入零启动 | 待验收 |
| 真实业务续接 | 至少一条双宿主「中断→新进程→继续→固定测试可核对」 | 待验收；合成/真实分记 |
| 静态/构建 | Node/Web/CLI 类型、必要 lint/格式、构建/分发身份 | 待验收 |
| 证据/文档 | 新 UUID、失败保留、不改第56结论与八题 | 待验收 |

**诚实边界：**

- 自然「改坏→同任务再修」未出现则记未覆盖（继承第56）  
- 真实多图续接本课可不做；若未做不得写通过  
- 原生资源 EPERM 不因本课成功而改写  
- 字符预算不是 token；项目限制不是官方上下文窗口复刻  

## 6. 八道自测题

状态：**八题均待作答，不附参考答案。**

1. 原记录、工作投影、TaskCheckpoint 三者分别保证什么？少了哪一个会变成「假续接」？  
2. 为什么 checkpoint 不能保存批准、读取凭据和命令票据？恢复后第一次写入应走什么路径？  
3. 桌面「重开恢复记录」与「显式继续任务」在请求计数上应有何不同？  
4. CLI 无 `--resume` 与有 `--resume` 时，history 初始条件有何差异？帮助/导入为何仍须零启动？  
5. 持久摘要的源指纹失败时，有哪些合法策略？为什么禁止静默删 raw？  
6. resume 后 call_id 防重集合应从哪里重建？若只从 working 投影重建会有什么风险？  
7. 第56的 96000/128000 与 raw 当轮 160/128000 在续接后是否仍然分别检查？为何不能合并成一个数字？  
8. 哪些证据只能证明「合同/装载」，哪些才能证明「双宿主真实续接业务」？第56哪些 open 项不能写进本课通过？

## 7. 学习记录与下一步

本轮仅创建第57课课稿，并对学习计划 README、学习路线、学习进度做**最小一行级**导航更新；不修改产品源码，不改写第56验收结论与证据。创建时八道自测待答，产品实现待进行。

实施时建议顺序：先完成 §4A 合同与普通 Node 再水合，再做 §4B 双宿主与真实续接；两阶段均可在本课第9节分表记录，不必拆成两个课号。

**与第56 open 项（后置，本课不关闭）：**

| Open 项 | 本课态度 |
| ------- | -------- |
| 第56 用户实测确认待补 | 不继承为已确认 |
| 第56/54/55 八道自测待答 | 后置；本课八题独立 |
| 原生资源符号链接 EPERM | 后置 |
| 真实多图整理回归 | 后置 |
| 自然「改坏→同任务再修」 | 后置 |

**下一步（实施完成并有证据后讨论，不提前实施）：** MCP 只读教学接入、或自然修错专项、或文档消噪工程整理。未完成本课真实续接前，不宣称「跨进程 Agent 产品化完成」。

## 8. 可复制到新对话的完整实施指令

以下供新对话明确实施第57课使用；**本轮创建课稿不执行其中产品、模型、构建和业务验收动作。**

```text
开始完成第57课：跨进程可恢复的 Agent 任务续接。
项目目录：D:\AiTools\ZoneCodex\ZoneCodex
先读取：
D:\AiTools\ZoneCodex\ZoneCodex\ZoneCodex学习计划\72-第五十七课-跨进程可恢复的Agent任务续接.md
严格按课程第8节与第4节（含§4A/§4B）实施，并按第5节完成分层验收。课程已创建，本次直接实施，不停留在只提计划。

按需读取编写约定、结构地图、学习进度、第54/55/56课实际合同与证据边界、tests/README.md。先核对当前源码、产物、Git 未提交改动。第56课为有条件通过：用户确认、八道自测、原生EPERM、真实多图、自然修错仍为 open，不得改写为通过。保留所有未提交改动、用户库、工作目录、旧证据，不提交或重置 Git。

目标：在不复活批准/读取凭据/命令票据的前提下，实现桌面显式继续与 CLI resume 共用的 TaskCheckpoint 合同与安全再水合；原记录完整；可选持久摘要带源指纹；第56 raw/working 限额不放宽。不做 MCP/SSH/并发/自动更新，不静默自动续跑。

§4A：冻结 checkpoint schema 与禁止项；共享装载/校验/拒绝；核心新 requestId、call_id 从 raw 重建、票据空启动；用普通 Node + 合成传输证明再水合安全。
§4B：桌面默认重开零请求 + 显式继续；CLI 无 resume 保持第55行为 + --resume；摘要指纹失效策略；开发/目录包桌面与开发/分发 CLI 真实或夹具中断→新进程→继续→固定业务可核对；帮助/导入零启动。

验收：合成与真实分记；新 UUID；追加本课第9节与最小导航；八题保持待答。第56 open 项在报告中继续标 open。
```

## 9. 本轮实施与分层验收记录（2026-10-11）

本轮直接实施 §4A 与 §4B。独立基线 UUID 为 `7b8f370a-3dfb-4354-ba5b-0307b5235bcd`，HEAD 为 `94b44c16a8cd7917f9fda0d9c7225856b172a8f6`。开始时已有学习路线、学习进度、README 的导航改动，以及本课与 `artifacts/payment-services.md` 两份未跟踪文档；产品源码当时没有未提交改动。原改动保留，未提交、重置或清理 Git；未使用用户会话库和工作目录做业务实验。所有新证据使用独立 UUID，旧证据和失败记录保留。

### 9.1 实际合同与职责

新增 [task-checkpoint.ts](../src/shared/task-checkpoint.ts) 与 [task-checkpoint-store.ts](../src/main/storage/task-checkpoint-store.ts)。`TaskCheckpoint.schemaVersion = 1` 独立于会话库 v9 和设置 v1，没有库迁移。字段冻结如下：

| 字段 | 实际合同 |
| ---- | -------- |
| 身份 | `taskId`、可选 `conversationId`、`createdAt`、`updatedAt`；同任务保存保留创建时间 |
| 意图 | `mode`、原任务 `prompt`（最多 2000 字符）、`scope`、`scopeFingerprint` |
| 目录 | `bindings.cwd`、可选 `bindings.workspace`，各含选择路径、真实路径及 `dev:ino:birthtimeMs` 身份；只复核漂移，不授予权限 |
| 原记录 | `raw.file`、SHA-256 JSON 源指纹、项数、字符数；同目录不可变 `raw-<fingerprint>.json` sidecar 保存完整 raw |
| 可选摘要 | `sourceFingerprint`、`contentHash`、`content`、形成时 `workingItems/workingCharacters`；哈希为 JSON 编码内容的 SHA-256 |
| 进度 | `interrupted / resumable / completed / abandoned` |
| 原因 | `user_cancelled / host_exit / budget_stop / failure / saved / completed / abandoned` |

全部嵌套 metadata 严格拒绝未知字段。没有批准决定、读取凭据、命令票据、windowId、Job、PTY、密钥、隐藏推理明文、原图或 HTTP 正文的字段。raw 接受既有 Responses 原协议字段的明确子集，未知字段拒绝；合法 opaque `encrypted_content` 仅作为原协议记录保留，不解析为推理、不进入摘要或授权。原图/dataURL 禁止落盘；本轮 checkpoint 对公开文字中 literal `data:image/...;base64,` 也明确拒绝而不删改。图片历史尚无安全持久引用合同，因此本课拒绝图片任务续接；普通图片请求继续沿原第56入口，未因此宣称真实多图通过。

存储按指针路径串行，先保存不可变 raw sidecar，再临时文件原子替换指针。同任务新 raw 必须完整包含旧 raw 前缀，旧 sidecar 不删除；坏指针、坏 raw、链接/硬链接与不符版本不会被覆盖。这里没有实现并发进程写同一任务的产品能力。

共享装载器在创建模型传输之前校验版本、目录身份、raw 指纹、每轮协议、模式和工具范围。目录失效、缺文件、版本不支持、原记录不合法分别返回明确 `TaskCheckpointError.code`；CLI 和桌面公开失败中保留错误码。scope 只允许同种工具能力形状的新 execution/workspace 描述重绑，附件 snapshotId 必须相同，不能从旧范围恢复材料授权。

摘要缺失合法；源指纹或内容哈希不符固定降级为 raw，`summaryStatus = absent / accepted / discarded`。核心和 context manager 再验摘要字段、哈希及源，持久摘要只以低信任工作块进入 input，整个包装仍受 20000 字符预算，全部计入 96000/128000 工作限额；不进入 instructions，不替代 raw 或读取凭据。新工具组增长后旧摘要失效，后续整理仍用第56唯一 manager。真实请求内摘要发布时可以随同安全 raw 保存到 checkpoint。

新增 `parseResumableHistory/Turn` 复用原协议校验：之前各轮须有真实 final，最后一轮允许无悬空调用的实际中断前缀。恢复未完成轮时保留原 `turnStart`，既不伪造 final，也不重复添加原 prompt；160 项/128000 字符原当轮限制跨进程继续累计。最后一轮已有同意图 final 的旧 resumable 指针明确拒绝，防止完成瞬间崩溃后重跑。

核心新增 awaited `onRawCheckpoint` 安全边界：初始原记录、完整工具组、已验证摘要发布、最终原记录。最终 raw 与 completed 指针一次保存。完整 raw 重建 `call_id` 防重集合；工具执行器、私有读取证据、批准适配、命令准备均本次新建。保存故障不能把已经执行的操作改报为没有副作用。

### 9.2 桌面与 CLI 的实际入口

桌面新增 lazy [desktop-checkpoints.ts](../src/main/agent/desktop-checkpoints.ts)、有界 [agent-resume.ts](../src/shared/agent-resume.ts) 展示合同，以及 `agent:resume-info / agent:resume`、preload 与“继续此任务”按钮。checkpoint 放在当前 `userData/task-checkpoints`，与 v9 会话库分离。重开/切会话只查询展示 metadata；点击继续后才共享装载、重建当前目录/材料/权限并启动唯一核心。renderer 为这次明确动作生成新的 UUID，并检查不复用已保存 toolRun 身份；CLI 使用装载器新 UUID。计划问答、审批、停止、关闭保护仍走原桌面适配。

原 messages/toolRuns 不改写；续接 UI 追加新用户/助手记录，完整 raw sidecar 继续原任务。存在工作区时必须重新选择当前工作区；旧附件或图片材料无法安全重建时明确拒绝。页面恢复不会恢复旧等待或批准。

CLI/脚本新增显式保存与续接，未传这两个参数仍为第55单次空历史行为：

```powershell
# 首次明确任务；文件位置由用户选择
node out/cli/index.cjs --mode execute --prompt "明确任务" --cwd "任务目录" --checkpoint "任务目录外的指针文件.json"

# 新终端/新进程明确继续；当前权限仍缺省 default
node out/cli/index.cjs --resume "任务目录外的指针文件.json" --output jsonl
```

`--resume` 与 `--mode/--prompt/--stdin/--checkpoint` 互斥；可显式传 `--cwd/--workspace` 复核原绑定，不传时使用已校验路径。权限不在 checkpoint 中，当前调用重新选择 `default/auto-approve/full-access`；需要交互而缺交互时仍退出 3，不能默认同意。公开 `resume` 事件只含新 requestId、taskId、摘要状态，不含 raw 或摘要正文。脚本 `runAgentTask` 接受新任务输入（可加 `checkpoint`）或 `{ resume, cwd?, workspace?, permission? }`。帮助、模块导入、无任务新进程均零模型/工具/writer；帮助与输入错误不启动 Windows 输出 writer。

### 9.3 自动分层结果与证据边界

本节最终结果由本轮独立磁盘报告填入；合成传输、真实磁盘、真实进程和联网结果分别记载，不能读旧报告补造本轮通过。维护入口在 [tests/lesson57](../tests/lesson57/) 与 [lesson57.mjs](../scripts/checks/lesson57.mjs)。

**产品实现完成，本轮自动分层验收通过；用户实测确认及八道自测保持待补。** 总报告为 [final-report.json](../.ui-check/lesson57/implementation-7b8f370a-3dfb-4354-ba5b-0307b5235bcd/final-report.json)，[证据导览](../.ui-check/lesson57/implementation-7b8f370a-3dfb-4354-ba5b-0307b5235bcd/README.md)提供分层入口；不能将本轮夹具结论解释为联网模型通过。

| 层级 | 本轮实际结果 | 新 UUID 证据 |
| ---- | ------------ | ----------- |
| §4A checkpoint | 13项通过：v1严格字段/禁止项、目录/mode/scope、完整raw、摘要源/hash失效、坏文件保护 | [checkpoint-9a64628e](../.ui-check/test-runs/lesson57/checkpoint-contract-9a64628e-2745-4f4a-b464-07b5c354325e/results.json) |
| §4A普通Node再水合 | 9项通过：新UUID、raw重建call_id、防重不受working整理影响、当前读取/批准/命令准备、160/128000跨进程同轮累计、摘要低信任与限额 | [core-70c54284](../.ui-check/test-runs/lesson57/safe-rehydration-70c54284-a410-401b-ab55-a3c0a5ed0522/results.json) |
| 终态保存风险 | 1组通过：真实批准/写入后保存故障exit1；副作用、工具结果、完整raw保留，坏指针不覆盖 | [terminal-5cbbff7a](../.ui-check/test-runs/lesson57/cli-terminal-failure-5cbbff7a-f49d-40bd-9229-695a3c9d45d0/results.json) |
| 完整断网回归 | 9套349项全过：第55 I/O54/shared226；第56 core22/disk4/host11/adapters9；第57 13/9/1。终态风险已含在349中 | [offline-354d6a8d](../.ui-check/test-runs/lesson57/offline-group-354d6a8d-a27d-4a7c-accd-1db287507265/results.json) |
| 开发/分发CLI | 各6组通过：真实宿主退出→新PID→显式resume；同轮raw3→10且旧call只出现一次；每版固定价格8例通过并独立再测8例；default缺交互仍exit3无写入；各4个帮助/导入/无任务新进程全零 | [CLI-c928038c](../.ui-check/test-runs/lesson57/resume-cli-group-c928038c-f244-4464-921a-04bfdd1c0579/results.json) |
| 开发/目录包桌面 | 各4组通过：UI停止→新PID→重开/切会话主/摘要/标题/批准/start/resume均0→显式继续；新UUID、旧读取证据拒绝→新读取→实际补丁/重读；原messages/toolRuns/raw前缀保留，原prompt一致且最终保存；独立固定8例通过 | [桌面-d210b620](../.ui-check/test-runs/lesson57/resume-desktop-group-d210b620-8c19-4833-a5d7-97242cd6c408/results.json) |
| 静态与制品 | Node/Web/CLI类型、35代码文件lint、37文件格式、开发构建、离线目录包、CLI构建通过；255份源码/394份制品指纹，CLI manifest匹配，ASAR内5份out与开发对应，测试前后身份不漂移 | [身份清单](../.ui-check/lesson57/implementation-7b8f370a-3dfb-4354-ba5b-0307b5235bcd/artifact-identities.json) |

**合成/真实分别记载：** 四入口模型均为合成传输，`realTransport=false`。普通Node与Electron、真实进程中断/新PID、checkpoint装载、文件读取/旧凭据拒绝/补丁/重读、独立磁盘和固定业务测试真实执行。开发桌面PID `27744→30188`，目录包 `11088→24416`；开发CLI `35640→27148`，分发CLI `38608→37236`，新旧requestId详见报告。CLI沿用固定价格八例；桌面采用另一个固定价格八例合同，不能声称复用了同一份第56业务台账。未联网、未执行真实摘要续接。

**实际失败与修复保留：** 首次标准 `build:unpack` 下载Electron出现EACCES，改用已安装Electron的离线目录包；中间捆绑codex版本探测曾ETIMEDOUT，后续打包成功。最初编译采集/目录binding未await、预算夹具原prompt不一致、终态夹具中止调用次数错误均保留原UUID；旧shared宿主替身缺checkpoint能力曾超时，补明确persistence替身后原断言及新组通过。首次双桌面因GPU子进程DLL失败而Inspector超时，仅维护测试宿主加 `--disable-gpu-compositing --in-process-gpu` 后复跑。随后真实开发桌面虽然实际补丁成功，最终保存因renderer使用占位继续prompt与raw原prompt不一致被v9拒绝；产品改为原 `source.prompt`，补一致断言，再构建两版均通过。具体11份失败报告含聚合与子报告重叠，不等于11个独立产品故障，全部在身份清单中保留。

**原记录及工作区保留：** HEAD仍为上述基线；未提交/重置/清理Git。原README、学习路线、学习进度字节与补录基线一致。未跟踪 `artifacts/payment-services.md` 在会话中观察到外部变化（源指纹 `4fb8bc8c…` → `7e030f6c…`），保留当前内容，未还原、未归因，也不声称该文件字节未变。用户库/工作目录没有用于业务夹具；实验均使用独立UUID目录，旧证据和备份保留。

**续接保证的边界：** 只恢复最后一次安全保存的完整raw组；若硬退出落在实际副作用与checkpoint提交之间，不能提供事务级“恰好执行一次”，继续前仍须核对实际文件/命令结果。图片历史没有安全持久引用合同，续接明确拒绝；旧窗口材料不恢复，摘要只为低信任资料。第56各open项及本课用户确认/八题状态见9.4，未由这些自动结果关闭。

### 9.4 复跑与保留范围

```powershell
npm test
npm run test:list
npm test -- --suite=checkpoint
npm test -- --suite=core
npm run test:lesson57:resume:cli
npm run test:lesson57:resume:desktop
npm run test:lesson57:resume:cli -- --suite=cli-distributed
npm run test:lesson57:resume:desktop -- --suite=desktop-packaged
npm run build
npx electron-builder --dir --config.electronDist=node_modules/electron/dist
npm run build:agent
```

默认 `npm test` 断网，保留第55 I/O/shared 和第56 context/disk/host/adapters，新增 checkpoint、再水合与 CLI 终态保存故障保护。旧桌面保护夹具仅补独立 checkpoint persistence 替身；原断言不删除，真实 checkpoint 磁盘与新 PID 由第57单独验收。原真实模型第56入口仍可显式运行，未纳入默认测试。

**学习者状态与后置边界：** 本课用户实测确认待补，八道自测继续待答，没有代答或推定掌握。第56用户确认、八道自测、原生资源符号链接 EPERM、真实多图整理回归、自然“改坏→同任务再修”全部继续 **open**；第54/55自测状态保留。本课未执行真实联网模型/摘要续接，不将合成 SSE 写成真实模型通过；真实多图续接、自然模型修错、任意跨平台/并发写入仍未覆盖。没有实现 MCP、SSH、并发 Agent 或自动更新。

### 9.5 用户完成确认与补充（2026-10-11）

用户明确表示“57课完了”，第57课完成确认已记录。9.3/9.4及独立实施报告里的待确认状态属于形成时的历史记录；本轮追加确认并同步最小学习进度，保留原报告与制品指纹快照。用户没有逐项说明手工实测范围，八道自测仍待答，真实联网模型/摘要续接及第56各open项不据此升级为通过。

本课没有必须继续补做的产品实现项。需要记住：续接恢复原任务记录，当前批准/读取凭据/命令准备仍重新建立；硬退出发生在副作用与安全检查点提交之间时，须核对实际结果。后续若补证据，优先做一次真实联网模型与摘要的“整理后中断→新进程→显式继续”专项，继续保留本课原限额与禁止项。
