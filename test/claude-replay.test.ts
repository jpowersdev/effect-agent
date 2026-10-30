/**
 * The real `ClaudeAgent` layer over recorded frame streams (test/fixtures/claude,
 * recorded by `node scripts/live-claude.ts --fixtures`), with no process.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { join } from "node:path"
import { ClaudeAgent, ClaudeReplay } from "../src/claude/index.ts"
import { AccountStatus, Agent, AgentEvent, type AgentSession, SessionId } from "../src/index.ts"

const fixture = (name: string) => join(import.meta.dirname, "fixtures", "claude", `${name}.jsonl`)
const replay = (name: string, options?: ClaudeReplay.ReplayOptions) =>
  ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile(fixture(name), options)))

const cwd = "/tmp/effect-agent-replay"
const observed: Array<ClaudeReplay.ReplayedHook> = []
const observedNone: Array<ClaudeReplay.ReplayedHook> = []

const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const fiber = yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.forkScoped({ startImmediately: true }),
    )
    return { events, fiber }
  })

/** Wait (by yielding, so it works under TestClock) until an event matches. */
const waitFor = (events: ReadonlyArray<AgentEvent>, f: (e: AgentEvent) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 10_000; i++) {
      const found = events.find(f)
      if (found !== undefined) return found
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("event never arrived"))
  })

const visible = (events: ReadonlyArray<AgentEvent>) =>
  events.filter((e) => !["Other", "Heartbeat", "LimitsUpdated"].includes(e._tag)).map((e) => e._tag)

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

describe("ClaudeAgent over recordings", () => {
  it.effect("hooks run in the session's context, but not under the span of the long-finished open", () =>
    Effect.gen(function* () {
      const parents: Array<string> = []
      const parentName = Effect.currentParentSpan.pipe(
        Effect.map((span) => (span._tag === "Span" ? span.name : span._tag)),
        Effect.orElseSucceed(() => "none"),
      )
      const session = yield* (yield* Agent).open({
        cwd,
        hooks: {
          beforeTool: () => Effect.map(parentName, (name) => (parents.push(name), Option.none())),
        },
      })
      yield* session.turn("Use the Bash tool once to run `echo hello`, then reply with the secret word.")
      expect(parents.length).toBeGreaterThan(0)
      expect(parents).not.toContain("ClaudeAgent.open")
    }).pipe(Effect.scoped, Effect.provide(replay("hooks"))),
  )


  it.effect("recorded hook calls reach the session's hooks, with the CLI's inputs, and their answers reach the SDK", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = []
      let stops = 0
      const session = yield* (yield* Agent).open({
        cwd,
        hooks: {
          beforeTool: (call) => Effect.sync(() => (calls.push({ before: call }), Option.some("replayed: secret"))),
          afterTool: (call) => Effect.sync(() => (calls.push({ after: call }), Option.some("replayed: checked"))),
          beforeStop: () => Effect.sync(() => (calls.push("stop"), stops++ === 0 ? Option.some("replayed: keep going") : Option.none())),
        },
      })
      const done = yield* session.turn("Use the Bash tool once to run `echo hello`, then reply with the secret word.")
      expect(done.finalText).toBe("KIWI") // recorded: a replay's reply can't change
      expect(calls).toEqual([
        { before: { callId: expect.stringMatching(/^toolu_/), name: "Bash", input: expect.objectContaining({ command: "echo hello" }) } },
        {
          after: {
            callId: expect.stringMatching(/^toolu_/),
            name: "Bash",
            input: expect.objectContaining({ command: "echo hello" }),
            output: "hello",
            isError: false,
          },
        },
        "stop",
        "stop",
      ])
      // What the SDK got back from each hook call: this session's answers, not the recorded ones.
      const context = (event: string) =>
        observed
          .filter((h) => h.event === event)
          .map((h) => (h.outputs[0] as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? null)
      expect(context("PreToolUse")).toEqual(["replayed: secret"])
      expect(context("PostToolUse")).toEqual(["replayed: checked"])
      expect(context("Stop")).toEqual(["replayed: keep going", null])
      expect(observed.map((h) => (h.input as { session_id?: string }).session_id)).toEqual(Array(4).fill(session.sessionId))
    }).pipe(Effect.scoped, Effect.provide(replay("hooks", { onHook: (h) => observed.push(h) }))),
  )

  it.effect("recorded hook calls with no hooks set call nothing", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      yield* session.turn("Use the Bash tool once to run `echo hello`, then reply with the secret word.")
      expect(observedNone.map((h) => h.outputs)).toEqual([[], [], [], []])
    }).pipe(Effect.scoped, Effect.provide(replay("hooks", { onHook: (h) => observedNone.push(h) }))),
  )

  it.effect("simple turn", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      expect((yield* agent.capabilities).version).toBe("2.1.312")
      const session = yield* agent.open({ cwd })
      const { events, fiber } = yield* collect(session)
      const done = yield* session.turn("Reply with just the word: pong")
      expect(done.finalText.toLowerCase()).toContain("pong")
      yield* session.end
      yield* Fiber.join(fiber)
      expect(visible(events)).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "Text", "TurnEnded"])
      const started = events[0]!
      expect(started).toMatchObject({ _tag: "SessionStarted", sessionId: session.sessionId, version: "2.1.312", model: "claude-haiku-5-5", resumed: false })
      expect((started.raw as { session_id: string }).session_id).toBe(session.sessionId)
      const ended = events.find((e) => e._tag === "TurnEnded")!
      expect(ended).toMatchObject({ turnId: done.turnId, cost: { source: "reported" } })
      expect(ended._tag === "TurnEnded" && ended.usage!.inputTokens).toBeGreaterThan(0)
      expect(Option.getOrThrow(session.location)).toMatch(new RegExp(`/projects/-tmp-effect-agent-replay/${session.sessionId}\\.jsonl$`))
    }).pipe(Effect.provide(replay("simple-turn"))),
  )

  it.effect("Bash tool call and result", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events } = yield* collect(session)
      const done = yield* session.turn("bash")
      expect(visible(events)).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "ToolCall", "ToolResult", "Text", "TurnEnded"])
      const call = events.find((e) => e._tag === "ToolCall")!
      expect(call).toMatchObject({ _tag: "ToolCall", name: "Bash", turnId: done.turnId })
      expect(call._tag === "ToolCall" && call.summary).toMatch(/^echo "marker:/)
      const result = events.find((e) => e._tag === "ToolResult")!
      expect(result).toMatchObject({ _tag: "ToolResult", isError: false, callId: call._tag === "ToolCall" ? call.callId : "" })
      expect(result._tag === "ToolResult" && result.output).toMatch(/^marker:x:/)
    }).pipe(Effect.provide(replay("bash-tool"))),
  )

  it.effect("steer lands in the running turn", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events } = yield* collect(session)
      const first = yield* session.turn("three sleeps").pipe(Effect.forkScoped)
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      const outcome = yield* session.steer("BANANA")
      const done = yield* Fiber.join(first)
      expect(outcome).toMatchObject({ _tag: "Landed", turnId: done.turnId })
      expect(events.find((e) => e._tag === "MessageLanded" && e.messageId === outcome.messageId)).toMatchObject({ turnId: done.turnId })
      expect(events.filter((e) => e._tag === "TurnEnded")).toHaveLength(1)
      expect(done.finalText.toLowerCase()).toContain("banana")
    }).pipe(Effect.provide(replay("steer"))),
  )

  it.effect("send while a turn runs queues a separate turn", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events } = yield* collect(session)
      const first = yield* session.send("one")
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      const second = yield* session.send("two")
      yield* session.end
      const turns = events.filter((e) => e._tag === "TurnStarted").map((e) => (e._tag === "TurnStarted" ? String(e.turnId) : ""))
      expect(turns).toEqual([first, second])
      expect(visible(events)).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "ToolCall", "ToolResult", "Text", "TurnEnded", "TurnStarted", "MessageLanded", "Text", "TurnEnded"])
    }).pipe(Effect.provide(replay("queue"))),
  )

  it.effect("interrupt ends the turn Interrupted; the session stays usable", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events } = yield* collect(session)
      const first = yield* session.turn("sleep").pipe(Effect.exit, Effect.forkScoped)
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      yield* session.interrupt
      expect(failureOf(yield* Fiber.join(first))?._tag).toBe("Interrupted")
      const again = yield* session.turn("ok")
      expect(again.finalText.toLowerCase()).toContain("ok")
      const ends = events.filter((e) => e._tag === "TurnEnded")
      expect(ends.map((e) => e._tag === "TurnEnded" && e.outcome._tag)).toEqual(["Interrupted", "Succeeded"])
    }).pipe(Effect.provide(replay("interrupt-then-turn"))),
  )

  it.effect("spend cap", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd, spendCapUsd: 0.0001 })
      const error = failureOf(yield* session.turn("hi").pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "SpendCapReached", capUsd: 0.0001, estimated: false })
      expect(error?._tag === "SpendCapReached" && error.spentUsd).toBeGreaterThan(0.0001)
    }).pipe(Effect.provide(replay("spend-cap"))),
  )

  it.effect("resume a recorded session", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd })
          yield* session.turn("remember walrus")
          yield* session.end
          return session.sessionId
        }),
      )
      const session = yield* agent.open({ cwd, resume: id })
      expect(session.sessionId).toBe(id)
      const { events } = yield* collect(session)
      const done = yield* session.turn("what word?")
      expect(done.finalText.toLowerCase()).toContain("walrus")
      expect(events[0]).toMatchObject({ _tag: "SessionStarted", sessionId: id, resumed: true })
    }).pipe(Effect.provide(replay("resume"))),
  )

  it.effect("resume of an unknown session fails the precheck without spawning", () =>
    Effect.gen(function* () {
      const id = SessionId.make("22222222-2222-4222-8222-222222222222")
      const error = failureOf(yield* (yield* Agent).open({ cwd, resume: id }).pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "SessionNotFound", sessionId: id })
    }).pipe(Effect.provide(replay("simple-turn"))),
  )

  it.effect("resume the CLI does not know fails open with SessionNotFound", () =>
    Effect.gen(function* () {
      const id = SessionId.make("33333333-3333-4333-8333-333333333333")
      const error = failureOf(yield* (yield* Agent).open({ cwd, resume: id }).pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "SessionNotFound", sessionId: id })
      expect(error?.message).toContain(`No conversation found with session ID: ${id}`)
    }).pipe(Effect.provide(replay("resume-missing", { knownSessions: "all" }))),
  )

  it.effect("process death ends the turn ProcessKilled and fails later calls", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events, fiber } = yield* collect(session)
      const error = failureOf(yield* session.turn("sleep").pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "ProcessKilled", signal: "SIGKILL", exitCode: null })
      expect(failureOf(yield* session.send("hello?").pipe(Effect.exit))?._tag).toBe("SessionClosed")
      expect(failureOf(yield* session.interrupt.pipe(Effect.exit))?._tag).toBe("SessionClosed")
      expect(failureOf(yield* Fiber.join(fiber).pipe(Effect.exit))?._tag).toBe("AgentError")
      expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", outcome: { _tag: "ProcessKilled" } })
      // A late subscriber sees the failure immediately.
      expect(failureOf(yield* Stream.runDrain(session.events).pipe(Effect.exit))?._tag).toBe("AgentError")
    }).pipe(Effect.provide(replay("process-killed"))),
  )

  it.effect("usage limit (CLI 2.1.301, no lifecycle frames)", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const { events } = yield* collect(session)
      const error = failureOf(yield* session.turn("hello").pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "UsageLimited", window: "five_hour", overageAvailable: null })
      expect(error?._tag === "UsageLimited" && DateTime.toEpochMillis(error.resetsAt!)).toBe(1792993200_000)
      expect(visible(events)).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "Text", "TurnEnded"])
      expect(events[0]).toMatchObject({ version: "2.1.301" })
    }).pipe(Effect.provide(replay("usage-limit"))),
  )

  it.effect("calls that diverge from the recording fail with AgentError", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      const error = failureOf(yield* session.interrupt.pipe(Effect.exit))
      expect(error).toMatchObject({ _tag: "AgentError", provider: "claude" })
      expect(error?.message).toContain("replay diverged")
    }).pipe(Effect.provide(replay("simple-turn"))),
  )

  it.effect("pid is none without a process", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd })
      expect(yield* session.pid).toEqual(Option.none())
    }).pipe(Effect.provide(replay("simple-turn"))),
  )

  it.effect("status: signed in, with plan windows", () =>
    Effect.gen(function* () {
      const status = yield* (yield* Agent).status()
      Schema.encodeUnknownSync(AccountStatus)(status)
      expect(status).toMatchObject({ provider: "claude", usable: true, reason: null, plan: "max" })
      expect(status.windows.map((w) => w.window)).toEqual(["five_hour", "weekly", "other"])
      expect(status.windows.map((w) => [w.label, Option.getOrNull(w.model)])).toEqual([
        ["five_hour", null],
        ["seven_day", null],
        ["model_scoped:Fable", "fable"],
      ])
      expect(status.windows.every((w) => w.resetsAt !== null)).toBe(true)
    }).pipe(Effect.provide(replay("status"))),
  )

  it.effect("status: signed out", () =>
    Effect.gen(function* () {
      expect(yield* (yield* Agent).status()).toMatchObject({ usable: false, reason: "unauthenticated", windows: [], plan: null })
    }).pipe(Effect.provide(replay("status-unauthenticated"))),
  )

  it.effect("status without a recorded answer fails with AgentError", () =>
    Effect.gen(function* () {
      expect(failureOf(yield* (yield* Agent).status().pipe(Effect.exit))).toMatchObject({ _tag: "AgentError", provider: "claude" })
    }).pipe(Effect.provide(replay("simple-turn"))),
  )

  const recordedHistory = (name: string) => {
    const line = ClaudeReplay.load(fixture(name)).find((l) => l.dir === "history" && l.history !== null)
    if (line?.dir !== "history") throw new Error(`no history in ${name}`)
    return { sessionId: SessionId.make(line.sessionId), cwd: line.cwd }
  }

  it.effect("history of a recorded session, across a compaction", () =>
    Effect.gen(function* () {
      const { sessionId, cwd } = recordedHistory("history")
      const events = yield* (yield* Agent).history(sessionId, { cwd })
      for (const event of events) Schema.encodeUnknownSync(AgentEvent)(event)
      expect(events.map((e) => e._tag)).toEqual([
        "TurnStarted", "UserMessage", "ToolCall", "ToolResult", "Text",
        "TurnStarted", "UserMessage", "Text",
        "Compacted",
        "TurnStarted", "UserMessage",
      ])
      const prompts = events.flatMap((e) => (e._tag === "UserMessage" ? [e.text] : []))
      expect(prompts).toEqual(["Use the Bash tool to run `echo history-marker`, then reply with just: done", "Reply with just: second", "/compact"])
      expect(events.find((e) => e._tag === "ToolCall")).toMatchObject({ name: "Bash", summary: "echo history-marker" })
      expect(events.find((e) => e._tag === "Compacted")).toMatchObject({ trigger: "manual" })
      // Every event belongs to the turn its prompt started.
      const first = events[0]!
      expect(events.slice(0, 5).every((e) => "turnId" in e && first._tag === "TurnStarted" && e.turnId === first.turnId)).toBe(true)
    }).pipe(Effect.provide(replay("history"))),
  )

  it.effect("history keeps a steer in its turn and ends an interrupted turn Interrupted", () =>
    Effect.gen(function* () {
      const { sessionId, cwd } = recordedHistory("history-steer-interrupt")
      const events = yield* (yield* Agent).history(sessionId, { cwd })
      const turns = events.flatMap((e) => (e._tag === "TurnStarted" ? [e.turnId] : []))
      expect(turns).toHaveLength(3)
      const messages = events.flatMap((e) => (e._tag === "UserMessage" ? [[e.turnId, e.text] as const] : []))
      expect(messages.map(([t]) => turns.indexOf(t!))).toEqual([0, 0, 1, 2])
      expect(messages[1]![1]).toContain("BANANA")
      expect(events.filter((e) => e._tag === "TurnEnded")).toMatchObject([{ turnId: turns[1], outcome: { _tag: "Interrupted" } }])
      // TurnIds are the MessageIds the live session sent (the recorded `out` uuids).
      const sent = ClaudeReplay.load(fixture("history-steer-interrupt")).flatMap((l) => (l.dir === "out" ? [l.frame.uuid] : []))
      expect(turns).toEqual([sent[0], sent[2], sent[3]])
    }).pipe(Effect.provide(replay("history-steer-interrupt"))),
  )

  it.effect("history of an unknown session fails SessionNotFound", () =>
    Effect.gen(function* () {
      const recorded = ClaudeReplay.load(fixture("history")).find((l) => l.dir === "history" && l.history === null)
      if (recorded?.dir !== "history") throw new Error("no missing-session line")
      for (const id of [recorded.sessionId, "44444444-4444-4444-8444-444444444444"]) {
        const error = failureOf(yield* (yield* Agent).history(SessionId.make(id), { cwd }).pipe(Effect.exit))
        expect(error).toMatchObject({ _tag: "SessionNotFound", sessionId: id })
      }
    }).pipe(Effect.provide(replay("history"))),
  )

  const watchdog = { idle: "20 seconds", toolIdle: "3 seconds" } as const

  it.effect("watchdog: a quiet tool call ends the turn Stalled after an interrupt; the session stays usable", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd, watchdog })
      const { events } = yield* collect(session)
      const first = yield* session.turn("sleep").pipe(Effect.exit, Effect.forkScoped)
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      yield* TestClock.adjust("2 seconds")
      expect(events.some((e) => e._tag === "TurnEnded")).toBe(false)
      yield* TestClock.adjust("2 seconds")
      const error = failureOf(yield* Fiber.join(first))
      expect(error).toMatchObject({ _tag: "Stalled", inTool: true })
      expect(error?._tag === "Stalled" && error.idleMs).toBeGreaterThanOrEqual(3000)
      expect(error?.message).toContain("interrupted")
      const again = yield* session.turn("ok")
      expect(again.finalText.toLowerCase()).toContain("ok")
      expect(events.flatMap((e) => (e._tag === "TurnEnded" ? [e.outcome._tag] : []))).toEqual(["Stalled", "Succeeded"])
    }).pipe(Effect.provide(replay("watchdog"))),
  )

  it.effect("watchdog: no stall while events keep coming within the limits", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd, watchdog: { idle: "1 minute" } })
      const { events } = yield* collect(session)
      const first = yield* session.turn("sleep").pipe(Effect.exit, Effect.forkScoped)
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      yield* TestClock.adjust("30 seconds")
      expect(events.some((e) => e._tag === "TurnEnded")).toBe(false)
      yield* session.interrupt
      expect(failureOf(yield* Fiber.join(first))?._tag).toBe("Interrupted")
    }).pipe(Effect.provide(replay("watchdog"))),
  )

  it.effect("watchdog: if the interrupt doesn't end the turn, the process is killed; the turn is still Stalled", () => {
    // The recording, cut right after the interrupt: the CLI never answers it.
    const lines = ClaudeReplay.load(fixture("watchdog"))
    const cut = lines.findIndex((l) => l.dir === "ctl" && l.call === "interrupt")
    const next = lines.slice(cut).find((l) => l.dir === "out")!
    const recording = [...lines.slice(0, cut + 1), next]
    return Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ cwd, watchdog })
      const { events, fiber } = yield* collect(session)
      const first = yield* session.turn("sleep").pipe(Effect.exit, Effect.forkScoped)
      yield* waitFor(events, (e) => e._tag === "ToolCall")
      yield* TestClock.adjust("4 seconds") // stalls at ~3s and interrupts
      yield* TestClock.adjust("3 seconds") // still inside the 5s grace
      expect(events.some((e) => e._tag === "TurnEnded")).toBe(false)
      yield* TestClock.adjust("3 seconds") // grace over: killed
      const error = failureOf(yield* Fiber.join(first))
      expect(error).toMatchObject({ _tag: "Stalled", inTool: true })
      expect(error?.message).toContain("killed")
      expect(events.at(-1)).toMatchObject({ _tag: "TurnEnded", outcome: { _tag: "Stalled" } })
      // As after any process death: later calls and the stream fail.
      expect(failureOf(yield* session.send("hello?").pipe(Effect.exit))?._tag).toBe("SessionClosed")
      expect(failureOf(yield* Fiber.join(fiber).pipe(Effect.exit))?._tag).toBe("AgentError")
    }).pipe(
      Effect.provide(ClaudeAgent.layer({ stallGrace: "5 seconds" }).pipe(Layer.provide(ClaudeReplay.layer(recording)))),
    )
  })
})
