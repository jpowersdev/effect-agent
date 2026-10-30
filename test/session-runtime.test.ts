/**
 * The provider-neutral session runtime: event fan-out and turn tracking.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EventHub from "../src/internal/eventHub.ts"
import * as Recorder from "../src/internal/recorder.ts"
import * as TurnTracker from "../src/internal/turnTracker.ts"
import { type AgentEvent, AgentError, MessageId, SessionId, TurnId } from "../src/index.ts"

const turnId = TurnId.make("t-1")
const sessionStarted: AgentEvent = {
  _tag: "SessionStarted",
  sessionId: SessionId.make("s"),
  provider: "test",
  version: null,
  model: null,
  resumed: false,
  raw: null,
}
const started: AgentEvent = { _tag: "TurnStarted", turnId, raw: null }
const landed = (id: string): AgentEvent => ({ _tag: "MessageLanded", messageId: MessageId.make(id), turnId, raw: null })
const ended: AgentEvent = {
  _tag: "TurnEnded",
  turnId,
  outcome: { _tag: "Succeeded", turnId, finalText: "ok" },
  usage: null,
  cost: null,
  raw: null,
}

describe("EventHub", () => {
  it.effect("every subscription starts with SessionStarted, then sees what follows, then the end", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub.make
      yield* hub.publish(sessionStarted)
      yield* hub.publish(started)
      // Subscribed after both: gets SessionStarted, not the TurnStarted it missed.
      const events = yield* hub.subscribe
      const fiber = yield* events.pipe(Stream.runCollect, Effect.forkScoped)
      yield* hub.publish(ended)
      yield* hub.end(null)
      expect((yield* Fiber.join(fiber)).map((e) => e._tag)).toEqual(["SessionStarted", "TurnEnded"])
    }).pipe(Effect.scoped),
  )

  it.effect("a subscription after a failed end gets only the failure", () =>
    Effect.gen(function* () {
      const hub = yield* EventHub.make
      yield* hub.publish(sessionStarted)
      const error = new AgentError({ message: "died", provider: "test" })
      yield* hub.end(error)
      yield* hub.end(null)
      const exit = yield* hub.subscribe.pipe(Effect.flatMap(Stream.runCollect), Effect.exit)
      expect(exit).toEqual(Exit.fail(error))
    }).pipe(Effect.scoped),
  )
})

describe("TurnTracker", () => {
  it.effect("a sent message lands in a turn, which then ends", () =>
    Effect.gen(function* () {
      const turns = TurnTracker.make({ provider: "test" })
      turns.expect("m-1")
      expect(turns.busy()).toBe(true)
      expect(turns.oldestUnlanded()).toBe("m-1")
      const landing = yield* turns.landing("m-1").pipe(Effect.forkChild)
      turns.observe(started)
      turns.observe(landed("m-1"))
      expect(yield* Fiber.join(landing)).toBe(turnId)
      const outcome = yield* turns.outcome(turnId).pipe(Effect.forkChild)
      turns.observe(ended)
      expect(yield* Fiber.join(outcome)).toMatchObject({ _tag: "Succeeded", finalText: "ok" })
      // Asked again later: answered from memory.
      expect(yield* turns.outcome(turnId)).toMatchObject({ _tag: "Succeeded" })
      expect(yield* turns.landing("m-1")).toBe(turnId)
      expect(turns.busy()).toBe(false)
    }),
  )

  it.effect("dropped, unknown and never-landed messages fail", () =>
    Effect.gen(function* () {
      const turns = TurnTracker.make({ provider: "test", owner: "host" })
      turns.expect("m-1")
      turns.observe({ _tag: "MessageDropped", messageId: MessageId.make("m-1"), reason: "cancelled", raw: null })
      expect((yield* Effect.flip(turns.landing("m-1"))).message).toMatch(/cancelled before it reached a turn/)
      expect((yield* Effect.flip(turns.landing("nope"))).message).toMatch(/not sent through this host/)
      turns.expect("m-2")
      const waiting = yield* turns.landing("m-2").pipe(Effect.flip, Effect.forkChild)
      const turnWaiting = yield* turns.outcome(TurnId.make("t-9")).pipe(Effect.flip, Effect.forkChild)
      turns.end(null)
      expect((yield* Fiber.join(waiting)).message).toMatch(/ended before message m-2/)
      expect((yield* Fiber.join(turnWaiting)).message).toMatch(/ended before turn t-9/)
    }),
  )

  it.effect("remembers at most `limit` settled turns; asking about a forgotten one fails at once", () =>
    Effect.gen(function* () {
      const turns = TurnTracker.make({ provider: "test", limit: 2 })
      for (const id of ["a", "b", "c"]) {
        turns.observe({ _tag: "MessageLanded", messageId: MessageId.make(`m-${id}`), turnId: TurnId.make(id), raw: null })
        turns.observe({ ...ended, turnId: TurnId.make(id) })
      }
      expect((yield* turns.outcome("c"))._tag).toBe("Succeeded")
      expect(yield* turns.landing("m-b")).toBe("b")
      // Still running, so waiting would be forever: it fails instead.
      expect((yield* Effect.flip(turns.outcome("a"))).message).toMatch(/turn a was settled too long ago/)
      expect((yield* Effect.flip(turns.landing("m-a"))).message).toMatch(/message m-a was settled too long ago/)
    }),
  )
})

describe("Recorder", () => {
  it.live("writes lines in order, truncating first, and flushes when its scope closes", () =>
    Effect.gen(function* () {
      const path = join(mkdtempSync(join(tmpdir(), "ea-rec-")), "nested", "rec.jsonl")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recorder = yield* Recorder.make(path, { truncate: true })
          for (let i = 0; i < 100; i++) recorder.record({ i })
          yield* recorder.flush
          recorder.record({ i: 100 })
        }),
      )
      const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).i)
      expect(lines).toEqual(Array.from({ length: 101 }, (_, i) => i))
      // Truncated by the next recorder; appended to without `truncate`.
      writeFileSync(path, '{"i":-1}\n')
      yield* Effect.scoped(Effect.map(Recorder.make(path, { truncate: false }), (r) => r.record({ i: 0 })))
      expect(readFileSync(path, "utf8")).toBe('{"i":-1}\n{"i":0}\n')
    }),
  )
})
