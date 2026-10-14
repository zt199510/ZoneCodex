# 第六十二课：Skills 发现、选择与按需加载

创建日期：2026-10-13。状态：**课稿已创建；产品实现、运行验收和用户实测待进行；八道自测均待作答，不附答案。**本轮只核对源码、编写课程和同步导航，不安装技能、不修改产品、不构建、不调用模型。实施时再追加第9节实际结果。

前置：[第61课第9节](76-第六十一课-Git改动列表与Diff查看.md#9-本轮实施与分层验收记录2026-10-12)已完成产品与必要自动验收，有条件通过，用户实测确认和八题待补；其后[Git工作台扩展](Git功能对照实现-2026-10-13.md)及[Git功能补齐](Git功能补齐与验收-2026-10-13.md)独立记录，外部业务待补。第56/58有条件通过、第57/59已有用户完成确认、第60有条件通过；旧确认、自测、失败和未覆盖项按各课记录保留。

本课按用户选择，先做 Skills，再考虑 MCP。Skills 是可复用的任务指导资料；MCP 提供外部工具连接。**加载技能不增加工具、不授予文件或命令权限，也不执行其中的脚本。**本课复用唯一 Agent 核心和工具循环，保持计划/执行模式、三种权限、停止、响应重试和显式任务续接。

## 1. 本课目标与前置条件

目标：在输入框旁选择一个本地技能，按需加载它的工作方法，让 Agent 使用现有工具完成当前任务，并能解释本次到底使用了哪个技能版本。

实施后应能观察到：

1. 打开技能选择器，看到技能名称和简介；此时只发现元信息，不将整个目录的正文发给模型。
2. 明确选择一个技能后，主进程读取并准备该技能正文；输入框显示选中名称，支持移除、刷新和错误提示。
3. 发送时固定本轮技能快照。每轮工具后续请求、响应自动重试和上下文整理后的主请求沿用同一正文；发送接受后清空下一轮的待选状态。
4. 普通新消息未选择技能时，沿用原聊天行为；过去用过的技能不会自动成为当前技能。
5. 原消息支持的重试/编辑重发及显式任务续接使用原技能快照，当前草稿选择不能替换它；被动重开不扫描技能目录、不读取源`SKILL.md`、不自动激活技能或启动模型，正常读回已保存快照允许。
6. 用一个“项目代码审查”技能完成真实只读审查。技能只指导阅读与报告，不替代真实读取、测试、批准或执行事实。

### 1.1 创建时核对到的事实

| 当前能力   | 源码事实                                                                            | 本课处理                                                   |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 项目指令   | `project-instruction.ts`读取运行目录或所选工作区根部的`AGENTS.md`，不发现`SKILL.md` | 借鉴职责分离；新增独立技能读取，不把项目指令当作技能管理器 |
| 请求组装   | `agent-instructions.ts`组装固定工具和指令，`agent-runtime.ts`固定模型配置及请求闭包 | 加入有界的当前技能材料，工具清单与授权逻辑保持             |
| 请求上下文 | `AgentRequestContext`有会话、模式、运行环境、工作区、附件和图片字段，没有技能字段   | 新增严格解析的技能选择/原快照引用，不接收任意磁盘路径      |
| 消息与保存 | 当前会话库v9；`ChatMessage`没有技能快照；会话容量主要累计消息文字和工具协议         | 增加快照的保存、解析与容量计数，不能只加UI标签             |
| 任务续接   | checkpoint v1保存prompt、raw、目录绑定、scope及可选摘要，不保存运行时指令           | 保存本任务的技能正文快照，显式续接沿用它                   |
| CLI/脚本   | 与桌面共用`createAgentRuntime`和Agent核心，现有`--resume`使用同一checkpoint服务     | 本课不加CLI技能发现/选择参数；已有resume要保留并使用快照   |
| 输入框     | `ChatComposer`已有`tools`插槽，`useChatRequest`负责准备、发送、重试与停止           | 在插槽放选择器，通用`ChatInput`不承担磁盘发现              |

### 1.2 首版范围

固定技能根为桌面应用的`app.getPath('userData')/skills`，由主进程确定。只发现它的一层直接子目录，每个技能为`<name>/SKILL.md`。目录缺失显示空列表；只有用户明确点击“打开技能目录”时才允许创建这个应用目录并用系统文件管理器打开。界面显示实际目录，不能硬编码开发机器的`userData`地址。

一次请求最多一个技能，用户手动选择。元信息仅支持`name`与`description`两个必需字段，正文为Markdown。首版采用下面明确的窄格式，不宣称兼容所有SKILL.md/YAML扩展。发现、选择及打开目录都不启动Agent、标题、摘要或审批模型。

项目级/多根目录、自动推荐或自动触发、多个技能组合、远程安装、市场、热监听、依赖安装、`scripts/`执行、`references/`自动读取、MCP、SSH与子Agent后置。普通Markdown链接可作为文字；不会因为加载技能而自动读取资源或访问网络。技能目录不是新的Agent工作区，也不借此修改当前任务目录。

## 2. 用 Vue 经验理解本课

| Vue 中的经验                  | React/Electron 中的对应                   | 本课要分清                                 |
| ----------------------------- | ----------------------------------------- | ------------------------------------------ |
| 列表先取摘要，点选再取详情    | `SkillDescriptor`列表与选中后的正文读取   | 发现不等于激活，激活不等于获得权限         |
| `ref`保存当前选项，提交时复制 | Hook保存待选技能；主进程冻结请求快照      | 后来修改下拉框不能改变已开始的请求         |
| `watch`请求以序号判断旧回包   | 会话ID和请求代次隔离异步发现/准备         | 切会话后旧结果不能落进新会话               |
| 请求参数与历史记录分开        | 临时selection ID与持久`SkillSnapshot`分开 | 清空待选状态不能删除原消息的快照           |
| 工作流模板复用现有服务        | 技能指导现有读取/命令/修改工具            | Skills不是工具协议，也不是一个新的工具循环 |

可以把技能理解为“做这一类任务时采用的工作方法”。例如代码审查技能要求先阅读实际文件、按严重程度列出问题、注明路径和行号；真正读取文件的仍是已有工具，是否可以写入或运行命令仍由当前模式与权限决定。

## 3. 当前实际文件与职责

实施前重新读取实际版本。下面是真实文件，不要求全部改动：

| 文件                                                                                                                                                                                                                                                                                                                                                                                     | 当前职责 / 本课落点                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [project-instruction.ts](../src/main/project/project-instruction.ts)、[agent-instructions.ts](../src/main/agent/agent-instructions.ts)                                                                                                                                                                                                                                                   | 现有项目指令读取与请求组装；技能读取要先限制字节，不能照抄先读全文件再检查大小          |
| [agent-runtime.ts](../src/main/agent/agent-runtime.ts)、[agent-core.ts](../src/main/agent/agent-core.ts)、[agent-core-contract.ts](../src/main/agent/agent-core-contract.ts)                                                                                                                                                                                                             | 共用请求组装、唯一核心和事件；技能材料放在本轮冻结组装中，不复制核心                    |
| [desktop-agent-host.ts](../src/main/agent/desktop-agent-host.ts)、[agent-ipc.ts](../src/main/agent/agent-ipc.ts)                                                                                                                                                                                                                                                                         | 验证上下文、准备材料、创建任务、保存checkpoint、取消与续接；冻结技能并绑定请求/用户消息 |
| [agent-tools.ts](../src/main/agent/agent-tools.ts)、[tool-loop.ts](../src/main/agent/tool-loop.ts)、[project.ts](../src/shared/project.ts)、[agent-history.ts](../src/shared/agent-history.ts)                                                                                                                                                                                           | 固定工具、模式和历史范围校验；本课不为技能开放新工具名或扩大scope                       |
| [context-manager.ts](../src/main/agent/context-manager.ts)、[agent-context.ts](../src/shared/agent-context.ts)                                                                                                                                                                                                                                                                           | 工作input容量、整理与额外负载展示；技能正文属于额外指令，不能误报为input或token         |
| [conversation.ts](../src/shared/conversation.ts)、[conversation-library.ts](../src/shared/conversation-library.ts)、[conversation-store.ts](../src/main/storage/conversation-store.ts)                                                                                                                                                                                                   | 消息快照、严格保存格式、主进程读回与总量校验                                            |
| [task-checkpoint.ts](../src/shared/task-checkpoint.ts)、[task-checkpoint-store.ts](../src/main/storage/task-checkpoint-store.ts)、[desktop-checkpoints.ts](../src/main/agent/desktop-checkpoints.ts)、[agent-resume.ts](../src/shared/agent-resume.ts)                                                                                                                                   | 有界技能快照保存/加载及续接展示；不保存批准或恢复凭据                                   |
| [cli/agent-host.ts](../src/cli/agent-host.ts)、[cli/host-contract.ts](../src/cli/host-contract.ts)                                                                                                                                                                                                                                                                                       | 原CLI/API及resume共享组装；从checkpoint沿用快照，不默认扫描桌面技能目录                 |
| [api.ts](../src/shared/api.ts)、[preload/index.ts](../src/preload/index.ts)、[agent-api.ts](../src/preload/agent-api.ts)、[ipc-source.ts](../src/main/ipc-source.ts)、[app-runtime.ts](../src/main/app-runtime.ts)                                                                                                                                                                       | 分组preload、主窗口来源验证、服务注册和窗口清理                                         |
| [ChatComposer.tsx](../src/renderer/src/features/chat/ChatComposer.tsx)、[ChatInput.tsx](../src/renderer/src/features/chat/ChatInput.tsx)、[ChatWorkspace.tsx](../src/renderer/src/features/chat/ChatWorkspace.tsx)                                                                                                                                                                       | 技能入口、通用输入、原任务续接提示；复用现有布局和焦点行为                              |
| [useConversation.ts](../src/renderer/src/features/conversation/useConversation.ts)、[useChatWorkspace.ts](../src/renderer/src/features/chat/useChatWorkspace.ts)、[useChatRequest.ts](../src/renderer/src/features/chat/useChatRequest.ts)、[agent-request.ts](../src/renderer/src/features/chat/agent-request.ts)、[capacity.ts](../src/renderer/src/features/conversation/capacity.ts) | 首次会话创建、准备/接受、标题启动与草稿清理、重试/编辑来源、严格请求及保存容量预留      |

建议新增职责模块：`src/shared/skills.ts`定义资料/引用/快照与限额；`src/main/skills/skill-reader.ts`作普通Node可调用的有界读取和解析；`skill-service.ts`管理固定根、发现代次、窗口/会话选择及已接受快照；`skills-ipc.ts`处理来源校验；`src/preload/skills-api.ts`加入同一个平铺AppAPI；`features/skills/useSkills.ts`和`ComposerSkills.tsx`负责选择与展示。以上是待建文件，创建本课并未创建产品模块。

## 4. 按依赖顺序操作与练习

### 步骤一：冻结数据、目录和格式合同

先核对Git状态、真实userData、当前格式版本及未提交改动。实施用独立测试userData，不把课程目录或Codex本身的技能目录当成ZoneCodex技能根，也不修改用户现有技能。

练习设计三类数据，明确哪些可以越过IPC或保存：

| 数据                     | 内容与来源                                                                                   | 生命周期                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `SkillDescriptor`        | 主进程发现的opaque skill ID、name、description及目录发现代次；不含正文或可自由指定的绝对路径 | 仅列表；刷新后旧代次不能用于新准备                                       |
| `PreparedSkillSelection` | 主进程明确读取正文后的selection ID、展示元信息、文件指纹；绑定window/conversation            | 当前待发选择；不是Agent授权，不写checkpoint                              |
| `SkillSnapshot`          | name、description、body、完整源文件SHA256及确定性快照SHA256；全部有界                        | 已接受请求、对应用户消息、任务checkpoint；没有句柄、权限、密钥或执行票据 |

确定性快照指纹基于固定字段顺序的规范JSON（不包含指纹本身）；完整`SKILL.md`原始字节指纹另算。两者不能混称为正文hash，hash也不证明资料可信或产生授权。共享解析负责严格结构；Node宿主首次读取/发送复核源字节sourceHash，保存/续接重算snapshotHash并保留原sourceHash，不要求从解析后的正文重建源文件字节，也不在恢复时重读源文件。

首版限额：最多64个一层目录项；元信息前缀最多4096字节；完整文件最多64KiB；name为1–64字符的小写ASCII字母/数字及单横线分段，与目录名相同；description为1–500字符单行文本；正文为非空且最多12000个JavaScript字符串字符；单份快照完整JSON序列化最多20000字符。超限明确拒绝，不提高旧预算、不截正文冒充完整加载。Windows保留设备名及不合法目录名拒绝。目录与文件以普通本地对象核对，不跟随symlink/junction/reparse point或多硬链接文件；校验路径归属、实际对象身份及前后变化，明确它是有界应用检查而不是OS沙箱。

示例只放在课稿中；实施时在隔离技能根准备，再由用户决定是否放入应用技能目录：

```markdown
---
name: code-review
description: 阅读实际项目代码，给出有证据的代码审查问题与验证建议。
---

# 项目代码审查

1. 先理解用户指定的审查范围；范围不明时说明需要的信息。
2. 使用当前可用的读取和搜索工具查看实际代码，按需扩大阅读。
3. 优先报告会造成错误行为、数据问题或明显回归的发现。
4. 每条发现写明严重程度、路径与行号、触发条件和影响。
5. 阅读不足或证据不完整时明确说明；没有发现问题时如实报告。
6. 只做审查报告和验证建议；用户另行要求修改时沿用现有模式和权限。
```

首版frontmatter必须在文件开头，按UTF-8严格解码，允许CRLF/LF及明确处理的UTF-8 BOM。只接受两个字段各一次、未加引号的单行文本；不解释嵌套、锚点、标签、多行标量、表达式或额外字段，遇到未支持格式给出具体错误。定义字段空白与正文边界后编写窄格式解析，不执行Markdown/YAML内容，不依赖正则截出两行便跳过完整格式校验。

预期效果：能够解释“列表资料、待选引用、任务快照”三个概念。常见错误：把前端传来的正文当成主进程已读结果；把技能name直接用作任意路径；将目录元信息误写成工具许可。

### 步骤二：实现元信息发现与按需读取

使用有界目录枚举与有界文件读取：列目录时读取每个候选的frontmatter前缀，到闭合分隔线即停止；头部在4096字节内未闭合或UTF-8无效就拒绝该项，不先读取整个正文。一个坏技能应显示为不可用及原因，不让其他合法项消失；目录整体不可访问或项数超限给出列表错误。

用户明确选择后才读取完整文件。先检查大小，再通过固定句柄读取最多64KiB加一个溢出检测字节，复核实际对象和内容一致性，严格解码并解析。不能只检查`stat.size`后无界`readFile`。主进程保存准备记录，UI只持有opaque引用与展示字段。取消或旧发现代次不能发布新准备结果。

首次发送前重新有界核验对应文件仍与准备时的sourceHash一致，才冻结原快照；选择后源文件变化、删除、格式失效或位置变化，则提示重新选择或移除技能，主模型请求为0。冻结后不在每轮工具调用重新读磁盘，也不因后来刷新列表而改变当前运行。

预期效果：只选中的技能正文被加载，列表和选择不用模型。常见错误：扫描时把所有正文放进内存或模型指令；坏项静默忽略；用`AGENTS.md`读取函数代替受限技能读取。

### 步骤三：接通主进程、preload和选择器

新增发现、准备、释放和固定目录打开API，校验主窗口/main frame来源以及会话、发现代次和准备记录归属。renderer不能指定技能根、文件路径、脚本、模型地址或工具权限。主进程清理未发送引用；已接受快照以有界记录保留，不能因请求失败/取消/结束就立即清掉：原重试来源仍有效且会话自动保存有延迟。只有原重试来源已清理，或确认成功持久化并可可靠读回时，才能释放对应临时关联。保存好的消息/checkpoint快照独立保留。

选择器放入`ChatComposer`的现有tools区域，展示“不使用技能”、名称、简介、加载中与错误；刷新和移除为明确操作。文字按纯文本显示，不把名称/简介当HTML。复用菜单焦点、Escape关闭和返回触发按钮的行为，不重做输入框。

当前首次聊天可能没有conversation ID。选择时先复用`useConversation`既有创建会话并继承草稿的机制，再绑定准备记录，不能向null会话准备后在发送时创建另一会话。切会话、新建、清空、归档和窗口重载清除待选状态；会话ID加局部代次拒绝迟到结果。

准备失败保留草稿与可见错误。按现有operation、导航、审批和图片忙碌状态禁用不合时宜的选择，不把新选择误计为正在生成任务。未选技能的发送路径维持原行为。

预期效果：初始空会话也能选择技能且草稿不丢；发送后待选状态清空。常见错误：把待选状态放全局导致跨会话串用；清空待选时一并销毁原请求快照。

### 步骤四：固定本轮技能并接入共用请求组装

在任何异步准备前捕获待选引用；主进程在原请求准备链中验证、冻结技能，并关联window/conversation/request ID及对应用户消息ID。定义一次“快照已接受”的有界回传或读回路径，使消息保存和重试引用拿到主进程确认的那一份快照。不能从renderer直接接收任意正文拼入最终指令。

现有发送会先建立pending消息再异步解析环境，输入框在收到发送接受结果后清空草稿。技能发送利用现有异步`onSend`接口：主进程快照接受、容量和环境核验完成前，Promise不能返回true，也不能触发原`onAccepted`回调、清草稿或首次标题请求；失败/取消返回false且不生成标题，沿用draftKey及草稿版本保护，不能恢复旧草稿覆盖用户新输入。前置确认通过准备接口/接受事件完成，不等待长任务的最终模型结果。技能准备失败或停止时使占位消息进入准确终态；迟到快照不能绑定另一消息或继续启动模型。快照接受、容量检查通过、运行环境有效之后，才开始现有主模型请求。

将`SkillSnapshot`作为`buildAgentRequest`的可选本轮材料，经`createAgentRuntime`建立冻结闭包。正文放在有明确来源和边界的指令资料段，说明它是用户选中的任务方法，不能覆盖应用工具规则、当前用户任务、模式或授权；不将其伪造为实际用户新请求、已完成工具结果或私有推理。首版不新增`load_skill`工具，也不让模型自动挑选技能。

主请求各工具后续、同轮响应重试及整理后继续都沿用同一快照。摘要模型、标题模型和自动审批模型不接收该技能正文、不因此新增请求。当前`instructionsCharacters`按最终指令字符串准确包含技能及封装；工作input仍为128000字符、96000触发整理，当轮160项/128000字符保护沿原规则。技能正文另受本课限额，不能称它已计入工作input预算、官方token窗口或完整HTTP负载。

预期效果：在合成传输观察到本轮每次主请求使用同一快照，其他模型不获得技能；原工具集合与scope一致。常见错误：每个工具回合读取新文件；塞入instructions后不更新额外负载；用技能文本宣称文件已读、命令已批准或任务已完成。

### 步骤五：保存原快照、重试与显式续接

对应用户消息保存可选有界`SkillSnapshot`，助手消息不得携带它；UI可以只展示名称。原sourceHash与snapshotHash都保留。将快照序列化字符并入既有会话文字总量1000000字符校验及renderer容量预留，工具协议总量2000000字符和1000消息等原保护不抬高，不允许反复保存技能绕过总量。

原消息支持的重试及编辑重发从主进程的已接受记录或已保存消息读回原快照，验证会话/用户消息归属及结构/hash。不能采纳renderer自报正文、当前草稿技能或磁盘新版本。编辑先验证原快照和保存容量，再截断历史；失败保留原消息。现有内存`retrySources`不自动成为跨重启的重试能力，本课不因此宣称所有历史消息都能重试；已有入口的范围要在实施记录讲清。

新普通发送采用新选择；未选就无技能。较早消息中的技能快照只用于展示和原任务恢复，不重新拼入当前指令，raw/tool history也不增加假工具调用或额外用户任务。

checkpoint保存本任务同一份技能快照，普通任务明确无技能。加载先验证结构、大小和确定性hash，再注入本轮组装；保存下一份checkpoint时继续保留它。显式resume读取checkpoint中的原快照，忽略当前草稿选择，即使技能文件已修改或删除也不悄悄换正文。资料快照只恢复工作方法；运行目录、模式、工具范围、当前授权和读取凭据仍由既有恢复链重新核对。

CLI普通任务/公共API不增加技能选择入口、不默认访问桌面userData。既有`--resume`共用快照验证和请求组装，必须从加载的checkpoint取技能并在后续保存中沿用；普通无技能checkpoint与原CLI任务也要回归。模块导入、帮助、被动启动和会话切换不扫描技能目录、不读取源`SKILL.md`、不激活技能或发模型请求；既有会话/checkpoint正常读回其已保存快照允许。

会话/checkpoint字段发生变化时，遵循[未发布结构约定](05-后续课程编写约定.md#未发布阶段的结构更新约定2026-10-08)：统一当前schema及其版本、全部解析/默认值/宿主/维护fixture，不增加旧版本迁移链。实施时明确记录最终版本；旧格式拒读并保留原文件，保存前与异步检查后保护不支持库，不自动清库、覆盖、迁移或删除用户数据。设置无新增存储字段则保持原结构。哈希错误、超限或损坏快照不得降级成“无技能继续”。

预期效果：先用技能A发起，改选B后重试仍用A；中断后改/删A源文件，明确继续仍用原A快照。常见错误：只保存name导致丢失正文；CLI恢复后再次保存丢技能；将hash正确理解为内容可信或权限可复活。

### 步骤六：用代码审查技能完成真实任务

准备隔离的小型代码项目及已知缺陷，例如价格计算函数把数量为0误当成缺省数量。项目输入、预期结果和固定缺陷先由维护材料定义，再使用上方技能发起“审查价格计算，给出问题及验证建议”。先在计划模式完成只读任务，核对工具实际读取、缺陷触发条件、路径/行号及报告证据。

分别在开发版和Windows目录包完成实际选择→发送→工具读取→报告→保存的主闭环，模型传输使用当前默认配置；不为本课更换主模型。另用可重复的合成传输验证中断、正文变化、重试与续接，不把模型碰巧采用报告格式当作加载成功的唯一证据。

不因技能要求测试就伪造已执行。用户没有要求写入时，技能任务不产生修改；若另行做写入/命令护栏验证，只在隔离项目沿原权限机制，结果独立记录。新UUID存证，保留失败，不复制无必要依赖树。

### 4A. 实施前收敛

1. 阅读本课、当前进度/结构地图和第56/57/58/60/61课实际记录；核对Git未提交修改与独立Git扩展，建立新基线。
2. 冻结固定根、窄格式、限额、三类数据、sourceHash/快照hash以及首次发送/重试/续接不同来源。
3. 冻结输入框选择、空会话创建、准备/接受顺序、占位消息终态、清理和迟到结果规则。
4. 确定本次当前会话/checkpoint schema与版本、保存容量及CLI resume保留策略；只调整实际需要的字段。

### 4B. 实施与收口

1. 最小shared、纯Node读取/服务、IPC/preload、选择器接线；以隔离磁盘验证发现及按需加载。
2. 加入主进程冻结快照、共用请求组装、消息与checkpoint保存、原重试/编辑及双宿主resume。
3. 完成本课合成、真实磁盘、开发/Windows桌面及必要CLI恢复验收，修复实际问题；原有工具、权限、取消及Git/终端回归按影响选择。
4. 运行必要类型、定向质量与构建检查，核对源码/加载产物身份；第9节追加实际合同、分层结果、失败、限制及用户确认待补状态。

## 5. 验收条件与常见错误

| 层次              | 必要证据                                                                                                     | 不可替代的事实                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 格式/合成         | 两字段解析、重复/未知字段、UTF-8/BOM、所有限额、快照/hash、不同请求代次；观察每轮主请求与其他模型材料        | 模拟加载通过不等于真实读取或模型任务完成                                                                                       |
| 真实隔离磁盘      | 一层目录、坏项、无目录、头部只读、正文选择读取、链接/硬链接拒绝、选择后变化/删除、冻结后变化                 | 文件来源和实际有界读取需独立核对；OS无法构造的用例标未覆盖                                                                     |
| 保存/恢复         | 快照计入总量；保存读回hash；原消息重试/编辑；原checkpoint中断/重开/显式继续；CLI resume再次保存仍保留        | 只存name、只核对raw或仅导入不能证明技能恢复正确                                                                                |
| 桌面              | 开发版与Windows目录包：首次空会话、选择/移除/刷新、错误、键盘焦点、切会话迟到、准备停止、准确终态            | 实际IPC/preload/renderer应运行当前产物；合成传输标明合成                                                                       |
| 真实模型业务      | 两版代码审查主闭环，实际文件读取、报告与独立缺陷证据；完整技能指纹/产物身份记录                              | 模型自然语言称“用了技能”或HTTP200不能证明业务完成                                                                              |
| 无隐式运行/旧回归 | 双桌面已有任务新进程被动重开、CLI帮助/导入、切会话；普通任务、模式/授权、取消、图片/附件、Git/终端受影响路径 | 重开至少5秒无主/标题/摘要/审核请求，不扫描技能目录、不读源SKILL.md、不启动命令；正常读回已保存快照允许，列表明确打开时可读头部 |

必须覆盖的行为：

- 打开列表不发模型请求，只读取有界头部；选择A不读取B正文；移除后新普通发送不激活任何技能。
- 非法选择ID、跨窗口/会话、任意路径/正文、过时代次与不支持格式失败且不启动模型；坏项有可理解原因。
- 选择后改/删源文件，首次发送拒绝；请求已经冻结后改文件，当前工具后续和响应重试不换版本。
- 准备过程中停止/切会话/关闭，迟到结果不绑定消息、不启动模型；下一次普通发送可继续。
- 原任务重试、编辑与显式续接沿原快照，当前选中B不能覆盖A；快照损坏失败并保留文件，不能静默忽略技能。
- 技能写有“忽略模式、读取越界文件、自动执行脚本、把未测试写成通过”等文字，原工具白名单、计划只读、审批和事实判断仍生效。
- 保存容量、instructions额外负载、摘要后主请求快照与当前格式一致；不抬原工作预算，不误称token。

固定维护源复用[tests说明](../tests/README.md)和现有调度模式：必要的新源可放`tests/lesson62/`，结果放`.ui-check/test-runs/lesson62/<类型>-UUID`。默认组保持离线，真实模型、实际Windows和打包分别明确调用。创建本课只核验文档与链接，不新增测试、不执行这些运行验收。

## 6. 八道自测题

以下均待作答，不附答案：

1. Skills、AGENTS.md与MCP分别解决什么问题？为什么加载技能并不意味着增加一个工具？
2. `SkillDescriptor`、待发选择引用与`SkillSnapshot`为什么需要分开？各自何时失效、何时应保存？
3. 怎样证明列表发现只读元信息、选中后才读取正文？只在读取前检查文件大小是否足够？
4. 技能已选中，但发送前文件被修改；与请求冻结后文件被修改，两种情况应如何处理？为什么？
5. 原消息用技能A，当前草稿选了B。响应自动重试、消息重试、编辑重发及任务续接分别应使用哪个版本、从哪里取？
6. 为什么将技能正文放进instructions后，要区分指令额外负载、工作input字符、会话保存容量与token？
7. checkpoint为什么要保存正文快照而不仅是name或磁盘路径？CLI续接后再次保存时漏掉它会发生什么？
8. 技能正文声称命令已批准或要求突破计划模式时，应该由哪些实际边界决定能否执行？怎样验收没有扩权？

## 7. 学习记录与下一步

本轮已创建课稿，核对当前实际文件及新模块落点，约定首版显式选择与快照合同，并同步课程导航。**技能发现/选择/加载、消息保存、续接与真实业务尚未实施或验收；用户完成确认待补，八题待答。**

第56–61课原确认、八题、失败和未覆盖保留；Git功能扩展的本地/外部验收边界也保持。创建本课不是补确认，不把框架源码存在当作用户掌握。下面第8节供下一轮明确实施使用。

后续方向：根据本课实际结果决定技能体验补充或MCP接入，再考虑多模型与子Agent；本轮不创建第63课，不一次性实现自动触发、技能市场或外部工具连接。

## 8. 可复制到新对话的完整实施指令

以下指令供明确实施第62课时使用；**本轮创建课稿不执行其中的产品、测试、构建或模型请求。**

```text
开始完成第62课：Skills 发现、选择与按需加载。
项目目录：D:\AiTools\ZoneCodex\ZoneCodex
先读取：
D:\AiTools\ZoneCodex\ZoneCodex\ZoneCodex学习计划\77-第六十二课-Skills发现选择与按需加载.md
按本课第4节（含4A/4B）实施，第5节分层验收。课程已创建，本次直接实施并收口，不停留在只提计划。

按需读取05编写约定、02结构地图、04学习进度、第56/57/58/60/61实际合同、2026-10-13两份Git扩展记录与tests/README.md。先核对当前源码、产物、Git状态和用户数据，新UUID保存基线；保留所有未提交改动、用户库/工作目录/技能和旧证据，不提交或reset Git，不清库或覆盖不支持格式。

目标：固定桌面userData/skills一层目录的SKILL.md元信息发现，用户每请求显式选一个技能，按需读取正文，主进程冻结本轮SkillSnapshot，使用现有Agent核心/工具完成代码审查任务。选择器置ChatComposer tools区域，通用ChatInput不管理技能磁盘。目录不存在显示空列表，明确打开目录才可创建应用技能根；不访问Codex自己的技能目录或扫描项目/远程根。

落实课程窄格式和限额：最多64目录项、头部4096字节、文件64KiB、name1–64小写slug且同目录、description1–500单行字符、body1–12000字符、快照JSON20000字符。只支持name/description各一次的未加引号单行frontmatter；不解释其他YAML特性。严格UTF-8和有界句柄读取，拒绝不普通/链接/硬链接/越界及变化文件；超限失败，不先无界readFile再判断、不截正文装完整。纯Node读取模块不含Electron依赖或导入副作用。

分清Descriptor、待选ID和持久Snapshot；首次读取/发送复核完整源文件字节SHA，保存/恢复重算规范快照SHA并保留原sourceHash，不重读源文件。AppAPI/preload分组，IPC校验main frame/window/conversation/代次归属；前端仅传opaque选择或原消息快照引用，不传任意路径/正文/授权。首次空会话先用已有机制创建ID并继承草稿，再绑定选择。技能onSend Promise在快照接受/容量/环境核验完成前不返回true，不触发onAccepted/清草稿/首次标题；失败/取消false保留草稿并保护draftKey/版本，不生成标题、不等待长任务终答；pending消息准确终态，停止/切会话/关闭丢弃迟到结果。

首次发送复核磁盘与准备指纹一致后冻结；关联原用户消息/请求，容量通过和环境有效后才启动模型。当前工具后续、响应自动重试与整理后主请求始终使用相同快照；磁盘变化不改已经冻结的任务。发送接受后清空下一轮待选，不删除原快照。已接受记录有界保留至原重试来源清理或已成功持久化且可可靠读回，失败/取消/请求结束不立即删除。新发送未选技能则不激活历史技能。

在agent-runtime/agent-instructions共用组装加入有来源标签的技能指导资料，不新增工具或loop、不扩大scope/isToolAllowed、不更换默认模型、不复活权限/批准/命令票据/读取凭据。技能不覆盖应用规则和当前任务，不自动执行scripts/读取references/访问网络。标题/摘要/审核模型不接收技能正文，不因发现/选择新增模型请求。instructionsCharacters准确含技能封装；原工作input128000/触发96000、当轮160项/128000及其他容量保护保持，不混称token/HTTP总量。

用户消息保存有界快照，助手消息不携带；把快照JSON并入原会话1M文字容量和renderer预留，原2M协议/1000消息保护保持。原支持的消息重试/编辑从main捕获记录或保存消息验证后沿用原快照，当前草稿新选择不能替换，编辑先验证再截历史。checkpoint保存同一快照；显式resume用原快照而非当前磁盘，损坏/超限/hash错误拒绝，不能降级无技能。原CLI --resume共用校验/组装且再次保存保留快照；普通CLI/API不加技能发现选择选项、不扫描桌面目录。导入/帮助/被动启动/切会话不扫描技能目录、不读源SKILL.md、不激活技能或发模型，正常读回已保存快照允许。

若schema变化，按未发布约定统一当前版本、严格解析、默认值及全部宿主/fixture，不做旧迁移链。实施记录明确最终版本；旧格式/不支持库保留原文件，保存前及异步检查后保护，不自动清空、覆盖或删除用户数据。设置无新增字段不改结构。

分层验收：离线格式/合成传输、真实隔离磁盘/有界读取、保存/重试/编辑、开发和Windows目录包实际选择与错误/取消/迟到、两版真实默认模型代码审查闭环、双桌面已有任务新PID至少5秒被动重开零请求及CLI帮助/导入零请求、桌面与CLI显式技能任务resume保留原快照。真实缺陷/磁盘/模型/原生事实与合成分别记录；失败、OS无法构造和未覆盖保留，不能用模型自称使用技能、旧报告或HTTP200替代。运行必要类型/定向质量/构建及受影响旧回归，复用依赖和维护测试，不复制无必要整目录包。

最后追加本课第9节实际实现/合同/各层结果/限制/用户确认待补，并同步最小导航。八题原样待答，不附答案；第56–61及Git扩展旧结论/open不改写。没有必要主功能证据不得称完成，不创建第63课、不扩MCP/SSH/子Agent/市场/自动触发。
```

第9节仅在实际实施时追加真实结果，本轮不预填完成或通过。


<!-- lesson62-implemented-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec:start -->

## 9. 本轮实施与分层验收记录（2026-10-14）

本轮按用户“开始完成62课”实施Skills发现、选择与按需加载。**产品实施与必要自动验收已完成，有条件通过**；用户实测确认待补，第6节八道自测题均待作答，不附答案。第1–8节与创建时状态按2026-10-13的历史记录保留，本节记录当前实际实现。

基线HEAD为`4b8d03efc43693071a9e05b252054879c1f35b2e`。基线已存在的六项未提交课程/导航改动保留；八份原文档字节副本及原模型配置、用户会话、设置的hash记录在[baseline.json](../.ui-check/lesson62/implementation-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec/baseline.json)。本轮独立复核HEAD及三份受保护文件hash均保持基线。八份文档采用追加/前置方式保留原字节，核验记录见[documents-preserved.json](../.ui-check/lesson62/implementation-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec/documents-preserved.json)。本轮测试使用各自新UUID隔离材料与userData，不向实际用户技能目录安装示例，不清库、不提交或重置Git。

### 9.1 当前入口与使用方法

输入框工具区增加“技能”入口。打开选择器会显示实际应用技能根、名称、简介、不可用项及原因；支持刷新、打开技能目录和移除。根固定为桌面`app.getPath('userData')/skills`，不接受前端传入路径。目录缺失时发现结果为空；只有用户明确点击“打开技能目录”才创建该应用目录并打开系统文件管理器。

使用时在技能根下建立`code-review/SKILL.md`，按第4节示例填入严格frontmatter和Markdown正文，刷新后选择，再发送审查任务。每次最多选一个技能；发送接受后清空下一轮的待选项，用户消息显示技能名称。未选择技能的普通新消息按原行为发送，不自动沿用历史技能。首次空会话先创建并绑定会话ID，继承原草稿后再准备选择。

选择器只展示主进程的opaque ID与元信息；选中后正文在主进程准备，发送前重新有界核验源文件。若选择后文件已修改、删除或替换，发送失败且要求重新选择，保留草稿，不启动标题或主模型。冻结后的工具后续、响应自动重试及整理后的主请求沿用原正文；磁盘后续变化不会替换本轮技能。

### 9.2 当前源码与维护职责

| 文件 | 当前职责 |
| --- | --- |
| `src/shared/skills.ts` | Descriptor、准备结果、选择/原消息引用、快照、接受事件的严格结构与共享限额；不含路径授权。 |
| `src/main/skills/skill-reader.ts` | 普通Node可调用的有界枚举、严格UTF-8/窄frontmatter解析、固定句柄读取、原始字节hash与规范快照hash。 |
| `src/main/skills/windows-skill-objects.ts` | Windows固定PowerShell helper批量检查对象及祖先的ReparsePoint属性；路径通过JSON stdin传入，不拼入程序文本；限定路径数、输入/输出及超时。 |
| `src/main/skills/skill-service.ts` | 固定根、窗口/会话归属、发现代次、待发选择、已接受快照、保存来源与编辑引用的独立有界生命周期。 |
| `src/main/skills/skills-ipc.ts`、`src/preload/skills-api.ts` | 主窗口/main frame来源校验；发现、准备、释放、丢弃原会话关联与打开固定目录；与原平铺AppAPI接通。 |
| `src/main/agent/skill-message.ts`、`agent-ipc.ts` | 原消息快照先查主进程关联，再查同一会话存储；结构/hash核验；编辑截历史前保存原引用，不读源SKILL.md。 |
| `desktop-agent-host.ts`、`agent-runtime.ts`、`agent-instructions.ts` | 发送冻结、接受事件、原快照续接与共用指令组装；复用同一Agent核心，不新增工具或loop。 |
| 会话/checkpoint共享解析与主进程存储、`src/cli/agent-host.ts` | 用户消息与任务checkpoint持久化原快照；读取和后续保存复核；CLI已有resume沿用同一快照。 |
| `features/skills/useSkills.ts`、`ComposerSkills.tsx` | 列表/选项状态、错误、焦点及会话/代次隔离；不承担模型或磁盘权限。 |
| `ChatInput.tsx`、聊天/会话Hook、`MessageList.tsx`、`capacity.ts` | 技能请求等待主进程接受后才清草稿与启动首次标题；原消息重试/编辑/续接来源，已接受快照显示与保存预留。 |
| `tests/lesson62`、`scripts/checks/lesson62.mjs` | 当前维护源和offline/cli/desktop/live分组，每轮新UUID，不自动构建或继承旧结果。 |

### 9.3 快照、权限、容量与存储合同

`SkillDescriptor`只负责列表；`PreparedSkillSelection`是当前窗口/会话的待发引用；`SkillSnapshot`包含name、description、body、sourceHash、snapshotHash。完整源文件原始字节SHA256与固定字段规范JSON SHA256分别计算：首次读取/发送核对源字节，保存/恢复核对快照并保留原sourceHash。hash不表示资料可信、工具已读或操作已批准。

发现最多枚举64个一层目录项，链接和非目录项也计入枚举上限；元信息最多4096字节，完整文件最多64KiB，name为1–64字符小写slug且与目录相同，description为1–500字符单行，正文非空且最多12000个JavaScript字符串字符，完整快照JSON最多20000字符。支持LF/CRLF及明确处理的UTF-8 BOM，仅接受name/description各一次的未加引号单行字段；不支持的YAML格式、Windows设备名、非普通对象、多硬链接、目录/文件越界或变化均拒绝。超限失败，不截正文装作完整加载，也不抬高原容量。

服务当前每窗口最多64个会话发现scope、128个未保存接受快照、128个保存/编辑引用；每会话最多4个待发准备引用。未保存接受快照达到上限明确拒绝新关联，不静默淘汰。请求失败、取消、结束不会删除已接受快照；普通切会话释放待选/发现并保留原重试来源。可靠同hash保存后退休未保存关联，保存引用可在确认仍位于磁盘后回收。编辑先验证原消息并保留独立引用，再截历史。明确清空会话先成功持久化消息/任务删除，再发布空状态并丢弃相应技能关联；保存失败保留原记录，清理缓存失败显示错误。窗口退休清理全部窗口关联；其他窗口/会话不随清空被删。

停止发生在主进程真正接受之前时，返回false并保留草稿，不启动标题；匹配当前请求的真实接受事件若在停止点击之后到达，快照、已接受图片绑定及原重试来源仍纳入保存，但抑制标题和草稿清除，并消费已被主进程接受的待选ID。已退休请求/会话的迟到结果不能覆盖新的状态。停止按钮和发送按钮使用不同React key，停止click显式阻止默认表单行为，防止停止后即时切换到submit而再次发送。

主进程保存链只允许当前窗口已接受的快照，或同一条已保存用户消息原有的快照；前端即使自行重算有效hash，也不能伪造正文、跨消息复制、替换或剥除原快照。助手消息不携带skill。坏结构、错误hash或超限数据拒读并保留原文件，不降级成无技能继续。

最终当前格式保持会话库v9、checkpoint v1、设置v1；skill为严格可选字段，普通旧无技能任务在同一当前schema下仍成立。没有旧版本迁移链，没有新增设置字段。checkpoint同任务后续保存保留原skill，不允许删除或替换。桌面显式续接及CLI已有`--resume`使用checkpoint原正文，即使源文件已改/删除也不重读，不受当前草稿技能替换；普通CLI/API没有技能发现或选择参数。

技能作为有来源标签的本轮指导资料进入共用instructions；正文不能增加工具、扩scope、突破计划模式或改变三种权限，不能恢复批准、命令票据、读取凭据或宣称完成事实。标题、摘要与审批模型不接收技能正文；references、scripts和网络不会因加载技能自动触发。`instructionsCharacters`包含实际封装；原工作input128000/触发96000、当轮160项/128000保持。快照JSON计入会话原1M文字容量及renderer预留，原2M协议/1000消息保护保持，字符数不改称token或HTTP总量。

被动启动、模块导入、帮助与切会话不扫描技能根、不读取源SKILL.md、不激活历史技能或发模型；正常加载已保存会话/checkpoint中的快照正文允许，不能把这一结果误写成“任何技能正文都不读取”。

### 9.4 分层结果与证据

最终结果必须由下表对应维护源、当轮结果及制品身份共同核对。Electron/UI/磁盘真实与模型传输合成分别记录；live才是实际默认模型请求。

| 层次 | 已观察资料 / 最终待填 |
| --- | --- |
| 当前源码offline | [offline-group-6457295a-2c43-4fd0-a020-02920c1b1d83](../.ui-check/test-runs/lesson62/offline-group-6457295a-2c43-4fd0-a020-02920c1b1d83/results.json)四套51项通过：skills18、storage10、renderer19、runtime4。Windows helper/真实有界磁盘与Node存储真实，Electron/IPC/Hook/DOM/传输按fixture合成；新增停止后接受保存、清空先可靠保存及独立discard预算检查。 |
| CLI开发入口 | [cli-development-de6c4bd8-30a9-4032-b4a9-bd8b497534a5](../.ui-check/test-runs/lesson62/cli-development-de6c4bd8-30a9-4032-b4a9-bd8b497534a5/results.json)五项通过；当前构建源码manifest身份通过，实际Node CLI进程、磁盘与新PIDresume，传输合成。源修改/删除后沿原快照，普通任务、坏hash拒绝、help/导入被动验证。 |
| 分发CLI launcher | [cli-distributed-048b65be-a338-4a5d-8a8c-abecc391228f](../.ui-check/test-runs/lesson62/cli-distributed-048b65be-a338-4a5d-8a8c-abecc391228f/results.json)五项通过；当前launcher与manifest身份通过，实际`dist/agent/agent.cmd`及新PID、磁盘，传输合成，同上合同。两版汇总见[CLI group](../.ui-check/test-runs/lesson62/cli-group-ba6ed80e-5062-4cbc-9bc3-6d862d642b18/results.json)。 |
| 双桌面合成传输 | 最终加严版[开发17acb5fe](../.ui-check/test-runs/lesson62/desktop-development-17acb5fe-346c-4d64-8f01-9cb9709df327/results.json)、[目录包ba3301fe](../.ui-check/test-runs/lesson62/desktop-packaged-ba3301fe-0e0c-47af-9fc9-efb9ca356be8/results.json)各15项通过。实际Electron、IPC、鼠标/键盘、文件读取与保存；模型及受控等待/故障明确合成。选择后源修改使首次发送拒绝，主/标题请求为0；停止/迟到与会话隔离、普通无技能、A原快照重试/编辑、删除A源后原checkpoint续接并保留B选择/未发草稿，均验证真实任务完成和对应用户/助手保存，不以空every或旧请求代替。两版新PID被动重开至少5秒，主/标题/摘要/审批及源文件/根操作/目录枚举/属性helper均为0。 |
| 双桌面实际默认模型审查 | [开发53b75374](../.ui-check/test-runs/lesson62/live-development-53b75374-6c0a-4df6-b33c-207a4305c077/results.json)、[目录包4085e418](../.ui-check/test-runs/lesson62/live-packaged-4085e418-0729-4bfe-b15a-43fd2500bdf9/results.json)各6项通过。两版使用实际默认`gpt-6.1-sol`，各主请求3次、独立标题1次；Agent真实读取`business.mjs`并报告第2–3行`quantity`的逻辑或默认值把数量0替换成1。独立实际调用`subtotal(199,0)`得到199，预期0；报告如实注明未运行测试，不能把独立复现写成Agent测试。完整快照保存、只读项目文件前后hash保持，各新PID被动重开至少5秒零模型及零技能源操作。原快照retry/edit/resume已在上行合成传输层验证，不冒称真实模型续接。 |
| 旧受影响offline回归 | 默认第58课[11组](../.ui-check/test-runs/lesson58/offline-group-f9ec2f6d-082f-4650-a34f-76ca2cf61592/results.json)、权限/任务第60课[offline68项](../.ui-check/test-runs/lesson60/offline-group-10246eec-0f63-4613-9e6e-131a2757ecdc/results.json)、Git工作台[offline103项](../.ui-check/test-runs/git-workbench/offline-group-f56921ed-d241-44b1-bd73-d5972bc39836/results.json)通过；checkpoint旧保护通过。 |
| 旧权限/任务桌面回归 | [desktop-group-a0b09eea-10f4-435b-86c2-4002fdb5f287](../.ui-check/test-runs/lesson60/desktop-group-a0b09eea-10f4-435b-86c2-4002fdb5f287/results.json)通过：开发`c6249825-2ef9-431d-b8ad-57cecbbd9804`、目录包`c66374f5-06d6-4f40-b84a-d7a9091746e8`各37项；实际Electron/IPC/磁盘/PowerShell PTY与helper退休，传输/故障合成。开发PID43976→47436、目录包40948→47356；主app自然exit0无强杀、helper观察退休且身份一致。基线App已经未挂载TerminalPanel/ChatHeader/WorkspaceStatus，当前终端通过真实preload API测试；终端面板键鼠、手动header保存、清空确认/late reinsertion、workspace文字未覆盖，不是第62课新增UI缺失。 |
| 类型/质量/构建与身份 | node/web/CLI类型、定向Prettier/ESLint及Windows目录包/CLI构建exit0；日志[build-unpack-final.log](../.ui-check/lesson62/implementation-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec/build-unpack-final.log)。四份最终桌面入口/ASAR在各自运行前后身份保持，CLI构建manifest与当前源码及分发launcher身份通过。加严合成fixture期间没有产品源码/制品变更；维护源版本按下文分别记录。 |

维护源版本分别保留：开发实际live轮运行时的checker与fixture完整原字节存于该轮[observed-desktop-check.mjs](../.ui-check/test-runs/lesson62/live-development-53b75374-6c0a-4df6-b33c-207a4305c077/observed-desktop-check.mjs)、[observed-desktop-fixture.cjs](../.ui-check/test-runs/lesson62/live-development-53b75374-6c0a-4df6-b33c-207a4305c077/observed-desktop-fixture.cjs)，独立hash核验精确匹配其artifacts-before：checker为`e8dd6468deb802e7e322cc0f8953277e5400a070e83641481df553aa8cd29fa9`，fixture为`6425c1511b6046b713623b45aa7a7741cd87d78a338e1ff8cde8baf90213d5b1`。实跑源到最终维护源的真实差异分别保存在同根两份`final-synthetic-changes-*.diff`：改动为合成ID与`!live`断言、live没有调用的辅助定义，生产制品保持相同。因此保留已成功的真实开发业务证据，不宣称其运行了后来加严的synthetic分支；最终合成两版和目录包live使用各自真实运行的维护版本。

16份最终套件/group与各层audit、制品身份入口见[final-evidence-input.json](../.ui-check/lesson62/implementation-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec/final-evidence-input.json)。套件汇总与单套子结果不是可重复相加的检查数。

维护命令：`npm run test:lesson62:list`列组；`test:lesson62:offline`四套当前源码保护；`test:lesson62:cli`开发和分发入口；`test:lesson62:desktop`实际双桌面与合成传输；`test:lesson62:live`显式双桌面默认模型审查，会联网。分组可用`-- --suite=<list中的名称>`；不自动构建、安装或改模型配置，默认`npm test`仍为第58课11组。

### 9.5 失败、修正与未覆盖保留

1. 首轮保存/CLI Host检查用未经JSON转义的多行正文做`instructions.includes(body)`断言，因指导正文以JSON封装而失败；维护源改为核对JSON封装中的原body。原失败`storage-a9fff769...`、`storage-1889f2a4...`保留，不能写成产品丢正文。
2. Windows属性检查接入初轮`skills-e0c2efcd...`出现属性helper失败，导致八项断言失败；后续固定批量stdin检查轮通过。该轮完整错误保留；不从helper通用错误推断某种特殊标签已覆盖。
3. 首轮CLI入口检查`cli-development-f3e50871...`与`cli-distributed-39d4e1a3...`在制品当前源码身份护栏被阻止：`src/shared/skills.ts`实际hash与构建manifest不一致，两轮都尚未启动CLI子进程，也没有模型请求。失败保留；构建更新后的新轮五项通过独立记录，不能把护栏前失败写成业务失败或悄悄删除。
4. 首次桌面开发轮`desktop-development-920e6815...`只完成被动零请求，选择点击被遮挡；旧菜单构建结果存档。后续当前维护源/产物测试独立记载，不让旧失败消失。
5. 第二轮桌面开发`fed54b6c...`与目录包`dd779d55...`已通过前四项，停止后出现`3 !== 0`，暴露停止按钮隐式提交造成重发的真实交互竞态。通过不同button key和停止click preventDefault修正；相应真实交互重跑独立记载，不让原失败消失。
6. 代码审查补充了停止后真实接受事件的保存一致性与清空预算生命周期：晚到接受快照保存但不清草稿、不启动标题，清空成功持久化后才discard。新增renderer十九项中的对应两项与backend十八项中的独立discard通过；这些是审查补强，不能编造先有一轮产品失败。
7. 开发`desktop-development-4591ee8d-fdee-4620-a605-e2fad911acc3`、目录包`desktop-packaged-cd2858ef-fb47-46c5-b330-4b78f13decea`各完成九项后准备观察超时，checker残留DOM专用id错定位sidebar；维护helper修正，原轮保留，不能记成用户无法准备技能。
8. 开发`desktop-development-8b09f3cc-03b0-40cd-8e80-b4b06bf1d45e`完成六项后真实save返回通用保存失败，等待自动保存超时；audit独立计数显示checker调用264次`conversation:load`。源码中的load会恢复并替换目录binding，save在await校验前后要求binding对象身份保持，支持“测试轮询诱导保存竞态”的分析；最终checker改为直接读隔离磁盘等待保存，保留产品防竞态保护。诊断轮`desktop-development-e7c8e559-5720-4867-ae14-020bc0a4f231`十五条断言通过、caught为空，没有再次触发错误，**不宣称捕获到该错误的直接异常实证**；原失败保留。
9. 第60课首轮开发`ed56eeb4...`、目录包`b8456cd2...`在旧fixture终端入口`Missing click target`，无完成检查；失败保留，不能用旧报告或offline替代。核对基线已未挂载相应组件后，维护源适配当前真实preload PTY及现有controls，独立双版各37项通过；未挂载的原UI、清空确认/迟到重新插入场景明确未覆盖，不抹掉原条件检查。
10. 合成桌面开发`08fec345...`与目录包`0482f5b7...`旧断言十五项通过后，审查发现fixture每个scenario复用固定call_id，与原历史冲突，导致一个edit业务failed而所选resume任务已completed。旧checker主要核对快照与上下文，未强制retry/edit实际complete/read/report；因此该十五项结果不能冒充完整任务闭环。当前维护源已使用每请求唯一call_id，retry/edit强制core done、真实读取缺陷行、非空当次main、matching accepted及新用户/助手complete；ordinary/resume强制非空请求、done及新消息保存，resume核对原call/output证据及B选择/未发草稿。最终加严的开发`17acb5fe...`与目录包`ba3301fe...`各十五项通过，生产源码/构建不因此修改；真实live分支不使用该合成call_id，证据及维护源版本独立核对。旧十五条断言的通过与最终加严闭环分别记载。

应用检查有界，但不宣称OS沙箱或任意恶意并发文件修改不可穿透。实际本轮已构造多硬链接和目录junction，并拒绝读取；Windows helper检查ReparsePoint属性及祖先，**未逐一真实构造并验证所有Windows特殊tag**。需按未来环境分别记录文件symlink、目录symlink、mount point/volume junction、云文件/OneDrive placeholder、AppExecLink、WCI/容器或其他厂商reparse tag；没有构造的项不从“属性位覆盖”推导实际用例通过。原生TTY SIGINT、真实网络CLI、自动技能触发/市场/远程安装/多根/组合/脚本/reference自动读取、MCP/SSH/子Agent不属于本轮证明范围。

### 9.6 用户确认与后续

用户实测确认待补，第6节八道题原样待答；本节自动验收不替代用户掌握或确认。第56–61各课确认、自测、失败/open及Git扩展外部待验项保持。下一步可由用户实际体验决定技能入口补充或MCP接入，本轮不创建第63课。

<!-- lesson62-implemented-16f2dbb3-deab-4a1a-8c37-e8c7f99e73ec:end -->


<!-- lesson62-skills-page-ui-20261014:start -->

## 10. Skills独立页面调整与复验（2026-10-14）

按用户要求把技能管理入口移出输入框，参照 Codex 26.1007.2314 改为侧栏进入的独立技能页。**本轮界面实施与必要自动复验已完成，有条件通过**；用户实测确认与第6节八题仍待补。第1–9节保持原字节，包含输入框选择器的旧入口描述及此前所有成功、失败和未覆盖项，按对应轮次阅读；当前入口以本节为准。

### 10.1 当前入口与行为

展开侧栏和折叠栏的“技能”入口打开同一独立页面。顶部提供返回聊天、搜索、刷新和打开技能目录；列表居中，内容最大宽度768px，容器至少581px时双列，否则单列，无横向溢出。侧栏采用同版 Codex 技能叠方块SVG，卡片使用淡灰底图标；点击查看名称、简介、位置与不可用原因的元数据详情，明确点击“使用此技能”才准备正文，成功后返回聊天并聚焦输入。待用技能名称与移除按钮位于输入框外。

聊天在页面切换时保持挂载，通过hidden/inert切换可见性，保留原草稿。同会话返回技能页沿用列表与待选状态，不自动刷新；只有首次明确进入且尚无发现状态时发起发现，手动刷新才重新发现并退休旧待选。页面保持打开期间的会话/根状态变化不隐式创建会话或扫描；下次明确进入或刷新再按当前状态处理。发现不创建缺失目录，只有明确“打开技能目录”才创建并打开固定应用技能根。

准备结果同时核对页面代次、页面仍打开及会话ID，迟到结果不能把新页面/会话切回聊天。明确返回或Escape关闭恢复原侧栏入口焦点，入口不可用时尝试折叠入口，再回输入框；选用成功则聚焦聊天输入。技能详情模态与聊天所属的审批、退出、提问分别处理，后者先显露保持挂载的聊天。原任务忙碌、权限、格式/容量、快照、重试/编辑、resume及CLI合同沿用；没有新增市场、推荐安装、创建器或启停开关。

当前界面职责在`features/skills/SkillsPage.tsx`、`useSkills.ts`、`App.tsx`、`features/chat/ChatComposer.tsx`及`assets/skills.css`，替代第9节当时的`ComposerSkills.tsx`入口。主进程读取与冻结合同不随界面调整扩大。

### 10.2 参考来源与边界

用户指定的`codex-app-26.1007.2314-keyfiles.tar.gz`缺少renderer assets；本机精确同版`OpenAI.Codex 26.1007.2314.0`静态补齐技能页、卡片、详情及侧栏SVG，来源和规格见[同版参考记录](../.ui-check/skills-reference-26.1007.2314/README.md)。未执行提取的bundle，未联网或读取账户配置；这不是原版运行时截图或业务验收。原版详情读取正文的能力未移入本课，仍坚持元数据详情、显式选用后按需读取正文。

### 10.3 本轮复验与保留结果

| 层次 | 本轮结果与证据 |
| --- | --- |
| 第62课renderer | [renderer-7ff8090b](../.ui-check/test-runs/lesson62/renderer-7ff8090b-d8dc-41a2-8c68-7917ea17e4cf/results.json)24项通过；Hook/React/DOM与接口合成，包含独立页进入、会话隔离、刷新及迟到结果保护。 |
| 第60课renderer回归 | [renderer-d89b9842](../.ui-check/test-runs/lesson60/renderer-d89b9842-ae2b-4ab7-8ec7-874a92930852/results.json)23项通过；原发送/接受/停止与草稿保护的合成回归，不冒称重跑旧整套桌面验收。 |
| 开发桌面 | [desktop-development-077868f7](../.ui-check/test-runs/lesson62/desktop-development-077868f7-fa93-447f-aeb3-e05853de5041/results.json)18项通过。 |
| Windows目录包 | [desktop-packaged-24be41f3](../.ui-check/test-runs/lesson62/desktop-packaged-24be41f3-6983-40d4-af8f-b25cc425745c/results.json)18项通过。 |
| 必要质量与制品 | 本轮类型、定向质量、构建与Windows目录包构建通过；制品身份、日志及受保护文件观察在[本轮总证据](../.ui-check/lesson62/ui-refactor-20261014/README.md)和[最终核对](../.ui-check/lesson62/ui-refactor-20261014/final-verification.json)统一记录。 |

双桌面使用实际Electron、鼠标/键盘、IPC与隔离磁盘；模型传输及受控等待合成，本轮未重复真实模型请求。各18项含双列/窄屏单列无溢出、不可用原因及窄格式拒绝、Escape恢复入口且草稿保持、展开/折叠同页、返回保留待选、零隐式扫描/模型请求、明确刷新退休待选；并继续验证源变化发送拒绝、停止/迟到、普通新消息无技能、原A快照重试/编辑及删A源后续接，同时保留B待选与未发草稿，至少5秒新PID被动重开模型与技能源操作为0。第9节双版真实默认模型审查是前一轮历史结果，不能继承为此次新界面真实模型验收。

早轮[07ae2e7f](../.ui-check/test-runs/lesson62/desktop-development-07ae2e7f-f261-4820-962a-83ed0dd13575/results.json)和[3daaade3](../.ui-check/test-runs/lesson62/desktop-development-3daaade3-5294-4980-acf5-9f1e0386ea73/results.json)各完成前三项后在Escape恢复侧栏入口的观察deadline失败，原结果保留。修正明确关闭时的焦点恢复后，以上最终双版各18项通过，不改写早轮失败。

本轮测试全部使用新UUID隔离userData，不向真实用户技能目录安装示例，不写回、恢复或清空真实会话库。`.env.local`与真实用户设置hash保持；真实`conversation.json`在观察期hash发生变化，按最终核对的实际差异记录，不宣称三份hash均保持。四份本轮文档用追加/前置保留修改前完整字节，核对见[documents-preserved.json](../.ui-check/lesson62/ui-refactor-20261014/documents-preserved.json)。

用户实测确认和八题待补，第56–61及Git扩展的确认、自测、失败/open保持；不创建第63课，不以本轮界面调整推导MCP、SSH、子Agent或未覆盖OS行为通过。

<!-- lesson62-skills-page-ui-20261014:end -->

