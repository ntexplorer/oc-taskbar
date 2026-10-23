import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, For, on, onCleanup, Show, createSignal } from "solid-js"
import { appendFileSync } from "node:fs"

// Opt-in diagnostics: set OC_TASKBAR_PROBE=<file> to append a line whenever
// the plugin sets up, a badge mounts, or the task total changes. Zero I/O otherwise.
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

// Module-level state shared across badge instances (sidebar + footer):
// - notifications de-duplicated so both instances don't double-notify
// - hydration guards: shell sync is global, session sync is per family root
const notified = new Set<string>()
let hydratedOnce = false
const hydratedRoots = new Set<string>()

/** Shared task store: reactive lists for running work plus a 60s completed trail. */
function useTasks(context: Plugin.Context, sessionID: () => string | undefined) {
  probe("useTasks enter")
  const data = context.data

  // ---- initial hydration FIRST: the data layer stays empty until the first
  // sync (verified root cause of the always-zero badge). Runs inline, NOT in
  // onMount — OpenTUI's Solid runtime never fires onMount for slotted plugin
  // components (verified by probe), so lifecycle-gated code never runs. ----
  if (!hydratedOnce) {
    hydratedOnce = true
    probe(`hydrate sessionID=${sessionID()}`)
    void data.shell.sync().catch(() => undefined)
  }
  const familyRoot = () => {
    const id = sessionID()
    if (!id) return undefined
    try {
      return data.session.get(id)?.parentID ?? id
    } catch {
      return id
    }
  }
  createEffect(() => {
    const rootID = familyRoot()
    if (!rootID || hydratedRoots.has(rootID)) return
    hydratedRoots.add(rootID)
    void data.session.sync(rootID, { children: true }).catch(() => undefined)
  })

  // ---- persistent terminals for this session (not in the reactive store) ----
  const [terminals, setTerminals] = createSignal<PtyInfo[]>([])
  const refreshTerminals = async () => {
    try {
      const id = sessionID()
      if (!id) {
        setTerminals([])
        return
      }
      setTerminals((await context.client.experimental.persistentPty.list({ sessionID: id })) ?? [])
    } catch {
      setTerminals([])
    }
  }
  void refreshTerminals()
  // pty lifecycle events (names not in the typed union yet; runtime subscription works)
  for (const type of ["persistent-pty.added", "persistent-pty.removed"] as const) {
    onCleanup((data.on as (t: string, h: () => void) => () => void)(type, () => void refreshTerminals()))
  }

  // ---- running shells (location-wide, matches the built-in task panel) ----
  const shells = createMemo(() => {
    try {
      return data.shell.list() ?? []
    } catch {
      return []
    }
  })

  // ---- running subagents: child sessions whose runner is active ----
  const agents = createMemo(() => {
    try {
      return (data.session.list() ?? []).filter(
        (session) => session.parentID !== undefined && data.session.status(session.id) === "running",
      )
    } catch {
      return []
    }
  })

  // ---- completed trail: remember labels before they vanish from the reactive lists ----
  const [completed, setCompleted] = createSignal<CompletedItem[]>([])
  const labelCache = new Map<string, TaskItem>()
  const remember = (item: TaskItem) => {
    setCompleted((list) => [...list.filter((entry) => entry.id !== item.id), { ...item, at: Date.now() }])
    setTimeout(() => {
      setCompleted((list) => list.filter((entry) => entry.id !== item.id))
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
        } catch {
          /* notifications are best-effort */
        }
      }
    }),
  )

  const running = createMemo<TaskItem[]>(() => [
    ...shells().map<TaskItem>((shell) => ({
      kind: "shell",
      id: shell.id,
      label: shell.command ?? `shell ${short(shell.id)}`,
      detail: shell.command,
    })),
    ...agents().map<TaskItem>((session) => ({
      kind: "agent",
      id: session.id,
      label: session.title ?? `agent ${short(session.id)}`,
      detail: session.title,
    })),
    ...terminals().map<TaskItem>((pty) => ({
      kind: "terminal",
      id: pty.id,
      label: pty.title ?? `terminal ${short(pty.id)}`,
    })),
  ])

  const stale = createMemo(() => completed().filter((entry) => Date.now() - entry.at <= RETAIN_MS))
  const total = createMemo(() => running().length)
  const grandTotal = createMemo(() => running().length + stale().length)

  createEffect(
    on(
      grandTotal,
      (value) =>
        probe(
          `total=${value} running=${running().length} shells=${shells().length} agents=${agents().length} terminals=${terminals().length} done=${stale().length}`,
        ),
      { defer: true },
    ),
  )

  return { running, stale, total, grandTotal }
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
  const context = props.context
  const tasks = useTasks(context, () => props.sessionID)

  return (
    <box>
      <text fg={tasks.grandTotal() > 0 ? context.theme.text.base : context.theme.text.muted}>
        <b>Tasks</b>
        <Show when={tasks.grandTotal() === 0}>
          <span style={{ fg: context.theme.text.muted }}> — none</span>
        </Show>
      </text>
      <For each={tasks.running()}>{(item) => <TaskRow item={item} theme={context.theme} />}</For>
      <For each={tasks.stale()}>{(item) => <TaskRow item={item} theme={context.theme} done />}</For>
    </box>
  )
}

/** One-line fallback for when the sidebar is collapsed; silent when idle. */
export function FooterBadge(props: { context: Plugin.Context }) {
  probe("footer body")
  const context = props.context
  const tasks = useTasks(context, () => undefined)
  return (
    <Show when={tasks.grandTotal() > 0}>
      <text fg={context.theme.text.base}>
        ⚙ {tasks.running().length} task{tasks.running().length === 1 ? "" : "s"}
        {tasks.stale().length > 0 ? ` (+${tasks.stale().length} done)` : ""}
      </text>
    </Show>
  )
}

export default Plugin.define({
  id: "oc-taskbar",
  setup(context) {
    probe("setup")
    void context.data.shell.sync().catch(() => undefined)
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
