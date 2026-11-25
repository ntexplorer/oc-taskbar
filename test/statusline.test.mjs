// Unit tests for statusline.ts: pure formatters/parsers plus quota parsing with an injected fetch.
// Run with `npm test`. No dependencies: Node >= 22.18 imports the .ts module through type stripping.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import * as s from "../statusline.ts"

// Registers one test asserting deep equality.
const eq = (name, actual, expected) => it(name, () => assert.deepStrictEqual(actual, expected))

describe("tokens and money", () => {
  eq("tokensTotal sums every field", s.tokensTotal({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }), 15)
  eq("tokensTotal of nothing is 0", s.tokensTotal(undefined), 0)
  eq("formatTokens below 1k", s.formatTokens(999), "999")
  eq("formatTokens 1.2k", s.formatTokens(1234), "1.2k")
  eq("formatTokens 12k", s.formatTokens(12345), "12k")
  eq("formatTokens 1.50M", s.formatTokens(1_500_000), "1.50M")
  eq("formatTokens 12.3M", s.formatTokens(12_300_000), "12.3M")
  eq("formatCost zero", s.formatCost(0), "$0")
  eq("formatCost tiny", s.formatCost(0.0042), "$0.0042")
  eq("formatCost below 1", s.formatCost(0.5), "$0.500")
  eq("formatCost below 100", s.formatCost(1.234), "$1.23")
  eq("formatCost 100 and above", s.formatCost(250.6), "$251")
  eq("currencyFor Chinese", s.currencyFor("zh-CN"), "CNY")
  eq("currencyFor other", s.currencyFor("en-US"), "USD")
  eq("currencyFor forced", s.currencyFor("en-US", "CNY"), "CNY")
  eq("formatMoney USD", s.formatMoney(1.234), "$1.23")
  eq("formatMoney CNY", s.formatMoney(1, "CNY", 7), "≈¥7.00")
  eq("formatMoney CNY cents", s.formatMoney(0.5, "CNY", 7), "≈¥3.50")
  eq("formatMoney zero", s.formatMoney(0, "CNY"), "≈¥0")
  eq("formatMoney falls back when the rate is unusable", s.formatMoney(1, "CNY", 0), "≈¥7.20")
  eq("formatMoney never shows a negative amount", s.formatMoney(-1), "$0")
  eq("formatPercent without a value", s.formatPercent(undefined), "—")
  eq("formatPercent rounds", s.formatPercent(12.6), "13%")
})

describe("time", () => {
  const now = new Date(2026, 10, 25, 15, 30, 5, 123).getTime()
  const parts = (at) => {
    const date = new Date(at)
    return [date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]
  }
  eq("startOfToday", parts(s.startOfToday(now)), [10, 25, 0, 0, 0, 0])
  eq("startOfMonth", parts(s.startOfMonth(now)).slice(0, 3), [10, 1, 0])
  it("localTimezone is a non-empty string", () => assert.ok(s.localTimezone().length > 0))
})

describe("context usage", () => {
  const first = { type: "assistant", tokens: { input: 1 } }
  const last = { type: "assistant", tokens: { input: 5 } }
  eq("last assistant with tokens", s.lastAssistantWithUsage([{ type: "user" }, first]), first)
  eq("ignores messages before the last completed compaction", s.lastAssistantWithUsage([first, { type: "compaction", status: "completed" }, { type: "assistant" }]), undefined)
  eq("unknown boundary finds nothing", s.lastAssistantWithUsage([first], "missing"), undefined)
  eq("stops at the boundary", s.lastAssistantWithUsage([first, { type: "user", id: "b" }, last], "b"), first)

  const messages = [
    { type: "assistant", tokens: { input: 100, output: 50 }, model: { providerID: "p", id: "m", modelID: "m2" } },
  ]
  eq("contextUsage matches the catalog by modelID", s.contextUsage(messages, [{ providerID: "p", id: "x", modelID: "m2", name: "Model X", limit: { context: 150 } }]), {
    tokens: 150,
    limit: 150,
    percent: 100,
    model: "Model X",
  })
  eq("contextUsage without a catalog", s.contextUsage(messages, undefined), { tokens: 150, limit: undefined, percent: undefined, model: "m2" })
  eq("contextUsage without messages", s.contextUsage([], []), undefined)
})

describe("daily stats and git", () => {
  const stats = s.dailyStats({
    tokens: { input: 10, output: 5 },
    cost: 0.5,
    sessions: 2,
    subagents: 1,
    prompts: 7,
    models: [
      { model: { providerID: "p", modelID: "m" }, tokens: { output: 3 }, cost: 0.25 },
      { model: { providerID: "q" }, cost: 0.1 },
    ],
  })
  eq("dailyStats", stats, {
    tokens: 15,
    cost: 0.5,
    sessions: 2,
    subagents: 1,
    prompts: 7,
    models: [
      { provider: "p", model: "m", tokens: 3, cost: 0.25 },
      { provider: "q", model: "?", tokens: 0, cost: 0.1 },
    ],
  })
  eq("dailyStats of nothing", s.dailyStats(undefined), { tokens: 0, cost: 0, sessions: 0, subagents: 0, prompts: 0, models: [] })
  eq("providerCost sums matching providers", s.providerCost(stats, /^p$/), 0.25)
  eq("providerCost without stats", s.providerCost(undefined, /x/), 0)
  eq("gitStats", s.gitStats([{ additions: 1, deletions: 2 }, { additions: 3 }], "main"), { branch: "main", files: 2, additions: 4, deletions: 2 })
  eq("gitStats of nothing", s.gitStats(undefined), { branch: undefined, files: 0, additions: 0, deletions: 0 })
})

describe("quota merge and age", () => {
  const previous = { deepseek: { label: "ds" }, zhipuFive: undefined, zhipuWeek: { label: "wk" }, at: 1000, errors: [] }
  const failed = { deepseek: undefined, zhipuFive: undefined, zhipuWeek: undefined, at: 3000, errors: ["e"] }
  eq("mergeQuota keeps the last good value per provider", s.mergeQuota(previous, { deepseek: undefined, zhipuFive: { label: "5h" }, zhipuWeek: undefined, at: 2000, errors: ["x"] }), {
    deepseek: { label: "ds" },
    zhipuFive: { label: "5h" },
    zhipuWeek: { label: "wk" },
    at: 2000,
    errors: ["x"],
  })
  eq("a fully failed refresh does not look fresh", s.mergeQuota(previous, failed).at, 1000)
  eq("no previous value to fall back on", s.mergeQuota(undefined, failed).at, undefined)

  const now = 1_000_000_000
  eq("ageText seconds", s.ageText(now - 5_000, now), "5s")
  eq("ageText minutes", s.ageText(now - 90_000, now), "2m")
  eq("ageText hours", s.ageText(now - 5_400_000, now), "2h")
  eq("ageText days", s.ageText(now - 172_800_000, now), "2d")
  eq("ageText of a future time", s.ageText(now + 5_000, now), "0s")
})

const ENV_NAMES = ["DEEPSEEK_API_KEY", "ZAI_API_KEY", "BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"]

// Runs `run` with only the given provider keys in the environment, restoring it afterwards.
async function withEnv(values, run) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))
  for (const name of ENV_NAMES) delete process.env[name]
  Object.assign(process.env, values)
  try {
    return await run()
  } finally {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

const credentials = (entries) => ({ credential: { list: async () => entries } })

describe("provider keys", () => {
  it("prefers the active entry", () =>
    withEnv({}, async () => {
      const keys = await s.readProviderKeys(
        credentials([
          { integrationID: "deepseek", value: { type: "key", key: "inactive" } },
          { integrationID: "DeepSeek", active: true, value: { type: "key", key: "active" } },
        ]),
      )
      assert.equal(keys.deepseek, "active")
    }))

  it("uses a single un-flagged entry", () =>
    withEnv({}, async () => {
      const keys = await s.readProviderKeys(credentials([{ integrationID: "zai", value: { type: "key", key: "z1" } }]))
      assert.equal(keys.zhipu, "z1")
      assert.equal(keys.deepseek, undefined)
    }))

  it("falls back to the environment when several entries match and none is active", () =>
    withEnv({ ZAI_API_KEY: "from-env" }, async () => {
      const keys = await s.readProviderKeys(
        credentials([
          { integrationID: "zhipu-a", value: { type: "key", key: "a" } },
          { integrationID: "zhipu-b", value: { type: "key", key: "b" } },
        ]),
      )
      assert.equal(keys.zhipu, "from-env")
    }))

  it("ignores entries that are not keys and empty keys", () =>
    withEnv({}, async () => {
      const keys = await s.readProviderKeys(
        credentials([
          { integrationID: "deepseek", value: { type: "oauth" } },
          { integrationID: "zhipu", value: { type: "key", key: "" } },
        ]),
      )
      assert.equal(keys.deepseek, undefined)
      assert.equal(keys.zhipu, undefined)
    }))

  it("reads the environment when there is no client", () =>
    withEnv({ DEEPSEEK_API_KEY: "d", BIGMODEL_API_KEY: "b" }, async () => {
      assert.deepEqual(await s.readProviderKeys(undefined), { deepseek: "d", zhipu: "b" })
    }))

  it("reads the environment when listing credentials fails", () =>
    withEnv({ GLM_API_KEY: "g" }, async () => {
      const keys = await s.readProviderKeys({ credential: { list: async () => { throw new Error("nope") } } })
      assert.equal(keys.zhipu, "g")
    }))

  it("uses the first environment variable that is set", () =>
    withEnv({ ZAI_API_KEY: "first", GLM_API_KEY: "second" }, async () => {
      assert.equal((await s.readProviderKeys(undefined)).zhipu, "first")
    }))
})

const DEEPSEEK = "https://api.deepseek.com/user/balance"
const ZHIPU = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"

// A fetch stand-in: answers each URL from `responses` and records every call.
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const respond = responses[url] ?? (() => ({ ok: false, status: 404, json: async () => ({}) }))
    return respond()
  }
  return { impl, calls }
}
const ok = (payload) => () => ({ ok: true, status: 200, json: async () => payload })
const fail = (status) => () => ({ ok: false, status, json: async () => ({}) })
const limit = (unit, number, fields) => ({ type: "CREDIT_LIMIT", unit, number, ...fields })

describe("quota", () => {
  it("parses the DeepSeek balance and prefers CNY", async () => {
    const fetch = fakeFetch({
      [DEEPSEEK]: ok({
        is_available: true,
        balance_infos: [
          { currency: "USD", total_balance: "5" },
          { currency: "CNY", total_balance: "110.5", topped_up_balance: "100", granted_balance: "10.5" },
        ],
      }),
    })
    const state = await s.fetchQuota({ deepseek: "k-d" }, { fetchImpl: fetch.impl, now: 1000 })
    assert.equal(state.deepseek.short, "💠 DS ¥110.50")
    assert.equal(state.deepseek.low, false)
    assert.equal(state.deepseek.at, 1000)
    for (const part of ["余额 ¥110.50", "可用 是", "充值 ¥100.00", "赠送 ¥10.50", "USD 5.00"]) assert.ok(state.deepseek.detail.includes(part))
    assert.equal(state.zhipuFive, undefined)
    assert.equal(state.errors.length, 0)
    assert.equal(fetch.calls.length, 1)
    assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer k-d")
  })

  it("flags a low DeepSeek balance at 20 CNY or below", async () => {
    const line = async (total) => (await s.fetchQuota({ deepseek: "k" }, { fetchImpl: fakeFetch({ [DEEPSEEK]: ok({ balance_infos: [{ currency: "CNY", total_balance: total }] }) }).impl })).deepseek
    assert.equal((await line("20")).low, true)
    assert.equal((await line("20.01")).low, false)
  })

  it("reports DeepSeek as unavailable", async () => {
    const state = await s.fetchQuota({ deepseek: "k" }, { fetchImpl: fakeFetch({ [DEEPSEEK]: ok({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "1" }] }) }).impl })
    assert.ok(state.deepseek.detail.includes("可用 否"))
  })

  it("records an empty DeepSeek balance as an error", async () => {
    const state = await s.fetchQuota({ deepseek: "k" }, { fetchImpl: fakeFetch({ [DEEPSEEK]: ok({ balance_infos: [] }) }).impl })
    assert.equal(state.deepseek, undefined)
    assert.deepEqual(state.errors, ["deepseek: empty balance"])
  })

  it("records a DeepSeek HTTP failure", async () => {
    const state = await s.fetchQuota({ deepseek: "k" }, { fetchImpl: fakeFetch({ [DEEPSEEK]: fail(401) }).impl })
    assert.deepEqual(state.errors, ["deepseek: HTTP 401"])
  })

  it("parses the Zhipu 5-hour and weekly windows", async () => {
    const state = await s.fetchQuota(
      { zhipu: "k-z" },
      {
        fetchImpl: fakeFetch({
          [ZHIPU]: ok({
            code: 200,
            data: {
              limits: [
                limit(3, 5, { percentage: 42.5, currentValue: "1700", usage: "4000", nextResetTime: 1795590000000 }),
                limit(6, 1, { percentage: 91, currentValue: 91000, usage: 100000, nextResetTime: 1795600000000 }),
                { type: "OTHER", unit: 3, number: 5, percentage: 99 },
              ],
            },
          }),
        }).impl,
        now: 500,
      },
    )
    assert.equal(state.zhipuFive.short, "⚡ GLM 5h 43%")
    assert.equal(state.zhipuFive.percent, 42.5)
    assert.equal(state.zhipuFive.low, false)
    assert.equal(state.zhipuWeek.short, "周 91%")
    assert.equal(state.zhipuWeek.low, true)
    assert.equal(state.zhipuWeek.at, 500)
    assert.equal(state.errors.length, 0)
  })

  it("takes Zhipu windows by position when unit and number differ", async () => {
    const state = await s.fetchQuota(
      { zhipu: "k" },
      {
        fetchImpl: fakeFetch({
          [ZHIPU]: ok({
            code: 200,
            data: { limits: [limit(9, 9, { percentage: 10, currentValue: 1, usage: 10 }), limit(9, 9, { percentage: 60, currentValue: 6, usage: 10 })] },
          }),
        }).impl,
      },
    )
    assert.equal(state.zhipuFive.short, "⚡ GLM 5h 10%")
    assert.equal(state.zhipuWeek.short, "周 60%")
    assert.equal(state.zhipuWeek.low, false)
  })

  it("records a Zhipu error code", async () => {
    const state = await s.fetchQuota({ zhipu: "k" }, { fetchImpl: fakeFetch({ [ZHIPU]: ok({ code: 500 }) }).impl })
    assert.equal(state.zhipuFive, undefined)
    assert.deepEqual(state.errors, ["zhipu: code 500"])
  })

  it("records a Zhipu response without credit limits", async () => {
    const state = await s.fetchQuota({ zhipu: "k" }, { fetchImpl: fakeFetch({ [ZHIPU]: ok({ code: 200, data: { limits: [] } }) }).impl })
    assert.deepEqual(state.errors, ["zhipu: no CREDIT_LIMIT"])
  })

  it("lets each provider fail on its own", async () => {
    const state = await s.fetchQuota(
      { deepseek: "k-d", zhipu: "k-z" },
      {
        fetchImpl: fakeFetch({
          [DEEPSEEK]: ok({ balance_infos: [{ currency: "CNY", total_balance: "30" }] }),
          [ZHIPU]: fail(500),
        }).impl,
      },
    )
    assert.equal(state.deepseek.short, "💠 DS ¥30.00")
    assert.equal(state.zhipuFive, undefined)
    assert.deepEqual(state.errors, ["zhipu: HTTP 500"])
  })

  it("makes no request without keys", async () => {
    const fetch = fakeFetch({})
    assert.deepEqual(await s.fetchQuota({}, { fetchImpl: fetch.impl, now: 7 }), {
      deepseek: undefined,
      zhipuFive: undefined,
      zhipuWeek: undefined,
      at: 7,
      errors: [],
    })
    assert.equal(fetch.calls.length, 0)
  })
})
