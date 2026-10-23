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

type PtyInfo = { id: string; title?: string }

type TaskKind = "shell" | "agent" | "terminal"

type TaskItem = {
  readonly kind: TaskKind
  readonly id: string
  readonly label: string
  readonly detail?: string
}

type CompletedItem = TaskItem & { readonly at: number }

const kindIcon: Record<TaskKind, string> = {
  shell: "$",
  agent: "@",
  terminal: ">",
}

const short = (id: string) => id.slice(-6)

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
  // listing and sub-session hydration key off this signal. The footer badge
  // never overrides it (no id of its own), so it mirrors the active sidebar.
  const [activeSession, setActiveSession] = createSignal<string | undefined>(undefined)
  const track = (id: string | undefined) => {
    if (id) setActiveSession(id)
  }

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

  // Track disappearing shells (exited or deleted both remove from the store).
  createEffect(
    on(shells, (list, previous) => {
      for (const shell of list) {
        labelCache.set(shell.id, {
          kind: "shell",
          id: shell.id,
          label: shell.command ?? `shell ${short(shell.id)}`,
          detail: shell.command,
        })
      }
      if (previous) {
        const alive = new Set(list.map((shell) => shell.id))
        for (const shell of previous) {
          if (!alive.has(shell.id))
            remember(labelCache.get(shell.id) ?? { kind: "shell", id: shell.id, label: `shell ${short(shell.id)}` })
        }
      }
    }),
  )

  // Track subagents transitioning running -> not running.
  createEffect(
    on(agents, (list, previous) => {
      for (const session of list) {
        labelCache.set(session.id, {
          kind: "agent",
          id: session.id,
          label: session.title ?? `agent ${short(session.id)}`,
          detail: session.title,
        })
      }
      if (previous) {
        const alive = new Set(list.map((session) => session.id))
        for (const session of previous) {
          if (!alive.has(session.id))
            remember(labelCache.get(session.id) ?? { kind: "agent", id: session.id, label: `agent ${short(session.id)}` })
        }
      }
    }),
  )

  // Track terminals closing.
  createEffect(
    on(terminals, (list, previous) => {
      for (const pty of list) {
        labelCache.set(pty.id, { kind: "terminal", id: pty.id, label: pty.title ?? `terminal ${short(pty.id)}` })
      }
      if (previous) {
        const alive = new Set(list.map((pty) => pty.id))
        for (const pty of previous) {
          if (!alive.has(pty.id))
            remember(labelCache.get(pty.id) ?? { kind: "terminal", id: pty.id, label: `terminal ${short(pty.id)}` })
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
            message: `${entry.label} finished`,
            sound: { name: entry.kind === "agent" ? "subagent_done" : "done" },
          })
          probe(`notify ok ${key}`)
        } catch (error) {
          probe(`notify fail ${key}: ${String(error)}`)
        }
      }
    }),
  )

  // Reuse cached item objects when their identity hasn't changed so Solid's
  // <For> (reference-keyed) preserves rows — and their expanded state —
  // across unrelated list updates.
  const stable = (item: TaskItem): TaskItem => {
    const cached = labelCache.get(item.id)
    if (cached && cached.kind === item.kind && cached.label === item.label) return cached
    labelCache.set(item.id, item)
    return item
  }

  const running = createMemo<TaskItem[]>(() => [
    ...shells().map((shell) =>
      stable({
        kind: "shell",
        id: shell.id,
        label: shell.command ?? `shell ${short(shell.id)}`,
        detail: shell.command,
      }),
    ),
    ...agents().map((session) =>
      stable({
        kind: "agent",
        id: session.id,
        label: session.title ?? `agent ${short(session.id)}`,
        detail: session.title,
      }),
    ),
    ...terminals().map((pty) =>
      stable({
        kind: "terminal",
        id: pty.id,
        label: pty.title ?? `terminal ${short(pty.id)}`,
      }),
    ),
  ])

  const stale = createMemo(() => completed().filter((entry) => Date.now() - entry.at <= RETAIN_MS))
  const total = createMemo(() => running().length)
  const grandTotal = createMemo(() => running().length + stale().length)

  createEffect(
    on(
      grandTotal,
      (value) =>
        probe(
          `total=${value} running=${running().length} shells=${shells().length} agents=${agents().length} terminals=${terminals().length} done=${stale().length} session=${activeSession() ?? "-"}`,
        ),
      { defer: true },
    ),
  )

  return { running, stale, total, grandTotal, track }
}

function TaskRow(props: { item: TaskItem; theme: Plugin.Context["theme"]; done?: boolean }) {
  const [expanded, setExpanded] = createSignal(false)
  const fg = props.done ? props.theme.text.muted : props.theme.text.base
  return (
    <box>
      <text fg={fg} onclick={() => setExpanded((value) => !value)}>
        {props.done ? "✓" : kindIcon[props.item.kind]} {props.item.label.slice(0, expanded() ? 200 : 40)}
        {props.item.label.length > 40 && !expanded() ? "…" : ""}
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
        <b>Tasks</b>
        <Show when={tasks.grandTotal() === 0}>
          <span style={{ fg: props.context.theme.text.muted }}> — none</span>
        </Show>
      </text>
      <For each={tasks.running()}>{(item) => <TaskRow item={item} theme={props.context.theme} />}</For>
      <For each={tasks.stale()}>{(item) => <TaskRow item={item} theme={props.context.theme} done />}</For>
    </box>
  )
}

/** One-line fallback for when the sidebar is collapsed; silent when idle. */
export function FooterBadge(props: { context: Plugin.Context }) {
  probe("footer body")
  const tasks = getStore(props.context)
  const label = () => {
    const runningCount = tasks.running().length
    const doneCount = tasks.stale().length
    if (runningCount === 0) return `⚙ +${doneCount} done`
    return `⚙ ${runningCount} task${runningCount === 1 ? "" : "s"}${doneCount > 0 ? ` (+${doneCount} done)` : ""}`
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
      render: () => <FooterBadge context={context} />,
    })
  },
})
