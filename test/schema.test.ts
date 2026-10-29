import { describe, expect, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import { AgentEvent, Pricing, SessionId, TurnId, UsageLimited } from "../src/index.ts"

describe("schemas", () => {
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
})
