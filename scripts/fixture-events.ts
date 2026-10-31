/**
 * Compares the fixtures in the working tree with those at a git ref, as
 * normalized event sequences and frame shapes rather than JSONL.
 *
 *   node scripts/fixture-events.ts                     # HEAD -> working tree
 *   node scripts/fixture-events.ts --base main         # another baseline
 *   node scripts/fixture-events.ts --print codex/simple   # one fixture's listing
 *   node scripts/fixture-events.ts --text              # include assistant text
 *
 * Events: each recording is folded through the provider's own pure mapping,
 * with no program driving it: Claude's `ClaudeAgent.step`/`stepExit` (the
 * session's whole state machine), and for Codex `CodexEvents` plus the turn
 * lifecycle `CodexAgent` runs around it (TurnStarted, MessageLanded,
 * TurnEnded). Stored history and account status lines go through
 * `historyEvents` and `accountStatus`. Ids become t1/m1/c1, heartbeats are
 * dropped, repeats are counted, and model-written text and timings are
 * left out, so a listing changes when the CLI's frames map differently,
 * not when the model words its reply differently. Outcomes the agent
 * decides itself (spend cap, watchdog) show as the interrupt they caused.
 *
 * Shapes: every key path (with value types) of every frame the CLI sent,
 * per frame kind, across each provider's fixtures. New fields and frame
 * kinds show up here even when the mapping ignores them.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DateTime } from "effect"
import type { AgentEvent } from "../src/AgentEvent.ts"
import type { TurnOutcome } from "../src/Turn.ts"
import { SessionId } from "../src/AgentSession.ts"
import * as ClaudeAgent from "../src/claude/ClaudeAgent.ts"
import type * as ClaudeSdk from "../src/claude/ClaudeSdk.ts"
import * as CodexEvents from "../src/codex/CodexEvents.ts"
import type * as P from "../src/codex/protocol.ts"
import { unifiedDiff } from "./lib/lineDiff.ts"

const repo = join(import.meta.dirname, "..")
const providers = ["claude", "codex"] as const
type Provider = (typeof providers)[number]

const args = process.argv.slice(2)
const optionValue = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const base = optionValue("--base") ?? "HEAD"
const withText = args.includes("--text")

const parse = (text: string): Array<any> =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))

// ---------------------------------------------------------------------------
// Rendering events
// ---------------------------------------------------------------------------

/** Replaces ids with t1, m1, c1, ... in order of first appearance. */
const makeIds = () => {
  const seen = new Map<string, string>()
  const counts: Record<string, number> = {}
  return (prefix: string, id: string | null | undefined): string => {
    if (id === null || id === undefined) return "-"
    const key = `${prefix}:${id}`
    if (!seen.has(key)) seen.set(key, `${prefix}${(counts[prefix] = (counts[prefix] ?? 0) + 1)}`)
    return seen.get(key)!
  }
}

const short = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, " ").trim()
  return JSON.stringify(line.length > max ? `${line.slice(0, max)}...` : line)
}

/** The frame kind of a raw value: Claude `type/subtype`, Codex `method`. */
const kindOf = (raw: unknown): string => {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r["method"] === "string") return "id" in r ? `${r["method"]} (request)` : r["method"]
  if (typeof r["type"] === "string") return typeof r["subtype"] === "string" ? `${r["type"]}/${r["subtype"]}` : r["type"]
  return "?"
}

/** Outcome tag and its fields, without messages, ids, text and amounts that vary run to run. */
const outcomeText = (outcome: TurnOutcome): string => {
  const skip = new Set(["_tag", "message", "turnId", "finalText", "spentUsd", "idleMs", "cause", "stack", "name"])
  const fields = Object.entries(outcome)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${DateTime.isDateTime(v) ? "<time>" : JSON.stringify(v)}`)
  return [outcome._tag, ...fields].join(" ")
}

const eventLine = (e: AgentEvent, id: ReturnType<typeof makeIds>): string | null => {
  switch (e._tag) {
    case "SessionStarted":
      return `SessionStarted resumed=${e.resumed}${e.model !== null ? ` model=${e.model}` : ""}`
    case "TurnStarted":
      return `TurnStarted ${id("t", e.turnId)}`
    case "MessageLanded":
      return `MessageLanded ${id("m", e.messageId)} in ${id("t", e.turnId)}`
    case "MessageDropped":
      return `MessageDropped ${id("m", e.messageId)} ${e.reason}`
    case "UserMessage":
      return `UserMessage ${id("t", e.turnId)} ${short(e.text)}`
    case "Text":
      return `Text ${id("t", e.turnId)}${withText ? ` ${short(e.text)}` : ""}`
    case "ToolCall":
      return `ToolCall ${id("t", e.turnId)} ${id("c", e.callId)} ${e.name} ${short(e.summary)}`
    case "ToolResult":
      return `ToolResult ${id("t", e.turnId)} ${id("c", e.callId)} ${e.isError ? "error" : "ok"}`
    case "Retrying":
      return `Retrying ${id("t", e.turnId)} ${e.attempt ?? "?"}/${e.maxAttempts ?? "?"}`
    case "LimitsUpdated":
      return `LimitsUpdated ${e.windows.map((w) => `${w.label}:${w.window}`).join(" ")}`
    case "Compacted":
      return `Compacted ${id("t", e.turnId)} ${e.trigger ?? "-"}`
    case "Heartbeat":
      return null
    case "Other":
      return `Other ${kindOf(e.raw)}`
    case "TurnEnded":
      return `TurnEnded ${id("t", e.turnId)} ${outcomeText(e.outcome)} usage=${e.usage !== null ? "yes" : "no"} cost=${e.cost?.source ?? "none"}`
  }
}

/** The mapping threw on a frame: the live session would end with a defect. */
const threw = (frame: unknown, e: unknown) => `!! mapping threw on ${kindOf(frame)}: ${e instanceof Error ? e.message : String(e)}`

/** Lines, with runs of the same line counted. */
const collapse = (lines: ReadonlyArray<string>): Array<string> => {
  const out: Array<string> = []
  let i = 0
  while (i < lines.length) {
    let j = i
    while (j < lines.length && lines[j] === lines[i]) j++
    out.push(j - i > 1 ? `${lines[i]} x${j - i}` : lines[i]!)
    i = j
  }
  return out
}

const statusLine = (s: {
  readonly usable: boolean
  readonly reason: string | null
  readonly plan: string | null
  readonly windows: ReadonlyArray<{ readonly label: string; readonly window: string }>
}) => `Status usable=${s.usable} reason=${s.reason ?? "-"} plan=${s.plan ?? "-"} windows=${s.windows.map((w) => `${w.label}:${w.window}`).join(",")}`

// ---------------------------------------------------------------------------
// Claude: ClaudeAgent.step over the recorded frames
// ---------------------------------------------------------------------------

const claudeEvents = (lines: ReadonlyArray<ClaudeSdk.RecordLine>): Array<string> => {
  const out: Array<string> = []
  const id = makeIds()
  let session: {
    state: ClaudeAgent.State
    ctx: ClaudeAgent.StepContext
    pending: Array<string>
  } | null = null
  let nowMs = 0
  const emit = (step: ClaudeAgent.Step) => {
    if (session === null) return
    session.state = step.state
    for (const e of step.events) {
      if (e._tag === "MessageLanded" || e._tag === "MessageDropped") session.pending = session.pending.filter((p) => p !== e.messageId)
      const line = eventLine(e, id)
      if (line !== null) out.push(line)
    }
  }
  const close = (failure: ClaudeAgent.ProcessFailure | null) => {
    if (session !== null) emit(ClaudeAgent.stepExit({ ...session.ctx, nowMs }, session.state, failure))
    session = null
  }
  for (const line of lines) {
    nowMs += 10_000 // past the heartbeat throttle; heartbeats aren't listed anyway
    switch (line.dir) {
      case "ctl":
        if (line.call === "open") {
          close(null)
          out.push(`-- open${line.options.resume !== undefined ? " (resume)" : ""}`)
          session = {
            state: ClaudeAgent.initialState,
            ctx: {
              sessionId: SessionId.make(line.options.resume ?? line.options.sessionId ?? "session"),
              resumed: line.options.resume !== undefined,
              capUsd: null,
              nowMs: 0,
            },
            pending: [],
          }
        } else if (line.call === "interrupt") {
          out.push("-- interrupt")
          if (session !== null) session.state = ClaudeAgent.markInterrupt(session.state)
        } else {
          out.push("-- end")
          close(null)
        }
        break
      case "out":
        out.push(`-- send ${id("m", line.frame.uuid ?? null)}`)
        if (session !== null && line.frame.uuid !== undefined) session.pending.push(line.frame.uuid)
        break
      case "in":
        if (session !== null) {
          try {
            emit(ClaudeAgent.step({ ...session.ctx, nowMs, nextPending: session.pending[0] ?? null }, session.state, line.frame))
          } catch (e) {
            // The live session dies here ("bug while reading Claude Code frames").
            out.push(threw(line.frame, e))
            session = null
          }
        }
        break
      case "hook":
        out.push(`-- hook ${line.event}`)
        break
      case "error":
        out.push(`-- error ${line.error.operation} ${line.error.errorClass ?? "-"} signal=${line.error.signal ?? "-"} exit=${line.error.exitCode ?? "-"}`)
        close({ message: line.error.message, signal: line.error.signal, exitCode: line.error.exitCode })
        break
      case "status":
        out.push(statusLine(ClaudeAgent.accountStatus(line.status, DateTime.makeUnsafe(0))))
        break
      case "history":
        out.push(`-- history${line.history === null ? " (none)" : ""}`)
        for (const e of line.history === null ? [] : ClaudeAgent.historyEvents(line.history.messages)) {
          const l = eventLine(e, id)
          if (l !== null) out.push(l)
        }
        break
    }
  }
  close(null)
  return out
}

// ---------------------------------------------------------------------------
// Codex: CodexEvents, with CodexAgent's turn lifecycle
// ---------------------------------------------------------------------------

type CodexFrame = { dir: "out" | "in"; msg: P.Message } | { dir: "exit"; exitCode: number | null; signal: string | null }

const codexEvents = (frames: ReadonlyArray<CodexFrame>): Array<string> => {
  const out: Array<string> = []
  const id = makeIds()
  const methods = new Map<P.RequestId, string>()
  const mapState = CodexEvents.makeMapState()
  let threadId: string | null = null
  let account: P.GetAccountResponse | null = null
  let run: {
    turnId: string | null
    announced: boolean
    unlanded: Array<string>
    interruptRequested: boolean
    sawUsage: boolean
    messages: Array<{ text: string; phase: string | null }>
  } | null = null
  const newRun = () => ({ turnId: null, announced: false, unlanded: [], interruptRequested: false, sawUsage: false, messages: [] })
  const push = (events: ReadonlyArray<AgentEvent>) => {
    for (const e of events) {
      const l = eventLine(e, id)
      if (l !== null) out.push(l)
    }
  }
  /** The `account/rateLimits/read` answer after index i, as `CodexAgent` reads one for a usage-limited turn. */
  const nextRateLimits = (i: number): P.GetAccountRateLimitsResponse | null => {
    let requestId: P.RequestId | undefined
    for (let j = i + 1; j < frames.length; j++) {
      const f = frames[j]!
      if (f.dir === "exit") return null
      if (requestId === undefined) {
        if (f.dir === "out" && f.msg.method === "account/rateLimits/read") requestId = f.msg.id
      } else if (f.dir === "in" && f.msg.id === requestId && f.msg.method === undefined) {
        return (f.msg.result as P.GetAccountRateLimitsResponse | undefined) ?? null
      }
    }
    return null
  }

  let dead = false
  frames.forEach((f, i) => {
    if (dead) return
    try {
      step(f, i)
    } catch (e) {
      out.push(threw(f.dir === "exit" ? f : f.msg, e))
      dead = true
    }
  })
  return out

  function step(f: CodexFrame, i: number): void {
    if (f.dir === "exit") {
      out.push(`-- exit ${f.signal ?? `code ${f.exitCode}`}`)
      if (run?.turnId != null) {
        push([
          {
            _tag: "TurnEnded",
            turnId: run.turnId as never,
            outcome: CodexEvents.classifyOutcome({ id: run.turnId, items: [], status: "interrupted", error: null }, {
              interruptRequested: run.interruptRequested,
              spendCap: null,
              capUsd: null,
              processExit: { exitCode: f.exitCode, signal: f.signal },
              finalText: "",
              rateLimits: null,
            }),
            usage: null,
            cost: null,
            raw: f,
          },
        ])
      }
      run = null
      return
    }
    const msg = f.msg
    const params: any = msg.params ?? {}
    if (f.dir === "out") {
      if (msg.method === undefined || msg.id === undefined) return
      methods.set(msg.id, msg.method)
      if (msg.method === "initialize" || msg.method === "account/read" || msg.method === "account/rateLimits/read") return
      out.push(`-- ${msg.method}`)
      if (msg.method === "turn/start") {
        run = { ...newRun(), unlanded: [params.clientUserMessageId] }
        out.push(`   send ${id("m", params.clientUserMessageId)}`)
      } else if (msg.method === "turn/steer") {
        run?.unlanded.push(params.clientUserMessageId)
        out.push(`   steer ${id("m", params.clientUserMessageId)}`)
      } else if (msg.method === "turn/interrupt" && run !== null) {
        run.interruptRequested = true
      }
      return
    }
    // A response
    if (msg.id !== undefined && msg.method === undefined) {
      const method = methods.get(msg.id) ?? "?"
      if (msg.error !== undefined) {
        out.push(`RpcError ${method} ${msg.error.code} ${short(msg.error.message, 80)}`)
        return
      }
      const result: any = msg.result
      switch (method) {
        case "thread/start":
        case "thread/resume":
          threadId = result.thread.id
          out.push(`SessionStarted resumed=${method === "thread/resume"} model=${result.model}`)
          return
        case "account/read":
          account = result
          return
        case "account/rateLimits/read":
          if (account !== null) out.push(statusLine(CodexEvents.accountStatus(account, result, 0)))
          return
        case "thread/turns/list":
          out.push(`-- history${result.nextCursor !== null ? " (more pages)" : ""}`)
          push(CodexEvents.historyEvents(result.data))
          return
      }
      return
    }
    // A notification or server request (CodexAgent's `handle`)
    const incoming = msg as P.Incoming
    if (typeof params.threadId === "string" && threadId !== null && params.threadId !== threadId) {
      out.push(`Other ${kindOf(msg)} (other thread)`)
      return
    }
    if (!("id" in incoming && incoming.id !== undefined)) {
      switch (incoming.method as P.NotificationMethod) {
        case "turn/started": {
          const current = (run ??= newRun())
          current.turnId ??= params.turn.id
          if (current.turnId !== params.turn.id || current.announced) return void out.push(`Other ${kindOf(msg)}`)
          current.announced = true
          return void out.push(`TurnStarted ${id("t", current.turnId)}`)
        }
        case "turn/completed": {
          const turn: P.Turn = params.turn
          if (run === null || (run.turnId !== null && run.turnId !== turn.id)) return void out.push(`Other ${kindOf(msg)}`)
          run.turnId ??= turn.id
          const kind = CodexEvents.errorKind(turn.error?.codexErrorInfo)
          const messages =
            run.messages.length > 0
              ? run.messages
              : turn.items.flatMap((item: any) => (item.type === "agentMessage" ? [{ text: item.text ?? "", phase: item.phase ?? null }] : []))
          const outcome = CodexEvents.classifyOutcome(turn, {
            interruptRequested: run.interruptRequested,
            spendCap: null,
            capUsd: null,
            processExit: null,
            finalText: CodexEvents.finalTextOf(messages),
            rateLimits: turn.status === "failed" && kind === "usageLimitExceeded" ? nextRateLimits(i) : null,
          })
          out.push(`TurnEnded ${id("t", turn.id)} ${outcomeText(outcome)} usage=${run.sawUsage ? "yes" : "no"} cost=none`)
          run = null
          return
        }
        case "thread/tokenUsage/updated":
          if (run !== null) run.sawUsage = true
          break
        case "item/started":
          if (params.item?.type === "userMessage") {
            const clientId: string | null = params.item.clientId
            const messageId = run === null ? undefined : clientId !== null && run.unlanded.includes(clientId) ? clientId : run.unlanded[0]
            if (run === null || messageId === undefined || run.turnId === null) return void out.push(`Other ${kindOf(msg)}`)
            run.unlanded.splice(run.unlanded.indexOf(messageId), 1)
            return void out.push(`MessageLanded ${id("m", messageId)} in ${id("t", run.turnId)}`)
          }
          break
        case "item/completed":
          if (params.item?.type === "agentMessage") run?.messages.push({ text: params.item.text ?? "", phase: params.item.phase ?? null })
          break
      }
    }
    push(CodexEvents.mapNotification(incoming, mapState, i * 10_000))
  }
}

// ---------------------------------------------------------------------------
// Frame shapes
// ---------------------------------------------------------------------------

/** Keys that are data, not field names (model names, limit ids, tool-use ids, paths): shown as `*`. */
const fieldName = (key: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/\d.*\d.*\d/.test(key) ? key : "*")

const jsonType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)

/** `path: type` for every value in a frame; an object with a string `type` is labelled `<type>`. */
const shapes = (value: unknown, path: string, out: Set<string>, depth = 0) => {
  if (depth > 8) return
  if (Array.isArray(value)) {
    out.add(`${path}: array`)
    for (const v of value) shapes(v, `${path}[]`, out, depth + 1)
    return
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>
    const label = depth > 0 && typeof o["type"] === "string" ? `${path}<${o["type"]}>` : path
    out.add(`${label}: object`)
    for (const [k, v] of Object.entries(o)) shapes(v, `${label}.${fieldName(k)}`, out, depth + 1)
    return
  }
  out.add(`${path}: ${jsonType(value)}`)
}

const frameShapes = (provider: Provider, text: string, out: Set<string>) => {
  const lines = parse(text)
  if (provider === "claude") {
    for (const l of lines) if (l.dir === "in") shapes(l.frame, kindOf(l.frame), out)
    return
  }
  const methods = new Map<unknown, string>()
  for (const l of lines) {
    if (l.dir === "out" && l.msg.method !== undefined) methods.set(l.msg.id, l.msg.method)
    if (l.dir !== "in") continue
    const m = l.msg
    const kind =
      m.method !== undefined ? kindOf(m) : `${methods.get(m.id) ?? "?"} (${m.error !== undefined ? "error" : "result"})`
    shapes(m.params ?? m.result ?? m.error ?? null, kind, out)
  }
}

// ---------------------------------------------------------------------------
// Fixtures at the ref and in the working tree
// ---------------------------------------------------------------------------

const git = (argv: ReadonlyArray<string>) => execFileSync("git", argv, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 })

const fixtureNames = (provider: Provider, ref: string | null): Array<string> =>
  ref === null
    ? readdirSync(join(repo, "test", "fixtures", provider)).filter((n) => n.endsWith(".jsonl"))
    : git(["ls-tree", "--name-only", `${ref}:test/fixtures/${provider}/`])
        .split("\n")
        .filter((n) => n.endsWith(".jsonl"))

const fixtureText = (provider: Provider, name: string, ref: string | null): string =>
  ref === null ? readFileSync(join(repo, "test", "fixtures", provider, name), "utf8") : git(["show", `${ref}:test/fixtures/${provider}/${name}`])

const listing = (provider: Provider, text: string): string =>
  collapse(provider === "claude" ? claudeEvents(parse(text)) : codexEvents(parse(text))).join("\n") + "\n"

/** The CLI version in a recording, if it says. */
const versionOf = (text: string): string | null =>
  /"claude_code_version":\s*"([^"]+)"/.exec(text)?.[1] ?? /"userAgent":\s*"[^/"]+\/([^ "]+)/.exec(text)?.[1] ?? null

const print = optionValue("--print")
if (print !== undefined) {
  const [provider, name] = print.split("/") as [Provider, string]
  process.stdout.write(listing(provider, fixtureText(provider, `${name}.jsonl`, null)))
  process.exit(0)
}

let changes = 0
for (const provider of providers) {
  const before = new Set(fixtureNames(provider, base))
  const after = new Set(fixtureNames(provider, null))
  const versions = { before: new Set<string>(), after: new Set<string>() }
  const shapeSets = { before: new Set<string>(), after: new Set<string>() }
  const unchanged: Array<string> = []
  console.log(`==== ${provider}: ${base} -> working tree ====`)
  for (const name of [...new Set([...before, ...after])].sort()) {
    const label = `${provider}/${name.replace(/\.jsonl$/, "")}`
    const a = before.has(name) ? fixtureText(provider, name, base) : null
    const b = after.has(name) ? fixtureText(provider, name, null) : null
    for (const [text, side] of [
      [a, "before"],
      [b, "after"],
    ] as const) {
      if (text === null) continue
      const v = versionOf(text)
      if (v !== null) versions[side].add(v)
      frameShapes(provider, text, shapeSets[side])
    }
    if (a === null || b === null) {
      changes++
      console.log(`\n== ${label}: ${a === null ? "added" : "removed"} ==`)
      continue
    }
    const diff = unifiedDiff(listing(provider, a), listing(provider, b), { context: 3 })
    if (diff === "") {
      unchanged.push(label)
      continue
    }
    changes++
    console.log(`\n== ${label} (${versionOf(a) ?? "?"} -> ${versionOf(b) ?? "?"}) ==\n${diff}`)
  }
  console.log(`\nversions: ${[...versions.before].join(", ") || "-"} -> ${[...versions.after].join(", ") || "-"}`)
  console.log(`events unchanged: ${unchanged.length === 0 ? "none" : unchanged.join(", ")}`)
  const shapeDiff = unifiedDiff([...shapeSets.before].sort().join("\n"), [...shapeSets.after].sort().join("\n"), { context: 0 })
  console.log(`\n== ${provider} frame shapes ==\n${shapeDiff === "" ? "unchanged" : shapeDiff.split("\n").filter((l) => !l.startsWith("@@")).join("\n")}\n`)
  if (shapeDiff !== "") changes++
}
console.log(changes === 0 ? "no differences" : `${changes} difference(s)`)
