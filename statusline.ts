// Pure data helpers for the usage statusline. Kept out of tui.tsx so the
// formatting / aggregation rules can be tested without a running host.
//
// Everything here is structural and defensive: the TUI host's generated client
// types are not available at runtime to plugins (only `effect` and
// `@opencode/plugin` are mapped), so callers pass plain objects and failures
// stay local to the displayed metric.

export type UsageTokens = {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

export type ContextUsage = {
  readonly tokens: number
  readonly limit?: number
  readonly percent?: number
  readonly model?: string
}

export type DailyStats = {
  readonly tokens: number
  readonly cost: number
  readonly sessions: number
  readonly subagents: number
  readonly prompts: number
  readonly models: ReadonlyArray<{
    readonly provider: string
    readonly model: string
    readonly tokens: number
    readonly cost: number
  }>
}

export type GitStats = {
  readonly branch?: string
  readonly files: number
  readonly additions: number
  readonly deletions: number
}

export type QuotaLine = {
  readonly label: string
  readonly short: string
  readonly detail: string
  readonly percent?: number
  readonly low: boolean
  readonly at: number
}

export type QuotaState = {
  readonly deepseek?: QuotaLine
  readonly zhipuFive?: QuotaLine
  readonly zhipuWeek?: QuotaLine
  readonly at?: number
  readonly errors: ReadonlyArray<string>
}

export type ProviderKeys = {
  readonly deepseek?: string
  readonly zhipu?: string
}

type FetchLike = (input: string, init?: any) => Promise<any>

const finite = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export function tokensTotal(tokens: UsageTokens | undefined | null): number {
  if (!tokens) return 0
  return (
    finite(tokens.input) +
    finite(tokens.output) +
    finite(tokens.reasoning) +
    finite(tokens.cache?.read) +
    finite(tokens.cache?.write)
  )
}

export function formatTokens(value: number): string {
  const n = Math.max(0, finite(value))
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) {
    const v = n / 1_000
    return `${v < 10 ? v.toFixed(1) : String(Math.round(v))}k`
  }
  const v = n / 1_000_000
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}M`
}

export function formatCost(value: number): string {
  const n = Math.max(0, finite(value))
  if (n === 0) return "$0"
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n)}`
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  return `${Math.round(value)}%`
}

export function startOfToday(now = Date.now()): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function startOfMonth(now = Date.now()): number {
  const date = new Date(now)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Mirrors the host's `lastAssistantWithUsage`: ignore messages before the last completed compaction and after a revert boundary. */
export function lastAssistantWithUsage(messages: readonly any[], boundary?: string): any | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  let end = messages.length
  if (boundary) {
    const index = messages.findIndex((message) => message?.id === boundary)
    if (index === -1) return undefined
    end = index
  }
  let compaction = -1
  for (let i = 0; i < end; i++) {
    if (messages[i]?.type === "compaction" && messages[i]?.status === "completed") compaction = i
  }
  for (let i = end - 1; i > compaction; i--) {
    const message = messages[i]
    if (message?.type === "assistant" && message.tokens !== undefined) return message
  }
  return undefined
}

export function contextUsage(
  messages: readonly any[],
  models: readonly any[] | undefined,
  boundary?: string,
): ContextUsage | undefined {
  const assistant = lastAssistantWithUsage(messages, boundary)
  if (!assistant) return undefined
  const tokens = tokensTotal(assistant.tokens)
  const ref = assistant.model
  const model = (models ?? []).find((candidate) => {
    if (!candidate || candidate.providerID !== ref?.providerID) return false
    return candidate.id === ref?.id || candidate.modelID === ref?.id || candidate.modelID === ref?.modelID
  })
  const limit = finite(model?.limit?.context) || undefined
  return {
    tokens,
    limit,
    percent: limit && limit > 0 ? Math.round((tokens / limit) * 100) : undefined,
    model: model?.name ?? ref?.modelID ?? ref?.id,
  }
}

export function dailyStats(raw: any): DailyStats {
  const models = Array.isArray(raw?.models)
    ? raw.models.map((entry: any) => ({
        provider: String(entry?.model?.providerID ?? "?"),
        model: String(entry?.model?.modelID ?? entry?.model?.id ?? "?"),
        tokens: tokensTotal(entry?.tokens),
        cost: finite(entry?.cost),
      }))
    : []
  return {
    tokens: tokensTotal(raw?.tokens),
    cost: finite(raw?.cost),
    sessions: finite(raw?.sessions),
    subagents: finite(raw?.subagents),
    prompts: finite(raw?.prompts),
    models,
  }
}

export function providerCost(stats: DailyStats | undefined, match: RegExp): number {
  if (!stats) return 0
  return stats.models.filter((model) => match.test(model.provider)).reduce((total, model) => total + model.cost, 0)
}

export function gitStats(files: readonly any[] | undefined, branch?: string): GitStats {
  const list = Array.isArray(files) ? files : []
  return {
    branch,
    files: list.length,
    additions: list.reduce((total, file) => total + finite(file?.additions), 0),
    deletions: list.reduce((total, file) => total + finite(file?.deletions), 0),
  }
}

/** Active key first, then a single un-flagged entry, then environment fallbacks. Values never leave this call. */
export async function readProviderKeys(client: any): Promise<ProviderKeys> {
  let entries: any[] = []
  try {
    const list = await client?.credential?.list?.()
    if (Array.isArray(list)) entries = list
  } catch {
    /* environment fallback below */
  }
  const value = (entry: any): string | undefined => {
    if (entry?.value?.type !== "key") return
    return typeof entry.value.key === "string" && entry.value.key !== "" ? entry.value.key : undefined
  }
  const fromEnv = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const candidate = process.env[name]
      if (candidate) return candidate
    }
    return undefined
  }
  const pick = (match: (id: string) => boolean, envs: readonly string[]): string | undefined => {
    const matches = entries.filter((entry) => match(String(entry?.integrationID ?? "").toLowerCase()))
    const preferred = matches.find((entry) => entry?.active === true) ?? (matches.length === 1 ? matches[0] : undefined)
    return value(preferred) ?? fromEnv(envs)
  }
  return {
    deepseek: pick((id) => id.includes("deepseek"), ["DEEPSEEK_API_KEY"]),
    zhipu: pick(
      (id) => /zhipu|zai|bigmodel/.test(id),
      ["ZAI_API_KEY", "BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"],
    ),
  }
}

async function getJson(url: string, key: string, fetchImpl: FetchLike): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    })
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

const resetText = (value: unknown, withDate: boolean): string => {
  const ms = finite(value)
  if (!ms) return "—"
  const date = new Date(ms)
  const options: Intl.DateTimeFormatOptions = withDate
    ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" }
  try {
    return date.toLocaleString(undefined, options)
  } catch {
    return date.toISOString()
  }
}

const deepseekLine = (json: any, now: number): QuotaLine => {
  const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
  const info = infos.find((entry: any) => entry?.currency === "CNY") ?? infos[0]
  if (!info) throw new Error("empty balance")
  const total = finite(info.total_balance)
  const currency = String(info.currency ?? "")
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `
  const low = total <= (currency === "CNY" ? 20 : currency === "USD" ? 3 : 0)
  const all = infos
    .map((entry: any) => `${entry?.currency ?? "?"} ${finite(entry?.total_balance).toFixed(2)}`)
    .join(" / ")
  return {
    label: "DeepSeek",
    short: `💠 ${symbol}${total.toFixed(2)}`,
    detail: `余额 ${symbol}${total.toFixed(2)} · 可用 ${json?.is_available === false ? "否" : "是"} · 充值 ${symbol}${finite(info.topped_up_balance).toFixed(2)} / 赠送 ${symbol}${finite(info.granted_balance).toFixed(2)}${infos.length > 1 ? ` · ${all}` : ""}`,
    low,
    at: now,
  }
}

const zhipuPercent = (entry: any): number | undefined => {
  if (!entry) return undefined
  const percent = finite(entry.percentage)
  return Number.isFinite(percent) ? percent : undefined
}

const zhipuLine = (entry: any, label: string, withDate: boolean, now: number, prefix = ""): QuotaLine | undefined => {
  if (!entry) return undefined
  const percent = zhipuPercent(entry)
  if (percent === undefined) return undefined
  const used = finite(entry.currentValue)
  const limit = finite(entry.usage)
  return {
    label,
    short: `${prefix}${label} ${Math.round(percent)}%`,
    detail: `${label} ${Math.round(percent)}%（${formatTokens(used)}/${formatTokens(limit)}） · 重置 ${resetText(entry.nextResetTime, withDate)}`,
    percent,
    low: percent >= 80,
    at: now,
  }
}

/** DeepSeek balance + Zhipu Coding Plan windows. Each provider fails independently. */
export async function fetchQuota(
  keys: ProviderKeys,
  options?: { readonly fetchImpl?: FetchLike; readonly now?: number },
): Promise<QuotaState> {
  const now = options?.now ?? Date.now()
  const fetchImpl = options?.fetchImpl ?? ((globalThis as any).fetch as FetchLike)
  const errors: string[] = []
  const tasks: Promise<void>[] = []
  let deepseek: QuotaLine | undefined
  let zhipuFive: QuotaLine | undefined
  let zhipuWeek: QuotaLine | undefined

  if (keys.deepseek) {
    tasks.push(
      getJson("https://api.deepseek.com/user/balance", keys.deepseek, fetchImpl)
        .then((json) => {
          deepseek = deepseekLine(json, now)
        })
        .catch((error) => {
          errors.push(`deepseek: ${String(error?.message ?? error)}`)
        }),
    )
  }

  if (keys.zhipu) {
    tasks.push(
      getJson("https://open.bigmodel.cn/api/monitor/usage/quota/limit", keys.zhipu, fetchImpl)
        .then((json) => {
          if (json?.code !== undefined && String(json.code) !== "200") throw new Error(`code ${json.code}`)
          const limits = Array.isArray(json?.data?.limits) ? json.data.limits : []
          const credits = limits.filter((entry: any) => entry?.type === "CREDIT_LIMIT")
          const five = credits.find((entry: any) => finite(entry?.unit) === 3 && finite(entry?.number) === 5) ?? credits[0]
          const week =
            credits.find((entry: any) => finite(entry?.unit) === 6 && finite(entry?.number) === 1) ?? credits[1]
          zhipuFive = zhipuLine(five, "5h", false, now, "⚡ GLM ")
          zhipuWeek = zhipuLine(week, "周", true, now)
          if (!zhipuFive && !zhipuWeek) throw new Error("no CREDIT_LIMIT")
        })
        .catch((error) => {
          errors.push(`zhipu: ${String(error?.message ?? error)}`)
        }),
    )
  }

  await Promise.all(tasks)
  return { deepseek, zhipuFive, zhipuWeek, at: now, errors }
}

/** Merge a fresh quota response with the last good values (sticky per provider). */
export function mergeQuota(previous: QuotaState | undefined, fresh: QuotaState): QuotaState {
  const any = Boolean(fresh.deepseek || fresh.zhipuFive || fresh.zhipuWeek)
  return {
    deepseek: fresh.deepseek ?? previous?.deepseek,
    zhipuFive: fresh.zhipuFive ?? previous?.zhipuFive,
    zhipuWeek: fresh.zhipuWeek ?? previous?.zhipuWeek,
    // A fully failed refresh must not make stale values look freshly updated.
    at: (any ? fresh.at : undefined) ?? previous?.at,
    errors: fresh.errors,
  }
}

export function ageText(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}
