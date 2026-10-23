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
- [ ] 用户验收：真实 TUI 确认「开任务→切 tab→计数与残影不丢」+ 完成通知声音 + emoji 显示无占位/错位（个别终端可能把 emoji 渲染成黑白）

## 使用

侧边栏 **📋 后台任务** 区块：每条任务显示为「emoji + 一句人话」——在跑 shell 按命令模式归类（`🧪 运行测试`、`🔨 构建项目`、`📦 安装依赖`、`📂 复制 · <文件名>`、`📖 查看变更`……不认识的命令显示 `💻 运行 <命令>`），子代理显示其任务描述并配语义图标（🔍 探索 / 🔧 修复 / ✍️ 实现 / 🧐 审查……），终端显示 `🖥️ 终端`。任务完成后变 `✅ … · 完成了` 残影保留 60 秒。**点击任意行可展开原始命令 / 完整标题**（懂行的人不损失信息）。切 tab 状态不丢（跟踪在模块级 store，组件只是视图）。

显示语种自动跟随当前会话（从 root session 标题做 CJK 检测——标题由宿主根据你的首条消息生成，语种跟随你的输入）；要强制固定，设 `OC_TASKBAR_LANG=zh` 或 `=en`（设其他值视为未设置，回落自动检测）。已知局限：会话中途换语言不跟随（标题由首条消息定），换 tab 到别的会话会切；日语纯汉字标题会误判为中文（无假名可辨时无法区分）。

sidebar 关闭时 composer 底部显示一行兜底徽标（有在跑任务 `🏃 2 个任务（1 个完成）`；仅剩残影时 `✅ 1 个刚完成`）。任务完成时弹通知 + 声音（想关掉：改 `tui.tsx` 里 `storage.store("notify", …)` 的值，或让 agent 帮你加开关）。

## 安装

上游 CLI 已无 `opencode plugin <path>` 本地装载命令（`add` 只收 npm/git 规格）。本地开发装载方式：

```powershell
# 插件目录 = <config>/plugins/ 下的子目录；Windows 用 robocopy 做真实副本
robocopy D:\Coding\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git
# 然后启动 opencode TUI；改代码后重新 robocopy，TUI 会热重载（watch + reconcile）
```

诊断开关：设 `OC_TASKBAR_PROBE=<文件路径>` 后，插件在徽标挂载与计数变化时向该文件追加一行（默认零 IO）。注意：无 tty 的重定向终端宽度不足时 OpenTUI 不挂载侧边栏，徽标自然不渲染——需在真实终端里验收。

## 开发

启动文档见 [AGENTS.md](AGENTS.md)（已验证事实、技术路径、约束、参考链接全在内）。在项目根开 opencode 会话即可接续。

## License

MIT
