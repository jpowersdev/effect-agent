/**
 * The real `CodexAgent` layer over recorded app-server sessions
 * (test/fixtures/codex/*.jsonl, recorded by `node scripts/live-codex.ts --record`;
 * usage-limit and process-killed are built by scripts/make-codex-fixtures.ts).
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { Agent, type AgentEvent, type AgentSession, type RunOptions, SessionId } from "../src/index.ts"
import { CodexAgent, CodexReplay } from "../src/codex/index.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex/${name}.jsonl`, import.meta.url), "utf8")
const agent = (name: string, options: CodexAgent.CodexAgentOptions = {}) =>
  CodexAgent.layer(options).pipe(Layer.provide(CodexReplay.layer(fixture(name))))

const base: RunOptions = { cwd: "/tmp/effect-agent-live/codex/work", effort: "low" }

const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const ready = yield* Deferred.make<void>()
    const fiber = yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e)).pipe(Effect.andThen(Deferred.succeed(ready, undefined)))),
      Effect.forkScoped,
    )
    yield* Deferred.await(ready)
    return { events, fiber }
  })

const is =
  <T extends AgentEvent["_tag"]>(tag: T) =>
  (e: AgentEvent): e is Extract<AgentEvent, { _tag: T }> =>
    e._tag === tag

const waitFor = <A extends AgentEvent>(events: Array<AgentEvent>, pred: (e: AgentEvent) => e is A) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const hit = events.find(pred)
      if (hit) return hit
      yield* Effect.sleep(Duration.millis(10))
    }
    return yield* Effect.die(new Error("timed out waiting for event"))
  })

describe("CodexAgent over replays", () => {
  it.live("simple turn", () =>
    Effect.gen(function* () {
      const a = yield* Agent
      const caps = yield* a.capabilities
      expect(caps).toMatchObject({ provider: "codex", version: "0.162.1", steer: true, queue: true, resume: true, cost: "none", spendCap: "none", resetTimes: true, hooks: false, reattach: false, disable: { askUser: true, subagents: false, tools: "some" } })
      const session = yield* a.open(base)
      expect(Option.getOrNull(session.location)).toMatch(/sessions\/.*rollout-.*\.jsonl$/)
      const { events, fiber } = yield* collect(session)
      const result = yield* session.turn("Reply with the word pong.")
      expect(result.finalText).toMatch(/pong/i)
      yield* session.end
      yield* Fiber.join(fiber) // the stream completes on end

      const tags = events.map((e) => e._tag).filter((t) => t !== "Other" && t !== "Heartbeat" && t !== "LimitsUpdated")
      expect(tags).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "Text", "TurnEnded"])
      expect(events[0]).toMatchObject({ _tag: "SessionStarted", sessionId: session.sessionId, version: "0.162.1", resumed: false })
      const landed = events.find(is("MessageLanded"))!
      const ended = events.find(is("TurnEnded"))!
      expect(landed.turnId).toBe(result.turnId)
      expect(ended).toMatchObject({ turnId: result.turnId, cost: null, outcome: { _tag: "Succeeded" } })
      expect(ended.usage!.inputTokens).toBeGreaterThan(0)
      expect(events.some(is("LimitsUpdated"))).toBe(true)
      // every event keeps its frame
      expect(events.every((e) => e.raw !== undefined)).toBe(true)
      expect(yield* session.send("again").pipe(Effect.flip)).toMatchObject({ _tag: "AgentError" })
    }).pipe(Effect.provide(agent("simple"))),
  )

  it.live("command execution", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      yield* session.turn("Run the shell command `echo hello-from-codex` and then reply with the word done.")
      const call = events.find(is("ToolCall"))!
      const result = events.find(is("ToolResult"))!
      expect(call).toMatchObject({ name: "shell", summary: "echo hello-from-codex" })
      expect(result).toMatchObject({ callId: call.callId, isError: false })
      expect(result.output).toContain("hello-from-codex")
    }).pipe(Effect.provide(agent("command"))),
  )

  it.live("steer that lands in the running turn", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      yield* session.send("Run two commands ...")
      const started = yield* waitFor(events, is("TurnStarted"))
      yield* waitFor(events, is("ToolCall"))
      const outcome = yield* session.steer("Steering note: end your final reply with the word STEERED.")
      expect(outcome).toMatchObject({ _tag: "Landed", turnId: started.turnId })
      const ended = yield* waitFor(events, is("TurnEnded"))
      expect(ended.turnId).toBe(started.turnId)
      expect(ended.outcome).toMatchObject({ _tag: "Succeeded", finalText: expect.stringMatching(/STEERED/) })
      const landed = events.filter(is("MessageLanded"))
      expect(landed.map((e) => e.turnId)).toEqual([started.turnId, started.turnId])
      expect(landed[1]!.messageId).toBe(outcome.messageId)
    }).pipe(Effect.provide(agent("steer-landed"))),
  )

  it.live("steer racing the end of the turn starts a new one", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      yield* session.send("Reply with the word pong.")
      const first = yield* waitFor(events, is("TurnStarted"))
      yield* waitFor(events, is("Text"))
      const outcome = yield* session.steer("Reply with the word again.")
      expect(outcome._tag).toBe("StartedNewTurn")
      expect(outcome.turnId).not.toBe(first.turnId)
      yield* session.end
      const ends = events.filter(is("TurnEnded"))
      expect(ends.map((e) => [e.turnId, e.outcome._tag])).toEqual([
        [first.turnId, "Succeeded"],
        [outcome.turnId, "Succeeded"],
      ])
      const landed = events.filter(is("MessageLanded"))
      expect(landed[1]).toMatchObject({ messageId: outcome.messageId, turnId: outcome.turnId })
    }).pipe(Effect.provide(agent("steer-stale"))),
  )

  it.live("interrupt kills the command, then the session keeps working", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      yield* session.send("Run the shell command `sleep 120 && echo effect-agent-late` and then reply ok.")
      yield* waitFor(events, is("ToolCall"))
      yield* session.interrupt
      const ended = events.find(is("TurnEnded"))!
      expect(ended.outcome._tag).toBe("Interrupted")
      const next = yield* session.turn("Reply with the word pong.")
      expect(next.finalText).toMatch(/pong/i)
      // the interrupted command's result arrives (failed) after we terminated it
      expect(events.find(is("ToolResult"))).toMatchObject({ isError: true })
    }).pipe(Effect.provide(agent("interrupt"))),
  )

  it.live("send queues behind the running turn", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      const first = yield* session.send("first")
      const second = yield* session.turn("second")
      expect(second.finalText).toMatch(/second/i)
      const ends = events.filter(is("TurnEnded"))
      expect(ends).toHaveLength(2)
      expect(ends[1]!.turnId).toBe(second.turnId)
      const landed = events.filter(is("MessageLanded"))
      expect(landed.map((e) => e.messageId)[0]).toBe(first)
      expect(landed[1]!.turnId).toBe(second.turnId)
    }).pipe(Effect.provide(agent("queue"))),
  )

  it.live("resuming an unknown session fails with SessionNotFound", () =>
    Effect.gen(function* () {
      const error = yield* (yield* Agent).open({ ...base, resume: SessionId.make("019a0000-0000-7000-8000-000000000000") }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SessionNotFound", sessionId: "019a0000-0000-7000-8000-000000000000" })
    }).pipe(Effect.provide(agent("resume-missing"))),
  )

  it.live("estimated spend cap interrupts the turn", () =>
    Effect.gen(function* () {
      const a = yield* Agent
      expect(yield* a.capabilities).toMatchObject({ cost: "estimated", spendCap: "estimated" })
      const session = yield* a.open({ ...base, spendCapUsd: 0.01 })
      const { events } = yield* collect(session)
      const failure = yield* session.turn("Run two sleeps ...").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SpendCapReached", estimated: true, capUsd: 0.01 })
      const ended = events.find(is("TurnEnded"))!
      expect(ended.cost).toMatchObject({ source: "estimated" })
      expect(ended.cost!.usd).toBeGreaterThanOrEqual(0.01)
      expect(ended.outcome).toBe(failure)
      // over the cap: no more turns
      expect(yield* session.turn("again").pipe(Effect.flip)).toMatchObject({ _tag: "SpendCapReached" })
    }).pipe(Effect.provide(agent("spend-cap", { pricing: { "*": { input: 1000, output: 1000 } } }))),
  )

  it.live("spend cap without a price for the model refuses to open", () =>
    Effect.gen(function* () {
      const error = yield* (yield* Agent).open({ ...base, spendCapUsd: 1 }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/no price/) })
    }).pipe(Effect.provide(agent("simple", { pricing: { "other-model": { input: 1, output: 1 } } }))),
  )

  it.live("usage limit reads the reset time from account/rateLimits/read", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const failure = yield* session.turn("Reply with the word pong.").pipe(Effect.flip)
      expect(failure._tag).toBe("UsageLimited")
      if (failure._tag !== "UsageLimited") return
      expect(failure.window).toBe("weekly")
      expect(DateTime.toEpochMillis(failure.resetsAt!)).toBe(1793803680_000)
      expect(failure.overageAvailable).toBe(false)
      expect(failure.message).toMatch(/usage limit/)
    }).pipe(Effect.provide(agent("usage-limit"))),
  )

  it.live("app-server dying ends the turn with ProcessKilled", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      const { events, fiber } = yield* collect(session)
      const failure = yield* session.turn("Run the shell command ...").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "ProcessKilled", signal: "SIGKILL", exitCode: null })
      expect(events.find(is("TurnEnded"))?.outcome).toBe(failure)
      const streamExit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(streamExit)).toBe(true)
      expect(yield* session.send("again").pipe(Effect.flip)).toMatchObject({ _tag: "AgentError" })
      expect(yield* session.interrupt.pipe(Effect.flip)).toMatchObject({ _tag: "AgentError" })
    }).pipe(Effect.provide(agent("process-killed"))),
  )
})
