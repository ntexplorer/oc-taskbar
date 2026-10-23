# oc-taskbar

OpenCode V2 TUI 的**任务监视插件**：把在跑的 subagent / 后台 shell / terminal 状态常驻显示在侧边栏（或状态栏徽标），替代「按 ↓ 展开三栏」的手动观测。

## 解决什么问题

V1 时代底部 spinner 转 = 有任务在跑，停 = 全部结束，看一眼就知道能不能关机。V2 引入真后台任务（后台 shell、子代理）后，「界面静止 ≠ 无事发生」，观测责任从 UI 转移到了「问 agent / 按方向键翻面板」——本插件把它变回**一眼可见**。

## 状态

- [x] 调研（2026-10-22）：TUI 插件槽位系统、内置 feature-plugins 机制、任务面板数据源均已确认存在
- [x] v0.1 原型（2026-10-23）：`tui.tsx` 挂 `sidebar.content`，实时显示在跑 shell / subagent / 终端计数（详见 [docs/api-notes.md](docs/api-notes.md)）
- [ ] v0.1 用户验收：真实 TUI 侧边栏肉眼确认徽标 + 后台任务计数变化
- [ ] v1.0：完整状态列表 + 完成通知

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
