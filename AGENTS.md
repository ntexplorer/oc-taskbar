# AGENTS.md — oc-taskbar 开发启动文档

本文件供 opencode 会话读取，是本项目的**单一事实源**：使命、已验证事实、技术路径、约束全在此。接手即读即开工，无需再问背景。

## 项目使命

为 opencode V2 的 TUI 开发**任务监视插件**：把当前在跑的 **subagent / 后台 shell / terminal** 数量与状态**常驻**显示在侧边栏（或状态栏徽标），替代「按 ↓ 展开三栏」的手动观测。解决「会话看起来结束了但后台还有任务在跑，不知道能不能关机」的判断难题（V1 底部 spinner 在 V2 后台任务化后失效）。

## 已验证事实（2026-10-22 调查，来源：zread sst/opencode 知识库）

以下均为查证过的结论，可直接作为设计依据，不要重新猜：

1. **TUI 架构**：SolidJS + `@opentui` GPU 加速渲染，代码在 monorepo 的 `packages/tui`
2. **TUI 有插件槽位系统**：`packages/tui/src/plugin/slots.tsx`（UI 插入点定义）、`packages/tui/src/plugin/runtime.tsx`（插件运行时）、插件路由在 `packages/tui/src/app.tsx`（约 L215-340）
3. **内置 feature-plugins 机制**：`packages/tui/src/feature-plugins/builtins.ts`——**WhichKey 弹窗就是插件实现的**，「往 TUI 插常驻 UI」是官方支持的扩展模式，有先例可抄
4. **侧边栏已渲染 MCP 服务器**：存在现成的侧边栏内容挂载点（MCP Integration 文档）
5. **V2 插件 API**：`@opencode-ai/plugin/v2/effect`（命令式注册：setup 期间 `ctx.domain.transform()` / `ctx.domain.hook()`，运行时重放变换）与 `@opencode-ai/plugin/v2/promise`（Promise 风格）两形态；内部与外部插件用同一 API
6. **插件安装**：`opencode plugin <路径或包名>`（`-g` 全局、`-f` 强制替换重装）；本地路径可直接装载，改代码后 `-f` 重装验证
7. **数据源现成**：TUI 按 ↓ 展开的三栏（subagent / shell / terminal）证明内部本就维护这套任务状态——插件订阅同一事件流即可，**不需要新造数据层**；服务端是 Effect-TS 服务层（`Effect.fn` 模式），任务/会话状态经服务层暴露给 TUI 与工具系统
8. **架构分权**：TUI 只是客户端（`opencode attach <url>` 可重连运行中的服务器）；后台任务挂在服务进程下，关 TUI 不死——本插件观测的就是服务端状态

## 技术路径（v0.1 原型，四步）

1. **摸 API**：zread 读 `sst/opencode` 的 `packages/tui/src/plugin/slots.tsx` 与 WhichKey 的 builtin 实现，弄清 slot 注册与渲染组件签名（用 zread 的 `read_file`/`get_repo_structure`，不用 clone）
2. **最小渲染**：注册一个 sidebar slot，渲染固定文本徽标（如 `⚙ 2 tasks`）——本地 `opencode plugin .` 装载，TUI 里能看到即里程碑一
3. **接数据**：定位 ↓ 三栏的数据源（服务层任务状态流），订阅事件更新计数——开一个后台任务，徽标实时变化即里程碑二（v0.1 验收线）
4. **打磨**：点击/展开显示任务明细列表、完成后短暂保留状态、零任务时淡显——进入 v1.0 迭代

## 约束

- **公开仓库潜质**：不得写入任何密钥、账号、私人信息（本仓预期开源）
- TypeScript + TSX；风格贴近上游（Effect-TS 生态、SolidJS 组件模式）
- 原型阶段**不做 npm 发布**，本地路径装载即可；发布决策留给用户
- 上游 opencode 迭代快，API 以实测为准：本文档的事实清单若与最新源码冲突，以源码为准并回写本文件
- **部署归主手册仓管**：v0.1 可用后，在 `~/.config/ai-dev-setup`（私有主手册仓库）加部署步骤并关闭其待办 9；本仓只管插件本体

## 开发工作流

- 环境：Node ≥ 18；`npm i` 装依赖后 `opencode plugin . -f` 本地装载
- 验证循环：改代码 → `opencode plugin . -f` → 开 TUI 看侧边栏 → 开个后台任务看徽标变化
- 提交：conventional commits（`feat(slot): ...`、`docs: ...`）；本地仓暂无远程，用户建 GitHub 仓后再推

## 参考

- 插件系统：https://zread.ai/sst/opencode/12-plugin-system
- TUI 架构：https://zread.ai/sst/opencode/17-terminal-ui-tui
- CLI 命令（plugin/service/attach）：https://zread.ai/sst/opencode/3-cli-commands
- 主手册仓：`~/.config/ai-dev-setup`（本项目的立项背景记录在其 docs/PROGRESS.md 待办 9）
