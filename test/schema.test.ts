import { describe, expect, it } from "@effect/vitest"
import { DateTime, Duration, Option, Schema } from "effect"
import {
  type AccountStatus,
  AgentEvent,
  appliesTo,
  LimitWindowStatus,
  Pricing,
  type RunOptions,
  RunSettings,
  settingsOf,
  SessionId,
  TurnId,
  UsageLimited,
  usableFor,
} from "../src/index.ts"

describe("schemas", () => {
  it("RunSettings: RunOptions without hooks, through JSON", () => {
    const run: RunOptions = {
      cwd: "/w",
      env: { KEEP: "1", DROP: undefined },
      effort: "high",
      disable: { tools: ["Bash"] },
      resume: SessionId.make("s-1"),
      watchdog: { idle: "30 seconds", grace: Duration.seconds(2) },
      hooks: { beforeStop: () => null as never },
    }
    const json = Schema.encodeSync(Schema.fromJsonString(RunSettings))(settingsOf(run))
    expect(JSON.parse(json)).toEqual({
      cwd: "/w",
      env: { KEEP: "1", DROP: null },
      effort: "high",
      disable: { tools: ["Bash"] },
      resume: "s-1",
      watchdog: { idle: 30_000, grace: 2_000 },
    })
    const back = Schema.decodeUnknownSync(Schema.fromJsonString(RunSettings))(json)
    expect(back.env).toEqual({ KEEP: "1", DROP: undefined })
    expect(Duration.toMillis(Duration.fromInputUnsafe(back.watchdog!.idle))).toBe(30_000)
    // Text durations decode too; nonsense doesn't.
    expect(Schema.decodeUnknownSync(RunSettings)({ cwd: "/w", watchdog: { idle: "5 minutes" } }).watchdog).toBeDefined()
    expect(() => Schema.decodeUnknownSync(RunSettings)({ cwd: "/w", watchdog: { idle: "soonish" } })).toThrow()
  })

  it("round-trips a TurnEnded with a typed usage-limit outcome through JSON", () => {
    const resetsAt = DateTime.makeUnsafe(1793803680_000)
    const event: AgentEvent = {
      _tag: "TurnEnded",
      turnId: TurnId.make("turn-1"),
      outcome: new UsageLimited({ message: "limit", window: "weekly", resetsAt, overageAvailable: false }),
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2, reasoningTokens: null },
      cost: { usd: 0.01, source: "estimated" },
      raw: { anything: true },
    }
    const json = Schema.encodeUnknownSync(Schema.fromJsonString(AgentEvent))(event)
    expect(JSON.parse(json).outcome).toMatchObject({ _tag: "UsageLimited", window: "weekly", resetsAt: 1793803680_000 })

    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(AgentEvent))(json)
    expect(decoded._tag).toBe("TurnEnded")
    if (decoded._tag !== "TurnEnded") return
    expect(decoded.outcome).toBeInstanceOf(UsageLimited)
    expect(decoded.outcome._tag === "UsageLimited" && DateTime.toEpochMillis(decoded.outcome.resetsAt!)).toBe(
      1793803680_000,
    )
  })

  it("brands ids", () => {
    expect(SessionId.make("abc")).toBe("abc")
  })

  it("prices cached input at the cached rate", () => {
    const usd = Pricing.costOf(
      { input: 2, cachedInput: 0.5, output: 8 },
      { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, reasoningTokens: null },
    )
    expect(usd).toBeCloseTo(0.6 * 2 + 0.4 * 0.5 + 0.1 * 8)
  })

  it("encodes a window's model Option as null or a string", () => {
    const encode = Schema.encodeUnknownSync(LimitWindowStatus)
    const base = { window: "weekly", label: "seven_day", usedPercent: 25, resetsAt: null } as const
    expect(encode({ ...base, model: Option.none() })).toMatchObject({ model: null })
    expect(encode({ ...base, label: "seven_day_opus", model: Option.some("opus") })).toMatchObject({ model: "opus" })
    expect(Schema.decodeUnknownSync(LimitWindowStatus)({ ...base, model: null }).model).toEqual(Option.none())
  })

  describe("usableFor", () => {
    const window = (label: string, usedPercent: number, model: Option.Option<string>) =>
      ({ window: model._tag === "None" ? "weekly" : "other", label, usedPercent, resetsAt: null, model }) as const
    const status = (usable: boolean, windows: AccountStatus["windows"]): AccountStatus => ({
      provider: "claude",
      usable,
      reason: usable ? null : "usage_limited",
      windows,
      plan: "max",
      checkedAt: DateTime.makeUnsafe(0),
    })

    it("a full per-model window stops only that model", () => {
      const s = status(true, [window("seven_day", 40, Option.none()), window("model_scoped:Fable", 100, Option.some("fable"))])
      expect(usableFor(s, "claude-fable-5-1")).toBe(false)
      expect(usableFor(s, "claude-haiku-5-5")).toBe(true)
    })

    it("an unusable account is unusable for every model", () => {
      const s = status(false, [window("five_hour", 100, Option.none())])
      expect(usableFor(s, "claude-haiku-5-5")).toBe(false)
    })

    it("matches the family name case-insensitively, and account-wide windows apply to all", () => {
      expect(appliesTo(window("seven_day_opus", 0, Option.some("opus")), "Claude-Opus-5-5")).toBe(true)
      expect(appliesTo(window("seven_day_opus", 0, Option.some("opus")), "claude-sonnet-5-5")).toBe(false)
      expect(appliesTo(window("five_hour", 0, Option.none()), "anything")).toBe(true)
    })
  })
})
