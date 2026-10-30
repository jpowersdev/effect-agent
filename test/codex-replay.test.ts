/**
 * The real `CodexAgent` layer over recorded app-server sessions
 * (test/fixtures/codex/*.jsonl, recorded by `node scripts/live-codex.ts --record`;
 * usage-limit and process-killed are built by scripts/make-codex-fixtures.ts).
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { AccountStatus, Agent, AgentEvent, type AgentSession, type RunOptions, SessionId } from "../src/index.ts"
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

  it.live("session pid is none under replay", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(base)
      expect(yield* session.pid).toEqual(Option.none())
    }).pipe(Effect.provide(agent("simple"))),
  )

  it.live("hooks are refused before anything starts", () =>
    Effect.gen(function* () {
      const error = yield* (yield* Agent).open({ ...base, hooks: { beforeTool: () => Effect.succeedNone } }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/hooks.*config-only/) })
    }).pipe(Effect.provide(agent("simple"))),
  )

  it.live("status: signed in, with limit windows and plan", () =>
    Effect.gen(function* () {
      const status = yield* (yield* Agent).status()
      Schema.encodeUnknownSync(AccountStatus)(status)
      expect(status).toMatchObject({ provider: "codex", usable: true, reason: null, plan: "pro" })
      expect(status.windows).toEqual([
        { window: "weekly", label: "primary", usedPercent: 20, resetsAt: DateTime.makeUnsafe(1793803680_000), model: Option.none() },
      ])
    }).pipe(Effect.provide(agent("status"))),
  )

  it.live("status: not signed in", () =>
    Effect.gen(function* () {
      const status = yield* (yield* Agent).status()
      expect(status).toMatchObject({ usable: false, reason: "unauthenticated", windows: [], plan: null })
    }).pipe(Effect.provide(agent("status-signed-out"))),
  )

  it.live("history of a stored thread", () =>
    Effect.gen(function* () {
      const id = SessionId.make("01a1896b-e054-7371-b868-b778fad6ea05")
      const events = yield* (yield* Agent).history(id, { cwd: base.cwd })
      for (const e of events) Schema.encodeUnknownSync(AgentEvent)(e)
      expect(events.map((e) => e._tag)).toEqual([
        "TurnStarted", "UserMessage", "Text", "ToolCall", "ToolResult", "Text", "TurnEnded",
        "TurnStarted", "UserMessage", "Text", "TurnEnded",
      ])
      const user = events.filter(is("UserMessage"))
      expect(user[0]!.text).toMatch(/echo history-probe/)
      expect(user[0]!.messageId).toMatch(/^ea-/)
      expect(events.find(is("ToolCall"))).toMatchObject({ name: "shell", summary: "echo history-probe" })
      expect(events.find(is("ToolResult"))).toMatchObject({ isError: false, output: expect.stringContaining("history-probe") })
      const ends = events.filter(is("TurnEnded"))
      expect(ends.map((e) => [e.outcome._tag, e.usage, e.cost])).toEqual([
        ["Succeeded", null, null],
        ["Succeeded", null, null],
      ])
      expect(ends[1]!.outcome).toMatchObject({ finalText: expect.stringMatching(/pong/i) })
      // every event belongs to its turn
      const starts = events.filter(is("TurnStarted"))
      expect(ends.map((e) => e.turnId)).toEqual(starts.map((e) => e.turnId))
    }).pipe(Effect.provide(agent("history"))),
  )

  it.live("history of an unknown thread fails with SessionNotFound", () =>
    Effect.gen(function* () {
      const id = SessionId.make("019a0000-0000-7000-8000-000000000000")
      const error = yield* (yield* Agent).history(id, { cwd: base.cwd }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "SessionNotFound", sessionId: id, message: expect.stringMatching(/thread not loaded/) })
    }).pipe(Effect.provide(agent("history-missing"))),
  )

  it.live("watchdog: a silent tool call ends the turn Stalled, and the session keeps working", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ ...base, watchdog: { idle: "30 seconds", toolIdle: "200 millis" } })
      const { events } = yield* collect(session)
      const failure = yield* session.turn("Run the shell command `sleep 30 && echo done` and then reply ok.").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "Stalled", inTool: true })
      if (failure._tag !== "Stalled") return
      expect(failure.idleMs).toBeGreaterThanOrEqual(200)
      expect(events.find(is("TurnEnded"))?.outcome).toBe(failure)
      const next = yield* session.turn("Reply with the word pong.")
      expect(next.finalText).toMatch(/pong/i)
      expect(events.filter(is("TurnEnded")).map((e) => e.outcome._tag)).toEqual(["Stalled", "Succeeded"])
    }).pipe(Effect.provide(agent("stall"))),
  )

  it.live("watchdog: a turn that doesn't end after the interrupt kills app-server, still Stalled", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open({ ...base, watchdog: { idle: "30 seconds", toolIdle: "200 millis" } })
      const { events, fiber } = yield* collect(session)
      const failure = yield* session.turn("Run the shell command `sleep 30 && echo done` and then reply ok.").pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "Stalled", inTool: true })
      expect(events.filter(is("TurnEnded")).map((e) => e.outcome)).toEqual([failure])
      // like a process death afterwards
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(yield* session.send("again").pipe(Effect.flip)).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/gone/) })
      expect(yield* session.interrupt.pipe(Effect.flip)).toMatchObject({ _tag: "AgentError" })
    }).pipe(Effect.provide(agent("stall-killed", { stallGrace: "100 millis" }))),
  )

  it.live("no watchdog without the option", () =>
    Effect.gen(function* () {
      // the stall recording, replayed without a watchdog, just waits for an interrupt
      const session = yield* (yield* Agent).open(base)
      const { events } = yield* collect(session)
      yield* session.send("Run the shell command `sleep 30 && echo done` and then reply ok.")
      yield* waitFor(events, is("ToolCall"))
      yield* Effect.sleep(Duration.millis(300))
      expect(events.some(is("TurnEnded"))).toBe(false)
      yield* session.interrupt
      expect(events.find(is("TurnEnded"))?.outcome._tag).toBe("Interrupted")
    }).pipe(Effect.provide(agent("stall"))),
  )
})
