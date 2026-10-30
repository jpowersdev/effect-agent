import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type AgentEvent, TurnId, Watchdog } from "../src/index.ts"

const turnId = TurnId.make("t1")
const started: AgentEvent = { _tag: "TurnStarted", turnId, raw: null }
const heartbeat: AgentEvent = { _tag: "Heartbeat", turnId, raw: null }
const call: AgentEvent = { _tag: "ToolCall", turnId, callId: "c1", name: "Bash", summary: "make test", input: {}, raw: null }
const result: AgentEvent = { _tag: "ToolResult", turnId, callId: "c1", isError: false, output: "", raw: null }
const ended: AgentEvent = {
  _tag: "TurnEnded",
  turnId,
  outcome: { _tag: "Succeeded", turnId, finalText: "" },
  usage: null,
  cost: null,
  raw: null,
}

const setup = (options: Watchdog.Options) =>
  Effect.gen(function* () {
    const dog = yield* Watchdog.make(options)
    const fired: Array<Watchdog.Expiry> = []
    yield* dog.expirations.pipe(
      Stream.runForEach((e) => Effect.sync(() => fired.push(e))),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { dog, fired }
  })

describe("Watchdog", () => {
  it.effect("doesn't fire while heartbeats keep arriving", () =>
    Effect.gen(function* () {
      const { dog, fired } = yield* setup({ idle: "10 seconds" })
      yield* dog.observe(started)
      for (let i = 0; i < 6; i++) {
        yield* TestClock.adjust("8 seconds")
        yield* dog.observe(heartbeat)
      }
      expect(fired).toEqual([])
    }),
  )

  it.effect("fires once when a running turn goes quiet", () =>
    Effect.gen(function* () {
      const { dog, fired } = yield* setup({ idle: "10 seconds" })
      yield* dog.observe(started)
      yield* TestClock.adjust("11 seconds")
      yield* TestClock.adjust("30 seconds")
      expect(fired).toHaveLength(1)
      expect(fired[0]).toMatchObject({ turnId, inTool: false })
      expect(fired[0]!.idleMs).toBeGreaterThanOrEqual(10_000)
    }),
  )

  it.effect("uses toolIdle while a tool call is open, and idle again after its result", () =>
    Effect.gen(function* () {
      const { dog, fired } = yield* setup({ idle: "10 seconds", toolIdle: "1 minute" })
      yield* dog.observe(started)
      yield* dog.observe(call)
      yield* TestClock.adjust("50 seconds")
      expect(fired).toEqual([])
      yield* dog.observe(result)
      yield* TestClock.adjust("11 seconds")
      expect(fired).toMatchObject([{ inTool: false }])
    }),
  )

  it.effect("ignores idle time between turns", () =>
    Effect.gen(function* () {
      const { dog, fired } = yield* setup({ idle: "10 seconds" })
      yield* dog.observe(started)
      yield* dog.observe(ended)
      yield* TestClock.adjust("5 minutes")
      expect(fired).toEqual([])
      yield* dog.observe(started)
      yield* TestClock.adjust("11 seconds")
      expect(fired).toHaveLength(1)
    }),
  )

  it.effect("stops with its scope", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.scoped(setup({ idle: "1 second" })).pipe(Effect.forkChild)
      yield* Fiber.join(fiber)
      yield* TestClock.adjust("1 minute")
    }),
  )
})

describe("Watchdog.supervise", () => {
  const supervised = (turnEnds: boolean) =>
    Effect.gen(function* () {
      const dog = yield* Watchdog.make({ idle: "10 seconds" })
      const log: Array<string> = []
      const ended = yield* Deferred.make<void>()
      yield* Watchdog.supervise(dog, {
        grace: "5 seconds",
        stall: (expiry) => Effect.sync(() => (log.push(`stall ${expiry.turnId}`), true)),
        // A wedged process: the interrupt never returns.
        interrupt: () => Effect.sync(() => log.push("interrupt")).pipe(Effect.andThen(Effect.never)),
        turnEnded: () => Deferred.await(ended),
        kill: Effect.sync(() => log.push("kill")),
      })
      yield* Effect.yieldNow
      yield* dog.observe(started)
      yield* TestClock.adjust("11 seconds")
      if (turnEnds) yield* Deferred.succeed(ended, undefined)
      yield* TestClock.adjust("6 seconds")
      return log
    }).pipe(Effect.scoped)

  it.effect("a hung interrupt doesn't hold up the kill after the grace period", () =>
    Effect.gen(function* () {
      expect(yield* supervised(false)).toEqual(["stall t1", "interrupt", "kill"])
    }),
  )

  it.effect("no kill when the turn ends within the grace period", () =>
    Effect.gen(function* () {
      expect(yield* supervised(true)).toEqual(["stall t1", "interrupt"])
    }),
  )
})
