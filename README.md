# oc-taskbar

OpenCode V2 TUI 的**任务监视插件**：把在跑的 subagent / 后台 shell / terminal 状态常驻显示在侧边栏（或状态栏徽标），替代「按 ↓ 展开三栏」的手动观测。

## 解决什么问题

V1 时代底部 spinner 转 = 有任务在跑，停 = 全部结束，看一眼就知道能不能关机。V2 引入真后台任务（后台 shell、子代理）后，「界面静止 ≠ 无事发生」，观测责任从 UI 转移到了「问 agent / 按方向键翻面板」——本插件把它变回**一眼可见**。

## 状态

- [x] 调研（2026-10-22）：TUI 插件槽位系统、内置 feature-plugins 机制、任务面板数据源均已确认存在
- [x] v0.1 原型（2026-10-23）：`tui.tsx` 挂 `sidebar.content`，实时显示在跑 shell / subagent / 终端计数（详见 [docs/api-notes.md](docs/api-notes.md)）
- [x] v1.0（2026-10-23）：计数恒零双根因修复（数据层懒加载需初始 sync；onMount 永不触发）+ 任务明细（点击展开）+ 完成保留 60s + 完成通知（默认开，storage 可关）+ `prompt.footer` 兜底一行徽标；无头探针实证 `total=2 shells=2`
- [x] v1.0.1（2026-10-23）：修复切 tab 后侧边栏重置为 none（Slot input 变化会销毁重建组件，状态提升为模块级单例 store）+ 对抗审查加固 9 项（数据抖动 sticky last-good 防假完成、窄终端下 subagent 兜底同步、事件订阅防泄漏等）
- [x] v1.1.0（2026-10-23）：任务描述人类可读化（命令模式表 + 语义 emoji，如 `🧪 运行测试`、`📂 复制 · oc-taskbar`；原始命令点击行展开仍可见）；显示语种自动跟随当前会话（root session 标题 CJK 检测，`OC_TASKBAR_LANG=zh|en` 可强制）；footer 兜底徽标同款 emoji 风格
- [x] v1.1.1（2026-10-23）：修复在跑行点击无反应（列表事件高频重建行组件导致点击状态被重置，缓存改比较后更新保引用稳定）；点击事件对齐上游 `onMouseDown`；兜底标签过滤（其他会话的 PowerShell 片段如 `[Console]::` 显示为 `💻 后台命令`）
- [x] v1.1.2（2026-10-26）：修复「侧边栏偶发不显示在跑 shell 而内置任务面板显示」——根因是 SSE 断连丢事件且宿主重连不重拉 shell 列表（源码实锤，详见 AGENTS.md 事实 15）；现于重连时自动重同步全部数据源 + 60s 兜底轮询，断连期间退出任务的幽灵行一并治愈
- [ ] 用户终验（建议重启 TUI 后）：`💻 后台命令` 兜底标签生效 + 回归「开任务→切 tab→计数与残影不丢」。已验收 ✓：emoji 显示、中文语种跟随、完成打勾残影、通知声音、跨 tab 任务显示、在跑行点击展开
- [x] 部署收尾（2026-10-23）：ai-dev-setup 步骤 8（clone + robocopy）已写入、其待办 9 已关闭
- [x] v1.2.0（2026-10-26）：第 4 通道「根会话忙碌」——根会话在跑（含前台工具/MCP 挂起，此前任务栏恒零的盲区）侧栏显示 `💬 + 会话标题`；当前 tab dim 显示、完成不打扰（无通知无残影），其他 tab 完整待遇；footer 徽标只计后台工作。低优先级候选：emoji 降级开关（`OC_TASKBAR_EMOJI=off`）、纯函数单测、日语纯汉字误判

## 使用

侧边栏 **📋 后台任务** 区块：每条任务显示为「emoji + 一句人话」——在跑 shell 按命令模式归类（`🧪 运行测试`、`🔨 构建项目`、`📦 安装依赖`、`📂 复制 · <文件名>`、`📖 查看变更`……不认识的命令显示 `💻 运行 <命令>`，命令名不可读时（如其他会话的 PowerShell 片段）显示 `💻 后台命令`），子代理显示其任务描述并配语义图标（🔍 探索 / 🔧 修复 / ✍️ 实现 / 🧐 审查……），终端显示 `🖥️ 终端`，根会话（主对话本身）在跑时显示 `💬 + 会话标题`——**当前 tab 的行淡显、完成时不通知不留残影**（你正看着它回答），其他 tab 的行与其他任务同待遇（侧栏计数含淡显行；footer 徽标不计——那是前台工作）。任务完成后变 `✅ … · 完成了` 残影保留 60 秒。**点击任意行可展开原始命令 / 完整标题**（懂行的人不损失信息）。切 tab 状态不丢（跟踪在模块级 store，组件只是视图）。

显示语种自动跟随当前会话（从 root session 标题做 CJK 检测——标题由宿主根据你的首条消息生成，语种跟随你的输入）；要强制固定，设 `OC_TASKBAR_LANG=zh` 或 `=en`（设其他值视为未设置，回落自动检测）。已知局限：会话中途换语言不跟随（标题由首条消息定），换 tab 到别的会话会切；日语纯汉字标题会误判为中文（无假名可辨时无法区分）。

sidebar 关闭时 composer 底部显示一行兜底徽标（有在跑任务 `🏃 2 个任务（1 个完成）`；仅剩残影时 `✅ 1 个刚完成`）。任务完成时弹通知 + 声音（想关掉：改 `tui.tsx` 里 `storage.store("notify", …)` 的值，或让 agent 帮你加开关；💬 通道因根会话每轮问答都会完成、天然更吵，单独开关是 `storage.store("notifyRoot", …)`，默认同样开）。徽标只计后台工作——当前 tab 自己的 💬 行不算（那是你正盯着的前台）。

## 安装

上游 CLI 已无 `opencode plugin <path>` 本地装载命令（`add` 只收 npm/git 规格）。本地开发装载方式：

```powershell
# 插件目录 = <config>/plugins/ 下的子目录；Windows 用 robocopy 做真实副本
robocopy D:\Coding\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git
# 然后启动 opencode TUI；改代码后重新 robocopy，TUI 会热重载（watch + reconcile）
```

其他电脑（或本机无克隆时）：`git clone https://github.com/ntexplorer/oc-taskbar.git D:\Coding\oc-taskbar` 后执行上面同一条 robocopy；已纳入 ai-dev-setup 部署手册步骤 8（默认项），用该仓配环境的机器照做即可。

诊断开关：设 `OC_TASKBAR_PROBE=<文件路径>` 后，插件在徽标挂载与计数变化时向该文件追加一行（默认零 IO）。断连自愈 30 秒自检：开个后台任务 → 断网/合盖几秒再恢复 → probe 里应出现 `resync all (server.connected)` 行、侧栏自动补上该任务（没有这行=重连主路径未生效，只剩 60s 兜底轮询，请报 issue）。注意：无 tty 的重定向终端宽度不足时 OpenTUI 不挂载侧边栏，徽标自然不渲染——需在真实终端里验收。

## 开发

启动文档见 [AGENTS.md](AGENTS.md)（已验证事实、技术路径、约束、参考链接全在内）。在项目根开 opencode 会话即可接续。

## License

MIT
