# oc-taskbar

OpenCode V2 TUI 的**任务监视 + 用量状态栏**插件：把在跑的 subagent / 后台 shell / terminal 常驻显示在侧边栏，同时给出 Context、会话花费、今日用量、提供商配额与 git 工作区状态；侧边栏收起时用一行紧凑徽标兜底。

## 解决什么问题

V1 时代底部 spinner 转 = 有任务在跑，停 = 全部结束，看一眼就知道能不能关机。V2 引入真后台任务（后台 shell、子代理）后，「界面静止 ≠ 无事发生」，观测责任从 UI 转移到了「问 agent / 按方向键翻面板」——本插件把它变回**一眼可见**。

同时，V2 内置 Context 卡只显示当前会话的粗略占用，不覆盖「今日花了多少、DeepSeek 余额还剩多少、GLM 套餐窗口用了多少、工作区改了多少」。本插件把这些判断「还能不能继续烧 token / 能不能关机」的数字集中到侧栏顶部。

## 状态

- [x] 调研（2026-10-22）：TUI 插件槽位系统、内置 feature-plugins 机制、任务面板数据源均已确认存在
- [x] v0.1 原型（2026-10-23）：`tui.tsx` 挂 `sidebar.content`，实时显示在跑 shell / subagent / 终端计数（详见 [docs/api-notes.md](docs/api-notes.md)）
- [x] v1.0（2026-10-23）：计数恒零双根因修复（数据层懒加载需初始 sync；onMount 永不触发）+ 任务明细（点击展开）+ 完成保留 60s + 完成通知（默认开，storage 可关）+ `prompt.footer` 兜底一行徽标；无头探针实证 `total=2 shells=2`
- [x] v1.0.1（2026-10-23）：修复切 tab 后侧边栏重置为 none（Slot input 变化会销毁重建组件，状态提升为模块级单例 store）+ 对抗审查加固 9 项（数据抖动 sticky last-good 防假完成、窄终端下 subagent 兜底同步、事件订阅防泄漏等）
- [x] v1.1.0（2026-10-23）：任务描述人类可读化（命令模式表 + 语义 emoji）；显示语种自动跟随当前会话（`OC_TASKBAR_LANG=zh|en` 可强制）；footer 兜底徽标同款 emoji 风格
- [x] v1.1.1（2026-10-23）：修复在跑行点击无反应；点击事件对齐上游 `onMouseDown`；兜底标签过滤（其他会话的 PowerShell 片段显示为 `💻 后台命令`）
- [x] v1.1.2（2026-10-26）：修复「侧边栏偶发不显示在跑 shell 而内置任务面板显示」——SSE 断连丢事件且宿主重连不重拉 shell；现于重连时自动重同步 + 60s 兜底轮询，幽灵行一并治愈
- [x] v1.2.0（2026-10-26）：第 4 通道「根会话忙碌」——根会话在跑（含前台工具/MCP 挂起）侧栏显示 `💬 + 会话标题`；当前 tab dim 显示、完成不打扰，其他 tab 完整待遇
- [x] v1.2.1（2026-10-28）：修复 opencode 2.2.0 下插件加载失败——删除 package.json 的 main+exports，回落约定文件名模式（见 AGENTS.md 事实 4）
- [x] v1.3.0（2026-11-06）：修复「shell 运行中但侧栏无任务」——根因是宿主按 location 分桶存 shell，插件只读默认桶；改为插件自管原始事件 + location 注册表 + 逐桶对账（详见 AGENTS.md 事实 16）
- [x] v1.4.0（2026-11-14）：Issue #1 修复——引入实验性 background job 通道，完成但未被父会话消费的子代理在本地持久账本保留到显式确认，并额外发系统通知；新增用量状态栏（Context / 会话 / 今日 / DeepSeek 余额 / GLM 套餐窗口 / git 工作区）与 `/statusline`、`/quota`、`/completed` 命令
- [x] v1.5.0（2026-11-14）：适配 opencode 2.3.0 的「子代理默认后台」——上游在子代理空闲时立即投递报告并删除持久 job 行，插件改用「运行代际消失」检测正常完成（✅ 残影 + 一次通知），`🎫 未确认` 收窄为「报告投递卡住」的持久收件箱；内置 Context 卡关闭项迁移到 TUI 配置 `cli.json`
- [x] v1.5.1（2026-11-14）：命令 keymap 层改为 `mode: "global"`——2.3.0 的斜杠自动补全打开时会压入 `autocomplete` 模式，非 global 层被过滤，导致 `/quota`、`/statusline`、`/completed` 显示「No matching commands」
- [x] v1.6.0（2026-11-14）：通知降噪——聚焦时只留残影/徽标，失焦才弹，2 秒内合并为一条；子代理完成不再重复发声（内置通知已覆盖），shell/terminal 每波一声；新增热重载活跃实例守卫。金额显示改为中文默认人民币（`≈¥`，实时 USD/CNY 汇率，6 小时刷新，失败回退缓存/7.2，`OC_TASKBAR_USD_CNY` 可覆盖），`/quota` 同时保留 USD 原值
- [ ] v1.6.0 验收：见 AGENTS.md「接续指引」的验收清单（2.3.0 子代理完成、🎫 卡住报告、斜杠命令、通知降噪、人民币显示、跨 location shell、断连重连、切 tab）

## 使用

### 任务区

侧边栏 **📋 后台任务** 区块：每条任务显示为「emoji + 一句人话」——在跑 shell 按命令模式归类（`🧪 运行测试`、`🔨 构建项目`、`📦 安装依赖`、`📂 复制 · <文件名>`、`📖 查看变更`……不认识的命令显示 `💻 运行 <命令>`），子代理显示其任务描述并配语义图标（🔍 探索 / 🔧 修复 / ✍️ 实现 / 🧐 审查……），终端显示 `🖥️ 终端`，根会话在跑时显示 `💬 + 会话标题`——**当前 tab 的行淡显、完成时不通知不留残影**，其他 tab 的行与其他任务同待遇（侧栏计数含淡显行；footer 徽标不计）。任务完成后变 `✅ … · 完成了` 残影保留 60 秒。**点击任意行可展开原始命令 / 完整标题**。切 tab 状态不丢（跟踪在模块级 store，组件只是视图）。

**后台子代理完成（opencode 2.3.0+）**：子代理空闲时上游会立即把报告投递给父会话并删除持久 job 行；插件把「在跑的 job 代际消失」判定为一次完成，侧栏出现 `✅ … · 完成了` 残影 60 秒；系统通知只在 TUI 失焦时弹，且 2 秒内的多个完成会合并成一条。`🎫 未确认 (N)` 只保留**报告投递卡住**（completed-but-unconsumed 行长期存在）的条目：本地 storage 持久保留（最多 20 条，重启 TUI 仍在），点击行直接跳到子会话查看报告；`/completed` 打开管理列表（`m` 确认、`o` 打开、`a` 全部确认），`/completed all` 一键清空。确认记录保留 30 天，同一 job 代际不会重复提醒。

### 用量区

侧边栏顶部 **📊 用量** 卡（默认全部开启，`/statusline` 可逐项开关，偏好持久化）：

- `🧠 Context`：当前会话最近一条 assistant message 的 context used / limit / 百分比；≥80% 变黄、≥95% 变红
- `💬 本会话`：根会话全家（根 + 已加载子会话）token 汇总与 `data.session.cost` 花费；子会话 tab 只算自己
- `📅 今日`：`experimental.session.stats` 的当日汇总——本地 00:00 起、**本机全部项目/会话**（含子代理）的 token / 花费；每 60 秒刷新，跨午夜自动归零
- `配额`：DeepSeek 余额（CNY）与 GLM Coding Plan 5 小时 / 周窗口百分比
- `⎇ Git`：当前分支、工作区改动文件数、增删行数
- 金额单位：中文界面默认人民币（`≈¥`），英文默认 USD；美元/人民币汇率在装载时联网获取、每 6 小时刷新（jsDelivr `@fawazahmed0/currency-api`），失败回退上次缓存，再回退 7.2；`OC_TASKBAR_USD_CNY` 可强制覆盖。`/quota` 里同时保留 `($…)` 原值并显示当前汇率与更新时间

凭证优先取 OpenCode V2 credential store 中 active 的 provider key，缺失时回退环境变量：DeepSeek `DEEPSEEK_API_KEY`；智谱 `ZAI_API_KEY` / `BIGMODEL_API_KEY` / `ZHIPU_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY`。密钥只在内存中用于请求，不写日志。配额请求 8 秒超时、5 分钟缓存，单 provider 失败保留上一次好值。DeepSeek 端点 `https://api.deepseek.com/user/balance`；智谱端点 `https://open.bigmodel.cn/api/monitor/usage/quota/limit`（当前适配 BigModel CN，z.ai 全局站未适配）。

`/quota` 打开详情对话框：额度明细、今日/本月汇总（人民币 + USD 原值）、当前汇率、当前 Context、会话与 git 状态，并强制刷新一次。

### Footer 兜底

侧边栏关闭时 composer 底部只显示最紧凑的一行：`🏃1 +2✅`（在跑 + 刚完成）、`🎫1`（未确认），以及真正告急时的低配额提示（DeepSeek 余额低显示 `💠`，GLM 5h 用量高显示 `⚡N%`）。不塞 repo 路径、完整 quota 文案或 Context 数字——内置 prompt footer 已显示 context，本插件不重复。

### 通知

完成时只更新侧栏残影 + footer 徽标，**不打断你**。系统通知只在 TUI 失焦时弹，2 秒窗口内的多个完成合并成一条（如「✅ 3 个子代理完成了」）；聚焦时完全不弹气泡，避免宿主逐个排队导致的延迟。子代理/根会话的完成声音由内置 `opencode.notifications` 播放，本插件不再重复发声；shell/terminal 完成每波最多一声 `done`。想关掉：`storage.store("notify", …)`；`💬` 根会话通道另有 `storage.store("notifyRoot", …)`，默认同样开。

## 安装

上游 CLI 已无 `opencode plugin <path>` 本地装载命令（`add` 只收 npm/git 规格）。本地开发装载方式：

```powershell
# 插件目录 = <config>/plugins/ 下的子目录；Windows 用 robocopy 做真实副本
robocopy D:\Coding\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git
# 然后启动 opencode TUI；改代码后重新 robocopy，TUI 会热重载（watch + reconcile）
```

其他电脑（或本机无克隆时）：`git clone https://github.com/ntexplorer/oc-taskbar.git D:\Coding\oc-taskbar` 后执行上面同一条 robocopy；已纳入 ai-dev-setup 部署手册步骤 8（默认项）。

**推荐同时关闭内置 Context 卡**（避免与 `📊 用量` 重复）。V2 的 TUI 内置插件开关在 `~/.config/opencode/cli.json`（不是 `opencode.jsonc`——后者只管服务端插件），在顶层加入：

```json
"plugins": ["-opencode.sidebar.context"],
```

配置有热加载；若未生效，重启 TUI。`opencode.sidebar.context` 是内置 Context 卡的 id，`-` 前缀表示禁用（TUI 插件 provider 的配置语法）。插件无法通过公开 API 关闭其他内置插件，因此这是部署配置项而非插件行为；其他内置卡（MCP / Todo / SidebarFooter）不受影响。改动前建议备份配置。

诊断开关：设 `OC_TASKBAR_PROBE=<文件路径>` 后，插件在徽标挂载、计数变化、用量刷新时向该文件追加一行（默认零 IO）。相关 probe 行：`store create #N`（热重载代数，只有最新实例会通知）、`jobs N running=M`（background job 轮询）、`job settle <子会话:开始时间>`（检测到一次完成）、`job ack <key>`、`notify send n=… ok=… skipped=…`（合并后的通知）、`fx live <rate>` / `fx fail …`（汇率）、`stats today/month`、`quota ds=ok glm=ok`、`git files=N`、`pref <key>=…`；shell 通道仍为 `location + <桶键>`、`bucket <桶键> -> N running`、`resync all (server.connected)`。无 tty 时 OpenTUI 不挂载侧边栏，侧栏卡的验收需在真实终端进行；footer 可无头探针看到 `footer body`。

## 开发

启动文档见 [AGENTS.md](AGENTS.md)（已验证事实、技术路径、约束、参考链接全在内）。在项目根开 opencode 会话即可接续。

## License

MIT
