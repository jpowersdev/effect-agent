/**
 * The host's persisted event log and the client's automatic reconnection,
 * with real host processes over recorded sessions (as in host.test.ts).
 * Connections are dropped while the host lives with its internal test
 * triggers: SIGUSR2 (drop every connection now) and `testDropBeforeReply`
 * (drop them right after the host has acted on a call, before it replies).
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Schedule, Stream } from "effect"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentError, type AgentEvent, ConnectionLost, MessageId, SessionId, SessionNotFound, TurnId } from "../src/index.ts"
import { AgentHosts, HostSpec, DetachedAgent, type SeqEvent } from "../src/host/index.ts"
import * as Host from "../src/host/Host.ts"
import { host } from "./support/hostCommand.ts"

const root = mkdtempSync(join(tmpdir(), "ea-hostd-"))
const dir = join(root, "hosts")
mkdirSync(dir, { mode: 0o700 })
const started = new Set<number>()

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  // Never leave a host behind, whatever a test did.
  for (const sub of readdirSync(root)) for (const m of DetachedAgent.listHosts(join(root, sub))) started.add(m.pid)
  for (const pid of started) if (isAlive(pid)) process.kill(pid, "SIGKILL")
  rmSync(root, { recursive: true, force: true })
})

const fixture = (provider: string, name: string) => join(import.meta.dirname, "fixtures", provider, `${name}.jsonl`)

const providers = [
  { name: "claude", cwd: "/tmp/effect-agent-replay", simple: "simple-turn", interrupt: "interrupt-then-turn", killed: "process-killed" },
  { name: "codex", cwd: "/tmp/effect-agent-live/codex/work", simple: "simple", interrupt: "interrupt", killed: "process-killed" },
] as const

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const waitUntil = (cond: () => boolean, what: string, timeout = Duration.seconds(10)) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(timeout)
    while (Date.now() < deadline) {
      if (cond()) return
      yield* Effect.sleep(Duration.millis(20))
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

/** Run a stream in the background, collecting into an array. */
const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const items: Array<A> = []
    const fiber = yield* stream.pipe(
      Stream.runForEach((a) => Effect.sync(() => items.push(a))),
      Effect.exit,
      Effect.forkScoped,
    )
    return { items, fiber }
  })

const seqs = (entries: ReadonlyArray<SeqEvent>) => entries.map((e) => e.seq)
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const tags = (events: ReadonlyArray<AgentEvent>) => events.map((e) => e._tag)

const fileLines = (d: string, sessionId: string) =>
  readFileSync(HostSpec.eventsPath(d, sessionId), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { seq?: number; ended?: unknown })

/** The events file's seqs, line by line. */
const fileSeqs = (d: string, sessionId: string) => fileLines(d, sessionId).flatMap((l) => (l.seq !== undefined ? [l.seq] : []))

/** The file's ending line (`{ ended }`), if it has one; it must be the last line. */
const fileEnding = (d: string, sessionId: string) => {
  const all = fileLines(d, sessionId)
  const endings = all.filter((l) => "ended" in l)
  expect(endings.length <= 1 && (endings.length === 0 || all.at(-1) === endings[0])).toBe(true)
  return endings[0]
}

const hostLog = (d: string, sessionId: string) => {
  try {
    return readFileSync(HostSpec.logPath(d, sessionId), "utf8")
  } catch {
    return ""
  }
}
const drops = (d: string, sessionId: string) => hostLog(d, sessionId).split("\n").filter((l) => l.includes("dropping")).length

/** Plant an events file last written an hour ago. */
const plantExpired = (d: string, sessionId: string) => {
  const path = HostSpec.eventsPath(d, sessionId)
  writeFileSync(path, "", { mode: 0o600 })
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(path, old, old)
  return path
}

const timeout = 30_000

for (const p of providers) {
  const layer = (name: string, options: Partial<DetachedAgent.DetachedAgentOptions> = {}) =>
    DetachedAgent.layer({ host, provider: p.name, replay: fixture(p.name, name), dir, ...options }).pipe(Layer.provide(NodeServices.layer))

  const toolCallTurn = (events: ReadonlyArray<AgentEvent>) => {
    const call = events.find((e) => e._tag === "ToolCall")
    return call?._tag === "ToolCall" ? (call.turnId as TurnId) : undefined
  }

  describe(`host events file: ${p.name}`, () => {
    it.live(
      "a catch-up older than the cache reads the file, then the cache and live events, with no gap or duplicate",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          // Subscribed before `send`, so no event after it can be missed.
          const live = yield* collect(yield* session.subscribe)
          const messageId = yield* session.send("sleep for a long time")
          yield* waitUntil(() => toolCallTurn(live.items) !== undefined, "the tool call")
          const firstTurn = toolCallTurn(live.items)!

          const info = yield* session.info
          expect(info.lastSeq).toBeGreaterThan(2) // more than the cache holds
          expect(info.oldestSeq).toBe(0)

          // Mid-turn: from the file (0..), the cache (last two) and on into live events.
          const all = yield* collect(session.subscribeFrom(0))
          const fromOne = yield* collect(session.subscribeFrom(1))
          yield* waitUntil(() => all.items.length > info.lastSeq, "the catch-up")

          yield* session.interrupt
          // Turns whose events have left the cache still answer from the outcome maps.
          expect(failureOf(yield* session.awaitTurn(firstTurn).pipe(Effect.exit))).toMatchObject({ _tag: "Interrupted" })
          expect(failureOf(yield* session.awaitMessage(messageId).pipe(Effect.exit))).toMatchObject({ _tag: "Interrupted" })
          const next = yield* session.turn("Reply with just the word: pong")
          yield* session.end

          yield* Fiber.join(all.fiber)
          yield* Fiber.join(fromOne.fiber)
          const last = all.items.at(-1)!.seq
          expect(seqs(all.items)).toEqual(range(0, last))
          expect(seqs(fromOne.items)).toEqual(range(1, last))
          expect(all.items.filter((e) => e.event._tag === "TurnEnded")).toHaveLength(2)
          expect(all.items.some((e) => e.event._tag === "TurnEnded" && e.event.turnId === next.turnId)).toBe(true)
          expect(fileSeqs(dir, session.sessionId)).toEqual(range(0, last))
        }).pipe(Effect.scoped, Effect.provide(layer(p.interrupt, { maxEvents: 2 }))),
      timeout,
    )

    it.live(
      "AgentHosts.events follows a live host, and reads an ended session's log from its file",
      () =>
        Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const { sessionId, hostPid, live, followed } = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* hosts.open({ cwd: p.cwd })
              started.add(session.hostPid)
              const followed = yield* collect(hosts.events(session.sessionId))
              yield* session.turn("Reply with just the word: pong")
              const last = yield* session.lastSeq
              const live = yield* session.subscribeFrom(0).pipe(Stream.take(last + 1), Stream.runCollect)
              yield* session.end
              const exit = yield* Fiber.join(followed.fiber)
              expect(Exit.isSuccess(exit)).toBe(true)
              return { sessionId: session.sessionId, hostPid: session.hostPid, live, followed: followed.items }
            }),
          )
          // The session logs a little more after `end`; `live` stopped at the turn.
          expect(followed.slice(0, live.length)).toEqual(live)
          expect(seqs(followed)).toEqual(range(0, followed.length - 1))

          yield* waitUntil(() => !isAlive(hostPid), "the host to exit")
          expect(existsSync(HostSpec.manifestPath(dir, sessionId))).toBe(false)
          expect(existsSync(HostSpec.socketPath(dir, sessionId))).toBe(false)
          expect(existsSync(HostSpec.eventsPath(dir, sessionId))).toBe(true)

          const ended = yield* hosts.events(sessionId).pipe(Stream.runCollect)
          expect(ended).toEqual(followed)
          // It ended cleanly, and the file says so: reading it completes, as the live stream did.
          expect(fileEnding(dir, sessionId)).toEqual({ ended: null })
          const tail = yield* hosts.events(sessionId, 3).pipe(Stream.runCollect)
          expect(seqs(tail)).toEqual(range(3, followed.length - 1))
          expect(yield* hosts.events(sessionId, 10_000).pipe(Stream.runCollect)).toEqual([])

          const unknown = SessionId.make("00000000-0000-4000-8000-00000000abcd")
          expect(failureOf(yield* hosts.events(unknown).pipe(Stream.runCollect, Effect.exit))).toBeInstanceOf(SessionNotFound)
          // `attach` still needs a live host.
          expect(failureOf(yield* hosts.attach(sessionId).pipe(Effect.scoped, Effect.exit))).toBeInstanceOf(SessionNotFound)
        }).pipe(Effect.provide(layer(p.simple))),
      timeout,
    )

    it.live(
      "a session that ended with an error: AgentHosts.events on the ended host fails with that error, as the live stream did",
      () =>
        Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const { sessionId, hostPid, liveError } = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* hosts.open({ cwd: p.cwd })
              started.add(session.hostPid)
              const live = yield* collect(session.subscribeFrom(0))
              const turn = failureOf(yield* session.turn("sleep").pipe(Effect.exit))
              expect(turn?._tag).toBe("ProcessKilled")
              const liveError = failureOf(yield* Fiber.join(live.fiber))
              expect(liveError).toBeInstanceOf(AgentError)
              return { sessionId: session.sessionId, hostPid: session.hostPid, liveError: liveError as AgentError }
            }),
          )
          yield* waitUntil(() => !isAlive(hostPid), "the host to exit")
          expect(fileEnding(dir, sessionId)).toMatchObject({ ended: { _tag: "AgentError", message: liveError.message } })
          const exit = yield* hosts.events(sessionId).pipe(Stream.runCollect, Effect.exit)
          const error = failureOf(exit)
          expect(error).toBeInstanceOf(AgentError)
          expect(error).toMatchObject({ message: liveError.message, provider: liveError.provider })
        }).pipe(Effect.provide(layer(p.killed, { onScopeClose: "detach" }))),
      timeout,
    )

    it.live(
      "a host SIGKILLed mid-session leaves no ending: AgentHosts.events reads the file to its end and completes",
      () =>
        Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const session = yield* hosts.open({ cwd: p.cwd })
          started.add(session.hostPid)
          yield* session.turn("Reply with just the word: pong")
          const last = yield* session.lastSeq
          process.kill(session.hostPid, "SIGKILL")
          yield* waitUntil(() => !isAlive(session.hostPid), "the host to die")
          expect(fileEnding(dir, session.sessionId)).toBeUndefined()
          const read = yield* hosts.events(session.sessionId).pipe(Stream.runCollect)
          expect(seqs(read)).toEqual(range(0, last))
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { onScopeClose: "detach" }))),
      timeout,
    )

    it.live(
      "expired events files are pruned by host startup, list and attach; a live host's file is kept",
      () =>
        Effect.gen(function* () {
          const own = join(root, `prune-${p.name}`)
          mkdirSync(own, { mode: 0o700 })
          const options = { dir: own, retainEvents: "300 millis", onScopeClose: "detach" } as const
          const atStartup = plantExpired(own, "startup")
          const { sessionId, hostPid } = yield* Effect.gen(function* () {
            const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
            started.add(session.hostPid)
            return { sessionId: session.sessionId, hostPid: session.hostPid }
          }).pipe(Effect.scoped, Effect.provide(layer(p.simple, options)))
          expect(existsSync(atStartup)).toBe(false)

          const own_ = HostSpec.eventsPath(own, sessionId)
          yield* Effect.sleep(Duration.millis(500))
          yield* Effect.gen(function* () {
            const hosts = yield* AgentHosts
            yield* hosts.list
            expect(existsSync(own_)).toBe(true) // older than retainEvents, but its host is alive

            const session = yield* hosts.attach(sessionId)
            yield* session.end
            yield* waitUntil(() => !isAlive(hostPid), "the host to exit")
            yield* hosts.list
            expect(existsSync(own_)).toBe(true) // just exited: retained

            yield* Effect.sleep(Duration.millis(400))
            const byList = plantExpired(own, "list")
            yield* hosts.list
            expect(existsSync(own_)).toBe(false)
            expect(existsSync(byList)).toBe(false)
            expect(failureOf(yield* hosts.events(sessionId).pipe(Stream.runCollect, Effect.exit))).toBeInstanceOf(SessionNotFound)

            const byAttach = plantExpired(own, "attach")
            yield* hosts.attach(SessionId.make("attach")).pipe(Effect.scoped, Effect.exit)
            expect(existsSync(byAttach)).toBe(false)
          }).pipe(Effect.scoped, Effect.provide(layer(p.simple, options)))
        }),
      timeout,
    )

    it.live(
      "the events file is mode 0600 and the host dir is made 0700",
      () =>
        Effect.gen(function* () {
          const own = join(root, `perm-${p.name}`)
          mkdirSync(own)
          chmodSync(own, 0o755)
          yield* Effect.gen(function* () {
            const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
            started.add(session.hostPid)
            yield* session.turn("Reply with just the word: pong")
            expect(statSync(own).mode & 0o777).toBe(0o700)
            expect(statSync(HostSpec.eventsPath(own, session.sessionId)).mode & 0o777).toBe(0o600)
          }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { dir: own })))
        }),
      timeout,
    )
  })

  describe(`host reconnect: ${p.name}`, () => {
    it.live(
      "a subscription spanning a drop sees every seq exactly once",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          // Subscribed before `send`, so no event after it can be missed.
          const live = yield* collect(yield* session.subscribe)
          yield* session.send("sleep for a long time")
          yield* waitUntil(() => all.items.some((e) => e.event._tag === "ToolCall"), "the tool call")

          process.kill(session.hostPid, "SIGUSR2")
          yield* waitUntil(() => drops(dir, session.sessionId) === 1, "the host to drop the connection")
          yield* session.interrupt
          yield* session.turn("Reply with just the word: pong")
          yield* session.end

          expect(Exit.isSuccess(yield* Fiber.join(all.fiber))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.join(live.fiber))).toBe(true)
          const last = all.items.at(-1)!.seq
          expect(seqs(all.items)).toEqual(range(0, last))
          expect(all.items.filter((e) => e.event._tag === "TurnEnded")).toHaveLength(2)
          // `subscribe`: SessionStarted, then everything after the moment it subscribed.
          const sinceSubscribe = all.items.slice(all.items.length - (live.items.length - 1))
          expect(live.items.length).toBeGreaterThan(all.items.length / 2)
          expect(tags(live.items)).toEqual(tags([all.items[0]!, ...sinceSubscribe].map((e) => e.event)))
        }).pipe(Effect.scoped, Effect.provide(layer(p.interrupt))),
      timeout,
    )

    it.live(
      "a send whose connection drops before its reply lands exactly once",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          const messageId = yield* session.send("Reply with just the word: pong")
          expect(drops(dir, session.sessionId)).toBe(1)
          const result = yield* session.awaitMessage(messageId)
          expect(result.finalText.toLowerCase()).toContain("pong")
          yield* session.end
          expect(Exit.isSuccess(yield* Fiber.join(all.fiber))).toBe(true)
          const landed = all.items.filter((e) => e.event._tag === "MessageLanded")
          expect(landed.map((e) => e.event._tag === "MessageLanded" && e.event.messageId)).toEqual([messageId])
          expect(all.items.filter((e) => e.event._tag === "TurnStarted")).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { testDropBeforeReply: ["Send"] }))),
      timeout,
    )

    it.live(
      "a turn() whose connection drops before its reply returns that turn's result, run once",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          const result = yield* session.turn("Reply with just the word: pong")
          expect(drops(dir, session.sessionId)).toBe(1)
          expect(result.finalText.toLowerCase()).toContain("pong")
          yield* session.end
          expect(Exit.isSuccess(yield* Fiber.join(all.fiber))).toBe(true)
          expect(all.items.filter((e) => e.event._tag === "TurnStarted")).toHaveLength(1)
          expect(all.items.filter((e) => e.event._tag === "MessageLanded")).toHaveLength(1)
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { testDropBeforeReply: ["Turn"] }))),
      timeout,
    )

    it.live(
      "an interrupt whose connection drops before its reply acts once (the retry doesn't hit the next turn)",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          yield* session.send("sleep for a long time")
          yield* waitUntil(() => all.items.some((e) => e.event._tag === "ToolCall"), "the tool call")
          yield* session.interrupt
          expect(drops(dir, session.sessionId)).toBe(1)
          const next = yield* session.turn("Reply with just the word: pong")
          expect(next.finalText.length).toBeGreaterThan(0)
          yield* session.end
          expect(Exit.isSuccess(yield* Fiber.join(all.fiber))).toBe(true)
          const outcomes = all.items.flatMap((e) => (e.event._tag === "TurnEnded" ? [e.event.outcome._tag] : []))
          expect(outcomes).toEqual(["Interrupted", "Succeeded"])
        }).pipe(Effect.scoped, Effect.provide(layer(p.interrupt, { testDropBeforeReply: ["Interrupt"] }))),
      timeout,
    )

    it.live(
      "a turn() spanning a drop mid-turn waits on the original turn",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          const inFlight = yield* session.turn("sleep for a long time").pipe(Effect.exit, Effect.forkScoped)
          yield* waitUntil(() => all.items.some((e) => e.event._tag === "ToolCall"), "the tool call")
          process.kill(session.hostPid, "SIGUSR2")
          yield* waitUntil(() => drops(dir, session.sessionId) === 1, "the host to drop the connection")
          yield* Effect.sleep(Duration.millis(200))
          yield* session.interrupt
          // The turn's own ending, not a connection error.
          expect(failureOf(yield* Fiber.join(inFlight))).toMatchObject({ _tag: "Interrupted" })
          const next = yield* session.turn("Reply with just the word: pong")
          expect(next.finalText.length).toBeGreaterThan(0)
          yield* session.end
          yield* Fiber.join(all.fiber)
          expect(all.items.filter((e) => e.event._tag === "TurnStarted")).toHaveLength(2)
        }).pipe(Effect.scoped, Effect.provide(layer(p.interrupt))),
      timeout,
    )

    it.live(
      "awaitMessage spanning a drop gets the turn's ending",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          const messageId: MessageId = yield* session.send("sleep for a long time")
          yield* waitUntil(() => all.items.some((e) => e.event._tag === "ToolCall"), "the tool call")
          const waiting = yield* session.awaitMessage(messageId).pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.sleep(Duration.millis(100))
          process.kill(session.hostPid, "SIGUSR2")
          yield* waitUntil(() => drops(dir, session.sessionId) === 1, "the host to drop the connection")
          yield* Effect.sleep(Duration.millis(200))
          yield* session.interrupt
          expect(failureOf(yield* Fiber.join(waiting))).toMatchObject({ _tag: "Interrupted" })
        }).pipe(Effect.scoped, Effect.provide(layer(p.interrupt))),
      timeout,
    )

    it.live(
      "with the host killed, calls and subscriptions fail ConnectionLost at once",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          const all = yield* collect(session.subscribeFrom(0))
          yield* Effect.sleep(Duration.millis(100))
          process.kill(session.hostPid, "SIGKILL")
          yield* waitUntil(() => !isAlive(session.hostPid), "the host to die")
          const t0 = Date.now()
          const failure = failureOf(yield* session.send("hello?").pipe(Effect.exit))
          expect(failure).toBeInstanceOf(ConnectionLost)
          expect(failure).toMatchObject({ message: expect.stringMatching(/gone/) })
          expect(failureOf(yield* Fiber.join(all.fiber).pipe(Effect.flatten, Effect.exit))).toBeInstanceOf(ConnectionLost)
          expect(Date.now() - t0).toBeLessThan(2_000) // not the 30 s schedule
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { onScopeClose: "detach" }))),
      timeout,
    )

    it.live(
      "when the schedule runs out, calls fail ConnectionLost",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          // The host lives on, but can't be reached.
          rmSync(session.socket)
          process.kill(session.hostPid, "SIGUSR2")
          // Before the host has handled the signal, the old connection still answers.
          yield* waitUntil(() => drops(dir, session.sessionId) === 1, "the host to drop the connection")
          const t0 = Date.now()
          const failure = failureOf(yield* session.info.pipe(Effect.exit))
          expect(failure).toBeInstanceOf(ConnectionLost)
          expect(failure).toMatchObject({ message: expect.stringMatching(/could not reconnect/) })
          expect(Date.now() - t0).toBeLessThan(5_000)
          expect(isAlive(session.hostPid)).toBe(true)
          process.kill(session.hostPid, "SIGTERM")
          yield* waitUntil(() => !isAlive(session.hostPid), "the host to exit")
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layer(p.simple, {
              onScopeClose: "detach",
              reconnect: Schedule.max([Schedule.spaced("50 millis"), Schedule.recurs(5)]),
            }),
          ),
        ),
      timeout,
    )

    it.live(
      "reconnect: false fails on the first drop",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          yield* session.turn("Reply with just the word: pong")
          const all = yield* collect(session.subscribeFrom(0))
          yield* waitUntil(() => all.items.length > 0, "the first event")
          process.kill(session.hostPid, "SIGUSR2")
          expect(failureOf(yield* Fiber.join(all.fiber).pipe(Effect.flatten, Effect.exit))).toBeInstanceOf(ConnectionLost)
          expect(failureOf(yield* session.info.pipe(Effect.exit))).toBeInstanceOf(ConnectionLost)
          expect(isAlive(session.hostPid)).toBe(true)
          process.kill(session.hostPid, "SIGTERM")
          yield* waitUntil(() => !isAlive(session.hostPid), "the host to exit")
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { onScopeClose: "detach", reconnect: false }))),
      timeout,
    )
  })
}

describe("host events file: resumed sessions", () => {
  const turn = (id: string): ReadonlyArray<AgentEvent> => [
    { _tag: "TurnStarted", turnId: TurnId.make(id), raw: null },
    {
      _tag: "TurnEnded",
      turnId: TurnId.make(id),
      outcome: { _tag: "Succeeded", turnId: TurnId.make(id), finalText: id },
      usage: null,
      cost: null,
      raw: null,
    },
  ]
  const started = (resumed: boolean): AgentEvent => ({
    _tag: "SessionStarted",
    sessionId: SessionId.make("resumed"),
    provider: "test",
    version: null,
    model: null,
    resumed,
    raw: null,
  })

  it.live("AwaitTurn and AwaitMessage answer for turns past the 10 000 kept in memory, from the events file", () =>
    Effect.gen(function* () {
      const path = HostSpec.eventsPath(root, "long-session")
      const log = yield* Host.makeLog(2, "test", { path, resumed: false })
      yield* log.append(started(false))
      for (let i = 0; i <= 10_000; i++) {
        log.sent(`m${i}`)
        yield* log.append({ _tag: "MessageLanded", messageId: MessageId.make(`m${i}`), turnId: TurnId.make(`t${i}`), raw: null })
        for (const event of turn(`t${i}`)) yield* log.append(event)
      }
      expect(yield* log.awaitTurn("t0")).toMatchObject({ _tag: "Succeeded", finalText: "t0" })
      expect(yield* log.awaitMessage("m0")).toMatchObject({ _tag: "Succeeded", finalText: "t0" })
      expect(yield* log.awaitTurn("t10000")).toMatchObject({ _tag: "Succeeded", finalText: "t10000" })
      log.closeFile()
    }),
  )

  it.live("without an events file, AwaitTurn on a turn too old to remember fails at once instead of waiting", () =>
    Effect.gen(function* () {
      // In memory only, with a ring of 2: the host keeps 10 000 turn endings either way.
      const log = yield* Host.makeLog(2, "test")
      yield* log.append(started(false))
      for (let i = 0; i <= 10_000; i++) for (const event of turn(`t${i}`)) yield* log.append(event)
      // The session is still running, so waiting on t0 would never end.
      const old = yield* log.awaitTurn("t0").pipe(Effect.flip, Effect.timeoutOption("1 second"))
      expect(Option.getOrUndefined(old)).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/settled too long ago/) })
      expect(yield* log.awaitTurn("t10000")).toMatchObject({ _tag: "Succeeded", finalText: "t10000" })
    }),
  )

  it.live("a resumed session's host numbers on from the file an earlier host left; a new one starts it afresh", () =>
    Effect.gen(function* () {
      const path = HostSpec.eventsPath(root, "resumed")
      const first = yield* Host.makeLog(2, "test", { path, resumed: false })
      for (const event of [started(false), ...turn("t1")]) yield* first.append(event)
      first.closeFile()
      // A crash mid-write leaves a torn last line: not part of the log.
      appendFileSync(path, '{"seq":3,"event":{"_tag":"Tu')

      const second = yield* Host.makeLog(2, "test", { path, resumed: true })
      expect(second.lastSeq()).toBe(2)
      for (const event of [started(true), ...turn("t2")]) yield* second.append(event)
      yield* second.end(null)
      const all = yield* second.subscribe(0, false).pipe(Stream.runCollect)
      expect(seqs(all)).toEqual(range(0, 5))
      expect(tags(all.map((e) => e.event))).toEqual(["SessionStarted", "TurnStarted", "TurnEnded", "SessionStarted", "TurnStarted", "TurnEnded"])
      // An earlier host's turn still answers.
      expect(yield* second.awaitTurn("t1")).toMatchObject({ _tag: "Succeeded", finalText: "t1" })
      second.closeFile()
      expect(fileSeqs(root, "resumed")).toEqual(range(0, 5))
      expect(fileEnding(root, "resumed")).toEqual({ ended: null })

      // Resumed again: the earlier ending is cut off, and the new one is the last line.
      const third = yield* Host.makeLog(2, "test", { path, resumed: true })
      expect(third.lastSeq()).toBe(5)
      for (const event of turn("t3")) yield* third.append(event)
      yield* third.end(new AgentError({ message: "it broke", provider: "test" }))
      third.closeFile()
      expect(fileSeqs(root, "resumed")).toEqual(range(0, 7))
      expect(fileEnding(root, "resumed")).toMatchObject({ ended: { _tag: "AgentError", message: "it broke" } })

      const fresh = yield* Host.makeLog(2, "test", { path, resumed: false })
      expect(fresh.lastSeq()).toBe(-1)
      fresh.closeFile()
      expect(readFileSync(path, "utf8")).toBe("")
      rmSync(path)
    }),
  )
})
