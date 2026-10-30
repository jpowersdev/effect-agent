/**
 * Checks src/codex/protocol.ts against the app-server protocol of a codex
 * binary, and shows what changed since the pinned release.
 *
 *   node scripts/codex-protocol.ts                 # against `codex` on PATH
 *   node scripts/codex-protocol.ts --codex PATH    # another binary (e.g. a newer release)
 *   node scripts/codex-protocol.ts --update        # also rewrite the surface snapshot
 *   node scripts/codex-protocol.ts --keep          # keep the generated files (path printed)
 *
 * Generates the protocol with `codex app-server generate-json-schema
 * --experimental` and `generate-ts --experimental` in a temp dir, then:
 *
 * 1. Surface. Renders the slice of the protocol effect-agent depends on
 *    (each definition named in `checks`, the params and results of the
 *    methods we call, and every method name) as text, and diffs it against
 *    test/fixtures/codex/protocol-surface.txt, rendered from the pinned
 *    codex. This shows what Codex added, removed or changed: new fields,
 *    error kinds, item types, notifications, and edited docs.
 * 2. Conformance. Type-checks protocol.ts against the generated bindings.
 *    For what codex sends, codex's type must fit ours and every field we name
 *    must exist. For what we send, codex must accept it and require no field
 *    we omit (required-ness comes from the JSON Schema: the TS bindings mark
 *    serde-defaulted fields as required). Every literal we name (methods,
 *    error kinds, item types, statuses) must still exist. Any mismatch is
 *    printed and the script exits 1.
 *
 * Every export of protocol.ts must appear in `checks`, in the `ClientRequests`
 * map, or in `local`, so a new type can't escape the check.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unifiedDiff } from "./lib/lineDiff.ts"

const repo = join(import.meta.dirname, "..")
const protocolPath = join(repo, "src", "codex", "protocol.ts")
const snapshotPath = join(repo, "test", "fixtures", "codex", "protocol-surface.txt")

const args = process.argv.slice(2)
const optionValue = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const codex = optionValue("--codex") ?? "codex"
const update = args.includes("--update")
const keep = args.includes("--keep")

// ---------------------------------------------------------------------------
// What protocol.ts mirrors
// ---------------------------------------------------------------------------

/**
 * `P.X` is protocol.ts's type, `G.X` codex's (from the generated bindings).
 *
 * - in: codex sends it. Codex's type must fit ours; every field ours names must exist.
 * - out: we send it. Codex must accept ours; ours must have every field codex requires.
 *   `variant` picks one `type` variant of a codex union.
 * - inUnion: `in` for each `type` variant ours names.
 * - known: every string literal ours names exists in codex's. Codex's literals
 *   come from the JSON Schema (the TS bindings fold `"a" | string` into
 *   `string`): enum values and object-variant keys (as in `codexErrorInfo`).
 *   For `G.X["method"]`, the method names of the TS union.
 */
interface Check {
  readonly kind: "in" | "out" | "inUnion" | "known"
  readonly ours: string
  readonly theirs: string
  readonly variant?: string
  readonly label?: string
}

const checks: ReadonlyArray<Check> = [
  { kind: "known", ours: "P.ReasoningEffort", theirs: "G.ReasoningEffort" },
  { kind: "known", ours: "P.AskForApproval", theirs: "G.AskForApproval" },
  { kind: "known", ours: "P.SandboxMode", theirs: "G.SandboxMode" },
  { kind: "out", ours: "P.TextInput", theirs: "G.UserInput", variant: "text" },
  { kind: "known", ours: "P.TurnStatus", theirs: "G.TurnStatus" },
  { kind: "known", ours: "P.CodexErrorKind", theirs: "G.CodexErrorInfo" },
  { kind: "in", ours: "P.TurnError", theirs: "G.TurnError" },
  { kind: "known", ours: "P.TurnItemsView", theirs: "G.TurnItemsView" },
  { kind: "in", ours: "P.Turn", theirs: "G.Turn" },
  { kind: "in", ours: "P.Thread", theirs: "G.Thread" },
  { kind: "known", ours: "P.MessagePhase", theirs: "G.MessagePhase" },
  { kind: "in", ours: "P.CommandAction", theirs: "G.CommandAction" },
  { kind: "inUnion", ours: "P.ThreadItem", theirs: "G.ThreadItem" },
  { kind: "in", ours: "P.TokenUsageBreakdown", theirs: "G.TokenUsageBreakdown" },
  { kind: "in", ours: "P.ThreadTokenUsage", theirs: "G.ThreadTokenUsage" },
  { kind: "in", ours: "P.RateLimitWindow", theirs: "G.RateLimitWindow" },
  { kind: "in", ours: "P.CreditsSnapshot", theirs: "G.CreditsSnapshot" },
  { kind: "in", ours: "P.RateLimitSnapshot", theirs: "G.RateLimitSnapshot" },
  { kind: "out", ours: `P.InitializeParams["clientInfo"]`, theirs: "G.ClientInfo", label: "InitializeParams.clientInfo" },
  {
    kind: "out",
    ours: `NonNullable<P.InitializeParams["capabilities"]>`,
    theirs: "G.InitializeCapabilities",
    label: "InitializeParams.capabilities",
  },
  { kind: "inUnion", ours: "P.Account", theirs: "G.Account" },
  { kind: "known", ours: "P.SortDirection", theirs: "G.SortDirection" },
  { kind: "in", ours: "P.BackgroundTerminal", theirs: "G.ThreadBackgroundTerminal" },
  { kind: "in", ours: "P.TurnNotification", theirs: "G.TurnStartedNotification" },
  { kind: "in", ours: "P.TurnNotification", theirs: "G.TurnCompletedNotification" },
  { kind: "in", ours: "P.ItemNotification", theirs: "G.ItemStartedNotification" },
  { kind: "in", ours: "P.ItemNotification", theirs: "G.ItemCompletedNotification" },
  { kind: "in", ours: "P.TokenUsageNotification", theirs: "G.ThreadTokenUsageUpdatedNotification" },
  { kind: "in", ours: "P.ErrorNotification", theirs: "G.ErrorNotification" },
  { kind: "in", ours: "P.RateLimitsUpdatedNotification", theirs: "G.AccountRateLimitsUpdatedNotification" },
  { kind: "known", ours: "P.NotificationMethod", theirs: `G.ServerNotification["method"]` },
  {
    kind: "known",
    ours: "(typeof P.ServerRequestMethods)[keyof typeof P.ServerRequestMethods]",
    theirs: `G.ServerRequest["method"]`,
    label: "ServerRequestMethods",
  },
  { kind: "out", ours: "P.ApprovalDeclined", theirs: "G.CommandExecutionRequestApprovalResponse" },
  { kind: "out", ours: "P.ApprovalDeclined", theirs: "G.FileChangeRequestApprovalResponse" },
  { kind: "out", ours: "P.LegacyApprovalAborted", theirs: "G.ExecCommandApprovalResponse" },
  { kind: "out", ours: "P.LegacyApprovalAborted", theirs: "G.ApplyPatchApprovalResponse" },
  { kind: "out", ours: "P.UserInputAnswers", theirs: "G.ToolRequestUserInputResponse" },
  { kind: "out", ours: "P.ElicitationDeclined", theirs: "G.McpServerElicitationRequestResponse" },
  { kind: "known", ours: "keyof P.ClientRequests", theirs: `G.ClientRequest["method"]`, label: "ClientRequests" },
]

/** Exports with nothing in codex's protocol to check them against. */
const local: Readonly<Record<string, string>> = {
  RequestId: "JSON-RPC framing",
  RpcErrorBody: "JSON-RPC framing",
  Message: "JSON-RPC framing",
  Notification: "JSON-RPC framing",
  ServerRequest: "JSON-RPC framing",
  Incoming: "JSON-RPC framing",
  isResponse: "JSON-RPC framing",
  isServerRequest: "JSON-RPC framing",
  isNotification: "JSON-RPC framing",
  METHOD_NOT_FOUND: "JSON-RPC error code",
  INVALID_REQUEST: "JSON-RPC error code (its messages are covered by the steer-stale fixture)",
  UserInput: "alias of TextInput",
  CodexErrorInfo: "open union; the kinds we name are CodexErrorKind",
  ThreadOverrides: "base of ThreadStartParams and ThreadResumeParams",
  ClientMethod: "keyof ClientRequests",
  JsonValue: "JSON; checked where it is used (ThreadOverrides.config)",
}

// ---------------------------------------------------------------------------
// protocol.ts: exports and the ClientRequests map
// ---------------------------------------------------------------------------

const protocolSource = readFileSync(protocolPath, "utf8")
const exportsOf = (source: string) => [...source.matchAll(/^export (?:interface|type|const) (\w+)/gm)].map((m) => m[1]!)
const clientRequestsBlock = /^export interface ClientRequests \{\n([\s\S]*?)\n\}/m.exec(protocolSource)?.[1] ?? ""
/** Methods we call, in protocol.ts order. */
const clientMethods = [...clientRequestsBlock.matchAll(/^ {2}readonly (?:"([^"]+)"|(\w+)): \{/gm)].map((m) => m[1] ?? m[2]!)
const clientRequestTypes = new Set([...clientRequestsBlock.matchAll(/(?:params|result): (\w+)/g)].map((m) => m[1]!))

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

const run = (file: string, argv: ReadonlyArray<string>) => execFileSync(file, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

const version = run(codex, ["--version"]).trim() // e.g. "codex-cli 0.162.1"
const out = mkdtempSync(join(tmpdir(), "codex-protocol-"))
run(codex, ["app-server", "generate-json-schema", "--experimental", "--out", join(out, "schema")])
run(codex, ["app-server", "generate-ts", "--experimental", "--out", join(out, "ts")])

type Schema = { readonly [key: string]: any }
const bundle = JSON.parse(readFileSync(join(out, "schema", "codex_app_server_protocol.schemas.json"), "utf8")) as Schema
/** Root and `v2` definitions in one namespace (v2 wins on a clash, as in the TS bindings below). */
const defs: Record<string, Schema> = { ...bundle["definitions"], ...bundle["definitions"]["v2"] }
delete defs["v2"]

const refName = (ref: string): string => ref.split("/").at(-1)!
const firstRef = (s: Schema | undefined): string | null => {
  if (s === undefined) return null
  if (typeof s["$ref"] === "string") return refName(s["$ref"])
  for (const alt of s["anyOf"] ?? s["oneOf"] ?? []) {
    const r = firstRef(alt)
    if (r !== null) return r
  }
  return null
}

interface MethodInfo {
  readonly method: string
  readonly params: string | null
  readonly paramsRequired: boolean
}
const methodsOf = (union: string): Array<MethodInfo> =>
  ((defs[union]?.["oneOf"] ?? []) as Array<Schema>).map((v) => ({
    method: v["properties"]["method"]["enum"][0] as string,
    params: firstRef(v["properties"]["params"]),
    paramsRequired: ((v["required"] ?? []) as Array<string>).includes("params"),
  }))
const clientRequestMethods = methodsOf("ClientRequest")

/**
 * Method names from the TS bindings' unions, which are complete: the JSON
 * Schema leaves out a few (the experimental raw-event notifications, legacy
 * client methods).
 */
const tsMethodsOf = (union: string): Array<{ readonly method: string; readonly params: string; readonly optional: boolean }> =>
  [...readFileSync(join(out, "ts", `${union}.ts`), "utf8").matchAll(/\{ "method": "([^"]+)",[^}]*?"?params"?(\?)?: (\w+)/g)].map((m) => ({
    method: m[1]!,
    params: m[3]!,
    optional: m[2] === "?",
  }))
const responseOf = (m: MethodInfo): string | null => {
  const name = m.params?.replace(/Params$/, "Response")
  return name !== undefined && name in defs ? name : null
}

// ---------------------------------------------------------------------------
// 1. Surface
// ---------------------------------------------------------------------------

const oneLine = (text: unknown): string | null =>
  typeof text === "string" && text.trim() !== "" ? text.replace(/\s+/g, " ").trim() : null

const typeText = (s: Schema): string => {
  if (s === undefined || s === null) return "unknown"
  if (typeof s["$ref"] === "string") return refName(s["$ref"])
  if (s["const"] !== undefined) return JSON.stringify(s["const"])
  if (Array.isArray(s["enum"])) return s["enum"].map((v: unknown) => JSON.stringify(v)).join(" | ")
  const alts = s["anyOf"] ?? s["oneOf"]
  if (Array.isArray(alts)) return [...new Set(alts.map(typeText))].join(" | ")
  if (Array.isArray(s["allOf"])) return s["allOf"].map(typeText).join(" & ")
  const types: Array<string> = Array.isArray(s["type"]) ? s["type"] : s["type"] !== undefined ? [s["type"]] : []
  if (types.length === 0) return "unknown"
  return types
    .map((t) => {
      if (t === "array") return `Array<${typeText(s["items"])}>`
      if (t !== "object") return t
      if (s["properties"] !== undefined) {
        return `{ ${fieldsOf(s)
          .map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`)
          .join("; ")} }`
      }
      if (typeof s["additionalProperties"] === "object") return `Record<string, ${typeText(s["additionalProperties"])}>`
      return "object"
    })
    .join(" | ")
}

const fieldsOf = (s: Schema) => {
  const required = new Set<string>(s["required"] ?? [])
  return Object.keys(s["properties"] ?? {})
    .sort()
    .map((name) => ({
      name,
      optional: !required.has(name),
      type: typeText(s["properties"][name]),
      doc: oneLine(s["properties"][name]["description"]),
    }))
}

const tagOf = (s: Schema): string | null => {
  const t = s["properties"]?.["type"]
  return Array.isArray(t?.["enum"]) && t["enum"].length === 1 ? String(t["enum"][0]) : null
}

const renderFields = (s: Schema, indent: string): Array<string> =>
  fieldsOf(s).flatMap((f) => [
    `${indent}${f.name}${f.optional ? "?" : ""}: ${f.type}`,
    ...(f.doc !== null ? [`${indent}    // ${f.doc}`] : []),
  ])

const renderDef = (name: string): Array<string> => {
  const s = defs[name]
  if (s === undefined) return [name, "  (not in this codex)"]
  const lines = [name, ...(oneLine(s["description"]) !== null ? [`  // ${oneLine(s["description"])}`] : [])]
  const alts: Array<Schema> | undefined = s["anyOf"] ?? s["oneOf"]
  // Fields shared by every variant (e.g. ThreadItem's timestamps in newer releases), then the variants.
  if (s["properties"] !== undefined) lines.push(...renderFields(s, "  "))
  if (Array.isArray(alts)) {
    for (const alt of alts) {
      const tag = tagOf(alt)
      if (tag !== null) {
        lines.push(`  [${tag}]`, ...(oneLine(alt["description"]) !== null ? [`    // ${oneLine(alt["description"])}`] : []))
        lines.push(...renderFields(alt, "    ").filter((l) => !l.startsWith("    type: ")))
      } else if (Array.isArray(alt["enum"])) {
        for (const v of alt["enum"]) lines.push(`  | ${JSON.stringify(v)}`)
      } else {
        lines.push(`  | ${typeText(alt)}`, ...(oneLine(alt["description"]) !== null ? [`    // ${oneLine(alt["description"])}`] : []))
      }
    }
    return lines
  }
  if (s["properties"] !== undefined) return lines
  if (Array.isArray(s["enum"])) return [...lines, ...s["enum"].map((v: unknown) => `  | ${JSON.stringify(v)}`)]
  return [...lines, `  = ${typeText(s)}`]
}

const renderMethods = (union: string): Array<string> => [
  `${union} methods`,
  ...tsMethodsOf(union)
    .map((m) => `  ${m.method}${m.params === "undefined" ? "" : `  (${m.params}${m.optional ? ", optional" : ""})`}`)
    .sort(),
]

const theirsNames = (expr: string) => [...expr.matchAll(/\bG\.(\w+)/g)].map((m) => m[1]!)
const methodUnions = new Set(["ClientRequest", "ServerNotification", "ServerRequest"])

const surface = (): string => {
  const names = new Set<string>()
  for (const c of checks) for (const n of theirsNames(c.theirs)) if (!methodUnions.has(n)) names.add(n)
  for (const m of clientRequestMethods.filter((m) => clientMethods.includes(m.method))) {
    if (m.params !== null) names.add(m.params)
    const response = responseOf(m)
    if (response !== null) names.add(response)
  }
  const blocks = [
    [`# ${version}: codex app-server generate-json-schema --experimental, the part protocol.ts depends on.`],
    ["# Written by `node scripts/codex-protocol.ts --update`; don't edit."],
    ...[...methodUnions].map(renderMethods),
    ...[...names].sort().map(renderDef),
  ]
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n"
}

// ---------------------------------------------------------------------------
// 2. Conformance
// ---------------------------------------------------------------------------

/**
 * Type-level checks. Each result is `never` or a union of messages. Each check
 * becomes `const CheckN: { [K in Messages]: true } = {}`, so tsc lists every
 * message as a missing property (a `never` constraint would show only the first).
 */
const prelude = `
type IsAny<T> = 0 extends 1 & T ? true : false
type Lits<T> = T extends string ? (string extends T ? never : T) : never
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]
type Primitive = string | number | boolean | bigint | symbol | null | undefined
type Writable<T> = T extends Primitive ? T : T extends ReadonlyArray<infer U> ? Array<Writable<U>> : { -readonly [K in keyof T]: Writable<T[K]> }

/** Codex sends Theirs: it must fit Ours, and every field of Ours must exist. */
type In<N extends string, Ours, Theirs> = IsAny<Theirs> extends true
  ? \`\${N}: codex's type did not resolve\`
  : {
      [K in keyof Ours & string]: K extends keyof Theirs
        ? [Theirs[K]] extends [Ours[K]]
          ? never
          : \`\${N}.\${K}: codex sends a type protocol.ts does not accept\`
        : \`\${N}.\${K}: not in codex\`
    }[keyof Ours & string]

/** We send Ours: codex must accept it, and Ours must have every field in Req (codex's required fields). */
type Out<N extends string, Ours, Theirs, Req extends string> = IsAny<Theirs> extends true
  ? \`\${N}: codex's type did not resolve\`
  :
      | {
          [K in keyof Ours & string]: K extends keyof Theirs
            ? [Writable<Exclude<Ours[K], undefined>>] extends [Theirs[K]]
              ? never
              : \`\${N}.\${K}: codex does not accept what protocol.ts sends\`
            : \`\${N}.\${K}: not in codex\`
        }[keyof Ours & string]
      | { [K in Req]: K extends RequiredKeys<Ours> ? never : \`\${N}.\${K}: required by codex\` }[Req]

/** Params of a method: as Out, except no params at all is fine when codex makes them optional. */
type Params<N extends string, Ours, Theirs, Req extends string, Optional extends boolean> = [Ours] extends [undefined]
  ? Optional extends true
    ? never
    : \`\${N}: codex requires params\`
  : Out<N, Ours, NonNullable<Theirs>, Req>

/** In, for each \`type\` variant Ours names. */
type InUnion<N extends string, Ours extends { readonly type: unknown }, Theirs extends { readonly type: unknown }> = {
  [T in Lits<Ours["type"]>]: [Extract<Theirs, { type: T }>] extends [never]
    ? \`\${N}: codex has no \${T} variant\`
    : In<\`\${N}[\${T}]\`, Extract<Ours, { type: T }>, Extract<Theirs, { type: T }>>
}[Lits<Ours["type"]>]

/** Every literal Ours names is one of Theirs. */
type Known<N extends string, Ours, Theirs> = { [L in Lits<Ours>]: L extends Theirs ? never : \`\${N}: codex has no \${L}\` }[Lits<Ours>]
`

const quote = (s: string) => JSON.stringify(s)
const asTs = (expr: string) => expr.replace(/\bG\.(\w+)/g, "G_$1")
const labelOf = (c: Check) => c.label ?? `${c.ours.replace(/^P\./, "")}${c.theirs !== `G.${c.ours.replace(/^P\./, "")}` && c.kind !== "known" ? ` (as ${theirsNames(c.theirs)[0]})` : ""}`

/** Required fields of codex's type (of one `type` variant, for a union), from the JSON Schema. */
const requiredOf = (name: string, variant?: string): Array<string> => {
  const s = defs[name]
  if (s === undefined) return []
  const target = variant === undefined ? s : ((s["oneOf"] ?? s["anyOf"] ?? []) as Array<Schema>).find((v) => tagOf(v) === variant)
  return target?.["required"] ?? []
}
const union = (keys: ReadonlyArray<string>) => (keys.length === 0 ? "never" : keys.map(quote).join(" | "))

/** The string literals a schema names (enum values and single-key object variants); `open` if it also takes any string. */
const literalsOf = (s: Schema | undefined, seen = new Set<string>()): { names: Array<string>; open: boolean } => {
  if (s === undefined) return { names: [], open: false }
  if (typeof s["$ref"] === "string") {
    const name = refName(s["$ref"])
    if (seen.has(name)) return { names: [], open: false }
    return literalsOf(defs[name], new Set(seen).add(name))
  }
  if (Array.isArray(s["enum"])) return { names: s["enum"].filter((v: unknown) => typeof v === "string"), open: false }
  if (typeof s["const"] === "string") return { names: [s["const"]], open: false }
  const alts: Array<Schema> | undefined = s["anyOf"] ?? s["oneOf"]
  if (Array.isArray(alts)) {
    const parts = alts.map((a) => literalsOf(a, seen))
    return { names: parts.flatMap((p) => p.names), open: parts.some((p) => p.open) }
  }
  const keys = Object.keys(s["properties"] ?? {})
  if (s["additionalProperties"] === false && keys.length === 1) return { names: keys, open: false }
  const types: Array<string> = Array.isArray(s["type"]) ? s["type"] : [s["type"]]
  return { names: [], open: types.includes("string") }
}

/** Codex's literals for a `known` check, as a TS type. */
const knownLiterals = (theirs: string): string => {
  const methods = /^G\.(\w+)\["method"\]$/.exec(theirs)
  if (methods !== null) return union(tsMethodsOf(methods[1]!).map((m) => m.method))
  const { names, open } = literalsOf(defs[theirsNames(theirs)[0]!])
  return names.length === 0 && open ? "string" : union([...new Set(names)])
}

const checkLines = (): Array<string> => {
  const lines = checks.map((c) => {
    const n = quote(labelOf(c))
    const ours = c.ours
    const theirs = asTs(c.theirs)
    switch (c.kind) {
      case "in":
        return `In<${n}, ${ours}, ${theirs}>`
      case "inUnion":
        return `InUnion<${n}, ${ours}, ${theirs}>`
      case "known":
        return `Known<${n}, ${ours}, ${knownLiterals(c.theirs)}>`
      case "out": {
        const t = c.variant === undefined ? theirs : `Extract<${theirs}, { type: ${quote(c.variant)} }>`
        return `Out<${n}, ${ours}, ${t}, ${union(requiredOf(theirsNames(c.theirs)[0]!, c.variant))}>`
      }
    }
  })
  for (const method of clientMethods) {
    const m = clientRequestMethods.find((r) => r.method === method)
    if (m === undefined) continue // reported by the ClientRequests `known` check
    const ours = `P.ClientRequests[${quote(method)}]`
    const req = m.params === null ? [] : requiredOf(m.params)
    lines.push(
      `Params<${quote(`${method} params`)}, ${ours}["params"], Extract<G_ClientRequest, { method: ${quote(method)} }>["params"], ${union(req)}, ${!m.paramsRequired}>`,
    )
    const response = responseOf(m)
    if (response !== null) lines.push(`In<${quote(`${method} result`)}, ${ours}["result"], G_${response}>`)
  }
  return lines
}

/** A check that must fail, so a broken setup can't pass silently. */
const canary = `In<"canary", { readonly field: string }, {}>`

const conformance = (): { readonly issues: Array<string>; readonly setupErrors: Array<string> } => {
  const lines = [...checkLines(), canary]
  const used = new Set(["ClientRequest", ...lines.flatMap((l) => [...l.matchAll(/\bG_(\w+)/g)].map((m) => m[1]!))])
  const imports = [...used].sort().map((name) => {
    const path = existsSync(join(out, "ts", "v2", `${name}.ts`)) ? `./ts/v2/${name}` : `./ts/${name}`
    return `import type { ${name} as G_${name} } from ${quote(path)}`
  })
  const file = [
    `import type * as P from ${quote(protocolPath)}`,
    ...imports,
    prelude,
    ...lines.map((l, i) => `export const Check${i}: { readonly [K in ${l}]: true } = {}`),
  ].join("\n")
  writeFileSync(join(out, "check.ts"), file)
  writeFileSync(
    join(out, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        target: "ES2024",
        module: "preserve",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        noErrorTruncation: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["check.ts"],
    }),
  )
  let output = ""
  try {
    run(join(repo, "node_modules", ".bin", "tsc"), ["-p", join(out, "tsconfig.json"), "--pretty", "false"])
  } catch (e) {
    output = String((e as { stdout?: unknown }).stdout ?? e)
  }
  // One diagnostic per `file(line,col): error ...` line, with its indented continuation lines.
  const diagnostics = output.split(/\n(?=\S)/).filter((d) => /\): error TS\d+/.test(d))
  const issues = new Set<string>()
  const setupErrors: Array<string> = []
  let sawCanary = false
  for (const d of diagnostics) {
    if (!/^\S*check\.ts\(/.test(d)) {
      setupErrors.push(d)
      continue
    }
    const messages = [...d.matchAll(/"([^"]+: [^"]+)"/g)].map((m) => m[1]!)
    if (messages.length === 0) setupErrors.push(d)
    for (const m of messages) {
      if (m.startsWith("canary")) sawCanary = true
      else issues.add(m)
    }
  }
  if (!sawCanary) setupErrors.push("the canary check passed: the conformance check is not running")
  return { issues: [...issues].sort(), setupErrors }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const exported = exportsOf(protocolSource)
const covered = new Set([
  ...Object.keys(local),
  ...clientRequestTypes,
  ...checks.flatMap((c) => [...c.ours.matchAll(/\bP\.(\w+)/g)].map((m) => m[1]!)),
])
const uncovered = exported.filter((name) => !covered.has(name))

const current = surface()
const committed = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : ""
const pinned = /^# (.*?):/.exec(committed)?.[1] ?? "(no snapshot)"
const { issues, setupErrors } = conformance()

console.log(`codex: ${version} (${codex}); snapshot: ${pinned}\n`)

console.log("== Surface (what protocol.ts depends on) ==")
const diff = unifiedDiff(committed, current, { from: `snapshot (${pinned})`, to: version, heading: /^[A-Za-z]/ })
console.log(diff === "" ? "unchanged\n" : diff)

console.log("== Conformance (protocol.ts against the generated bindings) ==")
if (uncovered.length > 0) {
  console.log(`not checked: ${uncovered.join(", ")} (add each to \`checks\` or \`local\` in scripts/codex-protocol.ts)`)
}
for (const e of setupErrors) console.log(`setup error: ${e}`)
console.log(issues.length === 0 ? "protocol.ts holds" : issues.map((i) => `- ${i}`).join("\n"))

if (update) {
  writeFileSync(snapshotPath, current)
  console.log(`\nwrote ${snapshotPath}`)
}
if (keep) console.log(`\ngenerated files: ${out}`)
else rmSync(out, { recursive: true, force: true })

if (issues.length > 0 || setupErrors.length > 0 || uncovered.length > 0) process.exitCode = 1
