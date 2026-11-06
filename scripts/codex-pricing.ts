/**
 * Refreshes `src/codex/CodexPrices.ts`, the table `CodexPricing` defaults to,
 * from OpenAI's pricing page:
 *
 *   node scripts/codex-pricing.ts           # rewrite the file if a price changed
 *   node scripts/codex-pricing.ts --check   # exit 1 if it would change
 *
 * The page is server-rendered: each table's data is in its component's
 * `props` attribute (Astro's serialization), so this reads the HTML with an
 * HTTP client, no browser. It takes the standard tier of the flagship
 * text-token table and the "Codex" group of the specialized-models table.
 * Anything it doesn't recognise fails the run rather than being guessed at, so
 * a redesign of the page shows up as an error, not as wrong prices.
 *
 * `asOf` only moves when a price does, so a run that finds nothing new leaves
 * the file untouched.
 */
import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { readFileSync, writeFileSync } from "node:fs"
import type { ModelPrice, PriceTable } from "../src/Pricing.ts"

const source = "https://developers.openai.com/api/docs/pricing"
const target = new URL("../src/codex/CodexPrices.ts", import.meta.url)
const check = process.argv.includes("--check")

class PageChanged extends Schema.TaggedError<PageChanged>()("PageChanged", { message: Schema.String }) {}
const changed = (message: string) => new PageChanged({ message: `${message} (${source} changed shape; update scripts/codex-pricing.ts)` })

// ---------------------------------------------------------------------------
// Astro island props
// ---------------------------------------------------------------------------

interface Island {
  readonly component: string
  /** The `data-value` of the content-switcher pane the island sits in (`standard`, `batch`, `fast`, ...), if any. */
  readonly pane: string | null
  readonly props: unknown
}

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

/** Astro serializes each value as `[type, value]`: 0 a plain value (objects hold serialized values), 1 an array. */
const deserialize = (value: unknown): unknown => {
  if (!Array.isArray(value) || value.length < 1 || typeof value[0] !== "number") throw changed(`unexpected serialized value ${JSON.stringify(value)}`)
  const [type, inner] = value as [number, unknown]
  if (type === 1) {
    if (!Array.isArray(inner)) throw changed("array value that isn't an array")
    return inner.map(deserialize)
  }
  if (type !== 0) throw changed(`serialized type ${type}`)
  if (inner !== null && typeof inner === "object") return deserializeObject(inner as Record<string, unknown>)
  return inner
}
const deserializeObject = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deserialize(v)]))

const islands = (html: string): Array<Island> => {
  const panes = [...html.matchAll(/<[a-z]+\b[^>]*data-content-switcher-pane="true"[^>]*>/g)].map((m) => ({
    at: m.index,
    value: /data-value="([^"]*)"/.exec(m[0])?.[1] ?? null,
  }))
  return [...html.matchAll(/<astro-island\b[^>]*>/g)].flatMap((m) => {
    const component = /component-export="([^"]*)"/.exec(m[0])?.[1]
    const props = /\bprops="([^"]*)"/.exec(m[0])?.[1]
    if (component === undefined || props === undefined) return []
    const pane = panes.filter((p) => p.at < m.index).at(-1)?.value ?? null
    return [{ component, pane, props: deserializeObject(JSON.parse(unescape(props))) }]
  })
}

// ---------------------------------------------------------------------------
// The two tables
// ---------------------------------------------------------------------------

/** A price cell: USD per million tokens, or `-` / null where the model has none. */
const Cell = Schema.Union([Schema.Number, Schema.Literal("-"), Schema.Null])
const Name = Schema.String

/**
 * `TextTokenPricingTables` rows. The component reads five-cell rows as
 * `[model, input, cachedInput, cacheWrite, output]` and four-cell rows as
 * `[model, input, cachedInput, output]`.
 */
const TextRow = Schema.Union([Schema.Tuple([Name, Cell, Cell, Cell, Cell]), Schema.Tuple([Name, Cell, Cell, Cell])])
const TextTable = Schema.Struct({
  tier: Schema.String,
  modelGroup: Schema.optionalKey(Schema.String),
  rows: Schema.Array(TextRow),
})

const Heading = Schema.Union([Schema.String, Schema.Struct({ __pricingTooltipHeading: Schema.Struct({ label: Schema.String }) })])
const GroupedTable = Schema.Struct({
  headings: Schema.Array(Heading),
  groups: Schema.Array(Schema.Struct({ model: Schema.String, rows: Schema.Array(Schema.Array(Schema.Unknown)) })),
})

/** `gpt-5.5 (<272K context length)` is the short-context rate, which is the one kept; any other decoration fails. */
const modelId = (name: string) => {
  const id = name.replace(/ \(<\d+K context length\)$/, "")
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) throw changed(`unrecognised model name ${JSON.stringify(name)}`)
  return id
}

const price = (model: string, cells: { readonly input: unknown; readonly cachedInput: unknown; readonly output: unknown }): ModelPrice => {
  const { input, cachedInput, output } = cells
  if (typeof input !== "number" || typeof output !== "number") throw changed(`${model} has no input or output price`)
  return { input, ...(typeof cachedInput === "number" && { cachedInput }), output }
}

const textPrices = (all: ReadonlyArray<Island>) =>
  Effect.gen(function* () {
    const tables = yield* Effect.forEach(
      all.filter((i) => i.component === "TextTokenPricingTables"),
      (i) => Schema.decodeUnknownEffect(TextTable)(i.props).pipe(Effect.mapError((e) => changed(`TextTokenPricingTables: ${e.message}`))),
    )
    const standard = tables.filter((t) => t.tier === "standard" && t.modelGroup === undefined)
    if (standard.length !== 1) return yield* changed(`${standard.length} standard flagship text-token tables, expected 1`)
    return standard[0]!.rows.map((row): readonly [string, ModelPrice] => {
      const id = modelId(row[0])
      const [input, cachedInput, output] = row.length === 5 ? [row[1], row[2], row[4]] : [row[1], row[2], row[3]]
      return [id, price(id, { input, cachedInput, output })]
    })
  })

const codexPrices = (all: ReadonlyArray<Island>) =>
  Effect.gen(function* () {
    const found: Array<readonly [string, ModelPrice]> = []
    for (const island of all.filter((i) => i.component === "GroupedPricingTable" && i.pane === "standard")) {
      const table = yield* Schema.decodeUnknownEffect(GroupedTable)(island.props).pipe(Effect.mapError((e) => changed(`GroupedPricingTable: ${e.message}`)))
      const group = table.groups.find((g) => g.model === "Codex")
      if (group === undefined) continue
      const labels = table.headings.map((h) => (typeof h === "string" ? h : h.__pricingTooltipHeading.label))
      // Cells follow the headings after the group's own column.
      const column = (label: string) => {
        const at = labels.indexOf(label)
        if (at < 1) throw changed(`Codex table has no "${label}" column`)
        return at - 1
      }
      const [model, input, output, cachedInput] = [column("Model"), column("Input"), column("Output"), column("Cached input")]
      for (const row of group.rows) {
        if (typeof row[model] !== "string") throw changed("Codex row without a model name")
        const id = modelId(row[model])
        found.push([id, price(id, { input: row[input], cachedInput: row[cachedInput], output: row[output] })])
      }
    }
    if (found.length === 0) return yield* changed("no Codex group in a standard-tier specialized-models table")
    return found
  })

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

const render = (asOf: string, prices: PriceTable) => `/**
 * Generated by \`node scripts/codex-pricing.ts\` from ${source}: the
 * standard tier, text tokens, short-context rates, USD per million tokens.
 * Don't edit by hand; run the script.
 *
 * @internal
 */
import type { PriceTable } from "../Pricing.ts"

/** When the prices below last changed. */
export const asOf = "${asOf}"

/** Where they come from. */
export const source = "${source}"

/** Keyed by model id, with no \`"*"\` fallback: a model that isn't here is unpriced. */
export const prices: PriceTable = ${JSON.stringify(prices, null, 2).replace(/"([a-zA-Z]+)":/g, "$1:")}
`

const current = (): { readonly asOf: string; readonly prices: string } | null => {
  try {
    const text = readFileSync(target, "utf8")
    return { asOf: /export const asOf = "([^"]*)"/.exec(text)?.[1] ?? "", prices: text.slice(text.indexOf("export const prices")) }
  } catch {
    return null
  }
}

const main = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
  const html = yield* client.get(source, { headers: { "user-agent": "effect-agent/codex-pricing" } }).pipe(Effect.flatMap((r) => r.text))
  const all = islands(html)
  const entries = [...(yield* textPrices(all)), ...(yield* codexPrices(all))]
  const prices: Record<string, ModelPrice> = {}
  for (const [id, p] of entries) {
    const seen = prices[id]
    if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(p)) {
      return yield* changed(`${id} has two prices: ${JSON.stringify(seen)} and ${JSON.stringify(p)}`)
    }
    prices[id] = p
  }
  const sorted = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)))

  const before = current()
  const today = new Date().toISOString().slice(0, 10)
  const same = before !== null && render(before.asOf, sorted).includes(before.prices)
  console.log(`${Object.keys(sorted).length} models; ${same ? "no price changed" : "prices changed"}`)
  if (same) return
  if (check) {
    console.error(`src/codex/CodexPrices.ts is out of date: run node scripts/codex-pricing.ts`)
    process.exitCode = 1
    return
  }
  writeFileSync(target, render(today, sorted))
  console.log(`wrote src/codex/CodexPrices.ts (asOf ${today})`)
})

Effect.runPromise(main.pipe(Effect.provide(FetchHttpClient.layer))).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
