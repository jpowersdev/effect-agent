/**
 * Token prices, for providers that report tokens but not cost (Codex).
 * No prices are built in: they change, and subscription plans don't bill
 * per token anyway, so the caller supplies the rates it wants to budget by.
 *
 * @since 0.1.0
 */
import type { TokenUsage } from "./Domain.ts"

/**
 * USD per million tokens.
 *
 * @since 0.1.0
 * @category models
 */
export interface ModelPrice {
  readonly input: number
  /** Defaults to `input` when omitted. */
  readonly cachedInput?: number
  readonly output: number
  /** Defaults to `output` when omitted; only used if the provider reports reasoning separately from output. */
  readonly reasoning?: number
}

/**
 * Keyed by model id; `"*"` is the fallback.
 *
 * @since 0.1.0
 * @category models
 */
export type PriceTable = Readonly<Record<string, ModelPrice>>

/**
 * The price for `model`, falling back to the `"*"` entry.
 *
 * @since 0.1.0
 * @category utils
 */
export const priceFor = (table: PriceTable, model: string | null): ModelPrice | undefined =>
  (model !== null ? table[model] : undefined) ?? table["*"]

/**
 * Cost in USD. `inputTokens` includes cached tokens (as both providers report
 * it), so cached tokens are billed at the cached rate and the rest at `input`.
 *
 * @example
 * ```ts
 * import { Pricing } from "@jpowersdev/effect-agent"
 * import assert from "node:assert"
 *
 * // USD per million tokens
 * const price: Pricing.ModelPrice = {
 *   input: 3,
 *   cachedInput: 0.25,
 *   output: 15
 * }
 *
 * const cost = Pricing.costOf(price, {
 *   inputTokens: 1_000_000, // half of them cached
 *   cachedInputTokens: 500_000,
 *   outputTokens: 100_000,
 *   reasoningTokens: null
 * })
 * assert.strictEqual(cost, 3.125)
 * ```
 *
 * @since 0.1.0
 * @category utils
 */
export const costOf = (price: ModelPrice, usage: TokenUsage): number => {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens)
  const uncached = usage.inputTokens - cached
  const reasoning = usage.reasoningTokens ?? 0
  return (
    (uncached * price.input +
      cached * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output +
      reasoning * (price.reasoning ?? price.output)) /
    1_000_000
  )
}
