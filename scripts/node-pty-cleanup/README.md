# node-pty 1.1.0 Windows 清理补丁

本目录固定修补已安装的 `node-pty@1.1.0`，不升级依赖，不替换原生 `.node` 模块，继续使用 Windows 系统 ConPTY（默认 `useConptyDll: false`）。产品代码只调用公开 PTY API；内部资源协调留在依赖补丁内。

原版 `kill()` 异步启动 console-list helper 后立即关闭 ConPTY，helper 随后 `AttachConsole` 可失败；`WindowsTerminal.kill()` 还会等首个输出才执行，安静或尚未就绪的 shell 可能无法关闭。自然退出仅关闭输出 socket，没有明确结束持有 pipe server 的 Conout worker。

补丁等待 helper 的 `close` 确认，过滤 helper 与父进程 PID，去重后立即结束快照中的附着后代，再发起原生关闭，最后仅对仍活着且尚未收到 native exit 的根 shell 进行 force-kill 兜底。根 shell 不会在原生关闭前被显式结束，避免 native exit 线程提前删除 baton 使原生关闭退化为 no-op。helper 的异常是有界结构化 IPC 数据；只有已证实 shell 死亡时的 `AttachConsole failed` 竞态可以消费，其他失败及非空 stderr 均留下有界诊断。helper 尚未确认结束时保留其所有权，允许后续关闭重试。

显式关闭不等首个输出。自然退出和显式关闭均等待输入/输出 socket 的 `close` 及 worker 的实际 `exit` 后，才向公开 `onExit` 通知完成；输出 EOF 自身不代表 shell 退出。重复关闭共享同一轮操作，已确认的原生关闭不会重复执行；未确认的抛错允许重试。正常边界为 helper 5 秒、helper 终止确认 1 秒、输出最多保留 2 秒、资源确认 1.5 秒、整轮 9.8 秒。资源退役失败保留失败状态和可重试语义，不能伪报成功。自然退出时仍发起一次原生关闭；上游 native exit 回调可能已经删除 baton，因此该调用也可能是上游 no-op，不宣称修补了原生层已删除的 HPCON。

Conout worker 和 console-list helper 创建时均显式设置 `execArgv: []`，不继承桌面宿主的 `--inspect` / `--inspect-brk`。Electron 的底层调试参数可能在 `process.execArgv` 表面为空时继续继承，因此不能只过滤该数组；否则 worker 等待调试器会阻止终端启动，helper 等待调试器会阻止清理。

`manifest.json` 锁定原版和当前补丁版每个完整文件的 SHA-256；仅两份调试参数修复资源登记一个精确的 `previousPatchedSha256`，允许已知旧完整补丁迁移。`upstream/*.js.txt` 保存 npm 发布的四份原版字节，`previous/*.js.txt` 保存这两份已知旧补丁字节，仅作离线基线、迁移测试与维护比对。运行来源始终是当前 `.cjs` 资源，不从旧证据目录加载；`.gitattributes` 将两类基线和 `.cjs` 补丁资源固定为 LF，避免 Windows checkout 改写哈希。许可正文保留在 `LICENSE`。

运行 `npm run prepare:node-pty-cleanup`：先预检版本、五份目标及当前补丁资源的完整哈希，只有原版、精确已知 previous 补丁、当前补丁可以通过；任一未知字节或版本拒绝整轮写入。全部预检通过后，原版与已知旧补丁转为当前补丁，当前补丁保持幂等；中断造成的这些已知混合状态可以继续完成。`node scripts/prepare-node-pty-cleanup.mjs --check` 只检查合法状态，不修改目标，也不表示所有目标已经应用当前补丁。`postinstall` 在原生依赖重建后执行 preparation，`predev`、`prestart`、`prebuild` 再执行同一 preparation。

维护时不得只改已安装依赖。先保存原始证据，修改本目录资源或 `patch-stock.mjs`，重新计算 manifest 完整 SHA，运行 `node tests/lesson59/node-pty-cleanup-check.mjs` 的合成故障时序、显式调试参数隔离和严格三态迁移检查，然后实际 preparation、重新构建并分别验证开发和 Windows 目录包。合成检查不替代真实桌面退出检查，不证明上游 HPCON / 原生 handles 已释放，也不替代第 56–58 课的后置 open 项。
