/** Shared value types: ids, token usage, cost and usage-limit windows. */
import { Schema } from "effect"

export const SessionId = Schema.String.pipe(Schema.brand("effect-agent/SessionId"))
export type SessionId = typeof SessionId.Type

export const TurnId = Schema.String.pipe(Schema.brand("effect-agent/TurnId"))
export type TurnId = typeof TurnId.Type

/** Client-assigned id for a message passed to `send`, `steer` or `turn`. */
export const MessageId = Schema.String.pipe(Schema.brand("effect-agent/MessageId"))
export type MessageId = typeof MessageId.Type

/**
 * `inputTokens` includes `cachedInputTokens`. `outputTokens` excludes
 * `reasoningTokens` when those are reported separately; when
 * `reasoningTokens` is null, any reasoning is already inside `outputTokens`.
 */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.NullOr(Schema.Number),
})
export type TokenUsage = typeof TokenUsage.Type

export const Cost = Schema.Struct({
  usd: Schema.Number,
  /** `reported` by the provider, or `estimated` from tokens and a price table. */
  source: Schema.Literals(["reported", "estimated"]),
})
export type Cost = typeof Cost.Type

/** Normalized limit window. `other` keeps the provider's name in `label`. */
export const LimitWindow = Schema.Literals(["five_hour", "weekly", "other"])
export type LimitWindow = typeof LimitWindow.Type

export const LimitWindowStatus = Schema.Struct({
  window: LimitWindow,
  /** Provider's own name for the window, e.g. `seven_day` or `primary`. */
  label: Schema.String,
  /** 0 to 100. */
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
})
export type LimitWindowStatus = typeof LimitWindowStatus.Type
