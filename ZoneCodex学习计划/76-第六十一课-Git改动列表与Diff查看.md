<!-- terminal-independent-host-ef6bdf50-602d-4fa2-8be3-4c9bca84c3b9 -->

2026-10-12 前置补修更新：下方创建时“启动已修复”属于上一轮普通/inspect-brk的有限验收，用户随后报告 VS Code 实际启动仍卡死。现已改独立PTY进程并补调试门控、退出收讫及双版真实验收，见[当前修复记录](../.ui-check/terminal-fixes/implementation-ef6bdf50-602d-4fa2-8be3-4c9bca84c3b9/README.md)。本课仍仅创建，产品实施/八题待进行；旧文按对应轮次保留。

# 第六十一课：Git 改动列表与 Diff 查看

创建日期：2026-10-12。状态：**课程已创建，产品实施与分层运行验收待进行；八题均待作答，不附参考答案。**本轮仅核对当前源码、制品和未提交修改，编写课稿及同步最小导航，没有实现 Git 模块、运行桌面、构建或调用模型。第9节由实际实施时追加，不预填通过结果。

前置：[第60课权限与任务状态一致性](75-第六十课-权限与任务状态一致性.md#9-本轮实施与分层验收记录2026-10-12)已完成产品与必要自动验收，当前有条件通过，用户实测确认待补、八题待答。第56有条件通过，第57用户确认完成，第58有条件通过，第59用户确认完成；各课原用户确认、自测与 open 项保持。第61课创建不替任何旧课补确认。

第61课前已修复终端主题不一致和点击“启动终端”阻塞问题，依据为[终端修复记录](../.ui-check/terminal-fixes/implementation-e1e7cb63-f45a-4b7c-bb37-1deb5421342e/README.md)及[维护入口](../tests/README.md)。其中开发/目录包、普通/调试启动及合成/真实观察分别记录；全部原生句柄回收仍未证明。修复源码和 node-pty 维护补丁当前未提交，实施本课必须保留。

本课将人工 Git 查看接入桌面，成为与聊天、独立终端并列的只读界面。**Git 查看不进入 tool-loop，不调用 Agent，不授予 Agent 凭据，不把内容写入 raw/checkpoint。**会话 v9、设置 v1、checkpoint v1、第56容量、三权限与第60任务合同保持；不复活批准、读取凭据或命令票据。MCP/Skills/SSH、远程壳、Agent 控终端、把终端或 Git 输出喂给模型继续后置。

## 1. 本课目标与前置条件

目标：用户主动选择本地仓库查看范围，看到当前改动列表，按“已暂存 / 未暂存 / 新文件”选择一项，查看该项有明确来源的只读差异或内容预览。

实施后应能观察到：

1. 入口打开面板，选择目录、手动刷新、选择文件和关闭面板可独立使用，无模型请求、PTY 命令或自动 Agent 任务。
2. 同一文件的已暂存和未暂存改动分开；新文件明确没有 Git 基线，不借写入 index 制造差异。
3. 列表和内容来自主进程固定的读取服务，renderer 只传临时查看标识与列表项标识，不能指定命令、任意目录或任意 revision。
4. 空仓库、非仓库、Git 不可用、二进制、超限、不支持类型和读取失败有可理解的提示；旧结果不冒充当前结果。
5. 面板关闭、换目录、页面重载和窗口退出使请求失效并清理真实读取进程；不改变聊天、终端或 Agent 权限。

### 1.1 创建时核对到的事实

| 现有能力 | 当前事实 | 本课处理 |
| -------- | -------- | -------- |
| Git 列表与 Diff | `src` 中尚无专用 Git 仓库发现、状态或 Diff API | 本课实施时建立最小模块，不写成已有功能 |
| 提案预览 | `review/diff.ts` 的 `buildDiff(before, after)`比较两段文本；主进程提案源为附件快照与候选文本 | 可借用展示样式；不能当作 Git 的 HEAD/index/worktree 事实 |
| 工作区选择 | `selectWorkspace` 读取项目指令并建立 Agent 工作区 grant | Git 选择使用独立人工查看范围，不能直接调用它 |
| 本地文件查看 | `file-view-ipc.ts` 的 local 分支依赖运行上下文与权限 | 不冒称现成 Git 读取宿主；保留原文件查看行为 |
| 会话任务目录 | 绑定会话目录首次可能创建目录 | Git 打开/选择不调用绑定，不为查看创建业务目录 |
| 桌面壳 | App 组装聊天、设置、文件查看和终端，标题栏已有终端入口 | 增加有限入口与面板，不重做工作台 |

### 1.2 首版范围

首版只做当前本地工作树的状态列表、单项只读 Diff/新文件预览和手动刷新。普通修改、新增、删除、重命名及同路径双态为必要功能；空仓库无 HEAD、仓库子目录及 linked worktree 为必要边界。Git 来自系统已安装的可信程序，不新增 Git npm 库、不捆绑 Git 安装器，不自动安装缺失程序。为防仓库配置隐式启动程序，原生 status/diff 必须在应用自有的隔离读取元数据快照上执行，见§4A步骤三；不把原始内容比较伪称完整 Git 未暂存 Diff。

不提供暂存/取消暂存、提交、撤销、分支切换、历史提交、合并冲突解决、fetch/push、stash、Git 初始化或全仓库搜索。冲突项、二进制、symlink/gitlink/submodule、bare 仓库和不支持编码可明确显示“不支持预览”或拒绝；首版拒绝 partial clone、原对象库 alternates、split/sparse index及不能准确支持的自定义转换语义。不跟随子模块递归，不凭一个“干净”标签隐瞒未覆盖。特殊类型的发现与不执行仍需验收。

## 2. 用 Vue 经验理解本课

| Vue 中的经验 | React/Electron 中的对应 | 必须分清 |
| ----------- | --------------------- | -------- |
| 列表选中项控制详情组件 | Git 面板状态与单项详情 | 列表项不是自由路径输入；后端按自己的项表解析 |
| `watch` 发请求，用序号防旧回包 | Hook 保存 repository/list/request generation | 取消 UI loading 不等于真实 Git 进程已退出 |
| 展示 store 与业务授权分离 | 临时 Git view scope 与 Agent workspace/execution scope 分离 | 人工看过文件不等于 Agent 已读或已批准 |
| 同一文件有多个比较基线 | HEAD → index；index → worktree | 一个文件可以同时出现在两组，不能只留最后一个状态 |
| 前端 Diff 组件只负责呈现 | Git 固定来源结果 → 纯展示 | 红绿行正确不证明基线、路径或时刻正确 |

例子：先把文件从 A 改成 B 并暂存，再把工作树改成 C。已暂存 Diff 是 A→B，未暂存 Diff 是 B→C。新建未跟踪文件没有 A 或 B，应显示“新文件内容”，不能标成“已暂存新增”。

## 3. 当前实际文件与职责

实施前重新读取当前版本，以下真实文件并不要求全部修改：

| 文件 | 当前职责 / 本课观察点 |
| ---- | --------------------- |
| [App.tsx](../src/renderer/src/App.tsx)、[TitleBar.tsx](../src/renderer/src/components/layout/TitleBar.tsx)、[Sidebar.tsx](../src/renderer/src/components/layout/Sidebar.tsx) | 桌面组装、入口、设置与焦点；选择一种清晰入口，不重复放置 |
| [useWorkspace.ts](../src/renderer/src/features/project/useWorkspace.ts)、[WorkspaceStatus.tsx](../src/renderer/src/features/project/WorkspaceStatus.tsx) | 当前 Agent 工作区选择与显示；Git 面板不改变其 grant 或任务状态 |
| [useFileView.ts](../src/renderer/src/features/files/useFileView.ts)、[FileViewPanel.tsx](../src/renderer/src/features/files/FileViewPanel.tsx) | 已有文件查看与迟到处理，借鉴有限展示/清理，不复用其 Agent 读取授权 |
| [diff.ts](../src/renderer/src/features/review/diff.ts)、[change-preview.ts](../src/main/tools/change-preview.ts) | 现有提案文本预览，须回归其原语义 |
| [workspace-access.ts](../src/main/project/workspace-access.ts)、[project-ipc.ts](../src/main/project/project-ipc.ts)、[file-view-ipc.ts](../src/main/project/file-view-ipc.ts) | 当前工作区 grant、来源检查与文件查看；不能用它们签发 Git 查看权限给 Agent |
| [ipc-source.ts](../src/main/ipc-source.ts)、[app-runtime.ts](../src/main/app-runtime.ts) | 主窗口/main frame 来源校验、注册及生命周期挂接 |
| [api.ts](../src/shared/api.ts)、[preload/index.ts](../src/preload/index.ts)、[project-api.ts](../src/preload/project-api.ts) | 同一个平铺 AppAPI 的分组实现；Git 新组保持窄协议，renderer 不接触 Node |
| [TerminalPanel.tsx](../src/renderer/src/features/terminal/TerminalPanel.tsx)、[local-terminal.ts](../src/main/terminal/local-terminal.ts) | 已有独立终端；Git 不借它执行，也不干扰其会话 |
| [tests/README.md](../tests/README.md)、[lesson58.mjs](../scripts/checks/lesson58.mjs)、[lesson59.mjs](../scripts/checks/lesson59.mjs)、[lesson60.mjs](../scripts/checks/lesson60.mjs) | 默认断网、独立终端及权限/任务行为锁 |

实施时可建立 `src/shared/git-view.ts`、`src/main/git/`（范围、固定进程读取、纯解析、IPC）、`src/preload/git-api.ts`、`src/renderer/src/features/git/` 和 `tests/lesson61/`，以及相应 checks 调度。**这些只是候选位置，创建时不存在；名称与拆分按必要职责决定。**不提前添加无法运行的 npm 测试命令，不为课号重构 Agent 核心。

## 4. 按依赖顺序实施与练习

严格按 §4A 冻结边界，再按 §4B 实施与验证。已有能力正确时保留；发现真实问题才作必要修复。

### §4A 阶段：冻结来源、只读边界与交互合同

#### 步骤一：新基线与孤儿能力核对

1. 新 UUID 保存源码、制品、HEAD、Git 原未提交补丁、用户库/工作目录身份和维护源；保留第61创建记录、终端修复、node-pty 精确字节补丁和旧失败。不提交、reset 或清空原数据。
2. 确认当前仍无 Git 宿主；画出人工 Git IPC 与 Agent 文件工具、提案预览、命令授权、PTY 四条独立调用链。
3. 默认离线与受影响旧分组建立本轮行为锁；原报告仅作历史依据，不继承通过计数。

**预期效果：** 知道从哪里新增、哪些现状必须保留。**常见错误：** 把已有提案 Diff 的截图当 Git 功能已完成。

#### 步骤二：冻结仓库与状态语义

| 项目 | 必须冻结的合同 |
| ---- | -------------- |
| 目录来源 | 主进程原生选择目录，建立窗口/document 所有的临时 Git 查看标识；不读取项目指令、不创建会话目录、不写 Agent workspaceGrants |
| 三种位置 | 区分用户选中目录、worktree 根、gitdir/common-dir。`.git` 可以是 linked-worktree 文件；允许解析必要 Git 元数据，不把它扩大成普通文件读取范围 |
| 子目录 | 仓库根在选中目录上层时，只列/看所选子树，界面同时显示仓库与查看范围；不静默读兄弟目录。跨边界 rename 不预览范围外旧/新内容 |
| 已暂存 | HEAD→index；无 HEAD 时按空树基线处理，不要求先提交一次 |
| 未暂存 | index→worktree；同路径的已暂存与未暂存独立标识、独立选择 |
| 新文件 | 未跟踪文件的有界本地内容预览，无 Git 基线；不运行 `add -N`、不写 index |
| 文件名 | 状态采用 `porcelain=v2 -z` 等固定机器协议，按 NUL 与明确记录语法解析，rename 消费第二路径；不按空格/换行拆路径 |
| 刷新与一致性 | 列表版本标识与单项内容绑定；读前/读后核对必要身份，变化提示刷新。多条 Git 查询不是原子快照，不把变化后的详情冒称原列表快照 |

需要明确空格、中文、引号、换行、前导 `-` 和 pathspec 魔法字符的处理。机器文件名字节不得有损解码后重新用于命令；平台不支持的名字/编码显式拒绝预览。删除项按已有父目录与主进程项身份核验，不能因叶文件已不存在一律拒绝。

**预期效果：** 每组的基线、路径与时刻可解释。**常见错误：** 用单个 `M` 或全文提案算法合并三种来源。

#### 步骤三：冻结固定读取与进程边界

1. 可信 Git 可执行文件由 main 定位、固定并记录版本/身份；固定命令类别与 argv、`shell:false`，renderer 不提供可执行文件、选项、任意 ref、环境变量或 cwd。无法确认程序时给错误，不从当前仓库执行同名程序。锁定能禁用懒抓取的受支持 Git 版本；对象缺失直接失败，不因只用本地命令就假定绝不会联网。
2. 使用 `--literal-pathspecs` / 字面 pathspec 与 `--`，按 main 的项表取路径；重验证 root、gitdir 和目标范围。拒绝 traversal、路径替换、ADS/设备路径及链接穿透；外部文件/网络 UNC 不进入首版读取。符号链接只显示类型，不跟随读取。
3. 关闭 optional locks（`--no-optional-locks` 或等效固定环境）、fsmonitor、pager、external diff、textconv 及递归子模块；清理继承的 Git 路径重定向/配置注入环境。禁网络/交互/credential helper调用，不放宽 `safe.directory`；目录所有权拒绝按事实显示。
4. **“只读命令”不等于“不会运行仓库配置程序”。**`--no-ext-diff --no-textconv` 不会关闭 clean/process filter。只做“预检无filter→在原仓库status/diff→后验hash”仍有配置变更执行窗口。因此先在应用自有临时目录建立有界 Git metadata/index/HEAD 快照，再执行列表与 Diff；原仓库仅允许不会读取内容转换/启动配置程序的固定定位与元数据查询。
5. 隔离查询不加载用户 local/global/system 配置、include 链、hooks、外部 attributes/excludes 路径或任何 filter/diff/process/credential 驱动；只导入经过枚举和值校验的必要内建语义（如 object format、autocrlf/eol/filemode），明确所支持的属性/忽略来源。固定查询的 `GIT_DIR/GIT_COMMON_DIR` 仅指向应用自有目录，`GIT_INDEX_FILE` 仅指向快照，`GIT_WORK_TREE` 与本地对象来源仅由 main 按已验证根指定；禁止复制用户 `.git` 指向文件、commondir、原 config/hooks 或导入 `core.worktree` 使查询重返原配置。HEAD 只使用捕获的对象 ID，无 HEAD 用受控空 ref，不复制整个 refs/历史。
6. 工作树 attributes 可作为数据解释，不能使临时配置出现外部驱动；自定义转换语义不能准确支持时明确拒绝，不能返回“与用户原配置完全相同”。冻结内建 ignorecase/symlinks、info/attributes、忽略来源等支持子集：支持的按数据和值校验捕获，不支持的明确提示，不悄悄省略后称等同原环境。临时 index 通过有界普通文件句柄采集、读前/后身份核验，按实际格式/扩展识别 split/sparse，不能只搜字符串或看 config。
7. 本地对象来源按 gitdir/common-dir 验证且禁 lazy fetch；版本不能禁用懒抓取、缺对象、partial clone、原对象库 alternates或特殊 index均拒绝。直接指定原 objects 仍会解析其 `info/alternates`，一次不存在检查防不住后加再删；须固定不会重解析源 alternates 的受限对象入口（例如应用自有对象入口下的有界逐文件快照/固定文件链接），无法成立就拒绝，不无界复制对象库/工作树。配置隔离不等于所有文件来源的 OS 级隔离，外部恶意进程改写文件/句柄的未保证边界如实记录；不把事后hash当安全补救。
8. 临时元数据写入属于应用缓存，不得写原 index/config/refs；待 owned 子进程实际 close 后才清自己拥有的目录，未确认退出/缓存清理失败要留诊断，不能提前宣称回收。
9. 读取路径不会调用用户转换器才是安全依据；读前/后配置、HEAD、index、路径身份核验负责新鲜度，不能撤销已执行的外部程序。有效 include/全局配置、linked-worktree common config、转换器/监视器哨兵与“检查后修改再恢复”反例均须验收；隔离条件不能成立则拒绝，禁止降级到原仓库 worktree status/diff。子目录查询须避免为 rename/全局统计读范围外工作树内容，不能仅在返回后过滤；必要祖先 `.gitattributes/.gitignore` 按明确、受限的仓库元数据规则处理，不扩为兄弟源码读取。
10. 固定读取操作不经 `propose_command`、命令票据、授权批准、PTY 或 Agent 核心。不调用 add/commit/reset/restore/checkout/clean/init/fetch/push，不运行 hook/外部 diff 或转换器来“帮助”预览。支持范围无法安全成立时明确拒绝，不降级借用终端。
11. 冻结并公开实现内限额：状态输出最多 1 MiB / 2000 项，单项 Diff/新文件最多 256 KiB / 4000 行，stderr 最多 16 KiB，临时 index/元数据输入合计最多 16 MiB；每窗口最多一个活跃读取，单次读取最多 10 秒。对象入口的项数/累计捕获字节也须在§4A写定，超限拒绝而非无界展开。先按原始字节计数，再解析/渲染；超限取消并显示不完整状态，不能截断协议后当完整列表。它们是 Git 查看限额，不修改第56 Agent 容量。
12. 超时/取消/输出超限监督真实子进程；终止请求与 close 确认分开，有界收尾，异常退出与未确认清理如实记录。不把主进程同步等待 Git/原生 helper 写入 UI 点击路径。

**预期效果：** 读取不会隐式扩权、写 index 或借配置启动业务程序。**常见错误：** 只有 `shell:false` 就声称任意仓库安全，或用取消按钮变灰证明进程退出。

#### 步骤四：冻结面板交互与隔离

| 用户动作/情境 | 合同 |
| ------------- | ---- |
| 打开/关闭 | 打开只显示面板，不自动选目录、绑定工作区或发模型；关闭取消读取、释放临时范围、清空内容并返入口焦点，再打开需重新选择 |
| 选目录/刷新/选文件 | 使用独立范围；刷新与快速切项取消/替换旧读取，清晰显示加载、空、失败、超限与需刷新；主/摘要/标题/审核请求均为0 |
| 设置/窄屏/文件查看 | 设置显示时 Git 隐藏且不可聚焦；关闭设置不自动查询。窄屏一次清楚展示一个辅助面板，避免叠盖审批/问答与关闭确认 |
| 切会话 | Git 为窗口级人工查看，不绑定会话；切会话不换仓库、不授 grant、不自动刷新，仍在面板明确显示其独立目录；切换过程中旧响应只按 Git 标识核验 |
| Agent 忙碌 | 已选范围允许手动刷新/查看，不改变 mode/revision、任务或等待；新开目录对话框在审批/问答/关闭模态等待时禁用，main 也核验。Agent 改动文件时提示刷新，不锁住或取消它 |
| 与终端/文件查看并列 | 标题栏终端旁增加 Git 入口，终端保持工作区下方。Git 与 FileView 共用一个副查看区，人工打开另一面先关闭当前查看，不自动重开旧面；Git 关闭、刷新、失败不杀 PTY，不能复用对话侧栏的 busy 禁用条件 |
| 页面/窗口销毁 | document generation 失效，取消 owned 读取并释放标识；跨窗口/frame、旧标识、旧项、迟到回包不能改变当前面板 |
| 存储与权限 | Git 标识与展示内容仅留窗口查看内存，不写会话 raw/checkpoint、不签发 Agent 读取证据/批准/命令票据、不触发 title/summary；仅允许上述有界应用自有查询缓存，等进程 close 后清理，不作为可恢复会话/授权 |

**预期效果：** 看 Git 和聊天执行是两个可独立解释的动作。**常见错误：** 从当前会话的展示目录自动恢复 Git 权限，或因 Agent 忙碌禁止一切独立查看。

### §4B 阶段：最小实现、护栏与真实双桌面验收

#### 步骤五：按职责接入

1. shared 定义窄请求/结果与运行时校验：选目录、刷新列表、读列表项、取消/释放。明确 stale/not-repository/unavailable/unsupported/too-large/error 等语义；不把原始命令输出任意透传成 API。
2. main 独立管理窗口/document 的范围、隔离元数据快照、项表与读取进程；纯 parser 与路径判定可单独验证。先实现并验证安全快照读取，再接原生 status/diff。IPC 入站和异步返回前都核验当前身份，scope 不是 Agent grant。
3. preload 新分组加入现有 AppAPI；只暴露固定操作，不暴露 Node、spawn 或任意文件读取能力。
4. renderer 用独立 Hook/面板接列表与详情，样式取框架 tokens；显示已暂存/未暂存/新文件、路径、基线与异常。Diff 行按文本安全渲染，不插入仓库 HTML 或执行控制序列。
5. App/标题栏或侧栏只组装入口与显示关系；按冻结合同实现取消、焦点、设置及辅助面板关系，不复写聊天/终端协议。只有用户动作才发查询，不因 render/effect 循环无限刷新。

**预期效果：** 最短路径从人工入口到真实只读结果，各层职责可追踪。**常见错误：** renderer 传拼好的命令，或把状态缓存写入 ConversationLibrary。

#### 步骤六：合成协议、故障与隔离护栏

建立少量有行为意义的维护测试，不只测返回标签：双态/rename/NUL 路径解析、空 HEAD、删除、冲突/特殊类型、恶意路径/旧项/错来源、字节/条数/行数限额、错误/超时/取消、输出背压、快速切项/换库/关闭的迟到结果。进程替身测试与真实进程分记。

有效 fsmonitor/filter/external diff/textconv/pager/懒抓取配置及变更用可观察哨兵验证“未执行”；验证 status/diff 实际只加载应用临时配置，不因原配置检查后修改再恢复而启动程序，隔离条件不成立时危险查询不启动。监听 Agent 核心与传输入口、读取凭据、approval/命令票据、raw/checkpoint 保存链，Git 开/选/刷新/读取/关闭均无污染。历史会话、未知权限禁发、busy权限切换拒绝及拒绝/停止/迟到事件继续走原第60合同。

**预期效果：** 违反冻结边界能被反例发现。**常见错误：** 只数模型网络请求0，漏掉本地 Agent 初始化、凭据授予或会话保存污染。

#### 步骤七：真实 Git 与隔离磁盘

在本轮新 UUID 的**自建临时仓库**准备固定材料：初始提交、同一文件双态、新增/删除/rename/untracked、中文/空格/前导 `-` 名称、子目录范围、空仓库、linked worktree、二进制/超限、冲突及配置哨兵。夹具准备可仅在这些明确隔离路径执行 init/add/commit 等写命令；它们不是产品能力，不能对 ZoneCodex 项目或用户仓库执行。准备完成后冻结输入，再验只读服务。

分别核对预期 HEAD/index/worktree 来源、列表与具体内容；读取前后比较工作树、index、配置与 refs/元数据身份，忽略的项目须逐项说明，不用 `git status` 一句话证明无写入。构造配置更改、目录替换、快速取消及真实受控阻塞进程；哨兵不执行、不写 index，owned 读取进程有实际退出证据。Windows 无法构造换行名或链接时记未覆盖，不能算通过。

**预期效果：** 真 Git、真文件和真清理支持首版结论。**常见错误：** 在项目里暂存/提交来造测试，或拿假的 parser 输入替代真实 rename/linked-worktree。

#### 步骤八：开发与 Windows 目录包真实界面

1. 两版各用隔离用户库和同一固定材料实际打开面板、选目录、刷新、点击双态/新文件/删除/rename，查看结果、错误及范围；保留截图、原始日志、Git 版本与进程身份。
2. 实际快速切项、换目录、关闭再开、设置来回、切会话、窄屏与键盘返焦点；终端用无害 echo 证明仍独立可用，不能只通过直接主 IPC 调用替代 UI 点击。
3. 用明确标注的合成 Agent 运行/审批/问答背景验并列合同，真实 Electron/UI/Git/PTY 与合成模型传输分记；Git 操作新增主/摘要/title/审核请求均0。无需真实联网模型业务，不借业务调用制造通过。
4. 正常目录包与附加调试审计分记；仅调试环境观察到的 main 计数不能冒称普通运行也具备同等观察覆盖。退出/取消要记录进程收口，原全部 native handles open 保持。

**预期效果：** 入口、preload、main、Git 程序及包内资源真实接线可用。**常见错误：** 只在开发版通过，或包内旧源码和当前测试身份不符。

#### 步骤九：必要回归、构建与收口

运行默认断网、本课新分组、受影响的文件查看/提案 Diff/第60权限状态及第59独立终端回归；Node/Web/CLI 类型、定向 lint/格式、开发和 Windows 目录包构建。未改 CLI 产品时明确映射其未改来源/编译身份，不为桌面只读课强制跑联网 CLI 业务或重验所有原生组。

核对真实加载 main/preload/renderer 与包内 ASAR、维护源和 node-pty 精确字节补丁身份；改变源码/夹具后重跑受影响组。实施时建立实际可运行的61调度再更新 tests/README，默认测试仍离线，不顺带联网或构建整包。

最后追加第9节：实现文件、冻结合同、安全支持/拒绝范围、合成/真实计数、各失败/未覆盖、双桌面证据、只读磁盘比较、进程清理、构建身份与复跑入口。同步最小导航；用户确认、八题和旧 open 单独保留。

## 5. 分层验收条件与方法

创建时全部**待验收**。本轮文档结构/链接校验不属于产品运行验收。

| 层级 | 必要证据 | 创建时状态 |
| ---- | -------- | ---------- |
| 基线/语义 | 独立调用链、三位置、三组来源、双态/空 HEAD、首版支持与拒绝范围 | 待验收 |
| 合成协议 | NUL/rename/pathspec、路径与来源、stale/限额/失败/取消/背压；真实函数接线与反例 | 待验收 |
| 隔离 | 无 Agent 核心/主/摘要/title/审核调用，无工作区 grant/读取证据/批准/命令票据/raw/checkpoint污染 | 待验收 |
| 真实 Git/磁盘 | 固定临时仓库，双态/删除/rename/untracked/子目录/空仓库/linked worktree；前后工作树/index/配置/refs不变 | 待验收 |
| 配置/特殊类型 | 临时隔离配置/index/HEAD来源可审计，fsmonitor/filter/ext-diff/textconv/pager/懒抓取哨兵零执行；变化再恢复反例不执行驱动；特殊类型/partial clone/alternates/特殊index/超限清晰拒绝 | 待验收 |
| 生命周期 | 真实受控读取超时/取消/关闭/换库/页面销毁；旧结果无效，owned 进程退出；未确认清理不写通过 | 待验收 |
| 开发桌面 | 真实点击、内容/错误/焦点/设置/切会话/Agent忙碌/终端并列，传输合成单列 | 待验收 |
| Windows目录包 | 同等真实界面与 Git/资源路径验证，普通与调试观察分记 | 待验收 |
| 回归/构建 | 当前维护源、默认离线及受影响旧组、类型/定向质量/构建，实际加载制品身份 | 待验收 |
| 文档/掌握 | 新 UUID、失败保留、只读边界及限制；用户确认待补、八题待答；第56–60 open保持 | 待验收 |

必要主功能未通过时记失败/阻塞，不以“有测试报告”称完成；平台限制、未观察到的全句柄收口和安全拒绝范围逐项记录。合成进程/传输不能代替真实 Git/Electron/磁盘；截图不能代替基线与无副作用核对。对并发外部修改不承诺跨命令原子快照，也不承诺取消回滚外部已经发生的写入。

当前可用旧入口（本轮创建不运行）：`npm test`、`npm run test:lesson59:offline`、`npm run test:lesson59:startup`、`npm run test:lesson60:offline`。第61入口实施时实际建立，再公布命令；不把候选文件或命令写成已经可运行。

## 6. 八道自测题

以下八题均**待作答**，不附参考答案；助手验收不等于学习者掌握。

1. 同一文件为什么能同时出现在已暂存和未暂存组？两项 Diff 的基线分别是什么？
2. 空仓库无 HEAD 与新文件无 Git 基线分别如何处理？为什么不能用 `add -N` 帮助只读预览？
3. 为什么 Git 目录选择不能直接复用当前 `selectWorkspace` 或会话目录绑定？哪些临时身份应由 main 保存？
4. NUL 状态记录、rename 的第二路径、前导 `-` 与 pathspec 魔法字符各有哪些解析或参数风险？
5. `shell:false`、`--no-ext-diff`、`--no-textconv` 为什么仍不足以证明任意仓库读取不会启动配置程序？
6. 仓库根、选中子目录、gitdir/common-dir 和 linked worktree 的关系怎样影响可查看范围及删除项核验？
7. 快速切项、刷新、换库、关闭与窗口销毁时，如何同时防止迟到结果污染和真实读取进程泄漏？
8. 哪些证据能分别证明 Git 来源正确、没有写 index、没有 Agent/凭据/存储污染，以及目录包真实接线可用？

## 7. 学习记录与下一步

本轮仅创建课程与最小导航，创建 UUID：`e7116dd0-979b-4d9a-85e1-5c9c40255fe6`。[创建基线](../.ui-check/lesson61/creation-e7116dd0-979b-4d9a-85e1-5c9c40255fe6/baseline.json)保存 HEAD `872134874c7bdf6b69c1f192c91cc81c6cea457b`、820份源码/测试/资源/文档/制品与 node-pty 文件身份、22份用户文件身份、原未提交补丁和未跟踪维护源快照。[文档校验](../.ui-check/lesson61/creation-e7116dd0-979b-4d9a-85e1-5c9c40255fe6/document-results.json)与[保留核验](../.ui-check/lesson61/creation-e7116dd0-979b-4d9a-85e1-5c9c40255fe6/preservation-results.json)只记录文档创建，不认证第5节运行通过。

产品实施、用户实测确认与八题待进行。第56/58有条件通过，第57/59用户确认完成，第60必要自动验收完成但用户确认/八题待补；原 EPERM、真实多图/自然修错/联网 resume、原生句柄与任意后代等 open 按原课继续后置，不扩称当前全部通过。

下一步按本课第8节直接实施；完成后根据实际证据再决定后续课。暂存/提交/分支/历史 Git、MCP/Skills/SSH均不自动成为第62课，本轮不创建第62课。

## 8. 可复制到新对话的完整实施指令

以下仅供明确实施第61课时使用；**本轮创建不执行其中产品、测试仓库准备、构建或桌面验收动作。**

```text
开始完成第61课：Git 改动列表与 Diff 查看。
项目目录：D:\AiTools\ZoneCodex\ZoneCodex
先读取：
D:\AiTools\ZoneCodex\ZoneCodex\ZoneCodex学习计划\76-第六十一课-Git改动列表与Diff查看.md
严格按课程第8节与第4节（含§4A/§4B）实施，并按第5节完成分层验收。课程已创建，本次直接实施，不停留在只提计划。

按需读取编写约定、结构地图、学习进度、第58课第9节宿主边界、第59/60课实际合同、终端修复证据和tests/README.md，以及App、TitleBar/Sidebar、shared/api、preload/index、app-runtime、ipc-source、workspace-access、file-view-ipc、现有review/diff与change-preview。
先核对当前源码、制品、Git未提交改动与用户数据，新UUID保存基线。保留终端主题/启动修复、node-pty维护补丁、所有未提交改动、用户库、工作目录和旧证据。不提交或reset Git，不清空数据。

目标：独立人工只读Git改动列表与单项Diff/新文件预览。已暂存HEAD→index、未暂存index→worktree、新文件无Git基线分开；同文件双态、空HEAD、删除/rename、子目录与linked worktree按合同处理。当前提案buildDiff不是已有Git Diff。
硬边界：Git查看不进tool-loop，不启动Agent核心/主请求/摘要/标题/审核，不借PTY/命令票据/批准执行，不授Agent workspace grant/读取凭据，不写raw/checkpoint。Git选目录独立，不直接复用selectWorkspace或会话目录绑定。会话v9、设置v1、checkpoint v1、第56容量、三权限、第60状态和终端原五API/IPC保持，不复活票据。
只用main固定可信Git程序、固定argv、shell:false和受限读取；renderer不能指定命令/cwd/ref。按NUL协议、literal pathspec、范围/身份再核验及安全配置合同处理。原生status/diff必须在应用自有临时metadata/index/HEAD快照执行，不加载用户local/global/system配置/include链/外部驱动，内建语义只按白名单导入并标明属性/忽略来源支持子集；GIT_DIR/GIT_COMMON_DIR只能指向应用缓存、GIT_INDEX_FILE只能快照，不能复制用户commondir/.git指向/config/hooks或core.worktree，HEAD只用捕获OID/受控空ref。验证本地对象来源，固定不会重解析源info/alternates的有界对象入口，不无界复制对象库/工作树；拒绝不能禁lazy fetch的版本、缺对象、partial clone/原alternates/split或sparse index及不支持转换语义，不能靠一次检查后hash声称OS级文件隔离。关闭optional locks/fsmonitor/pager/ext-diff/textconv/递归子模块/懒抓取，清除继承Git重定向/注入，禁止转换器/网络/交互。预检+后hash无法防止配置程序已经执行，不能冒称永久安全；隔离不能成立则拒绝，不降级到原仓库worktree查询或终端。落实课程字节/行/项/并发/时间/临时元数据/对象入口限额及真实取消收口，owned进程close后才清应用自有缓存，失败/未确认清理留证。
不做产品暂存/提交/撤销/checkout/clean/init/fetch/push/分支/历史/冲突解决，不放宽safe.directory，不做MCP/Skills/SSH/远程壳/Agent控终端或喂输出给模型。测试材料只在新建隔离仓库准备，允许夹具init/add/commit，禁止对项目和用户仓库写Git。

§4A：新基线/旧行为锁与真实能力盘点；冻结仓库三位置、所选子树范围、双态/新文件/空HEAD/NUL语义；固定读取与配置程序拒绝合同、限额/取消；冻结打开/关闭/设置/切会话/Agent忙碌/终端并列及迟到隔离。
§4B：最小shared/main/preload/renderer与桌面入口接线；合成协议/故障/隔离护栏；真实临时Git仓库与磁盘前后无写入核对；开发+Windows目录包真实点击与内容、取消/清理；必要离线旧回归、类型/定向质量/双构建身份；追加第9节与最小导航。

验收：合成与真实Git/磁盘/Electron/PTY分别记，普通目录包与调试审计分记。新UUID，不继承旧报告通过；失败与平台未覆盖保留。必要主功能未通过不得称完成，多命令非原子快照、全部原生句柄未证明不改写。第56有条件通过、第57用户确认完成、第58有条件通过、第59用户确认完成，第60有条件通过且用户确认/八题待补；各课原open、用户确认与八题不得改写为全部通过。本课用户实测确认待补、八题均待答，不附答案。
```

第9节仅在实际实施时追加真实合同、结果与限制；本轮不预设完成或通过。
