/**
 * Shared value types: ids, token usage, cost and usage-limit windows.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * The provider's id for a session, used to resume it.
 *
 * @since 0.1.0
 * @category models
 */
export const SessionId = Schema.String.pipe(Schema.brand("effect-agent/SessionId"))
/**
 * @since 0.1.0
 * @category models
 */
export type SessionId = typeof SessionId.Type

/**
 * @since 0.1.0
 * @category models
 */
export const TurnId = Schema.String.pipe(Schema.brand("effect-agent/TurnId"))
/**
 * @since 0.1.0
 * @category models
 */
export type TurnId = typeof TurnId.Type

/**
 * Client-assigned id for a message passed to `send`, `steer` or `turn`.
 *
 * @since 0.1.0
 * @category models
 */
export const MessageId = Schema.String.pipe(Schema.brand("effect-agent/MessageId"))
/**
 * @since 0.1.0
 * @category models
 */
export type MessageId = typeof MessageId.Type

/**
 * `inputTokens` includes `cachedInputTokens`. `outputTokens` excludes
 * `reasoningTokens` when those are reported separately; when
 * `reasoningTokens` is null, any reasoning is already inside `outputTokens`.
 *
 * @since 0.1.0
 * @category models
 */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningTokens: Schema.NullOr(Schema.Number),
})
/**
 * @since 0.1.0
 * @category models
 */
export type TokenUsage = typeof TokenUsage.Type

/**
 * @since 0.1.0
 * @category models
 */
export const Cost = Schema.Struct({
  usd: Schema.Number,
  /** `reported` by the provider, or `estimated` from tokens and a price table. */
  source: Schema.Literals(["reported", "estimated"]),
})
/**
 * @since 0.1.0
 * @category models
 */
export type Cost = typeof Cost.Type

/**
 * Normalized limit window. `other` keeps the provider's name in `label`.
 *
 * @since 0.1.0
 * @category models
 */
export const LimitWindow = Schema.Literals(["five_hour", "weekly", "other"])
/**
 * @since 0.1.0
 * @category models
 */
export type LimitWindow = typeof LimitWindow.Type

/**
 * Usage of one limit window.
 *
 * @since 0.1.0
 * @category models
 */
export const LimitWindowStatus = Schema.Struct({
  window: LimitWindow,
  /** Provider's own name for the window, e.g. `seven_day` or `primary`. */
  label: Schema.String,
  /** 0 to 100. */
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  /**
   * The model family this window caps, lowercase (e.g. `opus`, `fable`);
   * none for a window that applies to every model. Encoded as `null`.
   */
  model: Schema.OptionFromNullOr(Schema.String),
})
/**
 * @since 0.1.0
 * @category models
 */
export type LimitWindowStatus = typeof LimitWindowStatus.Type
