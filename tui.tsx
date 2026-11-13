import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, on, Show } from "solid-js"
import { appendFileSync } from "node:fs"
import {
  ageText,
  contextUsage,
  dailyStats,
  fetchQuota,
  formatCost,
  formatPercent,
  formatTokens,
  gitStats,
  localTimezone,
  mergeQuota,
  providerCost,
  readProviderKeys,
  startOfMonth,
  startOfToday,
  tokensTotal,
  type ContextUsage,
  type DailyStats,
  type GitStats,
  type QuotaState,
} from "./statusline"

// Opt-in diagnostics: set OC_TASKBAR_PROBE=<file> to append a line whenever
// the plugin sets up, the store is created, or the task total changes. Zero
// I/O otherwise.
const PROBE = process.env.OC_TASKBAR_PROBE
const probe = (msg: string) => {
  if (!PROBE) return
  try {
    appendFileSync(PROBE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* probe failures must never break rendering */
  }
}

// How long completed tasks stay visible before fading out.
const RETAIN_MS = 60_000

// While no sidebar has ever mounted (narrow terminal), re-hydrate agent
// families on this cadence so the footer fallback still sees fresh subagents.
const FALLBACK_POLL_MS = 30_000

// Belt-and-braces reconcile cadence for the shell buckets: raw events lost
// while disconnected are never replayed, so every known location is re-listed
// over HTTP on this cadence (see the reconnect self-heal in createTaskStore).
const RESYNC_MS = 60_000

// Background subagent jobs are listed every 10s. This is the only source that
// still shows a completed-but-unconsumed job after a platform wakeup loss
// (issue #1); keep it independent from the session diff channel.
const JOB_POLL_MS = 10_000

// Today's token/cost aggregate (one SQLite rollup on the server).
const STATS_POLL_MS = 60_000

// Provider balances change slowly; manual /quota always forces a refresh.
const QUOTA_TTL_MS = 5 * 60_000

// Working-tree status is cheap on normal repos but can be slow on huge ones.
const GIT_POLL_MS = 30_000

const short = (id: string) => id.slice(-6)

// ---------------------------------------------------------------------------
// Localization. The display language follows the root session's title — the
// host generates it from the user's first message, so it tracks the language
// the user writes in. OC_TASKBAR_LANG=zh|en forces a pack and skips
// detection. Adding a language = adding one entry to PACKS.
// ---------------------------------------------------------------------------

type Lang = "zh" | "en"

const ENV_LANG: Lang | undefined =
  process.env.OC_TASKBAR_LANG === "zh" || process.env.OC_TASKBAR_LANG === "en" ? process.env.OC_TASKBAR_LANG : undefined

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const KANA_HANGUL = /[\u3040-\u30ff\uac00-\ud7af]/g

function detectLang(text: string): Lang {
  const han = text.match(HAN)?.length ?? 0
  if (han === 0) return "en"
  // Kana/Hangul means Japanese/Korean — no packs for those yet, so fall back
  // to English rather than showing Chinese strings.
  if ((text.match(KANA_HANGUL)?.length ?? 0) > 0) return "en"
  const letters = text.match(/[A-Za-z]/g)?.length ?? 0
  return letters === 0 || han * 10 >= letters ? "zh" : "en"
}

type ShellKey = "test" | "build" | "install" | "commit" | "sync" | "search" | "inspect" | "copy" | "move" | "http"

type Pack = {
  readonly header: string
  readonly idle: string
  readonly doneSuffix: string
  readonly terminal: string
  readonly agent: string
  readonly rootBusy: string
  readonly notifyDone: (label: string) => string
  readonly shell: {
    readonly label: Record<ShellKey, string>
    readonly other: string
    readonly run: (cmd: string) => string
    readonly copyOne: (name: string) => string
    readonly moveOne: (name: string) => string
  }
  readonly footer: {
    readonly tasks: (running: number, done: number) => string
    readonly doneOnly: (done: number) => string
  }
  readonly status: {
    readonly header: string
    readonly context: string
    readonly session: string
    readonly today: string
    readonly quota: string
    readonly git: string
    readonly unacked: (count: number) => string
    readonly unackedTitle: string
    readonly ack: string
    readonly ackAll: string
    readonly open: string
    readonly none: string
    readonly settingsTitle: string
    readonly refresh: string
    readonly quotaTitle: string
    readonly noQuota: string
  }
}

const PACKS: Record<Lang, Pack> = {
  zh: {
    header: "📋 后台任务",
    idle: "😴 暂无任务",
    doneSuffix: " · 完成了",
    terminal: "终端",
    agent: "子代理",
    rootBusy: "主会话进行中",
    notifyDone: (label) => `✅ ${label} 完成了`,
    shell: {
      label: {
        test: "运行测试",
        build: "构建项目",
        install: "安装依赖",
        commit: "提交代码",
        sync: "同步仓库",
        search: "检索文件",
        inspect: "查看变更",
        copy: "复制文件",
        move: "移动文件",
        http: "网络请求",
      },
      other: "后台命令",
      run: (cmd) => `运行 ${cmd}`,
      copyOne: (name) => `复制 · ${name}`,
      moveOne: (name) => `移动 · ${name}`,
    },
    footer: {
      tasks: (n, m) => (m > 0 ? `🏃${n} +${m}✅` : `🏃${n}`),
      doneOnly: (n) => `✅${n}`,
    },
    status: {
      header: "📊 用量",
      context: "Context",
      session: "本会话",
      today: "今日",
      quota: "配额",
      git: "Git",
      unacked: (n) => `🎫 未确认 (${n})`,
      unackedTitle: "未确认的后台子代理",
      ack: "标记已读",
      ackAll: "全部已读",
      open: "打开子会话",
      none: "没有未确认的后台任务",
      settingsTitle: "📊 用量状态栏设置",
      refresh: "立即刷新",
      quotaTitle: "配额与用量",
      noQuota: "未找到可用的 DeepSeek / GLM 凭证",
    },
  },
  en: {
    header: "📋 Background",
    idle: "😴 all clear",
    doneSuffix: " · done",
    terminal: "terminal",
    agent: "subagent",
    rootBusy: "main session busy",
    notifyDone: (label) => `✅ ${label} finished`,
    shell: {
      label: {
        test: "Run tests",
        build: "Build project",
        install: "Install deps",
        commit: "Commit changes",
        sync: "Sync repo",
        search: "Search files",
        inspect: "Inspect changes",
        copy: "Copy files",
        move: "Move files",
        http: "HTTP request",
      },
      other: "background command",
      run: (cmd) => `Run ${cmd}`,
      copyOne: (name) => `Copy · ${name}`,
      moveOne: (name) => `Move · ${name}`,
    },
    footer: {
      tasks: (n, m) => (m > 0 ? `🏃${n} +${m}✅` : `🏃${n}`),
      doneOnly: (n) => `✅${n}`,
    },
    status: {
      header: "📊 Usage",
      context: "Context",
      session: "Session",
      today: "Today",
      quota: "Quota",
      git: "Git",
      unacked: (n) => `🎫 unacked (${n})`,
      unackedTitle: "Unacked background subagents",
      ack: "Mark read",
      ackAll: "Mark all read",
      open: "Open child session",
      none: "No unacked background task",
      settingsTitle: "📊 Usage statusline settings",
      refresh: "Refresh now",
      quotaTitle: "Quota & usage",
      noQuota: "No usable DeepSeek / GLM credential found",
    },
  },
}

// ---------------------------------------------------------------------------
// Friendly task descriptions (heuristic — no LLM calls from a task bar).
// Raw commands / titles always survive in item.detail for click-to-expand.
// ---------------------------------------------------------------------------

const SHELL_ICON: Record<ShellKey, string> = {
  test: "🧪",
  build: "🔨",
  install: "📦",
  commit: "💾",
  sync: "🔄",
  search: "🔍",
  inspect: "📖",
  copy: "📂",
  move: "📂",
  http: "🌐",
}

// Strip the common "powershell -Command …" / "cmd /c …" / "sh -c …" wrappers
// so the classifier sees the inner command.
function unwrapCommand(raw: string): string {
  let s = raw.trim()
  for (let round = 0; round < 3; round++) {
    const m =
      s.match(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-{1,2}[A-Za-z]+\s+)*-(?:c|command)\s+([\s\S]+)$/i) ??
      s.match(/^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i) ??
      s.match(/^(?:sh|bash|zsh)(?:\.exe)?\s+(?:-{1,2}[A-Za-z]+\s+)*-c\s+([\s\S]+)$/i)
    if (!m) break
    let inner = m[1].trim()
    if (inner.length >= 2) {
      const q = inner[0]
      if ((q === '"' || q === "'") && inner.endsWith(q)) inner = inner.slice(1, -1)
    }
    s = inner.trim()
  }
  return s
}

// Positional args: skip leading flags, stop at the first flag after them
// (robocopy's "/XD .git" tail must not leak into the path garnish).
function positional(args: string[]): string[] {
  let i = 0
  while (i < args.length && /^[-/]/.test(args[i])) i++
  const out: string[] = []
  for (; i < args.length; i++) {
    if (/^[-/]/.test(args[i])) break
    out.push(args[i])
  }
  return out
}

const NPM_LIKE = new Set(["npm", "pnpm", "yarn", "bun", "deno", "npx", "bunx"])

function classifyShell(exe: string, args: string[]): ShellKey | undefined {
  const pos = positional(args)
  const first = pos[0] ?? ""
  if (exe === "git") {
    if (pos.includes("commit")) return "commit"
    if (first === "push" || first === "pull" || first === "fetch") return "sync"
    if (["status", "log", "diff", "show", "blame"].includes(first)) return "inspect"
    return undefined
  }
  if (NPM_LIKE.has(exe)) {
    const sub = first === "run" || first === "exec" ? pos[1] : first
    if (sub?.startsWith("test")) return "test"
    if (sub?.startsWith("build")) return "build"
    if (sub === "install" || sub === "i" || sub === "add") return "install"
    return undefined
  }
  switch (exe) {
    case "vitest":
    case "jest":
    case "mocha":
    case "pytest":
    case "py.test":
      return "test"
    case "go":
    case "cargo":
      if (first === "test") return "test"
      if (first === "build") return "build"
      if (exe === "cargo" && first === "add") return "install"
      return undefined
    case "tsc":
    case "make":
    case "cmake":
    case "msbuild":
    case "webpack":
    case "vite":
      return "build"
    case "pip":
    case "pip3":
    case "uv":
      return first === "install" ? "install" : undefined
    case "rg":
    case "grep":
    case "findstr":
    case "find":
    case "fd":
    case "ls":
    case "dir":
    case "gci":
    case "Get-ChildItem":
    case "where":
    case "which":
      return "search"
    case "cat":
    case "type":
    case "head":
    case "tail":
      return "inspect"
    case "robocopy":
    case "xcopy":
    case "cp":
    case "copy":
    case "Copy-Item":
    case "scp":
    case "rsync":
      return "copy"
    case "mv":
    case "move":
    case "Move-Item":
      return "move"
    case "curl":
    case "wget":
    case "Invoke-WebRequest":
    case "Invoke-RestMethod":
    case "iwr":
      return "http"
    default:
      return undefined
  }
}

// Short basename of the last positional arg (the destination), for garnish.
function garnishPath(args: string[]): string | undefined {
  const pos = positional(args)
  const last = pos[pos.length - 1]
  if (!last) return undefined
  const name = last.split(/[\\/]/).filter(Boolean).pop()
  if (!name || name.length > 24) return undefined
  return name
}

function describeShell(
  command: string | undefined,
  fallbackName: string,
  pack: Pack,
): { icon: string; label: string } {
  const raw = command?.trim()
  if (!raw) return { icon: "💻", label: pack.shell.run(fallbackName) }
  const body = unwrapCommand(raw)
  // Iterate segments ("cd … && <real command>") until one classifies — a bare
  // "cd" must never become the label. First segment's exe feeds the fallback.
  const segments = body
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  let firstExe: string | undefined
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const exe = (tokens[0].split(/[\\/]/).pop() ?? tokens[0])
      .replace(/\.(exe|cmd|bat)$/i, "")
      .replace(/^"|"$/g, "")
    const args = tokens.slice(1).map((t) => t.replace(/^"|"$/g, ""))
    const key = classifyShell(exe, args)
    if (key === "copy" || key === "move") {
      const name = garnishPath(args)
      if (name) return { icon: SHELL_ICON[key], label: key === "copy" ? pack.shell.copyOne(name) : pack.shell.moveOne(name) }
    }
    if (key) return { icon: SHELL_ICON[key], label: pack.shell.label[key] }
    if (firstExe === undefined) firstExe = exe
  }
  // Fallback: only show the exe name when it reads like a command. Foreign
  // PowerShell snippets from other sessions ("$x = …", "[Console]::…") would
  // otherwise render as unreadable noise.
  const exe = firstExe || fallbackName
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(exe)) return { icon: "💻", label: pack.shell.other }
  return { icon: "💻", label: pack.shell.run(exe) }
}

// Sub-agent titles are already natural language (written by the parent model
// in the user's language); just pick a matching icon and trim noise.
const AGENT_ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(探索|检索|查找|搜索|调研|explor|investigat|research|scan)/i, "🔍"],
  [/(修复|改正|fix|patch|debug|bug)/i, "🔧"],
  [/(实现|编写|开发|添加|创建|重构|implement|write|creat|develop|refactor|build)/i, "✍️"],
  [/(审查|复查|检查|review|audit|inspect)/i, "🧐"],
  [/(测试|验证|test|verif)/i, "🧪"],
  [/(文档|注释|readme|document|comment)/i, "📝"],
]

function cleanTitle(title: string): string {
  return title
    .trim()
    .replace(/^[\s"'「『【（(-]+/, "")
    .replace(/[\s"'」』】）)-]+$/, "")
    .trim()
}

function describeAgent(
  title: string | undefined,
  fallbackName: string,
): { icon: string; label: string; detail?: string } {
  const cleaned = cleanTitle(title ?? "")
  if (!cleaned) return { icon: "🤖", label: fallbackName }
  for (const [pattern, icon] of AGENT_ICON_RULES) {
    if (pattern.test(cleaned)) return { icon, label: cleaned, detail: title }
  }
  return { icon: "🤖", label: cleaned, detail: title }
}

// ---------------------------------------------------------------------------
// Module-level singleton store.
//
// Slot components are re-created from scratch whenever the slot input changes
// (verified: switching tabs re-runs the sidebar render), so every signal,
// cache, and event subscription living inside a component dies with it — the
// root cause of "sidebar resets to Tasks — none after switching tabs" while
// the footer badge kept its (+N done) trail. All tracking therefore lives in
// ONE store under its own createRoot, created once per plugin load; badge
// components are thin views that can be torn down freely.
//
// Known dev-mode caveat: a plugin hot-reload loads this module again and
// builds a second store; the old root is never disposed, so until the TUI is
// restarted you may see duplicated probe lines / notification sounds.
// ---------------------------------------------------------------------------

type PtyInfo = { id: string; title?: string }

type TaskKind = "shell" | "agent" | "terminal" | "root"

type TaskItem = {
  readonly kind: TaskKind
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly detail?: string
  // v1.2: busy root session of the tab being watched — muted rendering, and
  // excluded from the footer badge / completion trail (foreground work).
  readonly dim?: boolean
}

type CompletedItem = TaskItem & { readonly at: number }

type JobStatus = "running" | "completed" | "error" | "cancelled"

// The experimental job API lists active and *unconsumed* background jobs. A
// completed job therefore remains visible when the host's wakeup/delivery
// chain loses the notification (issue #1) — the durable signal the session
// list cannot provide.
type JobInfo = {
  readonly id: string
  readonly sessionID?: string
  readonly childSessionID?: string
  readonly status: JobStatus
  readonly title?: string
  readonly description?: string
  readonly agent?: string
  readonly time?: { readonly started?: number; readonly completed?: number }
}

type UnackedJob = {
  readonly key: string
  readonly id: string
  readonly childSessionID?: string
  readonly parentSessionID?: string
  readonly label: string
  readonly status: JobStatus
  readonly at: number
  readonly agent?: string
}

type StatusPrefs = {
  context: boolean
  session: boolean
  today: boolean
  quota: boolean
  git: boolean
  footer: boolean
}

const STATUS_DEFAULTS: StatusPrefs = {
  context: true,
  session: true,
  today: true,
  quota: true,
  git: true,
  footer: true,
}

const jobKey = (job: JobInfo): string =>
  `${job.id}:${job.time?.completed ?? job.time?.started ?? 0}`

const jobLabel = (job: JobInfo, fallback: string): string => {
  const raw = cleanTitle(job.description ?? job.title ?? "")
  return raw || fallback
}

const jobIcon = (status: JobStatus): string =>
  status === "completed" ? "✅" : status === "error" ? "❌" : status === "cancelled" ? "⛔" : "🛰️"

type ShellList = NonNullable<ReturnType<Plugin.Context["data"]["shell"]["list"]>>
type SessionList = NonNullable<ReturnType<Plugin.Context["data"]["session"]["list"]>>

type TaskStore = ReturnType<typeof createTaskStore>
let store: TaskStore | undefined

function getStore(context: Plugin.Context): TaskStore {
  if (!store) store = createRoot(() => createTaskStore(context))
  return store
}

function createTaskStore(context: Plugin.Context) {
  const data = context.data
  probe("store create")

  // Initial hydration lives in the shell channel and the session fallback
  // below — both run synchronously at store creation, never in onMount
  // (OpenTUI never fires onMount for slotted plugin components).

  // The sidebar passes its sessionID whenever a Taskbar mounts; terminal
  // listing, sub-session hydration, and language detection key off this
  // signal. The footer badge never overrides it (no id of its own), so it
  // mirrors the active sidebar.
  const [activeSession, setActiveSession] = createSignal<string | undefined>(undefined)
  const track = (id: string | undefined) => {
    if (id) setActiveSession(id)
  }

  // ---- display language: follows the root session title (generated from
  // the user's first message). Sticky on read failure — same principle as
  // every other read below. ENV_LANG pins it. ----
  let lastLang: Lang = ENV_LANG ?? "en"
  // Language backstop for footer-only mode (narrow terminal: no sidebar ever
  // calls track()) — seeded from root-session titles by fallbackHydrate.
  const [fallbackLang, setFallbackLang] = createSignal<Lang>(ENV_LANG ?? "en")
  const lang = createMemo<Lang>(() => {
    if (ENV_LANG) return ENV_LANG
    const id = activeSession()
    if (!id) return fallbackLang()
    try {
      const session = data.session.get(id)
      const root = session?.parentID ?? id
      const title = data.session.get(root)?.title
      if (title) lastLang = detectLang(title)
    } catch {
      /* keep last good language */
    }
    return lastLang
  })
  const pack = createMemo(() => PACKS[lang()])

  // ---- sub-agent families are lazy too: sync each family root once.
  // A failed sync un-marks the root so a later tab switch retries it. ----
  const hydratedRoots = new Set<string>()
  const hydrateRoot = (root: string) => {
    if (hydratedRoots.has(root)) return
    hydratedRoots.add(root)
    void data.session.sync(root, { children: true }).catch(() => {
      hydratedRoots.delete(root)
    })
  }
  createEffect(() => {
    const id = activeSession()
    if (!id) return
    let root: string
    try {
      root = data.session.get(id)?.parentID ?? id
    } catch {
      root = id
    }
    hydrateRoot(root)
  })

  // ---- running shells across ALL locations (v1.3) ----
  // The host buckets shells per location (directory + optional workspaceID)
  // and a no-argument data.shell.list() reads ONLY the default location's
  // bucket — shells started by sessions elsewhere (other project directories,
  // worktree/workspace locations) were invisible forever, and the old
  // re-sync covered the default bucket only, so they never healed either.
  // Own the channel: track every location this server works in, subscribe to
  // the raw shell events (each carries its location), and reconcile every
  // known bucket against the HTTP API.
  type LocationRef = { readonly directory: string; readonly workspaceID?: string }
  type ShellEntry = { readonly info: ShellList[number]; readonly bucket: string }

  // Bucket key normalized for Windows path drift (case, trailing separators):
  // the host's own key is a raw JSON.stringify of [directory, workspaceID],
  // which would split one project into buckets that never reconcile.
  const bucketKey = (ref: LocationRef): string => {
    const dir = process.platform === "win32" ? ref.directory.toLowerCase() : ref.directory
    return `${dir.replace(/[\\/]+$/, "")}|${ref.workspaceID ?? ""}`
  }

  const locations = new Map<string, LocationRef>()
  // Per-bucket event counter: a reconcile response older than the latest
  // event for its bucket is discarded (events are the fresher truth).
  const bucketDirty = new Map<string, number>()
  const [shellMap, setShellMap] = createSignal(new Map<string, ShellEntry>())

  const reconcileBucket = async (ref: LocationRef) => {
    const key = bucketKey(ref)
    const dirty = bucketDirty.get(key) ?? 0
    try {
      const response = await (
        context.client as { shell: { list: (input: unknown) => Promise<{ data?: ShellList }> } }
      ).shell.list({ location: { directory: ref.directory, workspaceID: ref.workspaceID } })
      if ((bucketDirty.get(key) ?? 0) !== dirty) return
      const list = response?.data ?? []
      setShellMap((previous) => {
        const next = new Map(previous)
        for (const [id, entry] of previous) if (entry.bucket === key) next.delete(id)
        for (const info of list) next.set(info.id, { info, bucket: key })
        return next
      })
      probe(`bucket ${key} -> ${list.length} running`)
    } catch {
      // Keep the last good entries: a failed read must never look like
      // "everything exited" (false completions + phantom notifications).
      probe(`bucket fail ${key}`)
    }
  }

  const registerLocation = (ref: LocationRef | undefined) => {
    if (!ref || typeof ref.directory !== "string" || ref.directory === "") return
    const key = bucketKey(ref)
    if (locations.has(key)) return
    locations.set(key, ref)
    probe(`location + ${key}`)
    void reconcileBucket(ref)
  }

  const reconcileAll = () => {
    for (const ref of locations.values()) void reconcileBucket(ref)
  }

  // Raw events bypass the data layer — including its silent drop of shell
  // events without a location and its default-bucket-only reads.
  const onShellEvent = (event: { location?: LocationRef; data?: unknown }) => {
    registerLocation(event?.location)
    const key = event?.location ? bucketKey(event.location) : ""
    bucketDirty.set(key, (bucketDirty.get(key) ?? 0) + 1)
    const created = (event?.data as { info?: ShellList[number] } | undefined)?.info
    if (created?.id) {
      setShellMap((previous) => {
        const next = new Map(previous)
        next.set(created.id, { info: created, bucket: key })
        return next
      })
      return
    }
    const id = (event?.data as { id?: string } | undefined)?.id
    if (!id) return
    setShellMap((previous) => {
      if (!previous.has(id)) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }
  for (const type of ["shell.created", "shell.exited", "shell.deleted"] as const) {
    void (data.on as (t: string, h: (event: { location?: LocationRef; data?: unknown }) => void) => () => void)(
      type,
      onShellEvent,
    )
  }

  // Seed with the default location; sessions and events grow the set. Both
  // run at store creation — never in onMount (never fires for slotted plugins).
  try {
    registerLocation((data.location as { default?: () => LocationRef } | undefined)?.default?.())
  } catch {
    /* default location unavailable — events and the session scan still seed */
  }

  // Sessions carry their location; this also covers shells that were already
  // running elsewhere before this plugin loaded (no event will ever fire).
  const scanSessionLocations = () => {
    try {
      for (const session of data.session.list() ?? []) registerLocation((session as { location?: LocationRef }).location)
    } catch {
      /* a failed read keeps the current location set */
    }
  }

  // Running shells = the registry values, order-stable for <For>.
  const shells = createMemo<ShellList>(() =>
    [...shellMap().values()]
      .map((entry) => entry.info)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  )

  // Fallback for when the sidebar never mounts (narrow terminal suppresses
  // it, so track() never fires): pull sessions over HTTP and hydrate every
  // family that has children, repeating until a sidebar takes over.
  const fallbackHydrate = async () => {
    try {
      const sessions: SessionList = (await context.client.session.list()) ?? []
      const roots = new Set<string>()
      for (const session of sessions) {
        if (session.parentID) roots.add(session.parentID)
      }
      for (const root of roots) hydrateRoot(root)
      // Seed the shell channel's bucket set with every location this server
      // is working in (worktrees, other project directories).
      for (const session of sessions) registerLocation((session as { location?: LocationRef }).location)
      // Footer-only mode has no tracked session — seed the language from the
      // majority of root-session titles so badges/notifications localize too.
      if (!ENV_LANG && !activeSession()) {
        const votes = new Map<Lang, number>()
        for (const session of sessions) {
          if (session.parentID || !session.title) continue
          const detected = detectLang(session.title)
          votes.set(detected, (votes.get(detected) ?? 0) + 1)
        }
        if (votes.size > 0) {
          const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1])
          setFallbackLang(best[0])
        }
      }
    } catch {
      /* best effort — the poll retries */
    }
  }
  void fallbackHydrate()
  const fallbackTimer = setInterval(() => {
    if (activeSession()) {
      clearInterval(fallbackTimer)
      return
    }
    void fallbackHydrate()
  }, FALLBACK_POLL_MS)

  // ---- persistent terminals for the active session (not in the reactive store) ----
  const [terminals, setTerminals] = createSignal<PtyInfo[]>([])
  let termReq = 0
  const refreshTerminals = async () => {
    const id = activeSession()
    if (!id) return
    const req = ++termReq
    try {
      const list = (await context.client.experimental.persistentPty.list({ sessionID: id })) ?? []
      if (req === termReq) setTerminals(list)
    } catch {
      // Keep the previous list on failure: a transient error must not read as
      // "terminal closed" (false completion). Empty lists arrive as [] on
      // success, so this never masks real closes.
    }
  }
  createEffect(() => {
    if (activeSession()) void refreshTerminals()
  })
  // pty lifecycle events (names not in the typed union yet; runtime subscription works).
  // Subscribed for the lifetime of the store — NOT via onCleanup, which would
  // unhook whenever a badge instance unmounts (a tab-switch data-loss vector).
  try {
    for (const type of ["persistent-pty.added", "persistent-pty.removed"] as const) {
      void (data.on as (t: string, h: () => void) => () => void)(type, () => void refreshTerminals())
    }
  } catch {
    /* terminal events unavailable; refresh on remount still covers most changes */
  }

  // ---- reconnect self-heal (v1.1.2; v1.3 extends it to every bucket) ----
  // Events lost in a disconnect gap are never replayed and the host's
  // server.connected handler re-pulls sessions but never shells, so take
  // ownership: reconcile every known location bucket over HTTP, and let the
  // session list reveal locations not seen yet.
  const resyncShells = () => {
    probe("resync shells")
    reconcileAll()
    scanSessionLocations()
    void refreshTerminals()
  }
  const resyncAll = () => {
    probe("resync all (server.connected)")
    resyncShells()
    for (const root of hydratedRoots) void data.session.sync(root, { children: true }).catch(() => undefined)
    void fallbackHydrate()
    void syncJobs()
    void refreshStats(true)
    void refreshQuota(true)
    void refreshGit(true)
  }
  try {
    void (data.on as (t: string, h: () => void) => () => void)("server.connected", resyncAll)
  } catch {
    /* reconnect events unavailable; the tick below still heals every bucket */
  }
  // Belt-and-braces tick: every shell bucket + session-discovered locations +
  // terminals + already-hydrated root families. Root families matter here:
  // subagent events lost in a disconnect gap have NO other fallback if the
  // server.connected handler above ever fails to fire. fallbackHydrate (full
  // session scan) stays out of the steady-state tick.
  setInterval(() => {
    resyncShells()
    for (const root of hydratedRoots) void data.session.sync(root, { children: true }).catch(() => undefined)
  }, RESYNC_MS)

  // ---- background subagent jobs (issue #1) ----
  // Kept separate from the reactive session list: a background job can finish
  // while the TUI is disconnected or before its child session is loaded, and
  // the job API still returns the completed-but-unconsumed row. Foreground
  // subagents remain covered by the session diffs below.
  const [jobs, setJobs] = createSignal<JobInfo[]>([])
  const jobChildren = createMemo(() => new Set(jobs().flatMap((job) => (job.childSessionID ? [job.childSessionID] : []))))
  // Child sessions already covered by the job channel must not be announced a
  // second time by the session-list diff below.
  const jobChildHistory = new Set<string>()

  // ---- running subagents: child sessions whose runner is active ----
  let lastAgents: SessionList = []
  const agents = createMemo(() => {
    try {
      const inJob = jobChildren()
      const list = (data.session.list() ?? []).filter(
        (session) =>
          session.parentID !== undefined &&
          data.session.status(session.id) === "running" &&
          !inJob.has(session.id),
      )
      lastAgents = list
      return list
    } catch {
      return lastAgents
    }
  })

  // ---- v1.2 channel 4: busy root sessions (the main conversation itself
  // running — the blind spot of the other three channels when a foreground
  // tool/MCP call hangs with no shell, subagent, or terminal attached). Sticky
  // last-good like every other read. ----
  let lastRoots: SessionList = []
  const roots = createMemo(() => {
    try {
      const list = (data.session.list() ?? []).filter(
        (session) => session.parentID === undefined && data.session.status(session.id) === "running",
      )
      lastRoots = list
      return list
    } catch {
      return lastRoots
    }
  })

  // Family root of the tab the sidebar is showing (a child session's input
  // resolves upward). Its busy row renders dim and stays out of the completion
  // trail: the user is watching that conversation answer live.
  const activeRoot = createMemo<string | undefined>(() => {
    const id = activeSession()
    if (!id) return undefined
    try {
      return data.session.get(id)?.parentID ?? id
    } catch {
      return id
    }
  })

  // ---- usage statusline state -------------------------------------------------
  // Preferences are durable; a failed storage read degrades to in-memory state
  // instead of breaking the whole plugin.
  let prefsStore: any
  let setPrefsStore: ((mutation: (draft: StatusPrefs) => void) => Promise<void>) | undefined
  const [fallbackPrefs, setFallbackPrefs] = createSignal<StatusPrefs>(STATUS_DEFAULTS)
  try {
    const [stored, setter] = context.storage.store<StatusPrefs>("statusline", { initial: STATUS_DEFAULTS })
    prefsStore = stored
    setPrefsStore = setter
  } catch {
    /* default prefs */
  }
  const prefs = (): StatusPrefs => (prefsStore ?? fallbackPrefs()) as StatusPrefs
  const pref = (key: keyof StatusPrefs): boolean => Boolean(prefs()[key] ?? STATUS_DEFAULTS[key])
  const togglePref = (key: keyof StatusPrefs) => {
    const next = !pref(key)
    try {
      if (setPrefsStore) void setPrefsStore((draft) => { draft[key] = next })
      else setFallbackPrefs((previous) => ({ ...previous, [key]: next }))
    } catch {
      /* preference persistence is best effort */
    }
    probe(`pref ${key}=${next}`)
    if (next && (key === "quota" || key === "footer")) void refreshQuota(true)
  }

  // Completed background jobs are a durable "unread inbox": the server keeps
  // returning them until its own notification is consumed, and the user's ack
  // is stored locally so a replay never re-notifies.
  type UnackedState = { items: UnackedJob[]; acked: Record<string, number> }
  const UNACKED_INITIAL: UnackedState = { items: [], acked: {} }
  let unackedStore: any
  let setUnackedStore: ((mutation: (draft: UnackedState) => void) => Promise<void>) | undefined
  const [fallbackUnacked, setFallbackUnacked] = createSignal<UnackedState>(UNACKED_INITIAL)
  try {
    const [stored, setter] = context.storage.store<UnackedState>("unacked", { initial: UNACKED_INITIAL })
    unackedStore = stored
    setUnackedStore = setter
  } catch {
    /* in-memory ledger */
  }
  const unackedState = (): UnackedState => {
    const raw: any = unackedStore ?? fallbackUnacked()
    return {
      items: Array.isArray(raw?.items) ? raw.items : [],
      acked: raw?.acked && typeof raw.acked === "object" ? raw.acked : {},
    }
  }
  const unacked = createMemo<UnackedJob[]>(() => [...unackedState().items])
  const unackedCount = createMemo(() => unacked().length)
  const mutateUnacked = (mutation: (draft: UnackedState) => void) => {
    try {
      if (setUnackedStore) {
        void setUnackedStore((draft) => {
          if (!Array.isArray(draft.items)) draft.items = []
          if (!draft.acked || typeof draft.acked !== "object") draft.acked = {}
          mutation(draft)
        })
        return
      }
    } catch {
      /* fall through to the in-memory copy */
    }
    setFallbackUnacked((previous) => {
      const draft: UnackedState = { items: [...previous.items], acked: { ...previous.acked } }
      mutation(draft)
      return draft
    })
  }
  const ackJob = (key: string) => {
    mutateUnacked((draft) => {
      draft.items = draft.items.filter((item) => item.key !== key)
      draft.acked[key] = Date.now()
    })
    probe(`job ack ${key}`)
  }
  const ackAll = () => {
    mutateUnacked((draft) => {
      for (const item of draft.items) draft.acked[item.key] = Date.now()
      draft.items = []
    })
    probe("job ack all")
  }
  const addUnacked = (job: JobInfo) => {
    const key = jobKey(job)
    if (unackedState().acked[key]) return
    if (unacked().some((item) => item.key === key)) return
    const fallback = `${pack().agent} ${short(job.childSessionID ?? job.id)}`
    const item: UnackedJob = {
      key,
      id: String(job.id),
      childSessionID: job.childSessionID,
      parentSessionID: job.sessionID,
      label: jobLabel(job, fallback),
      status: job.status,
      at: job.time?.completed ?? job.time?.started ?? Date.now(),
      agent: job.agent,
    }
    mutateUnacked((draft) => {
      draft.items = [item, ...draft.items.filter((entry) => entry.key !== key)].slice(0, 20)
      const cutoff = Date.now() - 30 * 86_400_000
      for (const [id, at] of Object.entries(draft.acked)) if (at < cutoff) delete draft.acked[id]
    })
  }

  const [todayStats, setTodayStats] = createSignal<DailyStats>()
  const [monthStats, setMonthStats] = createSignal<DailyStats>()
  const [git, setGit] = createSignal<GitStats>()
  const [quota, setQuota] = createSignal<QuotaState>({ errors: [] })

  let lastContext: { id: string; value: ContextUsage } | undefined
  const contextInfo = createMemo<ContextUsage | undefined>(() => {
    const id = activeSession()
    if (!id) return undefined
    try {
      const session = data.session.get(id)
      if (!session) return undefined
      const models = data.location.model.list((session as any).location) ?? []
      const value = contextUsage(
        data.session.message.list(id) ?? [],
        models,
        (session as any).revert?.messageID,
      )
      if (value) lastContext = { id, value }
      return value ?? (lastContext?.id === id ? lastContext.value : undefined)
    } catch {
      return lastContext?.id === id ? lastContext.value : undefined
    }
  })

  const sessionUsage = createMemo<{ tokens: number; cost: number; subagents: number } | undefined>(() => {
    const id = activeSession()
    if (!id) return undefined
    try {
      const info = data.session.get(id)
      if (!info) return undefined
      const ids = info.parentID
        ? [id]
        : [...new Set([id, ...data.session.family(id)])]
      let tokens = 0
      for (const sessionID of ids) {
        const session = data.session.get(sessionID)
        if (!session) continue
        tokens += tokensTotal((session as any).tokens)
      }
      let cost = 0
      try {
        cost = Number(data.session.cost(id)) || 0
      } catch {
        /* keep zero */
      }
      return { tokens, cost, subagents: info.parentID ? 0 : Math.max(0, ids.length - 1) }
    } catch {
      return undefined
    }
  })

  let statsReq = 0
  let statsAt = 0
  let monthReq = 0
  let monthAt = 0
  async function refreshStats(force = false) {
    if (!force && Date.now() - statsAt < STATS_POLL_MS) return
    const req = ++statsReq
    try {
      const raw = await (context.client as any).experimental.session.stats({
        from: startOfToday(),
        to: Date.now(),
        timezone: localTimezone(),
        tools: "none",
      })
      if (req !== statsReq) return
      setTodayStats(dailyStats(raw))
      statsAt = Date.now()
      probe(`stats today cost=${raw?.cost ?? "?"}`)
    } catch {
      probe("stats today fail")
    }
  }
  async function refreshMonthStats(force = false) {
    if (!force && Date.now() - monthAt < STATS_POLL_MS) return
    const req = ++monthReq
    try {
      const raw = await (context.client as any).experimental.session.stats({
        from: startOfMonth(),
        to: Date.now(),
        timezone: localTimezone(),
        tools: "none",
      })
      if (req !== monthReq) return
      setMonthStats(dailyStats(raw))
      monthAt = Date.now()
      probe(`stats month cost=${raw?.cost ?? "?"}`)
    } catch {
      probe("stats month fail")
    }
  }

  let gitReq = 0
  let gitAt = 0
  async function refreshGit(force = false) {
    const id = activeSession()
    if (!id) return
    if (!force && Date.now() - gitAt < GIT_POLL_MS) return
    let location: any
    try {
      location = (data.session.get(id) as any)?.location ?? (data.location as any).default?.()
      if (!location) return
      void (data.location as any).vcs?.sync?.(location)
    } catch {
      return
    }
    const req = ++gitReq
    try {
      const response = await (context.client as any).vcs.status({ location })
      if (req !== gitReq) return
      let branch: string | undefined
      try {
        branch = (data.location as any).vcs?.info?.(location)?.branch?.current
      } catch {
        /* branch is optional */
      }
      setGit(gitStats(response?.data, branch))
      gitAt = Date.now()
      probe(`git files=${response?.data?.length ?? 0}`)
    } catch {
      probe("git fail")
    }
  }

  let quotaReq = 0
  let quotaAt = 0
  async function refreshQuota(force = false) {
    if (!force && !pref("quota") && !pref("footer")) return
    if (!force && Date.now() - quotaAt < QUOTA_TTL_MS) return
    const req = ++quotaReq
    try {
      const keys = await readProviderKeys(context.client)
      const fresh = await fetchQuota(keys)
      if (req !== quotaReq) return
      setQuota((previous) => mergeQuota(previous, fresh))
      quotaAt = Date.now()
      probe(
        `quota ds=${fresh.deepseek ? "ok" : "-"} glm=${fresh.zhipuFive || fresh.zhipuWeek ? "ok" : "-"} errors=${fresh.errors.join(";") || "-"}`,
      )
    } catch (error) {
      probe(`quota fail ${String(error)}`)
    }
  }

  const activeJobs = createMemo<TaskItem[]>(() => {
    const p = pack()
    return jobs()
      .filter((job) => job.status === "running")
      .map((job) => {
        const desc = describeAgent(job.description ?? job.title, `${p.agent} ${short(job.childSessionID ?? job.id)}`)
        return {
          kind: "agent" as const,
          id: `job:${job.id}`,
          icon: desc.icon,
          label: desc.label,
          detail: job.childSessionID,
        }
      })
  })

  const notifiedJobs = new Set<string>()
  function notifyJob(job: JobInfo) {
    const key = jobKey(job)
    if (notifiedJobs.has(key)) return
    notifiedJobs.add(key)
    if (!notifyEnabled()) return
    const p = pack()
    const label = jobLabel(job, `${p.agent} ${short(job.childSessionID ?? job.id)}`)
    try {
      const result = context.attention.notify({
        message: p.notifyDone(label),
        notification: { when: "always" },
        sound: { name: "subagent_done" },
      })
      void Promise.resolve(result)
        .then((value: any) => probe(`notify job ${key} ok=${value?.ok} skipped=${value?.skipped ?? "-"}`))
        .catch((error) => probe(`notify job fail ${key}: ${String(error)}`))
    } catch (error) {
      probe(`notify job fail ${key}: ${String(error)}`)
    }
  }

  let jobReq = 0
  let jobsPrimed = false
  let lastJobs = new Map<string, JobInfo>()
  async function syncJobs() {
    const req = ++jobReq
    try {
      const raw = await (context.client as any).experimental.job.list({ kind: "subagent" })
      if (req !== jobReq) return
      const list: JobInfo[] = Array.isArray(raw) ? raw : []
      const previous = lastJobs
      lastJobs = new Map(list.map((job) => [String(job.id), job]))
      for (const job of list) if (job.childSessionID) jobChildHistory.add(job.childSessionID)
      if (jobChildHistory.size > 500) {
        for (const id of [...jobChildHistory].slice(0, 200)) jobChildHistory.delete(id)
      }
      setJobs(list)
      const primed = jobsPrimed
      for (const job of list) {
        if (job.status === "running") continue
        addUnacked(job)
        const old = previous.get(String(job.id))
        const recent = (job.time?.completed ?? 0) > Date.now() - 5 * 60_000
        if (primed && (old?.status === "running" || (!old && recent))) notifyJob(job)
      }
      jobsPrimed = true
      probe(`jobs ${list.length} running=${list.filter((job) => job.status === "running").length}`)
    } catch {
      probe("jobs fail")
    }
  }

  function openJob(item: UnackedJob | undefined) {
    if (!item?.childSessionID) return
    try {
      context.ui.router.navigate({ type: "session", sessionID: item.childSessionID })
    } catch {
      /* navigation is optional */
    }
  }

  async function showCompleted() {
    const p = pack()
    const items = unacked()
    if (items.length === 0) {
      context.ui.toast.show({ message: p.status.none })
      return
    }
    try {
      const selected = await context.ui.dialog.select<string>({
        title: `${p.status.unackedTitle} (${items.length})`,
        options: items.map((item) => ({
          title: `${jobIcon(item.status)} ${item.label}`,
          value: item.key,
          description: `${item.status} · ${new Date(item.at).toLocaleString()} · ${item.childSessionID ?? "-"}`,
          footer: item.agent,
        })),
        actions: [
          {
            bind: "m",
            title: p.status.ack,
            selection: "required",
            onTrigger: (key) => {
              ackJob(key)
              context.ui.dialog.clear()
              context.ui.toast.show({ message: p.status.ack })
            },
          },
          {
            bind: "o",
            title: p.status.open,
            selection: "required",
            onTrigger: (key) => {
              context.ui.dialog.clear()
              openJob(items.find((item) => item.key === key))
            },
          },
          {
            bind: "a",
            title: p.status.ackAll,
            selection: "none",
            onTrigger: () => {
              ackAll()
              context.ui.dialog.clear()
            },
          },
        ],
      })
      if (selected) openJob(items.find((item) => item.key === selected))
    } catch {
      /* dialog unavailable */
    }
  }

  function refreshAll() {
    void syncJobs()
    void refreshStats(true)
    void refreshMonthStats(true)
    void refreshQuota(true)
    void refreshGit(true)
  }

  async function showSettings() {
    const p = pack()
    const labels: Array<[keyof StatusPrefs, string, string]> = [
      ["context", p.status.context, "Context % / tokens / limit"],
      ["session", p.status.session, "Session tokens + cost"],
      ["today", p.status.today, "All sessions today"],
      ["quota", p.status.quota, "DeepSeek balance / GLM windows"],
      ["git", p.status.git, "Branch + working tree stats"],
      ["footer", "Footer", "Compact footer fallback"],
    ]
    for (;;) {
      try {
        const selected = await context.ui.dialog.select<keyof StatusPrefs | "refresh">({
          title: p.status.settingsTitle,
          options: [
            ...labels.map(([key, label, description]) => ({
              title: `${pref(key) ? "✅" : "⬜"} ${label}`,
              value: key,
              description,
            })),
            { title: `🔄 ${p.status.refresh}`, value: "refresh" as const },
          ],
          actions: [
            {
              bind: "r",
              title: p.status.refresh,
              selection: "none",
              onTrigger: refreshAll,
            },
          ],
        })
        if (!selected) return
        if (selected === "refresh") {
          refreshAll()
          continue
        }
        togglePref(selected)
      } catch {
        return
      }
    }
  }

  async function showQuota() {
    const p = pack()
    await Promise.allSettled([refreshQuota(true), refreshMonthStats(true), refreshStats(true)])
    const lines: string[] = []
    const q = quota()
    if (q.deepseek) lines.push(`${q.deepseek.short}\n  ${q.deepseek.detail}`)
    if (q.zhipuFive) lines.push(`${q.zhipuFive.short}\n  ${q.zhipuFive.detail}`)
    if (q.zhipuWeek) lines.push(`${q.zhipuWeek.short}\n  ${q.zhipuWeek.detail}`)
    if (!q.deepseek && !q.zhipuFive && !q.zhipuWeek) lines.push(p.status.noQuota)

    const today = todayStats()
    if (today) {
      lines.push(
        `\n${p.status.today}: ${formatCost(today.cost)} · ${formatTokens(today.tokens)} tok · ${today.prompts} prompts`,
      )
      const dsCost = providerCost(today, /deepseek/i)
      const glmCost = providerCost(today, /zhipu|zai|bigmodel/i)
      if (dsCost || glmCost) lines.push(`  DeepSeek ${formatCost(dsCost)} · GLM ${formatCost(glmCost)}`)
    }
    const month = monthStats()
    if (month) {
      lines.push(`${p.status.quota} ${new Date().getMonth() + 1}月: ${formatCost(month.cost)} · ${formatTokens(month.tokens)} tok`)
    }
    const ctx = contextInfo()
    if (ctx) {
      lines.push(
        `\n${p.status.context}: ${formatPercent(ctx.percent)} · ${formatTokens(ctx.tokens)}${ctx.limit ? ` / ${formatTokens(ctx.limit)}` : ""}${ctx.model ? ` · ${ctx.model}` : ""}`,
      )
    }
    const usage = sessionUsage()
    if (usage) lines.push(`${p.status.session}: ${formatCost(usage.cost)} · ${formatTokens(usage.tokens)} tok`)
    const repository = git()
    if (repository) {
      lines.push(
        `${p.status.git}: ${repository.branch ?? "?"} · ${repository.files} files · +${repository.additions} -${repository.deletions}`,
      )
    }
    if (q.at) lines.push(`\nquota ${ageText(q.at)} ago`)
    try {
      await context.ui.dialog.alert({ title: p.status.quotaTitle, message: lines.join("\n") })
    } catch {
      /* dialog unavailable */
    }
  }

  // Hydrate the usage data the moment a sidebar/footer tracks a session. The
  // message sync is essential: the data layer only keeps the latest page, and
  // without it a fresh tab has no assistant usage to derive context from.
  const syncedModels = new Set<string>()
  createEffect(() => {
    const id = activeSession()
    if (!id) return
    try {
      const session = data.session.get(id)
      if (!session) return
      void data.session.message.sync(id).catch(() => undefined)
      const location = (session as any).location
      const key = JSON.stringify(location ?? null)
      if (!syncedModels.has(key)) {
        syncedModels.add(key)
        try {
          const pending = (data.location as any).model?.sync?.(location)
          if (pending && typeof pending.catch === "function") void pending.catch(() => undefined)
        } catch {
          /* model limits unavailable */
        }
      }
      setGit(undefined)
    } catch {
      /* best effort */
    }
    void refreshGit(true)
    void refreshStats()
  })

  // ---- friendly item builders (icon + localized label, raw text in detail) ----
  const shellItem = (shell: ShellList[number], p: Pack): TaskItem => {
    const desc = describeShell(shell.command, `shell ${short(shell.id)}`, p)
    return { kind: "shell", id: shell.id, icon: desc.icon, label: desc.label, detail: shell.command }
  }
  const agentItem = (session: SessionList[number], p: Pack): TaskItem => {
    const desc = describeAgent(session.title, `${p.agent} ${short(session.id)}`)
    return { kind: "agent", id: session.id, icon: desc.icon, label: desc.label, detail: desc.detail }
  }
  const rootItem = (session: SessionList[number], p: Pack, dim: boolean): TaskItem => {
    const cleaned = cleanTitle(session.title ?? "")
    return { kind: "root", id: session.id, icon: "💬", label: cleaned || p.rootBusy, dim: dim || undefined }
  }
  const terminalItem = (pty: PtyInfo, p: Pack): TaskItem => ({
    kind: "terminal",
    id: pty.id,
    icon: "🖥️",
    label: pty.title?.trim() || p.terminal,
  })

  // ---- completed trail: remember labels before they vanish from the reactive lists ----
  const [completed, setCompleted] = createSignal<CompletedItem[]>([])
  const labelCache = new Map<string, TaskItem>()
  const remember = (item: TaskItem) => {
    setCompleted((list) => [...list.filter((entry) => entry.id !== item.id), { ...item, at: Date.now() }])
    setTimeout(() => {
      setCompleted((list) => list.filter((entry) => entry.id !== item.id))
      labelCache.delete(item.id)
    }, RETAIN_MS + 1_000)
  }

  // Reuse cached item objects when their visible fields haven't changed so
  // Solid's <For> (reference-keyed) preserves row components — and their
  // expanded state — across output-progress list events. Function declaration
  // (hoisted) because the tracking effects above run once at creation, before
  // control flow reaches this point.
  function stable(item: TaskItem): TaskItem {
    const cached = labelCache.get(item.id)
    if (
      cached &&
      cached.kind === item.kind &&
      cached.icon === item.icon &&
      cached.label === item.label &&
      cached.dim === item.dim
    )
      return cached
    labelCache.set(item.id, item)
    return item
  }

  // Track disappearing shells (exited or deleted both remove from the store).
  // Reading pack() inside the handler also tracks the language signal, so a
  // language switch refreshes cached labels with no spurious completions
  // (the alive-diff finds nothing missing when only the language changed).
  // Funnel through stable(): replacing the cache entry unconditionally would
  // hand <For> a fresh object on every shell-output tick and rebuild (reset)
  // each running row, killing its expanded state mid-click.
  createEffect(
    on(shells, (list, previous) => {
      for (const shell of list) {
        probe(`shell up ${shell.id}: ${JSON.stringify(shell.command)}`)
        stable(shellItem(shell, pack()))
      }
      if (previous) {
        const alive = new Set(list.map((shell) => shell.id))
        for (const shell of previous) {
          if (!alive.has(shell.id)) remember(shellItem(shell, pack()))
        }
      }
    }),
  )

  // Track subagents transitioning running -> not running.
  createEffect(
    on(agents, (list, previous) => {
      for (const session of list) {
        stable(agentItem(session, pack()))
      }
      if (previous) {
        const alive = new Set(list.map((session) => session.id))
        for (const session of previous) {
          if (alive.has(session.id) || jobChildHistory.has(session.id)) continue
          remember(agentItem(session, pack()))
        }
      }
    }),
  )

  // Track root sessions transitioning running -> idle. The tab being watched
  // skips the trail entirely: every question/answer would otherwise ring a
  // notification and paint a 60s ghost of a conversation the user just saw
  // answer. Other tabs get the full completion treatment.
  createEffect(
    on(roots, (list, previous) => {
      const current = activeRoot()
      for (const session of list) {
        stable(rootItem(session, pack(), session.id === current))
      }
      if (previous) {
        const alive = new Set(list.map((session) => session.id))
        for (const session of previous) {
          if (alive.has(session.id) || session.id === current) continue
          remember(rootItem(session, pack(), false))
        }
      }
    }),
  )

  // Track terminals closing.
  createEffect(
    on(terminals, (list, previous) => {
      for (const pty of list) {
        stable(terminalItem(pty, pack()))
      }
      if (previous) {
        const alive = new Set(list.map((pty) => pty.id))
        for (const pty of previous) {
          if (!alive.has(pty.id)) remember(terminalItem(pty, pack()))
        }
      }
    }),
  )

  // ---- completion notifications (on by default, persisted toggle) ----
  // Defensive: storage shape is host-controlled; never let it break rendering.
  let notifyEnabled: () => boolean = () => true
  try {
    const [enabled] = context.storage.store("notify", { initial: true })
    if (typeof enabled === "function") notifyEnabled = () => Boolean(enabled())
  } catch {
    /* keep default */
  }
  // Root sessions complete on every Q&A round, so the 💬 channel gets its own
  // toggle (default on) — silencing it without losing shell/agent/terminal pings.
  let notifyRootEnabled: () => boolean = () => true
  try {
    const [rootEnabled] = context.storage.store("notifyRoot", { initial: true })
    if (typeof rootEnabled === "function") notifyRootEnabled = () => Boolean(rootEnabled())
  } catch {
    /* keep default */
  }
  const notified = new Set<string>()
  createEffect(
    on(completed, (list, previous) => {
      if (!notifyEnabled()) return
      const fresh = previous === undefined ? [] : list.filter((entry) => !previous.some((old) => entry.id === old.id))
      for (const entry of fresh) {
        const key = `${entry.id}:${entry.at}`
        if (notified.has(key)) continue
        if (entry.kind === "root" && !notifyRootEnabled()) continue
        notified.add(key)
        if (notified.size > 200) {
          for (const oldest of [...notified].slice(0, 100)) notified.delete(oldest)
        }
        try {
          context.attention.notify({
            message: pack().notifyDone(entry.label),
            sound: { name: entry.kind === "agent" ? "subagent_done" : "done" },
          })
          probe(`notify ok ${key}`)
        } catch (error) {
          probe(`notify fail ${key}: ${String(error)}`)
        }
      }
    }),
  )

  // Background jobs are polled: the experimental job list is the only source
  // that still reports completed-but-unconsumed subagents (issue #1). Stats,
  // provider quota, and working-tree data are independent and cheap enough to
  // poll on their own cadence.
  void syncJobs()
  void refreshStats()
  void refreshQuota()
  void refreshGit()
  const jobTimer = setInterval(() => void syncJobs(), JOB_POLL_MS)
  const statsTimer = setInterval(() => void refreshStats(), STATS_POLL_MS)
  const quotaTimer = setInterval(() => void refreshQuota(), QUOTA_TTL_MS)
  const gitTimer = setInterval(() => void refreshGit(), GIT_POLL_MS)
  jobTimer.unref?.()
  statsTimer.unref?.()
  quotaTimer.unref?.()
  gitTimer.unref?.()

  const running = createMemo<TaskItem[]>(() => {
    const p = pack()
    const current = activeRoot()
    return [
      ...roots().map((session) => stable(rootItem(session, p, session.id === current))),
      ...shells().map((shell) => stable(shellItem(shell, p))),
      ...agents().map((session) => stable(agentItem(session, p))),
      ...activeJobs().map((item) => stable(item)),
      ...terminals().map((pty) => stable(terminalItem(pty, p))),
    ]
  })

  const stale = createMemo(() => completed().filter((entry) => Date.now() - entry.at <= RETAIN_MS))
  const total = createMemo(() => running().length)
  const grandTotal = createMemo(() => running().length + stale().length)

  createEffect(
    on(
      grandTotal,
      (value) =>
        probe(
          `total=${value} running=${running().length} roots=${roots().length} shells=${shells().length} agents=${agents().length} terminals=${terminals().length} done=${stale().length} session=${activeSession() ?? "-"} lang=${lang()}`,
        ),
      { defer: true },
    ),
  )

  return {
    running,
    stale,
    total,
    grandTotal,
    track,
    lang,
    pack,
    unacked,
    unackedCount,
    ackJob,
    ackAll,
    openJob,
    showCompleted,
    showSettings,
    showQuota,
    refreshAll,
    status: {
      pref,
      contextInfo,
      sessionUsage,
      todayStats,
      monthStats,
      git,
      quota,
    },
  }
}

function TaskRow(props: { item: TaskItem; theme: Plugin.Context["theme"]; pack: Pack; done?: boolean }) {
  const [expanded, setExpanded] = createSignal(false)
  // done and dim share the muted color: dim marks the busy root session of the
  // tab being watched (v1.2), done marks the 60s completion trail.
  const fg = props.done || props.item.dim ? props.theme.text.muted : props.theme.text.base
  // Truncate by code points: slicing UTF-16 units can cut a surrogate pair
  // (agent titles may contain emoji) in half and render tofu.
  const chars = () => Array.from(props.item.label)
  return (
    <box onMouseDown={() => setExpanded((value) => !value)}>
      <text fg={fg}>
        {props.done ? "✅" : props.item.icon} {chars().slice(0, expanded() ? 200 : 40).join("")}
        {chars().length > 40 && !expanded() ? "…" : ""}
        {props.done ? props.pack.doneSuffix : ""}
      </text>
      <Show when={expanded() && (props.item.detail ?? "").length > 40}>
        <text fg={props.theme.text.muted}>  {props.item.detail}</text>
      </Show>
    </box>
  )
}

function StatusCard(props: { context: Plugin.Context; tasks: ReturnType<typeof getStore> }) {
  const p = () => props.tasks.pack()
  const theme = props.context.theme
  const s = props.tasks.status
  const warning = theme.text.feedback?.warning?.base ?? theme.text.base
  const danger = theme.text.feedback?.error?.base ?? theme.text.base
  const percentColor = (percent: number | undefined) => {
    if (percent !== undefined && percent >= 95) return danger
    if (percent !== undefined && percent >= 80) return warning
    return theme.text.base
  }
  const contextText = () => {
    const ctx = s.contextInfo()
    if (!ctx) return "—"
    const tokens = `${formatTokens(ctx.tokens)}${ctx.limit ? ` / ${formatTokens(ctx.limit)}` : ""}`
    return `${ctx.percent !== undefined ? `${formatPercent(ctx.percent)} · ` : ""}${tokens}`
  }
  const sessionText = () => {
    const usage = s.sessionUsage()
    if (!usage) return "—"
    const agents = usage.subagents > 0 ? ` · ${usage.subagents}🤖` : ""
    return `${formatCost(usage.cost)} · ${formatTokens(usage.tokens)} tok${agents}`
  }
  const todayText = () => {
    const today = s.todayStats()
    if (!today) return "—"
    return `${formatCost(today.cost)} · ${formatTokens(today.tokens)} tok`
  }
  const showQuota = () => {
    const q = s.quota()
    return Boolean(q.deepseek || q.zhipuFive || q.zhipuWeek)
  }
  return (
    <box>
      <text fg={theme.text.base}>
        <b>{p().status.header}</b>
      </text>
      <Show when={s.pref("context")}>
        <text>
          <span style={{ fg: theme.text.muted }}>{`🧠 ${p().status.context}  `}</span>
          <span style={{ fg: percentColor(s.contextInfo()?.percent) }}>{contextText()}</span>
        </text>
      </Show>
      <Show when={s.pref("session")}>
        <text>
          <span style={{ fg: theme.text.muted }}>{`💬 ${p().status.session}  `}</span>
          <span style={{ fg: theme.text.base }}>{sessionText()}</span>
        </text>
      </Show>
      <Show when={s.pref("today")}>
        <text>
          <span style={{ fg: theme.text.muted }}>{`📅 ${p().status.today}  `}</span>
          <span style={{ fg: theme.text.base }}>{todayText()}</span>
        </text>
      </Show>
      <Show when={s.pref("quota") && showQuota()}>
        <Show when={s.quota().deepseek}>
          <text>
            <span style={{ fg: theme.text.muted }}>{`${p().status.quota}  `}</span>
            <span style={{ fg: percentColor(s.quota().deepseek?.low ? 100 : undefined) }}>
              {s.quota().deepseek?.short}
            </span>
          </text>
        </Show>
        <Show when={s.quota().zhipuFive}>
          <text>
            <span style={{ fg: theme.text.muted }}>{`${p().status.quota}  `}</span>
            <span style={{ fg: percentColor(s.quota().zhipuFive?.percent) }}>
              {s.quota().zhipuFive?.short}
              {s.quota().zhipuWeek ? ` · ${s.quota().zhipuWeek?.short}` : ""}
            </span>
          </text>
        </Show>
      </Show>
      <Show when={s.pref("git") && (s.git()?.branch || (s.git()?.files ?? 0) > 0)}>
        <text>
          <span style={{ fg: theme.text.muted }}>{`⎇ ${p().status.git}  `}</span>
          <span style={{ fg: theme.text.base }}>
            {s.git()?.branch ?? "?"}
            {s.git()?.files ? ` ±${s.git()?.files} +${s.git()?.additions} -${s.git()?.deletions}` : " ✓"}
          </span>
        </text>
      </Show>
    </box>
  )
}

function UnackedRow(props: { item: UnackedJob; tasks: ReturnType<typeof getStore>; theme: Plugin.Context["theme"] }) {
  const warning = props.theme.text.feedback?.warning?.base ?? props.theme.text.base
  return (
    <box onMouseDown={() => props.tasks.openJob(props.item)}>
      <text fg={warning}>
        {jobIcon(props.item.status)} {props.item.label}
      </text>
    </box>
  )
}

export function Taskbar(props: { context: Plugin.Context; sessionID?: string }) {
  probe(`taskbar body sessionID=${props.sessionID}`)
  const warning = props.context.theme.text.feedback?.warning?.base ?? props.context.theme.text.base
  const tasks = getStore(props.context)
  // Reactive on purpose: works whether the host re-creates this component on
  // input change (current behavior) or only updates props (Solid convention).
  createEffect(() => tasks.track(props.sessionID))
  const idle = () => tasks.grandTotal() === 0 && tasks.unackedCount() === 0
  return (
    <box>
      <StatusCard context={props.context} tasks={tasks} />
      <text fg={tasks.grandTotal() > 0 ? props.context.theme.text.base : props.context.theme.text.muted}>
        <b>{tasks.pack().header}</b>
        <Show when={idle()}>
          <span style={{ fg: props.context.theme.text.muted }}>{` ${tasks.pack().idle}`}</span>
        </Show>
      </text>
      <Show when={tasks.unackedCount() > 0}>
        <text fg={warning}>
          <b>{tasks.pack().status.unacked(tasks.unackedCount())}</b>
        </text>
        <For each={tasks.unacked()}>
          {(item) => <UnackedRow item={item} tasks={tasks} theme={props.context.theme} />}
        </For>
      </Show>
      <For each={tasks.running()}>{(item) => <TaskRow item={item} theme={props.context.theme} pack={tasks.pack()} />}</For>
      <For each={tasks.stale()}>{(item) => <TaskRow item={item} theme={props.context.theme} pack={tasks.pack()} done />}</For>
    </box>
  )
}

/** One-line fallback for when the sidebar is collapsed; silent when idle. */
export function FooterBadge(props: { context: Plugin.Context; sessionID?: string }) {
  probe("footer body")
  const tasks = getStore(props.context)
  // The footer input carries the composer's sessionID — tracking it gives
  // footer-only mode (no sidebar) the right language and terminal list.
  createEffect(() => tasks.track(props.sessionID))
  const label = () => {
    const p = tasks.pack()
    const parts: string[] = []
    // Dim rows (the current tab's own busy session) are foreground work the
    // user is watching — the footer badge counts background work only.
    const runningCount = tasks.running().filter((item) => !item.dim).length
    const doneCount = tasks.stale().length
    if (tasks.unackedCount() > 0) parts.push(`🎫${tasks.unackedCount()}`)
    if (runningCount > 0) parts.push(p.footer.tasks(runningCount, doneCount))
    else if (doneCount > 0) parts.push(p.footer.doneOnly(doneCount))
    // The footer is the collapsed-sidebar fallback; keep it to the one number
    // that matters at a glance. The built-in prompt footer already shows
    // context %, so only a low quota warning is added here.
    if (tasks.status.pref("footer")) {
      const q = tasks.status.quota()
      if (q.deepseek?.low) parts.push(q.deepseek.short)
      else if (q.zhipuFive?.low) parts.push(`⚡${Math.round(q.zhipuFive.percent ?? 0)}%`)
    }
    return parts.length > 0 ? parts.join(" · ") : undefined
  }
  return (
    <Show when={label() !== undefined}>
      <text fg={props.context.theme.text.base}>{label()}</text>
    </Show>
  )
}

export default Plugin.define({
  id: "oc-taskbar",
  setup(context) {
    probe("setup")
    // Warm up tracking immediately: the store starts accumulating the
    // completed trail from plugin load, before any badge mounts.
    getStore(context)
    context.keymap.layer(() => ({
      commands: [
        {
          id: "oc-taskbar.statusline",
          title: "Statusline settings",
          description: "Toggle the usage metrics shown in the sidebar and footer",
          group: "oc-taskbar",
          slash: { name: "statusline" },
          run: () => {
            void getStore(context).showSettings()
          },
        },
        {
          id: "oc-taskbar.quota",
          title: "Usage and quota details",
          description: "Show session context, daily/monthly usage, and provider quota",
          group: "oc-taskbar",
          slash: { name: "quota" },
          run: () => {
            void getStore(context).showQuota()
          },
        },
        {
          id: "oc-taskbar.completed",
          title: "Unacknowledged background jobs",
          description: "Review completed background subagents; append 'all' to mark every item read",
          group: "oc-taskbar",
          slash: { name: "completed", arguments: true },
          run: (input) => {
            const tasks = getStore(context)
            if (input?.trim().toLowerCase() === "all") tasks.ackAll()
            else void tasks.showCompleted()
          },
        },
      ],
    }))
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Taskbar context={context} sessionID={props.sessionID} />,
    })
    context.ui.slot({
      prepend: "prompt.footer",
      render: (props) => <FooterBadge context={context} sessionID={props.sessionID} />,
    })
  },
})
