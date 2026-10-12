<!-- terminal-independent-host-ef6bdf50-602d-4fa2-8be3-4c9bca84c3b9 -->

## 终端启动卡死补修：独立 PTY 进程（2026-10-12）

上一轮仅测普通/inspect-brk，漏掉 VS Code 的 NodeWorker 自动暂停条件；execArgv 空数组不能关闭该调试器门控。当前主进程异步监督固定的 terminal-host utility 进程，原五 API/IPC 保持；打开/使用终端零 Agent 请求、无权限提升、无 raw/checkpoint 注入。helper 原生退出后等待主进程收讫回执，再真实退出；ACK、kill 返回和退出消息均不单独等价于进程退休。

| 维护命令 | 当前覆盖 |
| ---- | ---- |
| npm run test:lesson59:offline | IPC31、隔离10、独立宿主39、维护补丁25，共105项；Electron/utility/PTY/时钟合成分记 |
| npm run test:lesson59:startup | 两版各22项，普通/inspect-brk/VS Code NodeWorker 条件；真点击、PTY无害输出、颜色/选区、窗口响应、关闭；无模型传输 |
| npm run test:lesson59:desktop | 两版真实shell/utility/CIM、快速关闭、自然退出、附着子孙、Agent并列、活PTY窗口销毁与独立关闭保护；模型/故障合成 |
| npm run test:lesson60:desktop | 两版各38项；现有权限/任务/停止/续接合同与终端并列，真实桌面/磁盘/PTY，模型/审核合成 |

本轮[证据导览](../.ui-check/terminal-fixes/implementation-ef6bdf50-602d-4fa2-8be3-4c9bca84c3b9/README.md)保留原卡死、退役尾消息丢失、先红反例、首次包检查超时及对应旧产物。main fixture 观察迁到 utility 的真实消息和实际退出；其内部 Worker/helper/native 加载不再直接观察，不从空数组宣称通过。目录包普通启动的 main 计数仍未观察。主入口、helper、共享chunk、全部 out 与 ASAR 及两个 native 文件核对身份。旧内容按对应版本阅读；用户新版本重启复验、八题及第56–60全部原open保持。

## 第61课创建导航（2026-10-12）

[第61课：Git改动列表与Diff查看](../ZoneCodex学习计划/76-第六十一课-Git改动列表与Diff查看.md)已创建，产品和运行验收待实施；第5节区分合成协议/隔离、真实临时Git与磁盘、开发桌面、Windows目录包及构建身份。本轮未新增61测试源或npm命令，现有终端修复与第58–60维护入口保持；八题与旧open不关闭。

## 终端主题与启动修复维护入口（2026-10-12）

本轮修复终端固定深色与桌面浅色框架不一致，以及 `inspect-brk` 被 node-pty 输出线程继承后，点击“启动终端”阻塞主窗口的问题。xterm 使用框架背景、正文、光标与选区色值；输出 Worker 和 console-list helper 显式 `execArgv: []`。原五 API、IPC、每窗口一终端及 Agent 隔离不变。

| 命令 | 当前职责与边界 |
| ---- | -------------- |
| `npm run test:lesson59:startup` | 已有开发产物与 Windows 目录包各测普通/`inspect-brk`启动；真实点击、PowerShell 无害 echo、ANSI/选区颜色、窗口响应与关闭。纯终端、不使用模型传输；夹具不包装 PTY/Worker/fork，不改启动参数 |
| `npm run test:lesson59:offline` | IPC 29、隔离 10、cleanup 25；保留原 22 项清理保护，追加隐式调试继承与精确旧补丁迁移。Electron/PTY/helper/worker 合成分记 |
| `npm run prepare:node-pty-cleanup` | 原始、两份精确已知旧补丁、当前补丁完整哈希预检后迁移；未知字节/版本拒绝。`--check` 不写入，合法旧补丁不等于已应用当前补丁 |

startup 可用 `-- --suite=startup-development` 或 `-- --suite=startup-packaged`；默认 `npm test` 保持第58课11套。第59/60桌面夹具已移除测试专用的调试参数替换，仅被动观察实际参数。每轮新 UUID，不从旧报告继承通过；维护源见 [tests/lesson59](lesson59/)，本轮结果与制品身份见[修复证据](../.ui-check/terminal-fixes/implementation-e1e7cb63-f45a-4b7c-bb37-1deb5421342e/README.md)。

目录包普通启动直接使用独立 `--user-data-dir`，验证实际 UI/PTY/命令/关闭及存储；没有主进程夹具，main 同步启动耗时、完整 Agent IPC 与 main fetch 计数标为未观察。目录包 `inspect-brk` 在入口暂停时安装被动夹具，另验这些计数；renderer 网络观察不冒称 main 网络观察。首轮包入口夹具失败和被拒绝的 `NODE_OPTIONS --require` 探针均保留。

第56/58有条件通过、第57/59用户完成确认，以及第60用户实测/八题和全部既有 open 状态保持。有限进程/线程退休仍不证明全部 HPCON/native pipe handles 回收；非 Windows、联网模型和资源符号链接 EPERM 全组不由本轮关闭。下方旧计数、二态 preparation 与测试夹具去 inspect 描述按相应修复前时间阅读。

<!-- lesson60-implemented-2026-10-12:start -->

## 第60课当前维护入口（2026-10-12）

[课程第9节](../ZoneCodex学习计划/75-第六十课-权限与任务状态一致性.md#9-本轮实施与分层验收记录2026-10-12)记录权限/任务/等待/停止及双宿主当前证据。实现与必要自动验收完成，用户实测/八题待补，第56–59原open保持。

| 命令 | 内容与边界 |
| ---- | ---- |
| `npm run test:lesson60:list` | 列出三组和suite，零业务请求 |
| `npm run test:lesson60:offline` | authorization32、renderer23、cli-source13，共68项；拒绝网络/清模型配置，合成Electron/React/传输/approve/answer/backend，真实当前源与隔离磁盘分别记 |
| `npm run test:lesson60:cli` | 开发/分发CLI各12项；共28个实际Node进程、10个真实TTY阶段，模型/审核合成；非TTY3及真实yes/no/EOF/Ctrl+C和当前权限续接；不含cmd launcher或真实command后端 |
| `npm run test:lesson60:desktop` | 开发/目录包各38项；真实Electron/CDP/IPC/隔离磁盘/PTY、新PID被动重开和显式继续；SSE/审核/故障合成，审批等待整任务停止用现有API，非modal外点击 |

维护源：[tests/lesson60](lesson60/)，调度：[lesson60.mjs](../scripts/checks/lesson60.mjs)。三组可选`-- --suite=<list中的名称>`；默认`npm test`仍是第58十一suite。每次新`.ui-check/test-runs/lesson60/<类型>-UUID`，不自动构建/联网，不读取旧通过报告。保留所有失败及改前快照；CLI夹具采用真实写入后Ctrl+C产生interrupted，不削弱completed不可resume保护。模型/真实磁盘/Node/TTY/桌面分别记，停止不保证回滚已执行操作；全部native handles、任意后代及资源EPERM仍open。

本轮[最终报告](../.ui-check/lesson60/implementation-e87bf7f4-1cf9-4702-9e84-8b0bf6625353/final-report.json)与[证据导览](../.ui-check/lesson60/implementation-e87bf7f4-1cf9-4702-9e84-8b0bf6625353/README.md)索引当前UUID、逐报告输入及ASAR/native身份；下方历史入口/计数保留原时间语义。

<!-- lesson60-implemented-2026-10-12:end -->

## 第59课当前维护入口（2026-10-11）

终端回挂的合同、分层结果与失败记录见[第59课第9节](../ZoneCodex学习计划/74-第五十九课-终端面板回挂与独立交互宿主.md#9-本轮实施与分层验收记录2026-10-11)，当前清理优化见[9.6节](../ZoneCodex学习计划/74-第五十九课-终端面板回挂与独立交互宿主.md#96-终端清理优化2026-10-11)。维护源位于 [tests/lesson59](lesson59/)，调度为 [lesson59.mjs](../scripts/checks/lesson59.mjs)；每轮另建 `.ui-check/test-runs/lesson59/<类型>-UUID/`，不读取旧报告当本轮通过。

| 命令 | 当前职责与边界 |
| ---- | -------------- |
| `npm test` / `npm run test:list` | 保留第58课全部11套断网行为锁与列表；不会自动构建、启动桌面或联网 |
| `npm run test:lesson59:offline` | 普通 Node；terminal-ipc 29项、isolation 10项、node-pty-cleanup 22项；覆盖关闭等待/重试/退出时序、补丁原始及已应用字节与隔离。Electron/PTY/socket/helper/worker边界合成，不冒称真实shell |
| `npm run prepare:node-pty-cleanup` | 预检 node-pty 1.1.0 及完整 SHA 后幂等应用局部补丁；未知版本/字节拒绝。`node scripts/prepare-node-pty-cleanup.mjs --check` 只检查合法二态，不应用补丁；postinstall/predev/prestart/prebuild自动准备 |
| `npm run test:lesson59:desktop` | 使用已有当前开发构建及Windows目录包，命令不自动构建；实际Electron/xterm/本地PTY/隔离存储，PowerShell/cmd无害echo和自然exit、首提示符前关闭、重复关闭、持续输出子孙与worker/helper退出；主模型传输与失败注入合成并单独标记 |
| `npm run test:lesson59:list` | 本课分组和suite列表；desktop可用 `--suite=desktop-development` / `--suite=desktop-packaged` 单独选择 |

桌面组在开/用终端阶段核对主/摘要/title/approval/start/resume均0、raw/checkpoint无PTY数据、权限不变；另跑实际时间工具的合成Agent业务及停止任务保留PTY。开发/目录包各含独立新UUID的关闭保护子阶段：取消关闭保留同PTY，随后保存并关闭；实际shell/helper/worker及可严格归属的ConPTY host退休分别记录。调试器仅用于隔离夹具引导，并移除向PTY辅助线程/进程继承的inspect参数；夹具不改产品依赖，产品的局部补丁由上述独立preparation管理，原五API/IPC保持。全部HPCON/native pipe handles回收、任意detached/new-console后代及未观察到的短周期host未证明。第56–58原open、自测与用户确认状态保持；联网模型、非Windows、MCP/Skills/SSH不属于本课通过范围。

## 第58课当前维护入口（2026-10-11）

后续职责/续接安全补强见[第58课9.6节](../ZoneCodex学习计划/73-第五十八课-宿主边界收敛与agent-runner瘦身.md#96-职责收口与续接安全补强2026-10-11)。默认组追加 `resume-safety`（也可 `npm test -- --suite=resume-safety`）：真实隔离磁盘写入后、完整checkpoint提交前强制退出普通Node进程，再由新PID装载旧指针并重新核验；主/摘要模型仍合成，不保证任意任务跨进程恰好执行一次。两版CLI/桌面维护夹具新增请求instructions和风险提示断言，原raw/prompt、JSONL白名单及零启动保护保持。下面359项与第9节制品身份属于补强前历史，新结果另建UUID。

本课执行结果见[第58课第9节](../ZoneCodex学习计划/73-第五十八课-宿主边界收敛与agent-runner瘦身.md#9-本轮实施与分层验收记录2026-10-11)。`npm test` / `npm run test:list` 当前由 [lesson58.mjs](../scripts/checks/lesson58.mjs) 调度，保留55/56/57原九套行为锁，追加 [boundary](lesson58/boundary-check.mjs)。`npm test -- --suite=boundary` 检查含类型边的核心/共享/CLI闭包、薄入口、唯一循环、导入零启动及全部冻结容量；导入反例校验异步尝试也会被拦截。

`npm run test:lesson58:resume:cli` 与 `npm run test:lesson58:resume:desktop` 原样复用第57四入口维护夹具，分别验开发/分发CLI、开发/目录包桌面的真实新进程与隔离磁盘；模型/摘要仍为合成传输。本课调度每次另建 `.ui-check/test-runs/lesson58/<类型>-UUID/`，复用夹具的子报告仍在原课目录下新UUID；不读取旧报告冒充本轮通过。`test:lesson57:offline`、原第57续接及第56显式真实组继续可复跑，第56/57 open 与各课八题状态保持。

## 第57课当前维护入口（2026-10-11）

第57课已接通共享 TaskCheckpoint v1、安全再水合、桌面显式继续与 CLI `--resume`；当前分层结果与新 UUID 见[课程第9节](../ZoneCodex学习计划/72-第五十七课-跨进程可恢复的Agent任务续接.md#9-本轮实施与分层验收记录2026-10-11)。下面第55/56记录保留为各轮历史，不从旧报告继承本轮通过。

| 命令                                                  | 当前职责与边界                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` / `npm run test:list`                      | 第57默认断网组/列表；保留第55 I/O/shared 与第56 context/disk/host/adapters，再加 checkpoint/core/cli-terminal；无真实模型或 Electron 启动 |
| `npm test -- --suite=checkpoint`                      | schema、禁止项、raw/目录/scope、指纹、坏文件保护；普通 Node 与真实隔离磁盘                                                                |
| `npm test -- --suite=core`                            | 合成传输、安全再水合、旧 call_id、当前读取/批准/命令票据、同轮160/128000与摘要限额                                                        |
| `npm test -- --suite=cli-terminal`                    | public host 真实写入后终态保存故障；保留 effects/工具事实/完整 raw，不覆盖坏指针                                                          |
| `npm run test:lesson57:resume:cli`                    | 开发与实际 `agent.cmd` 分发；人为宿主退出→新 Node PID→显式 resume→固定价格八项独立测试；合成 SSE，真实磁盘和启动器                        |
| `npm run test:lesson57:resume:desktop`                | 开发与目录包实际 Electron；UI停止→新 PID→被动重开/切换零请求→显式继续→独立固定八例测试；模型/摘要为夹具，读取/补丁/记录实际落盘           |
| `npm run test:lesson56:offline`                       | 保留第56原调度，当前共享源码运行，不读取旧 UUID 冒充通过                                                                                  |
| `npm run test:native`                                 | 原第55 Windows原生组；本课矩阵不能关闭原资源符号链接 EPERM                                                                                |
| `npm run test:real:cli` / `npm run test:real:desktop` | 保留第56显式联网业务入口；本课未将合成续接计为真实联网                                                                                    |

本课源码在 [tests/lesson57](lesson57/)，统一调度 [lesson57.mjs](../scripts/checks/lesson57.mjs)，每次另建 `.ui-check/test-runs/lesson57/<类型>-UUID/`。旧桌面生命周期夹具新增明确的 checkpoint persistence 替身，原保护断言保留；真实 checkpoint/新 PID 单独验收。各组的真实/合成边界、首次失败、制品身份、未覆盖及复跑命令以第9节和本轮独立报告为准。八道自测与用户实测待补，第56用户确认/八题/EPERM/真实多图/自然修错继续 open。

<!-- lesson56-cli-completion-2026-10-11:start -->

## 第56课CLI业务闭环补验维护（2026-10-11）

第56课CLI业务闭环补验已完成：保持原限额，在20000候选内分配知识块实际剩余空间，324项断网保护、类型、定向lint/格式及构建通过。默认gpt-6.1-sol两版CLI真实整理→业务→固定测试/重读重测通过，双桌面当前源码业务/整进程重开零请求通过；首批321项及双CLI整体失败、后续两次超预算候选拒绝全部保留。 见[课程第10节](../ZoneCodex学习计划/71-第五十六课-上下文整理与容量管理.md#10-cli业务闭环补验2026-10-11)。

补验继续使用现有`npm test`、`npm run test:native`、`npm run test:real:cli -- --suite=cli-development`与`--suite=cli-distributed`，真实业务prompt及受保护价格/八项测试/台账长度保持。修复涉及共享核心时，桌面两入口、实际图片映射及整进程被动重开独立回归，不从旧报告继承通过。合成主/摘要传输、真实磁盘、Windows进程及联网结果分别记录，新UUID保留每次实际尝试。本轮基线HEAD为bcbffe1f1280662ee740eb69f93ea8dfbe837ccc、未提交状态为空。前轮第9节、旧prepend、失败及原证据全部保留；前轮CLI失败和Git变化仍是对应旧轮事实。160项/128000字符原保存、96000/128000工作预算及全部摘要预算保持；固定业务prompt、价格需求、八项测试及台账长度不改。八道自测待作答，用户本课实测确认待补；第57课、持久会话和跨进程续接后置。

<!-- lesson56-cli-completion-2026-10-11:end -->

<!-- lesson56-implemented-2026-10-11:start -->

## 第56课当前维护入口（2026-10-11）

第56课共享上下文整理、容量管理及桌面/CLI/脚本适配已完成；断网317项、构建/制品身份及双桌面真实固定业务与新PID重开零请求通过。两版CLI真实整理/后续发送和8个帮助/导入新进程零请求通过，但原保存容量触顶，业务闭环失败。Windows原生13组11通过、2资源组因符号链接构造EPERM失败/未覆盖，不声明全部验收通过。 实际状态见[课程第9节](../ZoneCodex学习计划/71-第五十六课-上下文整理与容量管理.md#9-本轮实施与分层验收记录2026-10-11)。

| 命令                               | 当前职责与边界                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                         | 第56课offline：复用第55课I/O与shared原保护，加context-core、context-disk、host、adapters；清除模型配置并拒绝网络，不启动Electron或真实模型业务 |
| `npm run test:list`                | 列出第56课各组和suite；无业务请求                                                                                                              |
| `npm test -- --suite=context-core` | 纯合同、预算、完整组、取消、分块与投影；合成摘要传输                                                                                           |
| `npm test -- --suite=context-disk` | 当前核心/执行器真实隔离磁盘：读凭据、格式/备份补丁、取消/失效后副作用保持；摘要/HTTP/批准合成，零网络/命令                                     |
| `npm test -- --suite=host`         | 图片明确重映射与固定主/摘要配置；合成传输/图片捕获                                                                                             |
| `npm test -- --suite=adapters`     | 公共事件白名单、preload、CLI输出及实际renderer Hook的合成生命周期                                                                              |
| `npm run test:native`              | 保留第55课开发/分发Windows Node、ConPTY/Job/writer/资源/背压保护；模型传输合成                                                                 |
| `npm run test:real:cli`            | 第56课开发CLI与实际Windows launcher；单任务空历史内部真实完整组整理，真实默认gpt-6.1-sol                                                       |
| `npm run test:real:desktop`        | 第56课开发/Windows目录包；合法长历史夹具触发，真实摘要和业务、已有任务新PID同userData重开零请求另验                                            |
| `npm run test:lesson55:offline`    | 保留第55课原维护调度，不读取旧UUID当当前通过                                                                                                   |

当前最少维护源在[tests/lesson56/](lesson56/)，调度为[scripts/checks/lesson56.mjs](../scripts/checks/lesson56.mjs)；固定价格需求与八项测试继续复用[第55课合同](lesson55/real/task-contracts.mjs)，Agent不得修改测试、requirements、sidecar、package与价格台账。新结果另存 `.ui-check/test-runs/lesson56/<类型>-UUID/`；context-core与context-disk独立证据分别为 `.ui-check/lesson56/context-core/<UUID>/`和`.ui-check/lesson56/context-disk/<UUID>/`。复用项目依赖及现有包，不复制整份依赖树。合成传输、真实磁盘、Windows进程、Electron及联网业务分别报告；停止/输出故障不能承诺JSONL终态送达。

最终offline317项通过（54 I/O＋224 shared＋15 core＋4 disk＋11 host＋9 adapters），两版真实CLI整体失败而整理/后续发送及帮助/导入零请求分别通过；首轮host、offline与真实失败均保留，详情及复跑见课程第9节。原课下方旧入口和计数属于相应历史轮。完整原记录保持；摘要仅存在于本次明确请求，帮助、导入、启动、恢复和切换会话不发整理请求。本次Agent未执行Git提交或重置；核验观察到HEAD从5dab5f18变为0929b728，原HEAD保持检查未通过，已记录且不回滚。第56课八道自测均待作答，第54/55课原失败、未覆盖和自测保持；持久CLI会话、跨进程任务续接及第57课创建/实施后置。下方旧创建状态按原记录时间阅读。

本轮汇总：[最终实施/部分验收报告](../.ui-check/lesson56/implementation-f195f5fe-559d-47aa-b394-031f6013c82a/final-report.json)、[证据导览](../.ui-check/lesson56/implementation-f195f5fe-559d-47aa-b394-031f6013c82a/README.md)、[6次真实入口事实索引](../.ui-check/test-runs/lesson56/real-entry-final-facts-642f8615-97e0-44e6-82fd-409f749b5ca0/index.json)；实现完成与全部验收通过分别记录，后者为false。

<!-- lesson56-implemented-2026-10-11:end -->

# 测试工程

第55课的维护入口放在 `tests/lesson55`，统一调度在 `scripts/checks/lesson55.mjs`。旧 `.ui-check/lesson55` 脚本、报告、失败记录和用户资料保持原字节；维护入口不读取旧 UUID 报告。

| 命令                        | 内容                                              | 运行边界                                                                                           |
| --------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm test`                  | I/O 54项与共享八套保护检查                        | 固定合成传输、隔离文件、Node与本地esbuild编译；不启动Electron、业务CLI或命令沙箱，不发业务网络请求 |
| `npm run test:list`         | 列出各组及子套件                                  | 不启动测试或模型                                                                                   |
| `npm run test:native`       | 开发/分发CLI、公共API、writer、资源拒绝与六组背压 | Windows真实Node、ConPTY、Job监督和资源查询进程，模型传输合成；需已有两版构建产物                   |
| `npm run test:real:cli`     | 开发CLI与实际Windows启动脚本的价格任务            | 真实默认`gpt-6.1-sol`，需要原模型配置并发送业务网络请求                                            |
| `npm run test:real:desktop` | 开发/Windows目录包价格任务与整进程重开            | 真实Electron与模型请求；隔离资料目录，重开阶段核对零请求                                           |

可只跑一套，例如 `npm test -- --suite=io`、`npm run test:native -- --suite=api-development`。子套件名称以 `npm run test:list` 为准。真实组也支持明确选择一版，例如 `npm run test:real:cli -- --suite=cli-development`。默认命令不自动构建、联网或运行原生组。

维护源分为 `offline`（I/O与离线调度）、`shared`（既有断言和夹具）、`native`（实际Windows宿主）、`real`（真实业务与固定合同）。每轮输出另建 `.ui-check/test-runs/lesson55/<类型>-<UUID>`；编译夹具、实际磁盘、日志、报告与快照都留在该轮目录，避免覆盖源码或旧结果。共享套件先复制维护源到新轮目录，再固定项目根运行；不会从历史报告补造凭据或通过状态。默认组移除模型配置环境变量，并安装拒绝网络的保护；合成响应只在明确的测试片段替换传输。

提升来源和适配见 `tests/lesson55/migration-provenance.json`。保留既有断言及生成的固定业务材料，只调整项目根、辅助脚本定位、输出目录、必要JavaScript规范和格式；未用整份迁移前源码快照。历史汇总、身份映射、独立审查、准备脚本、旧编译失败对照及原生研究探针仍属于对应历史轮，未挂入默认当前源码回归。真实CLI的当前身份清单补入 `tsconfig.cli.json`，不改历史清单或计数。

资源套件仍要求全部覆盖；Windows不能创建符号链接时保留未覆盖与失败状态，不静默跳过。合成模型、真实磁盘、实际进程和真实联网结果分别记录；原自然红测试继续修正、非Windows、完整OS隔离等未覆盖/未通过范围保持。两真实入口的迁移本轮仅完成语法和静态检查，不等于新业务回归通过。

## 本轮验证

最终固定默认入口通过I/O 54项及共享八套224项；所有维护脚本语法、lint与格式检查通过。提升后的开发版公共API 21项和CLI 43项也经新调度实际通过，模型传输合成，实际Node/ConPTY/受监督命令与资源查询分别按其原记录区分。首次提升源lint暴露114项JavaScript返回类型、既有空夹具/诊断捕获、未用帮助函数和ANSI正则问题，随后只修测试源与测试范围配置。最终默认复跑在 `.ui-check/test-runs/lesson55/offline-group-5ce313bf-2efc-4295-889e-55708b9bdec5/results.json`；开发API在 `native-group-1aba6e36-37a4-45b9-8653-ab6a63912f1e`，开发CLI在 `native-group-33e4fb62-a3d4-45f6-bc96-553ae15db381`；整理验证索引在 `.ui-check/test-runs/lesson55/organization-check-ff1428f9-d3e5-478f-9afb-e599e6e8fced`。原 `.ui-check` 源不修改，产品源码及构建产物不因本次整理改写。分发版原生矩阵、完整writer/资源/背压组与两个真实业务组本轮未执行，不能借旧结果记为本轮通过；共享附件夹具还会创建唯一命名的测试自写系统临时材料，未读取用户文件。

## 历史运行副本清理与恢复

清理统计、保留副本与恢复命令由本轮清理记录和 `scripts/checks/restore-evidence.mjs` 导航。固定合同、测试、报告、失败记录、observer、用户资料与ASAR不作为重复依赖树删除；需要重跑历史原生记录时，先按恢复索引恢复其运行副本，再用原记录的命令和边界。

本轮实际删除151298个重复文件（27.565 GiB）：88个相同依赖树和3502个相同平台/命令运行文件。不同字节版本各保留一份原路径副本，报告及业务证据不改写。详见[清理账本与保留核验](../.ui-check/test-engineering/cleanup-00087637-3224-4a24-ada8-b90a388de191/README.md)。运行`node scripts/checks/restore-evidence.mjs --list`查看索引；用`--target=.ui-check/lesson46/packaged-6c3c8045-b0e1-4cf9-9dce-85ce6d21002d`恢复某轮历史运行材料，或指定其中一项目标。恢复核对源/目的SHA256，不覆盖已有不同内容文件，不启动产品或模型；已实际验证依赖树、单文件和拒绝覆盖路径。
