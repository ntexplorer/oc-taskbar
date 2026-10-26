import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createRoot, createSignal, For, on, Show } from "solid-js"
import { appendFileSync } from "node:fs"

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

// Belt-and-braces re-sync cadence for the shell list: the client data layer is
// purely event-driven and events lost while disconnected are never replayed
// (see the reconnect self-heal in createTaskStore).
const RESYNC_MS = 60_000

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
}

const PACKS: Record<Lang, Pack> = {
  zh: {
    header: "📋 后台任务",
    idle: "😴 暂无任务",
    doneSuffix: " · 完成了",
    terminal: "终端",
    agent: "子代理",
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
      tasks: (n, m) => (m > 0 ? `🏃 ${n} 个任务（${m} 个完成）` : `🏃 ${n} 个任务`),
      doneOnly: (n) => `✅ ${n} 个刚完成`,
    },
  },
  en: {
    header: "📋 Background",
    idle: "😴 all clear",
    doneSuffix: " · done",
    terminal: "terminal",
    agent: "subagent",
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
      tasks: (n, m) => {
        const unit = n === 1 ? "task" : "tasks"
        return m > 0 ? `🏃 ${n} ${unit} (${m} done)` : `🏃 ${n} ${unit}`
      },
      doneOnly: (n) => `✅ ${n} just finished`,
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

type TaskKind = "shell" | "agent" | "terminal"

type TaskItem = {
  readonly kind: TaskKind
  readonly id: string
  readonly icon: string
  readonly label: string
  readonly detail?: string
}

type CompletedItem = TaskItem & { readonly at: number }

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

  // ---- initial hydration: the data layer stays empty until the first sync.
  // Runs here (store creation), never in onMount — OpenTUI never fires
  // onMount for slotted plugin components. ----
  void data.shell.sync().catch(() => undefined)

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

  // ---- reconnect self-heal (v1.1.2) ----
  // The client data layer maintains the shell list ONLY from shell.created/exited/
  // deleted events plus an explicit sync(). A disconnect invalidates its read cache
  // and the host's server.connected handler re-pulls session.active/location/vcs/
  // project — but NOT shells ("active UI owners decide what to sync again"). Shells
  // that started or exited inside the reconnect gap stayed invisible here forever
  // (the built-in panel reads the message stream, which re-syncs on invalidation —
  // hence "panel shows 2 / sidebar shows none"). Take ownership: full re-sync on
  // server.connected, plus a low-cadence shell poll as belt-and-braces.
  const resyncShells = () => {
    probe("resync shells")
    void data.shell.sync().catch(() => undefined)
    void refreshTerminals()
  }
  const resyncAll = () => {
    probe("resync all (server.connected)")
    resyncShells()
    for (const root of hydratedRoots) void data.session.sync(root, { children: true }).catch(() => undefined)
    void fallbackHydrate()
  }
  try {
    void (data.on as (t: string, h: () => void) => () => void)("server.connected", resyncAll)
  } catch {
    /* reconnect events unavailable; the poll below still heals the shell list */
  }
  setInterval(resyncShells, RESYNC_MS)

  // ---- running shells (location-wide, matches the built-in task panel).
  // On read failure keep the last good list: a transient error must not look
  // like "everything exited" (false completions + phantom notifications). ----
  let lastShells: ShellList = []
  const shells = createMemo(() => {
    try {
      const list = data.shell.list() ?? []
      lastShells = list
      return list
    } catch {
      return lastShells
    }
  })

  // ---- running subagents: child sessions whose runner is active ----
  let lastAgents: SessionList = []
  const agents = createMemo(() => {
    try {
      const list = (data.session.list() ?? []).filter(
        (session) => session.parentID !== undefined && data.session.status(session.id) === "running",
      )
      lastAgents = list
      return list
    } catch {
      return lastAgents
    }
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
    if (cached && cached.kind === item.kind && cached.icon === item.icon && cached.label === item.label) return cached
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
          if (!alive.has(session.id)) remember(agentItem(session, pack()))
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
  const notified = new Set<string>()
  createEffect(
    on(completed, (list, previous) => {
      if (!notifyEnabled()) return
      const fresh = previous === undefined ? [] : list.filter((entry) => !previous.some((old) => entry.id === old.id))
      for (const entry of fresh) {
        const key = `${entry.id}:${entry.at}`
        if (notified.has(key)) continue
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

  const running = createMemo<TaskItem[]>(() => {
    const p = pack()
    return [
      ...shells().map((shell) => stable(shellItem(shell, p))),
      ...agents().map((session) => stable(agentItem(session, p))),
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
          `total=${value} running=${running().length} shells=${shells().length} agents=${agents().length} terminals=${terminals().length} done=${stale().length} session=${activeSession() ?? "-"} lang=${lang()}`,
        ),
      { defer: true },
    ),
  )

  return { running, stale, total, grandTotal, track, lang, pack }
}

function TaskRow(props: { item: TaskItem; theme: Plugin.Context["theme"]; pack: Pack; done?: boolean }) {
  const [expanded, setExpanded] = createSignal(false)
  const fg = props.done ? props.theme.text.muted : props.theme.text.base
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

export function Taskbar(props: { context: Plugin.Context; sessionID?: string }) {
  probe(`taskbar body sessionID=${props.sessionID}`)
  const tasks = getStore(props.context)
  // Reactive on purpose: works whether the host re-creates this component on
  // input change (current behavior) or only updates props (Solid convention).
  createEffect(() => tasks.track(props.sessionID))
  return (
    <box>
      <text fg={tasks.grandTotal() > 0 ? props.context.theme.text.base : props.context.theme.text.muted}>
        <b>{tasks.pack().header}</b>
        <Show when={tasks.grandTotal() === 0}>
          <span style={{ fg: props.context.theme.text.muted }}>{` ${tasks.pack().idle}`}</span>
        </Show>
      </text>
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
    const runningCount = tasks.running().length
    const doneCount = tasks.stale().length
    if (runningCount === 0) return p.footer.doneOnly(doneCount)
    return p.footer.tasks(runningCount, doneCount)
  }
  return (
    <Show when={tasks.grandTotal() > 0}>
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
