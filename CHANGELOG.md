# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Historical note: the `v0.1`–`v1.1.2` milestones predate consistent `package.json` version bumps (for example, the `v1.0` tag contains `"version": "0.0.1"`). Tag names follow the milestone names used in the project notes; `package.json` has been aligned from `v1.2.0` onward.

## [Unreleased]

### Added
- Unit tests for `statusline.ts` (`test/statusline.test.mjs`, built on `node:test`, no dependencies) and an `npm test` script.

### Documentation
- Verified against opencode 2.4.1: a source comparison with 2.3.0 found no breaking changes for the plugin, and the baseline (bundle check, unit tests, headless probe) passes. Plugin code is unchanged.

## [1.6.3] - 2026-11-14

### Changed
- Completion trail shortened from 60 seconds to 30 seconds for shells, subagents, root sessions and terminals.

### Documentation
- English README is now the default; full Chinese translation at `README.zh-CN.md`.
- Added `assets/banner.svg` and `assets/banner.zh-CN.svg`.
- Added this changelog and release history; historical tags `v0.1`–`v1.6.2` are annotated and published as historical releases.
- Added repository/homepage/bugs/keywords metadata to `package.json`; no `main`/`exports` entry was added.

## [1.6.2] - 2026-11-14

### Changed
- The `🤖` suffix in the session usage line now counts only **running** child sessions; tokens and cost remain cumulative for the whole family.
- `/statusline` uses a local draft and awaits persistence, so check marks stay in sync during rapid toggles.
- DeepSeek quota label now reads `💠 DS ¥…`.

## [1.6.1] - 2026-11-14

### Fixed
- Sidebar crash `s.money is not a function`: `money` lives on the task store, while `StatusCard` was reading it from the nested `status` object. It now reads `props.tasks.money` with a USD fallback for older hot-reload stores.

## [1.6.0] - 2026-11-14

### Added
- CNY display for Chinese UI (`≈¥`), live USD/CNY rate (6-hour refresh, cached, fallback 7.2), `/quota` shows both currencies and the rate, `OC_TASKBAR_USD_CNY` override.
- Active-instance generation guard (`globalThis.__ocTaskbarInstance`) so stale hot-reload stores stop polling and notifying.

### Changed
- Notifications are blurred-only and coalesced into one message per 2-second window.
- Subagent/root completion sounds are left to the built-in `opencode.notifications`; shell/terminal waves play at most one `done` sound.

## [1.5.1] - 2026-11-14

### Fixed
- Plugin slash commands were invisible in the autocomplete menu because the keymap layer defaulted to `base` mode while autocomplete pushes its own mode. The layer now uses `mode: "global"`, restoring `/quota`, `/statusline` and `/completed`.

## [1.5.0] - 2026-11-14

### Changed
- Adapted to opencode 2.3.0 background subagents: normal completion is detected as a running job **generation** disappearing; `✅` trail and one notification.
- Completed-but-unconsumed job rows are now only the "delivery stuck" inbox (`🎫 Unacked`), not every completion.
- `jobChildHistory` uses a 5-minute window instead of suppressing direct child-session follow-ups forever.
- Built-in Context card disable moved from `opencode.jsonc` to the TUI config `cli.json`.

## [1.4.0] - 2026-11-14

### Added
- Persistent completed-job ledger for Issue #1, with `🎫 Unacked (N)`, `/completed` management and a second notification channel.
- Usage statusline: Context, session cost/tokens, today's totals, DeepSeek balance, GLM windows and git stats; `/statusline` and `/quota` commands.

## [1.3.0] - 2026-11-06

### Fixed
- Shells running in other locations (project directories, worktrees, workspace IDs) were invisible because the client only reads the default bucket. The plugin now maintains a location registry, subscribes to raw `shell.*` events and reconciles each location.

## [1.2.1] - 2026-10-28

### Fixed
- Removed `main`/`exports` from `package.json`; opencode 2.2.0 treated the root export as a server entry and tried to import the TUI JSX (crash `Cannot find package 'react'`). The plugin falls back to the conventional `tui.tsx` entry.

## [1.2.0] - 2026-10-26

### Added
- Fourth channel: busy root sessions (`💬 + title`), including foreground tools and stalled MCP calls. The current tab is dimmed and does not notify; other tabs get the full trail/notification treatment.
- `notifyRoot` storage switch.
- 60-second fallback poll covers root families after reconnect.

## [1.1.2] - 2026-10-26

### Fixed
- After an SSE reconnect, the host did not re-read shells, so running shells could disappear from the sidebar. The plugin resyncs shells, terminals, root families and fallback hydration on `server.connected`, plus a 60-second safety poll; ghost rows are healed by the full replacement.

## [1.1.1] - 2026-10-23

### Fixed
- Running rows were not clickable: `labelCache` was replaced on every event, rebuilding the `<For>` row and resetting `expanded`; cached labels are now reused after `stable()` comparison.
- Click handling uses `onMouseDown` (the OpenTUI-supported event).
- Fallback labels filter out command fragments (for example PowerShell snippets from other sessions) and show `💻 background command`.

## [1.1.0] - 2026-10-23

### Added
- Human-readable task labels: shell command pattern classification, semantic emoji, subagent title cleanup and keyword icons.
- Automatic UI language from the root-session title (`OC_TASKBAR_LANG=zh|en` forced).
- Footer badge uses the same emoji style; footer-only language hydration.

## [1.0.1] - 2026-10-23

### Fixed
- Sidebar state reset when switching tabs: slot input changes destroyed and rebuilt the component. Task tracking now lives in a module-level `createRoot` store; the component is a pure view.
- Adversarial-review hardening: sticky last-good reads, event-subscription cleanup, narrow-terminal subagent hydration.

## [1.0] - 2026-10-23

### Added
- Live counts for running shells, subagents and terminals.
- Task detail list (click to expand), completion trail (60 seconds at the time), completion notifications, and a compact `prompt.footer` badge.
- Fixed zero-count root causes: lazy client data requires an explicit initial `sync()`, and `onMount` never fires for slotted components.

## [0.1] - 2026-10-22

### Added
- Initial prototype: claim `sidebar.content` and render a task badge.
- API notes covering the TUI plugin slot system, built-in feature plugins and data sources.

[1.6.3]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.6.3
[1.6.2]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.6.2
[1.6.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.6.1
[1.6.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.6.0
[1.5.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.5.1
[1.5.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.5.0
[1.4.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.4.0
[1.3.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.3.0
[1.2.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.2.1
[1.2.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.2.0
[1.1.2]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.1.2
[1.1.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.1.1
[1.1.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.1.0
[1.0.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.0.1
[1.0]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v1.0
[0.1]: https://github.com/ntexplorer/oc-taskbar/releases/tag/v0.1
