# AGENTS.md — oc-taskbar 开发启动文档

本文件供 opencode 会话读取，是本项目的**单一事实源**：使命、已验证事实、技术路径、约束全在此。接手即读即开工，无需再问背景。

## 项目使命

为 opencode V2 的 TUI 开发**任务监视插件**：把当前在跑的 **subagent / 后台 shell / terminal** 数量与状态**常驻**显示在侧边栏（或状态栏徽标），替代「按 ↓ 展开三栏」的手动观测。解决「会话看起来结束了但后台还有任务在跑，不知道能不能关机」的判断难题（V1 底部 spinner 在 V2 后台任务化后失效）。

## 已验证事实（2026-10-22 调查，2026-10-23 实装载修正；来源：zread 知识库 + anomalyco/opencode 源码直读 + 本机实测）

以下均为查证过的结论，可直接作为设计依据，不要重新猜：

1. **仓库已迁移**：`sst/opencode` → `anomalyco/opencode`（默认分支 `dev`）。老文档里的路径以新仓库为准
2. **TUI 架构**：SolidJS + `@opentui` GPU 加速渲染，代码在 monorepo 的 `packages/tui`
3. **插件 API 现行形态**（旧 slots.tsx/runtime.tsx 已被重构掉）：`import { Plugin } from "@opencode/plugin/tui"`，`Plugin.define({ id, setup(context) })`；setup 里 `context.ui.slot({ append: "<path>", render: (props) => <C/> })`。参考样板 `packages/tui/src/feature-plugins/sidebar/mcp.tsx`
4. **插件入口规则**（实测）：TUI 入口 = 插件目录下的 `tui.ts(x)` 文件；`package.json` 的 main **完全不参与**；JSX 需 `jsx: "preserve"` + `jsxImportSource: "@opentui/solid"`（宿主 Bun 现场转译）
5. **装载机制**（实测，v2.1.x）：插件目录 = `<config>/plugins/*` 与 `<项目>/.opencode/plugins/*` 的子目录；CLI `opencode plugin add` 只收 npm/git 规格（`file:` 被拒），本地开发 = 直接把项目副本放进 plugins 目录（Windows 无符号链接权限时用 robocopy）；目录变更触发热重载（watch + reconcile）
6. **peer 依赖由宿主提供**：solid-js、@opentui/*、@opencode/theme、`@opencode/plugin` 全部映射到宿主副本，插件目录**不需要 node_modules**
7. **数据源现成**：`context.data.shell.list()`（只含在跑 shell，事件驱动维护）；子代理 = `data.session.list()` 里 parentID 非空且 `status(id)==="running"` 的会话；持久终端 = `context.client.experimental.persistentPty.list({sessionID})` + `persistent-pty.added/removed` 事件（需 `server.info().capabilities?.persistentPty !== false` 探测）——不需要新造数据层
8. **侧边栏挂载点**：`routes/session/sidebar.tsx` 里 `<Slot path="sidebar.content" input={{sessionID}}>`；内置顺序 Context→MCP→Todo→Footer，外部插件 append 在后
9. **渲染事实**（实测）：claim→resolve→render 全链路对自定义插件生效（prompt.footer 实证 render 被调用）；但**窄终端/无 tty 时 OpenTUI 不挂载 sidebar**，sidebar.content 的 claim 被 suppress——无头探针验证渲染必须换必挂载槽位或用真实终端
10. **架构分权**：TUI 只是客户端（`opencode attach <url>` 可重连运行中的服务器）；后台任务挂在服务进程下，关 TUI 不死——本插件观测的就是服务端状态

## 技术进度（v0.1 原型，四步）

1. **摸 API** ✅：现行插件 API、SlotClaim、Context、数据源、装载机制全部查证并固化到 `docs/api-notes.md`（含网络通道教训：webfetch+jsDelivr/blob API 可靠，本机 PowerShell 直连 GitHub 不通）
2. **最小渲染** ✅：`tui.tsx` claim `sidebar.content`，setup 实测零报错；渲染链路经 `prompt.footer` 对照实验实证打通（见事实 9）
3. **接数据** ✅ 代码 / ⏳ 验收：shell（data.shell.list）、subagent（session.list+status）、terminal（persistentPty.list+事件）三通道已实现，零任务时 dim 显示；待用户真实 TUI 肉眼验收「开后台任务→计数变化」（v0.1 验收线）
4. **打磨**（v1.0）：任务明细列表、完成后短暂保留、零任务淡显、`attention.notify` 完成通知、`prompt.footer` 紧凑徽标（sidebar 关闭时兜底）

## 约束

- **公开仓库潜质**：不得写入任何密钥、账号、私人信息（本仓预期开源）
- TypeScript + TSX；风格贴近上游（Effect-TS 生态、SolidJS 组件模式）
- 原型阶段**不做 npm 发布**，本地路径装载即可；发布决策留给用户
- 上游 opencode 迭代快，API 以实测为准：本文档的事实清单若与最新源码冲突，以源码为准并回写本文件
- **部署归主手册仓管**：v0.1 可用后，在 `~/.config/ai-dev-setup`（私有主手册仓库）加部署步骤并关闭其待办 9；本仓只管插件本体

## 开发工作流

- 环境：opencode v2.1.x（CLI 用 `opencode.cmd`，PowerShell 会拦截 .ps1）；插件**不需要** npm i / node_modules（peer 依赖由宿主提供）
- 装载：`robocopy D:\Coding\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git`，TUI 热重载；无头探针：`Start-Process opencode.cmd --print-logs [-c]` 重定向日志 + 12s 杀进程（注意 dump 文本是会话内容回显 + 增量渲染拆 cell，**不可 grep 验证渲染**，用 OC_TASKBAR_PROBE 或真实终端）
- 验证循环：改 tui.tsx → robocopy 同步 → 真实 TUI 看侧边栏 → 开个后台任务看计数变化
- 提交：conventional commits（`feat(slot): ...`、`docs: ...`）；本地仓暂无远程，用户建 GitHub 仓后再推

## 参考

- 插件系统：https://zread.ai/sst/opencode/12-plugin-system
- TUI 架构：https://zread.ai/sst/opencode/17-terminal-ui-tui
- CLI 命令（plugin/service/attach）：https://zread.ai/sst/opencode/3-cli-commands
- 主手册仓：`~/.config/ai-dev-setup`（本项目的立项背景记录在其 docs/PROGRESS.md 待办 9）
