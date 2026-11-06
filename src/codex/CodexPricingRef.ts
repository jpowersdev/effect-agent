/**
 * `CodexAgent.CodexPricing`, kept apart from `CodexAgent` so `DetachedAgent`
 * can read it without loading the Codex provider.
 *
 * @internal
 */
import { Context } from "effect"
import type { PriceTable } from "../Pricing.ts"
import { prices } from "./CodexPrices.ts"

/** @internal */
export const CodexPricing: Context.Reference<PriceTable> = Context.Reference<PriceTable>("@jpowersdev/effect-agent/codex/CodexPricing", {
  defaultValue: () => prices,
})
