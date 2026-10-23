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
10. **OpenTUI 生命周期陷阱**（实测，v1.0 头号 bug 源）：**onMount 对 slotted 插件组件永不触发**——初始化代码必须放组件体/setup 内联；且数据层 store 懒加载（shell/session 列表初始为空，事件只在 sync 后进来）——**挂载时必须 `data.shell.sync()` + `data.session.sync(root,{children:true})`，否则徽标恒零**
11. **架构分权**：TUI 只是客户端（`opencode attach <url>` 可重连运行中的服务器）；后台任务挂在服务进程下，关 TUI 不死——本插件观测的就是服务端状态
12. **Slot 组件随 input 变化整体重建**（2026-10-23 实测，v1.0 头号 bug）：切换 tab → sidebar Slot 的 input（sessionID）变化 → render 重新调用 → **组件实例被销毁重建**，实例内一切本地 state（signal、缓存、onCleanup 挂的事件订阅）随之丢失；而 prompt.footer 的 Slot 无 input，切 tab 不重建——曾致「sidebar 切 tab 后重置为 none、footer 却保留 (+N done)」。对策：任务跟踪全部放模块级 `createRoot` 单例 store（setup 时创建），组件退化为纯视图。已知开发期干扰：热重载重载模块会建第二个 store，旧 root 不 dispose——重启 TUI 前可能 probe 双行/通知双响
13. **数据读取必须 sticky last-good**（对抗审查发现）：`data.shell.list()`/`session.list()` 瞬时抛错若 catch 成 `[]`，与「任务全部退出」不可区分 → 假完成风暴（误响通知+假残影 60s）。所有读取失败一律返回上次好值；`persistentPty.list` 失败保持旧列表不清空（误报完成比漏报危险——「能不能关机」判断场景）
14. **内置 Todo 侧边栏与插件不冲突、语义互补**（2026-10-23 调研）：v2 有 `packages/tui/src/feature-plugins/sidebar/todo.tsx`，显示会话中**最近一次完成的 `todowrite` 工具调用**内容（`util/todo.ts` 的 `sessionTodos` findLast 解析，四态 `[ ] [•] [✓] [-]`，>2 项可 `onMouseDown` 折叠）。更新完全依赖模型自觉调工具——「执行中忘记勾完成」的 v1 痛点 v2 依旧。与 oc-taskbar：数据源不同（message 流 vs shell/session/pty 客观状态）、挂载不冲突（内置在 Slot 内部上方、插件 append 下方）、语义互补（todo=计划/主观可过期，taskbar=执行/客观实时）——插件恰好是 todo 不可信的解药

## 技术进度（v0.1 原型，四步）

1. **摸 API** ✅：现行插件 API、SlotClaim、Context、数据源、装载机制全部查证并固化到 `docs/api-notes.md`（含网络通道教训：webfetch+jsDelivr/blob API 可靠，本机 PowerShell 直连 GitHub 不通）
2. **最小渲染** ✅：`tui.tsx` claim `sidebar.content`，setup 实测零报错；渲染链路经 `prompt.footer` 对照实验实证打通（见事实 9）
3. **接数据** ✅ 代码 / ⏳ 验收：shell（data.shell.list）、subagent（session.list+status）、terminal（persistentPty.list+事件）三通道已实现，零任务时 dim 显示；实测「开任务→计数出现、任务完成→footer 保留 (+N done)」数据链已通（2026-10-23）；切 tab 重置 bug 已修（事实 12，store 单例化），待用户回归验收「开任务→切 tab→侧边栏计数与残影不丢」
4. **打磨** ✅ 代码 / ⏳ 验收（v1.0.1，2026-10-23 下午）：任务明细列表（点击展开）、完成保留 60s、零任务淡显、`attention.notify` 完成通知（storage 可关）、`prompt.footer` 紧凑徽标（sidebar 关闭时兜底）均已实现；v1.0.1 修复切 tab 状态重置（事实 12）+ 对抗审查加固（事实 13 等共 9 项，含 sticky last-good、data.on 防护、窄终端 subagent 兜底 hydrate、For 引用稳定）。待用户真实 TUI 回归验收（含通知声音是否真响，probe 有成败记录）
5. **可读化** ✅ 代码 / ⏳ 验收（v1.1.0，2026-10-23）：任务显示「emoji + 人类语言」替代原始命令碎片——shell 走启发式命令模式表（剥 powershell/cmd/sh 包装→拆 `&&`→分类：测试🧪/构建🔨/安装📦/commit💾/push-pull🔄/检索🔍/复制移动📂（带目标 basename 点缀）/网络🌐/兜底 `💻 运行 <命令>`），不调 LLM（`client.prompt.create` 会真开会话耗 token，任务栏不适用）；子代理 title 本就是自然语言，仅清理 + 关键词配 emoji；**语种自适应**：root session 标题（宿主据用户首条消息生成）做 CJK 检测选 zh/en 文案包，kana/hangul 回退 en（暂无对应包），`OC_TASKBAR_LANG=zh|en` 强制，检测 sticky last-good。已知局限：中途换语言不跟随（标题由首条消息定）、emoji 宽度个别终端可能错位（验收点）。原始命令/完整 title 保留在 detail（点击展开）；labelCache/`stable()` 比较字段升级为 kind+icon+label，语言切换时 tracking effect 因读取 pack() 会重跑（只刷新缓存标签，不产生假完成）；对抗审查后追加修复 4 项（同日）：分类器改逐段迭代直到命中（`cd X && npm test` 不再显示「运行 cd」）、新增 📖 查看变更类（git status/log/diff/show/blame、cat/type/head/tail）、footer-only 语种修复（prompt.footer 槽也 track 其 sessionID + fallbackHydrate 用根会话标题多数投票播种 fallbackLang）、行截断按码点切（防 agent 标题含 emoji 时代理对被切半出乱码）。已知未修：日语纯汉字误判 zh、emoji 无降级开关、纯函数无单测（均低优先级，v1.2 候选）；**v1.1.1**（同日晚，用户实测驱动）：①在跑行点击无反应——根因是 tracking effect 每次输出事件无条件 `labelCache.set` 新对象，For（引用 keyed）随即重建行、expanded 被重置；改为经 `stable()` 比较后再缓存（stable 提升为 hoisted function，effect 首跑即可用）。②点击事件改 `onMouseDown`（对齐上游 todo.tsx；`onclick` 不是 OpenTUI 属性，静默无效）。③兜底标签过滤：exe 名不像命令（`$probeLog`、`[Console]::` 等其他会话的 PowerShell 片段）时显示 `💻 后台命令`。实测教训：**热重载残留会让 TUI 显示异常（如 shell 行凭空消失），重启 TUI 即愈**——用户报 bug 前先确认是否重启过 TUI；宿主不包装 shell 命令原文（无头探针 `JSON.stringify(command)` 实证），「运行 Remove-Item/[Console]::」实为其他 tab 会话的真实任务（`shell.list()` location-wide 设计使然，与内置任务面板口径一致）。用户已验收：emoji/中文文案/完成打勾/通知/跨 tab 任务/在跑行点击展开 ✓
6. **v1.2 提案：第 4 通道「根会话忙碌」（2026-10-23 立项，待开发）**：现有三通道观测不到根会话自身在跑——前台工具/MCP 调用挂起时任务栏恒零（用户 2026-10-23 实测：主会话 zread 卡死数分钟，任务栏始终「暂无任务」）。数据源：`data.session.list()` 中 parentID 为空且 `status(id)==="running"` 的根会话，默认排除当前 tab（slot input 的 sessionID；是否改为含当前会话 dim 显示，开发时定——「能不能关机」理论上需要完整性，但当前会话有 TUI spinner 可见）。显示：💬 + 会话 title（title 本就是自然语言，复用 labelCache/stable）；busy 语义对齐上游 session-tabs.tsx（running || pending 非 synthetic，首版保守只取 running）。与 tab 栏自带 busy 指示的冗余是有意为之（tab 指示太不显眼；且根会话在服务端跑，service stop/关机会杀——正是本插件使命）。工程约束沿用事实 10/12/13（挂载 sync、store 单例、sticky last-good）。验收：①任一**其他** tab 的主会话发起长任务（含挂起的 MCP 调用）→ 任务栏出现该会话行（当前 tab 默认排除，见上）②切 tab 计数保留 ③完成 ✓ 残影 60s ④「不重复计数」指同一工作单位只计一次——pty 终端与根会话属不同工作单位，💬 行与终端行并存不算重复。**开发前置实验**：实测 MCP 挂起时当前 tab 的 TUI spinner 是否持续显示（v1 教训：spinner 会失效），据此定夺「当前会话 dim 显示」还是维持排除。边界：根会话 title 未生成时（新会话首任务在跑）用兜底标签（参照 v1.1 fallbackLang 兜底思路）

## 约束

- **公开仓库潜质**：不得写入任何密钥、账号、私人信息（本仓预期开源）
- TypeScript + TSX；风格贴近上游（Effect-TS 生态、SolidJS 组件模式）
- 原型阶段**不做 npm 发布**，本地路径装载即可；发布决策留给用户
- 上游 opencode 迭代快，API 以实测为准：本文档的事实清单若与最新源码冲突，以源码为准并回写本文件
- **部署归主手册仓管**：v0.1 可用后，在 `~/.config/ai-dev-setup`（私有主手册仓库）加部署步骤并关闭其待办 9；本仓只管插件本体

## 开发工作流

- **接续指引**：新会话先读本文件 → 看「技术进度」第 3/4/5 条验收状态（当前：v1.1.1 已同步到插件目录 `~/.config/opencode/plugins/oc-taskbar`；已验收 emoji/中文语种/完成残影/通知/跨 tab 任务/在跑行点击展开；**待终验**：`💻 后台命令` 兜底标签生效、以及 v1.0.1 遗留回归项「开任务→切 tab→计数与残影不丢」，终验建议重启 TUI 后进行以避开热重载残留）→ 验收通过后做部署（约束节：主手册仓 ai-dev-setup 加部署步骤、关闭其待办 9）。**下一开发项：第 6 条 v1.2 第 4 通道「根会话忙碌」（已立项，数据源/显示/验收标准见该条）**。本仓改动提交后须重新 robocopy 才会生效
- 环境：opencode v2.1.x（CLI 用 `opencode.cmd`，PowerShell 会拦截 .ps1）；插件**不需要** npm i / node_modules（peer 依赖由宿主提供）
- 装载：`robocopy D:\Coding\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git`，TUI 热重载；无头探针：`Start-Process opencode.cmd --print-logs [-c]` 重定向日志 + 12s 杀进程（注意 dump 文本是会话内容回显 + 增量渲染拆 cell，**不可 grep 验证渲染**，用 OC_TASKBAR_PROBE 或真实终端）
- 验证循环：改 tui.tsx → robocopy 同步 → 真实 TUI 看侧边栏 → 开个后台任务看计数变化
- 提交：conventional commits（`feat(slot): ...`、`docs: ...`）；远程已建（2026-10-23）：`github.com/ntexplorer/oc-taskbar`（public，MIT）——提交后 `git push`；若 push 直连失败，按主手册仓 ai-dev-setup 的 AGENTS.md 坑位 8 处置（等待自愈或 gh api 通道）；部署归 ai-dev-setup 步骤 8 管辖（clone + robocopy），其他终端照该步骤即装

## 参考

- 插件系统：https://zread.ai/sst/opencode/12-plugin-system
- TUI 架构：https://zread.ai/sst/opencode/17-terminal-ui-tui
- CLI 命令（plugin/service/attach）：https://zread.ai/sst/opencode/3-cli-commands
- 主手册仓：`~/.config/ai-dev-setup`（本项目的立项背景记录在其 docs/PROGRESS.md 待办 9）
