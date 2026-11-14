<div align="center">
  <img src="assets/banner.svg?v=2" alt="oc-taskbar — task monitor and usage statusline for the OpenCode V2 TUI" width="100%">
</div>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ntexplorer/oc-taskbar/releases/latest"><img src="https://img.shields.io/github/v/release/ntexplorer/oc-taskbar?style=flat-square&sort=semver" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ntexplorer/oc-taskbar?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/OpenCode-2.3.0%2B-0ea5e9?style=flat-square" alt="OpenCode 2.3.0+">
  <img src="https://img.shields.io/badge/TypeScript-SolidJS-3178c6?style=flat-square" alt="TypeScript + SolidJS">
  <img src="https://img.shields.io/badge/platform-Windows%20verified-0078d4?style=flat-square" alt="Windows verified">
</p>

> **See every background task in your OpenCode TUI — and know what it costs.**
>
> oc-taskbar keeps running subagents, background shells and terminals visible in the sidebar, adds a compact usage statusline (context, session spend, today's spend, provider quota, git state), and turns "is it safe to close the lid?" into a glance instead of a guess.

## Why

OpenCode V2 moved work into real background tasks. The UI can look idle while subagents, shells or terminals are still running. The built-in task panel is a keypress away, and the built-in context card only covers the current session. oc-taskbar puts the live state and the numbers that matter on screen at all times.

- **No more silent background work.** Running shells, subagents, root sessions and persistent terminals are tracked across tabs and locations.
- **A completion trail you can trust.** Finished work stays visible for 30 seconds; the footer keeps a compact count when the sidebar is closed.
- **Spend without surprises.** Context usage, session cost, today's cost across all projects, provider quota and git changes in one card.
- **Quiet by design.** Notifications appear only when the TUI is blurred, and completions within 2 seconds are merged into one message.
- **Local-first.** No server changes, no npm install, no data leaves your machine. Provider keys are used in memory only.

## Features

| | |
|---|---|
| **Task monitor** | Live rows for background subagents, shells, persistent terminals and other root sessions. Click a row to expand the raw command or full title. |
| **Readable labels** | Commands are classified into semantic labels with emoji (`🧪 Running tests`, `🔨 Building`, `📦 Installing`, `💾 Committing`, …). Subagent titles are shown as written. |
| **Cross-location** | Shells are reconciled per `location`, so other project directories and worktrees are included — not just the default bucket. |
| **Completion trail** | `✅ … · done` for 30 seconds after a task ends. A resumed session does not produce duplicate rows. |
| **Usage statusline** | Context usage, session cost/tokens, today's cost/tokens, DeepSeek balance, GLM 5-hour/weekly windows, and git branch/file stats. |
| **Automatic language** | Chinese UI for CJK root-session titles, English otherwise; override with `OC_TASKBAR_LANG`. |
| **Bilingual docs** | This README in English; full Chinese version at [README.zh-CN.md](README.zh-CN.md). |

## Requirements

- **opencode 2.3.0+** (the background-subagent job model is 2.3.0+; older 2.x may work but is not supported).
- The TUI plugin loads from `<config>/plugins/oc-taskbar` — no npm install and no `node_modules` are needed.
- Persistent terminals require the host's `persistentPty` capability; the channel is skipped gracefully otherwise.
- Verified on **Windows**; macOS/Linux should work (POSIX install instructions below) but are not yet verified.

## Install

### 1. Get the source

```bash
git clone https://github.com/ntexplorer/oc-taskbar.git
```

### 2. Copy it into the TUI plugin directory

**Windows (PowerShell):**

```powershell
robocopy .\oc-taskbar "$env:USERPROFILE\.config\opencode\plugins\oc-taskbar" /MIR /XD .git
```

**macOS / Linux:**

```bash
mkdir -p ~/.config/opencode/plugins/oc-taskbar
rsync -a --delete --exclude .git ./oc-taskbar/ ~/.config/opencode/plugins/oc-taskbar/
```

Restart the TUI. The plugin is discovered from the directory (no `main`/`exports` field is required — in fact, adding them breaks the server entrypoint on some 2.2+ builds).

### 3. Disable the built-in Context card (recommended)

The built-in Context card duplicates the `🧠 Context` line. TUI built-ins are configured in `~/.config/opencode/cli.json` (not `opencode.jsonc`, which is server-side). Add:

```json
"plugins": ["-opencode.sidebar.context"]
```

Keep other entries if the file already has a `plugins` array. The `-` prefix disables that built-in. Restart if the change does not hot-reload.

## Usage

### Task area

The **📋 Background tasks** card shows one row per running unit:

- `🧪 Running tests`, `🔨 Building project`, `📦 Installing dependencies`, `💾 Committing`, `🔍 Searching`, `📂 Copying · <file>`, `📖 Viewing changes`, `💻 Running <command>` for shells
- `🔍 Exploring`, `🔧 Fixing`, `✍️ Implementing`, `🧐 Reviewing`, … for subagents (from their task description)
- `🖥️ Terminal` for persistent terminals
- `💬 <session title>` for other root sessions that are busy

The **current tab's** root-session row is dimmed and does not notify; other sessions get the full treatment. Finished rows become `✅ … · done` for 30 seconds. The footer shows `🏃N +M✅` when the sidebar is collapsed.

### Subagent completion (opencode 2.3.0+)

When a subagent goes idle, opencode delivers its report to the parent and deletes the durable job row almost immediately. oc-taskbar detects the running **generation** disappearing, paints the 30-second trail and sends **one** notification. `🎫 Unacked (N)` is only for reports whose delivery is stuck (a completed-but-unconsumed job row that persists): the entry is kept in local storage across restarts, clicking it opens the child session, and `/completed` manages the list (`m` ack, `o` open, `a` ack all; `/completed all` clears).

### Commands

| Command | What it does |
|---|---|
| `/statusline` | Toggle Context / session / today / quota / git / footer sections. Preferences persist. |
| `/quota` | Quota details, today/month totals in CNY + USD, current FX rate, context and git state; forces a refresh. |
| `/completed` | Manage stuck-report entries (`m` / `o` / `a`). |
| `/completed all` | Ack every stuck-report entry. |

### Usage card

- **🧠 Context** — context used / limit / percent from the latest assistant message; yellow at ≥80%, red at ≥95%.
- **💬 Session** — family token total and `session.cost`; the `🤖` suffix counts **currently running** child sessions only (tokens/cost remain cumulative).
- **📅 Today** — `session.stats` since local midnight, across **all projects and sessions** on this machine, including subagents; refreshed every 60 seconds and resets at midnight.
- **Quota** — DeepSeek balance (`💠 DS ¥…`) and GLM Coding Plan 5-hour/weekly windows.
- **⎇ Git** — branch, changed files, insertions/deletions.

Amounts are **CNY by default in the Chinese UI** (`≈¥`), USD in the English UI. The USD/CNY rate is fetched live (jsDelivr `@fawazahmed0/currency-api`), refreshed every 6 hours, cached across restarts, and falls back to the last good rate and then `7.2`. Set `OC_TASKBAR_USD_CNY` to override. `/quota` always shows the original USD value and the current rate.

### Notifications

Notifications are **blurred-only**: while the TUI is focused, completions only update the trail and footer. Within a 2-second window, multiple completions are merged into one message (for example, “✅ 3 subagents finished”). Subagent/root sounds come from the built-in `opencode.notifications` plugin; oc-taskbar does not duplicate them. shell/terminal completions play at most one `done` sound per wave.

Advanced: notification channels respect the plugin storage flags `notify` and `notifyRoot` (both default on).

### Footer fallback

When the sidebar is hidden, the composer footer shows only the compact essentials: `🏃1 +2✅` (running + recently finished), `🎫1` (stuck reports), and a low-quota warning (`💠` for low DeepSeek balance, `⚡N%` for high GLM 5-hour usage).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OC_TASKBAR_LANG` | auto | `zh` or `en`; otherwise inferred from the root-session title. |
| `OC_TASKBAR_USD_CNY` | live rate | Fixed USD→CNY rate; useful offline or for testing. |
| `OC_TASKBAR_PROBE` | unset | Append diagnostic lines to this file (zero I/O when unset). |

Credential lookup prefers the active OpenCode credential-store entry, then environment variables: DeepSeek `DEEPSEEK_API_KEY`; Zhipu `ZAI_API_KEY` / `BIGMODEL_API_KEY` / `ZHIPU_API_KEY` / `ZHIPUAI_API_KEY` / `GLM_API_KEY`. Keys are used in memory only and are never logged. Quota requests time out after 8 seconds and are cached for 5 minutes; a failed provider keeps its last good value.

## How it works

- **Shells** — subscribes to raw `shell.created/exited/deleted` events, discovers locations from the default location, events and sessions, and reconciles each location with `client.shell.list({location})`. This avoids the default-bucket blind spot and survives reconnects.
- **Subagents** — polls `experimental.job.list({kind:"subagent"})` every 10 seconds; background jobs are keyed by `childSessionID + started` generations. A running generation that disappears is a completion; completed rows that persist feed the stuck-report ledger.
- **Root sessions** — uses the client's reactive `session.active` status; the current tab's root is dimmed.
- **Terminals** — uses `experimental.persistentPty.list` and `persistent-pty.added/removed` events when the capability is present.
- **Usage** — `session.message`, `session.stats`, `session.cost/family`, `vcs.status`, model catalog and credential store. No server-side changes.

## Compatibility and limitations

- Tested against **opencode 2.3.0** on Windows. opencode iterates quickly; behavior may change in later versions.
- A user-cancelled background job looks like a normal completion (the generation disappears).
- A subagent that leaves its own background shell running may be reported as idle before that shell finishes; the trail can appear early.
- The plugin cannot disable other built-in plugins through a public API; disabling the built-in Context card is a deployment step (see above).
- Notification sounds are controlled by the host's notification settings; oc-taskbar only decides the message and whether to show a bubble.

## Development

Project notes, verified upstream facts and acceptance checklists live in [AGENTS.md](AGENTS.md); data-source notes are in [docs/api-notes.md](docs/api-notes.md).

```bash
# Fast syntax/bundle check (no node_modules required; peer deps are external)
npx esbuild tui.tsx --bundle --packages=external --format=esm \
  --jsx=automatic --jsx-import-source=@opentui/solid --outfile=/tmp/oc-taskbar.mjs
```

For a real TUI check, copy the directory into `<config>/plugins/oc-taskbar`, restart the TUI, then run a background shell or subagent. Set `OC_TASKBAR_PROBE` to see `store create #N`, `jobs N running=M`, `stats today`, `quota …` and `resync all (server.connected)` lines.

## License

MIT — see [LICENSE](LICENSE).
