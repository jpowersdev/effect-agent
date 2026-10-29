/**
 * Token prices, for providers that report tokens but not cost (Codex).
 * No prices are built in: they change, and subscription plans don't bill
 * per token anyway, so the caller supplies the rates it wants to budget by.
 */
import type { TokenUsage } from "./Domain.ts"

/** USD per million tokens. */
export interface ModelPrice {
  readonly input: number
  /** Defaults to `input` when omitted. */
  readonly cachedInput?: number
  readonly output: number
  /** Defaults to `output` when omitted; only used if the provider reports reasoning separately from output. */
  readonly reasoning?: number
}

/** Keyed by model id; `"*"` is the fallback. */
export type PriceTable = Readonly<Record<string, ModelPrice>>

export const priceFor = (table: PriceTable, model: string | null): ModelPrice | undefined =>
  (model !== null ? table[model] : undefined) ?? table["*"]

/**
 * Cost in USD. `inputTokens` includes cached tokens (as both providers report
 * it), so cached tokens are billed at the cached rate and the rest at `input`.
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
