/**
 * What a turn used: tokens, and what they cost.
 *
 * @since 0.3.0
 */
import { Schema } from "effect"

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
