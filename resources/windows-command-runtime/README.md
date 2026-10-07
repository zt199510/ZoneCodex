# Windows 命令运行资源

本目录保存 ZoneCodex 的原生进程监督器与 Codex **0.160.1** 的 Windows 沙箱运行程序。它们只执行本项目已经形成执行计划的命令，不启动第二个 Agent，也不向模型发送请求。

## 构建

在 Windows 上执行：

```powershell
npm run build:windows-runtime
```

`npm run dev`、`npm run start` 和 `npm run build` 会先运行相同检查。构建优先复用已生成且哈希完整的运行资源，然后查找本机 Codex App 或 npm 安装目录中的固定版本；不会下载、安装程序或初始化系统沙箱。

也可以指定包含以下三个官方程序的绝对目录：

```powershell
$env:CODEX_WINDOWS_RUNTIME_DIR = 'C:\path\to\codex-runtime'
npm run build:windows-runtime
```

- `codex.exe`
- `codex-command-runner.exe`
- `codex-windows-sandbox-setup.exe`

明确指定的目录缺失、不完整或版本不符会使构建失败，不会改用其他安装。未指定目录且本机没有完整的 0.160.1 运行资源时也会明确失败。非 Windows 平台输出跳过说明。

首次构建监督器需要 Visual Studio 的 C++ 桌面开发工具与 Windows 10/11 SDK。脚本动态发现工具路径，使用 C++17 和静态运行库；源码或构建脚本改变后重新编译 `host.exe`。完整资源未改变时无需再次编译。

## 生成与打包

生成的 `host.exe`、上述三个官方程序、`host.obj` 和 `manifest.json` 均不提交 Git。manifest 使用协议1，记录 CLI 版本、四个程序的 SHA-256，以及用于构建缓存的 `hostSourceHash`。应用在准备和启动命令时复核程序完整性。

Windows 安装包通过 `extraResources` 将四个程序、manifest、许可证和声明放在 `resources/windows-command-runtime/`，位于 `app.asar` 外。编译对象、开发脚本、课程文档及重复的运行资源不进入安装包。

`afterPack` 校验复制完成的资源、监督器协议、固定 CLI 版本与许可文件，并原子更新安装包内的 manifest。`afterSign` 再次记录签名完成后的程序哈希，避免 PE 签名元数据改变后与构建时的哈希不符。禁用签名的构建仍执行 `afterPack`。这些钩子作为模块导入时不会触发本地资源构建或系统初始化。

沙箱运行使用用户已有的 Codex Windows elevated 初始化状态。资源构建和打包不会创建账户、修改 ACL 或防火墙；运行资源完整与系统沙箱已就绪分别核对。不可用时不宣称具有沙箱能力。

## 上游来源与许可

官方程序的代码不作修改；安装包签名可以改变 PE 签名元数据，manifest 记录最终分发文件的字节。上游源码为 [openai/codex 的 rust-v0.160.1](https://github.com/openai/codex/tree/rust-v0.160.1)。[LICENSE](LICENSE) 保留该版本的 Apache 2.0 原文；[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 保留该版本的 NOTICE，并附带其中注明的 Ratatui MIT 许可文本。ZoneCodex 的监督器是本项目独立实现。
