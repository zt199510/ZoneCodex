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
