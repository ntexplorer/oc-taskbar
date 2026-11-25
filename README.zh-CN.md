<div align="center">
  <img src="assets/banner.zh-CN.svg?v=2" alt="oc-taskbar — OpenCode V2 TUI 的任务监视与用量状态栏" width="100%">
</div>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://github.com/ntexplorer/oc-taskbar/releases/latest"><img src="https://img.shields.io/github/v/release/ntexplorer/oc-taskbar?style=flat-square&sort=semver" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ntexplorer/oc-taskbar?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/OpenCode-2.3.0%2B-0ea5e9?style=flat-square" alt="OpenCode 2.3.0+">
  <img src="https://img.shields.io/badge/TypeScript-SolidJS-3178c6?style=flat-square" alt="TypeScript + SolidJS">
  <img src="https://img.shields.io/badge/platform-Windows%20verified-0078d4?style=flat-square" alt="Windows 已验证">
</p>

> **OpenCode TUI 里的每个后台任务，一眼可见——以及它花了多少钱。**
>
> oc-taskbar 把在跑的子代理、后台 shell、持久终端常驻显示在侧栏，并附一条紧凑的用量状态栏（Context、本会话花费、今日花费、提供商配额、git 状态）。「能不能关机」从猜测变成一个眼神。

## 解决什么问题

OpenCode V2 把工作搬进了真后台任务：界面可能看起来静止，但子代理、shell 或终端还在跑。内置任务面板要按键才看得到，内置 Context 卡又只覆盖当前会话。oc-taskbar 把实时状态和关键数字常驻在屏幕上。

- **后台工作不再静默。** 跨 tab、跨 location 跟踪在跑 shell、子代理、根会话和持久终端。
- **可信的完成轨迹。** 完成后的任务保留 30 秒；侧栏收起时 footer 仍有紧凑计数。
- **花费心里有数。** Context 占用、本会话花费、全机今日花费、提供商配额、git 改动集中在一张卡里。
- **默认安静。** TUI 失焦才弹通知，2 秒内的多个完成合并成一条。
- **本地优先。** 不改服务端、不需要 npm install、数据不出本机；provider key 只在内存中使用。

## 功能

| | |
|---|---|
| **任务监视** | 后台子代理、shell、持久终端、其他根会话各占一行。点击行可展开原始命令 / 完整标题。 |
| **人类可读标签** | 命令按语义归类并配 emoji（`🧪 运行测试`、`🔨 构建项目`、`📦 安装依赖`、`💾 提交`……），子代理标题保持原样。 |
| **跨 location** | 按 `location` 逐桶对账，其他项目目录、worktree 的 shell 也会出现，不再只盯默认桶。 |
| **完成残影** | 任务结束后显示 `✅ … · 完成了` 30 秒；resume 的会话不会出现重复行。 |
| **用量状态栏** | Context 占用、本会话金额/token、今日金额/token、DeepSeek 余额、GLM 5 小时/周窗口、git 分支与改动统计。 |
| **语种自适应** | 根会话标题是 CJK 时用中文界面，否则英文；`OC_TASKBAR_LANG` 可强制。 |
| **双语文档** | 本文件为中文完整版；英文默认版见 [README.md](README.md)。 |

## 环境要求

- **opencode 2.3.0+**（后台子代理 job 模型从 2.3.0 开始；更早的 2.x 或许能用，但不受支持）。
- TUI 插件从 `<config>/plugins/oc-taskbar` 装载——不需要 npm install，也不需要 `node_modules`。
- 持久终端需要宿主的 `persistentPty` 能力；没有时该通道会自动跳过。
- 已在 **Windows** 验证；macOS/Linux 预期可用（下方给了 POSIX 安装命令），但尚未实测。

## 安装

### 1. 获取源码

```bash
git clone https://github.com/ntexplorer/oc-taskbar.git
```

### 2. 复制到 TUI 插件目录

**Windows（PowerShell）：**

```powershell
robocopy .\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git
```

**macOS / Linux：**

```bash
mkdir -p ~/.config/opencode/plugins/oc-taskbar
rsync -a --delete --exclude .git ./oc-taskbar/ ~/.config/opencode/plugins/oc-taskbar/
```

重启 TUI。插件按目录约定发现，不需要 `main`/`exports` 字段——在部分 2.2+ 构建里加了反而会破坏服务端入口。

### 3. 关闭内置 Context 卡（推荐）

内置 Context 卡会和 `🧠 Context` 行重复。TUI 内置插件开关在 `~/.config/opencode/cli.json`（不是 `opencode.jsonc`，后者只管服务端插件）。加入：

```json
"plugins": ["-opencode.sidebar.context"]
```

如果文件里已有 `plugins` 数组，保留其他项；`-` 前缀表示禁用该内置插件。配置有热加载；不生效就重启 TUI。

## 使用

### 任务区

**📋 后台任务** 卡每行一个在跑的工作单元：

- shell：`🧪 运行测试`、`🔨 构建项目`、`📦 安装依赖`、`💾 提交`、`🔍 检索`、`📂 复制 · <文件名>`、`📖 查看变更`，不认识的命令显示 `💻 运行 <命令>`
- 子代理：按其任务描述显示 `🔍 探索`、`🔧 修复`、`✍️ 实现`、`🧐 审查`……
- 持久终端：`🖥️ 终端`
- 其他根会话在跑：`💬 + 会话标题`

**当前 tab** 的根会话行淡显、完成时不通知；其他会话完整待遇。完成后的行变 `✅ … · 完成了`，保留 30 秒。侧栏收起时 footer 显示 `🏃N +M✅`。

### 子代理完成（opencode 2.3.0+）

子代理空闲时，上游会立即把报告投递给父会话并删除持久 job 行。插件把「在跑的 job 代际消失」判定为一次完成，补 30 秒残影并只发**一次**通知。`🎫 未确认 (N)` 只保留**报告投递卡住**（completed-but-unconsumed 行长期存在）的条目：本地存储跨重启保留，点击行跳到子会话；`/completed` 管理（`m` 确认、`o` 打开、`a` 全部确认），`/completed all` 一键清空。

### 命令

| 命令 | 作用 |
|---|---|
| `/statusline` | 逐项开关 Context / 本会话 / 今日 / 配额 / Git / footer；偏好持久化。 |
| `/quota` | 配额明细、今日/本月汇总（人民币 + USD 原值）、当前汇率、Context 与 git 状态；并强制刷新一次。 |
| `/completed` | 管理投递卡住的条目（`m` / `o` / `a`）。 |
| `/completed all` | 确认全部条目。 |

### 用量卡

- **🧠 Context**：当前会话最近一条 assistant message 的已用 / 上限 / 百分比；≥80% 变黄，≥95% 变红。
- **💬 本会话**：家族 token 汇总与 `session.cost`；`🤖` 只统计**当前运行中**的子代理（token/金额仍累计）。
- **📅 今日**：本地 00:00 起的 `session.stats`，覆盖**本机全部项目/会话**（含子代理）；每 60 秒刷新，跨午夜归零。
- **配额**：DeepSeek 余额（`💠 DS ¥…`）与 GLM Coding Plan 的 5 小时 / 周窗口百分比。
- **⎇ Git**：当前分支、改动文件数、增删行数。

中文界面默认人民币（`≈¥`），英文界面默认 USD。汇率实时获取（jsDelivr `@fawazahmed0/currency-api`），每 6 小时刷新，跨重启缓存，失败回退上次好值、再回退 `7.2`；`OC_TASKBAR_USD_CNY` 可强制覆盖。`/quota` 始终保留 `($…)` 原值并显示当前汇率。

### 通知

通知只在 **TUI 失焦**时弹；聚焦时只更新残影和 footer。2 秒窗口内的多个完成合并成一条（如「✅ 3 个子代理完成了」）。子代理/根会话的完成声音由内置 `opencode.notifications` 播放，本插件不重复发声；shell/终端每波最多一声 `done`。

进阶：通知通道受插件 storage 的 `notify` / `notifyRoot` 开关控制（默认都开）。

### Footer 兜底

侧栏隐藏时，composer 底部只显示最紧凑的信息：`🏃1 +2✅`（在跑 + 刚完成）、`🎫1`（未确认），以及真正告急时的低配额提示（DeepSeek 余额低显示 `💠`，GLM 5h 用量高显示 `⚡N%`）。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `OC_TASKBAR_LANG` | 自动 | `zh` 或 `en`；否则根据根会话标题推断。 |
| `OC_TASKBAR_USD_CNY` | 实时汇率 | 固定 USD→CNY 汇率；离线或测试时有用。 |
| `OC_TASKBAR_PROBE` | 未设置 | 把诊断行追加到该文件（未设置时零 IO）。 |

凭证优先取 OpenCode credential store 中 active 的 provider 条目，缺失时回退环境变量：DeepSeek `DEEPSEEK_API_KEY`；智谱 `ZAI_API_KEY` / `BIGMODEL_API_KEY` / `ZHIPU_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY`。密钥只在内存中用于请求，不写日志。配额请求 8 秒超时、5 分钟缓存；单个 provider 失败保留上一次好值。

## 工作原理

- **shell**：订阅原始 `shell.created/exited/deleted` 事件，从默认 location、事件和会话三路发现 location，再用 `client.shell.list({location})` 逐桶对账；绕开默认桶盲区，断连后也能自愈。
- **子代理**：每 10 秒轮询 `experimental.job.list({kind:"subagent"})`；后台 job 按 `childSessionID + started` 的代际索引。上一轮在跑、这一轮消失 = 一次完成；长期存在的 completed 行进入「投递卡住」账本。
- **根会话**：读客户端响应式的 `session.active` 状态；当前 tab 的根会话淡显。
- **终端**：能力存在时用 `experimental.persistentPty.list` 与 `persistent-pty.added/removed` 事件。
- **用量**：`session.message`、`session.stats`、`session.cost/family`、`vcs.status`、模型目录与 credential store；不改服务端。

## 兼容性与已知限制

- 已在 **Windows + opencode 2.3.0** 上日常使用实测。**2.4.1** 已做源码核对（对本插件无破坏性变更）并无头装载验证通过，但尚未做完整的真实 TUI 回归。opencode 迭代快，后续版本行为可能变化。
- 用户主动 cancel 的后台 job 也会表现为「代际消失」，因此会显示为完成。
- 子代理如果留下自己的后台 shell，可能在 shell 结束前就被判定 idle，残影会提前出现。
- 插件不能用公开 API 关闭其他内置插件；关闭内置 Context 卡是部署配置项（见上）。
- 通知声音受宿主通知设置控制；本插件只决定消息内容与是否弹气泡。

## 开发

已验证事实、技术路径、验收清单在 [AGENTS.md](AGENTS.md)；数据源笔记在 [docs/api-notes.md](docs/api-notes.md)。

```bash
# 快速语法/打包检查（不需要 node_modules；peer 依赖全部 external）
npx esbuild tui.tsx --bundle --packages=external --format=esm \
  --jsx=automatic --jsx-import-source=@opentui/solid --outfile=/tmp/oc-taskbar.mjs
```

`npm test` 运行 `statusline.ts` 的单元测试（`test/statusline.test.mjs`，基于 `node:test`，零依赖）。需要 Node 22.18+，以便通过类型剥离直接加载 `.ts` 模块。

真实 TUI 验证：把目录复制到 `<config>/plugins/oc-taskbar`，重启 TUI，然后跑一个后台 shell 或子代理。设置 `OC_TASKBAR_PROBE` 可以看到 `store create #N`、`jobs N running=M`、`stats today`、`quota …`、`resync all (server.connected)` 等诊断行。

## License

MIT — 见 [LICENSE](LICENSE)。
