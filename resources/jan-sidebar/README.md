# Jan 侧边栏来源说明

ZoneCodex 的侧边栏布局、视觉尺寸和交互参考 [Jan](https://github.com/janhq/jan) 的开源实现，并与 ZoneCodex 现有功能连接。该移植覆盖侧边栏，不包含 Jan 的模型服务、项目数据结构或其他产品功能。

## 上游版本与许可

- 仓库：<https://github.com/janhq/jan>
- 参考提交：`d364ac199e5579da1496dd00a452b418f0636ddc`（2026-10-12 获取的 `main`）
- Jan 版权所有：Copyright 2025 Menlo Research
- Jan 许可：Apache License, Version 2.0。原仓库 `LICENSE` 的完整原始字节保存在 [LICENSE-Jan](./LICENSE-Jan)，Apache 官方完整许可文本保存在 [Apache-2.0.txt](./Apache-2.0.txt)。
- 本产品包含 Menlo Research（<https://menlo.ai>）开发的软件的侧边栏设计及实现参考。

主要参考文件（链接固定到上述提交）：

- [web-app/src/components/left-sidebar/index.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/left-sidebar/index.tsx)：侧边栏组成与滚动区域。
- [web-app/src/components/left-sidebar/NavMain.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/left-sidebar/NavMain.tsx)：顶部导航、图标与快捷键提示。
- [web-app/src/components/left-sidebar/NavProjects.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/left-sidebar/NavProjects.tsx) 和 [NavChats.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/left-sidebar/NavChats.tsx)：项目与会话分组。
- [web-app/src/components/ui/sidebar.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/ui/sidebar.tsx)：浮动容器、行高、边距、选中状态、悬停菜单与收起/拖动逻辑。
- [web-app/src/containers/ThreadList.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/containers/ThreadList.tsx)：会话列表与行菜单。
- [web-app/src/containers/dialogs/SearchDialog.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/containers/dialogs/SearchDialog.tsx)：会话搜索弹窗。
- [web-app/src/hooks/useInterfaceSettings.ts](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/hooks/useInterfaceSettings.ts)、[providers/InterfaceProvider.tsx](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/providers/InterfaceProvider.tsx) 与 [index.css](https://github.com/janhq/jan/blob/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/index.css)：运行时灰色主题、字体尺寸和基础颜色。
- [web-app/src/components/animated-icon/](https://github.com/janhq/jan/tree/d364ac199e5579da1496dd00a452b418f0636ddc/web-app/src/components/animated-icon)：导航图标形状与悬停动画参考。

## 字体

Inter Regular（400）与 Medium（500）来自 Jan 同一提交：

- `web-app/public/fonts/inter/Inter_18pt-Regular.ttf` → `src/renderer/src/assets/fonts/Inter_18pt-Regular.ttf`
- `web-app/public/fonts/inter/Inter_18pt-Medium.ttf` → `src/renderer/src/assets/fonts/Inter_18pt-Medium.ttf`

上述字体文件未经修改。Jan 中此字体目录提供静态字体，因此使用与 Jan 相同的两个字重。

Inter 版权所有：Copyright (c) 2016 The Inter Project Authors (<https://github.com/rsms/inter>)。字体采用 SIL Open Font License, Version 1.1，完整许可保存在 [Inter-OFL.txt](./Inter-OFL.txt)。该许可从 Inter 官方仓库提交 [`353b61b9f4430d5f420d56605a6e7993e0941470`](https://github.com/rsms/inter/blob/353b61b9f4430d5f420d56605a6e7993e0941470/LICENSE.txt) 获取。

## ZoneCodex 功能映射

| 侧栏入口或区域 | 连接的现有功能                                                                        |
| -------------- | ------------------------------------------------------------------------------------- |
| 新建会话       | ZoneCodex 原有会话创建流程。                                                          |
| 选择工作区     | 为当前会话选择工作区；尚无会话时禁用。此行位于 Jan「新建项目」的位置。                |
| 搜索           | 原有标题和消息搜索，呈现为侧栏搜索弹窗。                                              |
| 终端           | 原有终端显示/隐藏入口；位于 Jan「Hub」的位置。                                        |
| 设置           | 原有设置页面。                                                                        |
| 项目区域       | 根据会话已有工作区元数据分组，可展开并切换关联会话；沿用 ZoneCodex 会话与工作区数据。 |
| 置顶与会话区域 | 原有置顶、切换、重命名、归档及会话操作；通过分组三点菜单切换已归档视图。              |
| 底部个人空间   | 保留 ZoneCodex 原有个人空间菜单，以紧凑布局呈现。                                     |

Jan 当前参考版本将设置放在顶部导航中。ZoneCodex 底部的个人空间菜单、置顶分组与归档视图是结合现有功能保留的入口。
