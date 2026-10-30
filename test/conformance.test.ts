/**
 * The same programs against both providers (over their recorded sessions),
 * checking the guarantees `Agent` makes regardless of provider.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeAgent, ClaudeReplay } from "../src/claude/index.ts"
import { CodexAgent, CodexReplay } from "../src/codex/index.ts"
import { RemoteAgent } from "../src/host/index.ts"
import { AccountStatus, Agent, AgentEvent, type AgentSession, type RunOptions, SessionId } from "../src/index.ts"
import { host } from "./support/hostCommand.ts"

type Scenario =
  | "simple"
  | "tool"
  | "steer"
  | "interrupt"
  | "queue"
  | "spendCap"
  | "killed"
  | "usageLimit"
  | "resumeMissing"
  | "status"
  | "statusSignedOut"
  | "history"
  | "historyMissing"
  | "stall"

interface Provider {
  readonly name: string
  /** The underlying provider (`claude` / `codex`); differs from `name` for remote providers. */
  readonly kind: "claude" | "codex"
  /** Per-test timeout (remote sessions start a host process). */
  readonly timeout?: number
  readonly cwd: string
  readonly missingId: string
  readonly spendCapUsd: number
  /** A session stored in the `history` recording. */
  readonly stored: { readonly sessionId: string; readonly cwd: string }
  readonly layer: (scenario: Scenario) => Layer.Layer<Agent>
}

const fixture = (provider: string, name: string) => join(import.meta.dirname, "fixtures", provider, `${name}.jsonl`)

const claudeFixtures: Record<Scenario, string> = {
  simple: "simple-turn",
  tool: "bash-tool",
  steer: "steer",
  interrupt: "interrupt-then-turn",
  queue: "queue",
  spendCap: "spend-cap",
  killed: "process-killed",
  usageLimit: "usage-limit",
  resumeMissing: "resume-missing",
  status: "status",
  statusSignedOut: "status-unauthenticated",
  history: "history",
  historyMissing: "history",
  stall: "watchdog",
}

const codexFixtures: Record<Scenario, string> = {
  simple: "simple",
  tool: "command",
  steer: "steer-landed",
  interrupt: "interrupt",
  queue: "queue",
  spendCap: "spend-cap",
  killed: "process-killed",
  usageLimit: "usage-limit",
  resumeMissing: "resume-missing",
  status: "status",
  statusSignedOut: "status-signed-out",
  history: "history",
  historyMissing: "history-missing",
  stall: "stall",
}

/** Codex prices that make the spend-cap recording hit its cap. */
const codexPricing = (scenario: Scenario) => (scenario === "spendCap" ? { "*": { input: 1000, output: 1000 } } : undefined)

const claude: Provider = {
  name: "claude",
  kind: "claude",
  cwd: "/tmp/effect-agent-replay",
  missingId: "33333333-3333-4333-8333-333333333333",
  spendCapUsd: 0.0001,
  get stored() {
    const line = ClaudeReplay.load(fixture("claude", "history")).find((l) => l.dir === "history" && l.history !== null)
    if (line?.dir !== "history") throw new Error("no stored session in claude/history")
    return { sessionId: line.sessionId, cwd: line.cwd }
  },
  layer: (scenario) => {
    const name = claudeFixtures[scenario]
    // Skip the transcript precheck so the CLI's own "not found" path is exercised.
    const options = scenario === "resumeMissing" ? { knownSessions: "all" as const } : undefined
    return ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile(fixture("claude", name), options)))
  },
}

const codex: Provider = {
  name: "codex",
  kind: "codex",
  cwd: "/tmp/effect-agent-live/codex/work",
  missingId: "019a0000-0000-7000-8000-000000000000",
  spendCapUsd: 0.01,
  stored: { sessionId: "01a1896b-e054-7371-b868-b778fad6ea05", cwd: "/tmp/effect-agent-live/codex/work" },
  layer: (scenario) => {
    const name = codexFixtures[scenario]
    const pricing = codexPricing(scenario)
    return CodexAgent.layer(pricing ? { pricing } : {}).pipe(
      Layer.provide(CodexReplay.layer(readFileSync(fixture("codex", name), "utf8"))),
    )
  },
}

/**
 * The same recordings, each session in its own host process (src/host/main.ts)
 * behind a unix socket. `status` and `history` delegate to a local provider.
 */
const hostDir = mkdtempSync(join(tmpdir(), "ea-conf-"))
afterAll(() => {
  for (const host of RemoteAgent.listHosts(hostDir)) process.kill(host.pid, "SIGKILL")
  rmSync(hostDir, { recursive: true, force: true })
})

const remote = (local: Provider): Provider => ({
  ...local,
  name: `remote-${local.kind}`,
  timeout: 30_000,
  layer: (scenario) => {
    const fixtures = local.kind === "claude" ? claudeFixtures : codexFixtures
    const pricing = local.kind === "codex" ? codexPricing(scenario) : undefined
    return RemoteAgent.layer({ host,
      provider: local.kind,
      replay: fixture(local.kind, fixtures[scenario]),
      dir: hostDir,
      ...(local.kind === "claude" && scenario === "resumeMissing" && { replayKnownSessions: "all" as const }),
      ...(pricing !== undefined && { codex: { pricing } }),
    })
  },
})

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

/** Subscribe eagerly (the point of `subscribe`) and collect into an array. */
const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const stream = yield* session.subscribe
    const fiber = yield* stream.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.exit,
      Effect.forkScoped,
    )
    return { events, fiber }
  })

const waitFor = (events: ReadonlyArray<AgentEvent>, tag: AgentEvent["_tag"], count = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < 2_000; i++) {
      if (events.filter((e) => e._tag === tag).length >= count) return
      yield* Effect.sleep("1 millis")
    }
    return yield* Effect.die(new Error(`never saw ${count} × ${tag}`))
  })

/** Guarantees every provider's stream must satisfy. */
const checkStream = (events: ReadonlyArray<AgentEvent>, sessionId: string) => {
  // Every event is a valid AgentEvent (ids, outcomes, timestamps) and serializes.
  for (const event of events) Schema.encodeUnknownSync(AgentEvent)(event)

  expect(events[0]).toMatchObject({ _tag: "SessionStarted", sessionId })
  expect(events.filter((e) => e._tag === "SessionStarted")).toHaveLength(1)

  const open = new Set<string>()
  const ended = new Set<string>()
  const calls = new Set<string>()
  for (const event of events) {
    expect(event).toHaveProperty("raw")
    switch (event._tag) {
      case "TurnStarted":
        expect(open.size, "turns don't overlap").toBe(0)
        open.add(event.turnId)
        break
      case "MessageLanded":
        expect(open.has(event.turnId), "a message lands in the running turn").toBe(true)
        break
      case "ToolCall":
        calls.add(event.callId)
        expect(event.summary.length).toBeGreaterThan(0)
        break
      case "ToolResult":
        expect(calls.has(event.callId), "a result follows its call").toBe(true)
        break
      case "TurnEnded":
        expect(open.has(event.turnId), "a turn ends after it starts").toBe(true)
        expect(ended.has(event.turnId), "a turn ends once").toBe(false)
        open.delete(event.turnId)
        ended.add(event.turnId)
        break
    }
  }
  return { ended: [...ended] }
}

const outcomes = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e._tag === "TurnEnded" ? [e.outcome._tag] : []))

for (const provider of [claude, codex, remote(claude), remote(codex)]) {
  const base: RunOptions = { cwd: provider.cwd }

  describe(`conformance: ${provider.name}`, { timeout: provider.timeout ?? 5_000 }, () => {
    it.live("a turn succeeds, with a landed message, usage and cost-or-null", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        const done = yield* session.turn("Reply with just the word: pong")
        expect(done.finalText.toLowerCase()).toContain("pong")
        yield* waitFor(events, "TurnEnded")
        const { ended } = checkStream(events, session.sessionId)
        expect(ended).toEqual([done.turnId])
        expect(events.some((e) => e._tag === "MessageLanded" && e.turnId === done.turnId)).toBe(true)
        const end = events.find((e) => e._tag === "TurnEnded")!
        expect(end._tag === "TurnEnded" && end.usage?.inputTokens).toBeGreaterThan(0)
        yield* session.end
      }).pipe(Effect.provide(provider.layer("simple"))),
    )

    it.live("a tool call is followed by its result", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        yield* session.turn("run a command")
        yield* waitFor(events, "TurnEnded")
        checkStream(events, session.sessionId)
        const call = events.find((e) => e._tag === "ToolCall")
        const result = events.find((e) => e._tag === "ToolResult")
        expect(call && result && call._tag === "ToolCall" && result._tag === "ToolResult" && result.callId === call.callId).toBe(true)
        expect(result?._tag === "ToolResult" && result.isError).toBe(false)
      }).pipe(Effect.provide(provider.layer("tool"))),
    )

    it.live("steer lands in the running turn", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        yield* session.send("do some slow work")
        yield* waitFor(events, "ToolCall")
        const outcome = yield* session.steer("steering note")
        yield* waitFor(events, "TurnEnded")
        const { ended } = checkStream(events, session.sessionId)
        expect(outcome._tag).toBe("Landed")
        expect(ended).toEqual([outcome.turnId])
        expect(events.some((e) => e._tag === "MessageLanded" && e.messageId === outcome.messageId && e.turnId === outcome.turnId)).toBe(true)
        expect(outcomes(events)).toEqual(["Succeeded"])
      }).pipe(Effect.provide(provider.layer("steer"))),
    )

    it.live("interrupt ends the turn Interrupted and the session keeps working", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        yield* session.send("sleep for a long time")
        yield* waitFor(events, "ToolCall")
        yield* session.interrupt
        yield* waitFor(events, "TurnEnded")
        const next = yield* session.turn("Reply with just the word: pong")
        yield* waitFor(events, "TurnEnded", 2)
        checkStream(events, session.sessionId)
        expect(outcomes(events)).toEqual(["Interrupted", "Succeeded"])
        expect(next.finalText.length).toBeGreaterThan(0)
      }).pipe(Effect.provide(provider.layer("interrupt"))),
    )

    it.live("a message sent during a turn runs as the next turn", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        const first = yield* session.send("first")
        yield* waitFor(events, "TurnStarted")
        const second = yield* session.send("second")
        yield* waitFor(events, "TurnEnded", 2)
        const { ended } = checkStream(events, session.sessionId)
        expect(ended).toHaveLength(2)
        const landedIn = (id: string) => events.find((e) => e._tag === "MessageLanded" && e.messageId === id)
        const [a, b] = [landedIn(first), landedIn(second)]
        expect(a?._tag === "MessageLanded" && b?._tag === "MessageLanded" && a.turnId !== b.turnId).toBe(true)
        expect(outcomes(events)).toEqual(["Succeeded", "Succeeded"])
      }).pipe(Effect.provide(provider.layer("queue"))),
    )

    it.live("the spend cap ends the turn SpendCapReached", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open({ ...base, spendCapUsd: provider.spendCapUsd })
        const { events } = yield* collect(session)
        const failure = failureOf(yield* session.turn("spend some money").pipe(Effect.exit))
        expect(failure).toMatchObject({ _tag: "SpendCapReached", capUsd: provider.spendCapUsd })
        yield* waitFor(events, "TurnEnded")
        checkStream(events, session.sessionId)
        expect(outcomes(events)).toEqual(["SpendCapReached"])
      }).pipe(Effect.provide(provider.layer("spendCap"))),
    )

    it.live("process death ends the turn ProcessKilled and fails everything after", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events, fiber } = yield* collect(session)
        const failure = failureOf(yield* session.turn("sleep").pipe(Effect.exit))
        expect(failure?._tag).toBe("ProcessKilled")
        expect(failureOf(yield* session.send("hello?").pipe(Effect.exit))?._tag).toBe("AgentError")
        expect(failureOf(yield* session.interrupt.pipe(Effect.exit))?._tag).toBe("AgentError")
        expect(failureOf(yield* Fiber.join(fiber))?._tag).toBe("AgentError")
        checkStream(events, session.sessionId)
        expect(outcomes(events)).toEqual(["ProcessKilled"])
      }).pipe(Effect.provide(provider.layer("killed"))),
    )

    it.live("a usage limit is UsageLimited with a window and a reset time", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        const { events } = yield* collect(session)
        const failure = failureOf(yield* session.turn("hello").pipe(Effect.exit))
        expect(failure?._tag).toBe("UsageLimited")
        if (failure?._tag !== "UsageLimited") return
        expect(["five_hour", "weekly"]).toContain(failure.window)
        expect(failure.resetsAt).not.toBeNull()
        yield* waitFor(events, "TurnEnded")
        checkStream(events, session.sessionId)
      }).pipe(Effect.provide(provider.layer("usageLimit"))),
    )

    it.live("resuming an unknown session fails open with SessionNotFound", () =>
      Effect.gen(function* () {
        const id = SessionId.make(provider.missingId)
        const failure = failureOf(yield* (yield* Agent).open({ ...base, resume: id }).pipe(Effect.exit))
        expect(failure).toMatchObject({ _tag: "SessionNotFound", sessionId: id })
      }).pipe(Effect.provide(provider.layer("resumeMissing"))),
    )

    it.live("status reports sign-in, plan and limit windows without a turn", () =>
      Effect.gen(function* () {
        const status = yield* (yield* Agent).status()
        Schema.encodeUnknownSync(AccountStatus)(status)
        expect(status).toMatchObject({ provider: provider.kind, usable: true, reason: null })
        expect(status.plan).not.toBeNull()
        expect(status.windows.length).toBeGreaterThan(0)
        for (const w of status.windows) {
          expect(w.usedPercent === null || (w.usedPercent >= 0 && w.usedPercent <= 100)).toBe(true)
        }
        expect(status.windows.some((w) => w.window === "five_hour" || w.window === "weekly")).toBe(true)
      }).pipe(Effect.provide(provider.layer("status"))),
    )

    it.live("status reports a signed-out account as unusable", () =>
      Effect.gen(function* () {
        const status = yield* (yield* Agent).status()
        expect(status).toMatchObject({ usable: false, reason: "unauthenticated", windows: [], plan: null })
      }).pipe(Effect.provide(provider.layer("statusSignedOut"))),
    )

    it.live("history replays a stored session as well-formed turns", () =>
      Effect.gen(function* () {
        const { sessionId, cwd } = provider.stored
        const events = yield* (yield* Agent).history(SessionId.make(sessionId), { cwd })
        for (const event of events) Schema.encodeUnknownSync(AgentEvent)(event)
        expect(events[0]?._tag).toBe("TurnStarted")
        let turn: string | null = null
        const calls = new Set<string>()
        for (const [i, event] of events.entries()) {
          if (event._tag === "TurnStarted") {
            turn = event.turnId
            expect(events[i + 1]?._tag, "each turn opens with its prompt").toBe("UserMessage")
          }
          if ("turnId" in event && event.turnId !== null && event._tag !== "TurnStarted") expect(event.turnId).toBe(turn)
          if (event._tag === "ToolCall") calls.add(event.callId)
          if (event._tag === "ToolResult") expect(calls.has(event.callId)).toBe(true)
        }
        expect(events.filter((e) => e._tag === "UserMessage").length).toBeGreaterThan(1)
        expect(events.some((e) => e._tag === "ToolCall")).toBe(true)
      }).pipe(Effect.provide(provider.layer("history"))),
    )

    it.live("history of an unknown session fails SessionNotFound", () =>
      Effect.gen(function* () {
        const id = SessionId.make(provider.kind === "claude" ? "44444444-4444-4444-8444-444444444444" : provider.missingId)
        const failure = failureOf(yield* (yield* Agent).history(id, { cwd: provider.cwd }).pipe(Effect.exit))
        expect(failure).toMatchObject({ _tag: "SessionNotFound", sessionId: id })
      }).pipe(Effect.provide(provider.layer("historyMissing"))),
    )

    it.live("the watchdog ends a silent tool call Stalled, and the session keeps working", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open({ ...base, watchdog: { idle: "30 seconds", toolIdle: "300 millis" } })
        const { events } = yield* collect(session)
        const failure = failureOf(yield* session.turn("run a slow, silent command").pipe(Effect.exit))
        expect(failure).toMatchObject({ _tag: "Stalled", inTool: true })
        const next = yield* session.turn("Reply with just the word: pong")
        expect(next.finalText.length).toBeGreaterThan(0)
        yield* waitFor(events, "TurnEnded", 2)
        checkStream(events, session.sessionId)
        expect(outcomes(events)).toEqual(["Stalled", "Succeeded"])
      }).pipe(Effect.provide(provider.layer("stall"))),
    )

    it.live("pid is none without a process", () =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open(base)
        expect(Option.isNone(yield* session.pid)).toBe(true)
      }).pipe(Effect.provide(provider.layer("simple"))),
    )

    it.live("capabilities decode as Capabilities", () =>
      Effect.gen(function* () {
        const caps = yield* (yield* Agent).capabilities
        expect(caps.provider).toBe(provider.kind)
        expect(caps.reattach).toBe(provider.name.startsWith("remote-"))
        expect(caps.version).toMatch(/^\d+\.\d+\.\d+/)
      }).pipe(Effect.provide(provider.layer("simple"))),
    )
  })
}
