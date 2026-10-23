import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, For, on, Show, createSignal, onCleanup } from "solid-js"
import { appendFileSync } from "node:fs"

// Opt-in diagnostics: set OC_TASKBAR_PROBE=<file> to append a line whenever
// the badge mounts or the task total changes. Zero I/O otherwise.
const PROBE = process.env.OC_TASKBAR_PROBE
const probe = (msg: string) => {
  if (!PROBE) return
  try {
    appendFileSync(PROBE, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* probe failures must never break rendering */
  }
}

type PtyInfo = { id: string; title?: string }

type TaskRow = {
  readonly kind: "shell" | "agent" | "terminal"
  readonly label: string
}

export function Taskbar(props: { context: Plugin.Context; sessionID?: string }) {
  probe(`render sessionID=${props.sessionID}`)
  const context = props.context
  const theme = context.theme

  // Running shells for the current location. The data layer only keeps
  // in-flight shells, so this list is exactly "background work still running".
  const shells = createMemo(() => {
    try {
      return context.data.shell.list() ?? []
    } catch {
      return []
    }
  })

  // Running subagents: child sessions (parentID set) whose runner is active.
  const agents = createMemo(() => {
    try {
      return (context.data.session.list() ?? []).filter(
        (session) => session.parentID !== undefined && context.data.session.status(session.id) === "running",
      )
    } catch {
      return []
    }
  })

  // Persistent terminals attached to this session. Not part of the reactive
  // data store, so refresh on pty lifecycle events.
  const [terminals, setTerminals] = createSignal<PtyInfo[]>([])
  const refreshTerminals = async () => {
    try {
      const sessionID = props.sessionID
      if (!sessionID) {
        setTerminals([])
        return
      }
      const list = (await context.client.experimental.persistentPty.list({ sessionID })) ?? []
      setTerminals(list)
    } catch {
      setTerminals([])
    }
  }
  void refreshTerminals()
  for (const type of ["persistent-pty.added", "persistent-pty.removed"] as const) {
    // Event names are not part of the typed union yet; runtime subscription works.
    onCleanup((context.data.on as (t: string, h: () => void) => () => void)(type, () => void refreshTerminals()))
  }

  const rows = createMemo<TaskRow[]>(() => {
    const result: TaskRow[] = []
    const shellCount = shells().length
    const agentCount = agents().length
    const terminalCount = terminals().length
    if (shellCount > 0) result.push({ kind: "shell", label: `${shellCount} shell${shellCount > 1 ? "s" : ""} running` })
    if (agentCount > 0) result.push({ kind: "agent", label: `${agentCount} agent${agentCount > 1 ? "s" : ""} running` })
    if (terminalCount > 0)
      result.push({ kind: "terminal", label: `${terminalCount} terminal${terminalCount > 1 ? "s" : ""} open` })
    return result
  })

  const total = createMemo(() => shells().length + agents().length + terminals().length)

  // Machine-checkable acceptance trail: every change in the task total is
  // observable without reading the screen.
  createEffect(
    on(total, (value) => probe(`total=${value} shells=${shells().length} agents=${agents().length} terminals=${terminals().length}`), { defer: true }),
  )

  return (
    <box>
      <text fg={total() > 0 ? theme.text.base : theme.text.muted}>
        <b>Tasks</b>
        <Show when={total() === 0}>
          <span style={{ fg: theme.text.muted }}> — none</span>
        </Show>
      </text>
      <For each={rows()}>
        {(row) => <text fg={theme.text.muted}>• {row.label}</text>}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: "oc-taskbar",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Taskbar context={context} sessionID={props.sessionID} />,
    })
  },
})
