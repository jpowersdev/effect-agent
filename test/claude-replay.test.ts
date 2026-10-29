/**
 * The real `ClaudeAgent` layer over recorded frame streams (test/fixtures/claude,
 * recorded by `node scripts/live-claude.ts --fixtures`), with no process.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { join } from "node:path"
import { ClaudeAgent, ClaudeReplay } from "../src/claude/index.ts"
import { Agent, type AgentEvent, type AgentSession, SessionId } from "../src/index.ts"

const fixture = (name: string) => join(import.meta.dirname, "fixtures", "claude", `${name}.jsonl`)
const replay = (name: string, options?: ClaudeReplay.ReplayOptions) =>
  ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile(fixture(name), options)))

const cwd = "/tmp/effect-agent-replay"

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
      expect(failureOf(yield* session.send("hello?").pipe(Effect.exit))?._tag).toBe("AgentError")
      expect(failureOf(yield* session.interrupt.pipe(Effect.exit))?._tag).toBe("AgentError")
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
})
