# 上游 API 研究笔记（2026-10-23，源码实测）

来源：`anomalyco/opencode`（原 sst/opencode）`dev` 分支，v2.1.x。本文档是实现 `src/index.tsx` 的依据，防止上游重构后迷失。

## 插件形态（TUI feature-plugin）

```tsx
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "oc-taskbar",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content", // SlotClaim：恰好一个 placement 键
      render: (props) => <Comp context={context} sessionID={props.sessionID} />,
    })
  },
})
```

- 渲染 = SolidJS + `<box>`/`<text>`（@opentui/solid 内建元素），`Show`/`For`/`createMemo` 可用
- 样板：`packages/tui/src/feature-plugins/sidebar/{mcp,context,todo}.tsx`
- 内置顺序：Context → MCP → Todo → Footer；外部插件 `append: "sidebar.content"` 排在其后
- 挂载点：`packages/tui/src/routes/session/sidebar.tsx` → `<Slot path="sidebar.content" input={{sessionID}} />`

## SlotClaim 五种 placement

`prepend`/`append` = 目标边界内首/尾；`before`/`after` = 目标外侧相邻；`replace` = 接管（原内容可经 before/after 重组）。多个插件 claim 同一 anchor 时按启用顺序共存。

## SlotMap 全表（packages/plugin/src/tui/context.ts）

| path | input |
|---|---|
| `home.footer` / `home.footer.status` | {} |
| `prompt.footer` / `.status` / `.file` | `{sessionID?, mode: "normal"\|"shell", showDetails}` |
| `session.composer.top` | `{sessionID}` |
| `session.panel` | PanelInput |
| `sidebar.content` / `sidebar.footer` | `{sessionID}` |

## Plugin.Context 要点

`options` / `location` / `app` / `renderer` / **`client`**（OpenCodeClient API 句柄）/ **`data`**（响应式数据层）/ `attention` / `theme` / `themeMode` / `markdown` / `keymap` / `storage.store|memory`（持久化/内存响应式状态）/ `ui.dialog|toast|format.path|router|panel|tabs|model|slot`

## 数据源（v0.1 任务计数）

| 任务类型 | 通道 | 说明 |
|---|---|---|
| 后台 shell | `data.shell.list(location?)` | 数据层只存在跑的 shell（`api().shell.list` + `shell.created/exited/deleted` 事件维护）；ShellInfo 含 `metadata.sessionID`、`metadata.background` |
| 子代理 | `data.session.list()` + `data.session.status(id)` | 子代理 = 子会话（`parentID` 非空）；`status(): "idle"\|"running"`；`family(id)` 取全会话族 |
| 终端 | `client.experimental.persistentPty.list({sessionID})` | 不在 data 层；事件 `persistent-pty.added/removed` 触发刷新；能力探测 `server.info().capabilities?.persistentPty !== false` |

事件订阅：`data.on(type, handler) => () => void`（typed 于 OpenCodeEvent 联合；pty 事件名需 as-cast）。

## 装载机制

- 外部插件目录：`<config>/plugins/<dir>`（`packages/tui/src/plugin/discovery.ts`）；`opencode plugin <path> -f` 安装
- 宿主运行时映射 `@opencode/plugin`（全部子路径）与 `effect` 到宿主副本（`packages/plugin/src/runtime-modules.ts`）——插件**无需**为它们装 node_modules
- JSX：`jsx: "preserve"` + `jsxImportSource: "@opentui/solid"`（Bun 转译，参照 packages/tui/tsconfig.json）
- peer 依赖（solid-js、@opentui/*、@opencode/theme）由宿主提供

## v1.0 备忘

- 完成通知：`context.attention.notify({message, sound: {name: "subagent_done"}})`
- 展开明细：`context.ui.dialog.show()` 或 `context.ui.panel.open()`
- 状态栏徽标：`prompt.footer` slot（一行紧凑版）

## 环境教训

- 本机直连 GitHub/raw 不通（封锁）；harness webfetch + jsDelivr（`cdn.jsdelivr.net/gh/anomalyco/opencode@dev/<path>`）+ GitHub blob API（按 sha 取 base64）三条通道可用
- PowerShell 执行策略拦截 `.ps1`：CLI 一律用 `npm.cmd` / `opencode.cmd`
