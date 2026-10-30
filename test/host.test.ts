/**
 * Real host processes (src/host/main.ts) over recorded sessions: no CLIs run,
 * but every session lives in its own detached process and every call crosses
 * a unix socket, so detaching, reattaching and process death are exercised
 * for real.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Cause, DateTime, Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, AgentError, MessageId, SessionId, SessionNotFound, type TurnId, UsageLimited } from "../src/index.ts"
import { AgentHosts, EventsTrimmed, HostSpec, RemoteAgent } from "../src/host/index.ts"

const dir = mkdtempSync(join(tmpdir(), "ea-host-"))
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
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.endsWith(".json")) continue
    const manifest = RemoteAgent.listHosts(dir).find((m) => `${m.sessionId}.json` === name)
    if (manifest !== undefined) started.add(manifest.pid)
  }
  for (const pid of started) if (isAlive(pid)) process.kill(pid, "SIGKILL")
  rmSync(dir, { recursive: true, force: true })
})

const fixture = (provider: string, name: string) => join(import.meta.dirname, "fixtures", provider, `${name}.jsonl`)

const providers = [
  { name: "claude", cwd: "/tmp/effect-agent-replay", simple: "simple-turn", usageLimit: "usage-limit", interrupt: "interrupt-then-turn" },
  { name: "codex", cwd: "/tmp/effect-agent-live/codex/work", simple: "simple", usageLimit: "usage-limit", interrupt: "interrupt" },
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

const hostFilesGone = (sessionId: string) =>
  !existsSync(HostSpec.socketPath(dir, sessionId)) && !existsSync(HostSpec.manifestPath(dir, sessionId))

const timeout = 30_000

for (const p of providers) {
  const layer = (name: string, options: Partial<RemoteAgent.RemoteAgentOptions> = {}) =>
    RemoteAgent.layer({ provider: p.name, replay: fixture(p.name, name), dir, ...options })

  /** Open a session, send one message and return as soon as it lands, leaving the session running. */
  const startTurn = (name: string, options: Partial<RemoteAgent.RemoteAgentOptions> = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
        started.add(session.hostPid)
        const events = yield* session.subscribe
        const messageId = yield* session.send("Reply with just the word: pong")
        const landed = yield* events.pipe(
          Stream.filter((e) => e._tag === "MessageLanded" && e.messageId === messageId),
          Stream.runHead,
        )
        const event = Option.getOrThrow(landed)
        if (event._tag !== "MessageLanded") throw new Error("unreachable")
        return { sessionId: session.sessionId, turnId: event.turnId as TurnId, messageId, hostPid: session.hostPid }
      }),
    ).pipe(Effect.provide(layer(name, { onScopeClose: "detach", ...options })))

  describe(`host: ${p.name}`, () => {
    it.live(
      "awaitMessage picks up a turn's result by the MessageId send returned, after a reattach",
      () =>
        Effect.gen(function* () {
          const { sessionId, turnId, messageId } = yield* startTurn(p.simple)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).attach(sessionId)
              const result = yield* session.awaitMessage(messageId)
              expect(result).toMatchObject({ _tag: "Succeeded", turnId })
              const unknown = failureOf(yield* session.awaitMessage(MessageId.make("not-sent-here")).pipe(Effect.exit))
              expect(unknown).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/not sent through this host/) })
              yield* session.end
            }),
          ).pipe(Effect.provide(layer(p.simple)))
        }),
      30_000,
    )

    it.live(
      "a session survives its client; a fresh client reattaches, catches up and ends it",
      () =>
        Effect.gen(function* () {
          const { sessionId, turnId, hostPid } = yield* startTurn(p.simple)
          expect(isAlive(hostPid)).toBe(true)

          // A fresh client: a new layer, a new connection.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const hosts = yield* AgentHosts
              expect((yield* hosts.list).map((m) => m.sessionId)).toContain(sessionId)
              const session = yield* hosts.attach(sessionId)
              expect(session.hostPid).toBe(hostPid)

              const result = yield* session.awaitTurn(turnId)
              expect(result).toMatchObject({ _tag: "Succeeded", turnId })
              expect(result.finalText.toLowerCase()).toContain("pong")

              const lastSeq = yield* session.lastSeq
              const all = yield* session.subscribeFrom(0).pipe(Stream.take(lastSeq + 1), Stream.runCollect)
              expect(all.map((e) => e.seq)).toEqual(Array.from({ length: lastSeq + 1 }, (_, i) => i))
              expect(all[0]?.event).toMatchObject({ _tag: "SessionStarted", sessionId })
              expect(all.some((e) => e.event._tag === "TurnEnded" && e.event.turnId === turnId)).toBe(true)

              // From the middle, too.
              const tail = yield* session.subscribeFrom(lastSeq).pipe(Stream.take(1), Stream.runCollect)
              expect(tail.map((e) => e.seq)).toEqual([lastSeq])

              yield* session.end
            }),
          ).pipe(Effect.provide(layer(p.simple, { onScopeClose: "detach" })))

          yield* waitUntil(() => !isAlive(hostPid), "the host to exit")
          expect(hostFilesGone(sessionId)).toBe(true)
        }),
      timeout,
    )

    it.live(
      "awaitTurn after a reattach returns a typed failure",
      () =>
        Effect.gen(function* () {
          const { sessionId, turnId, hostPid } = yield* startTurn(p.usageLimit)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).attach(sessionId)
              const failure = failureOf(yield* session.awaitTurn(turnId).pipe(Effect.exit))
              expect(failure).toBeInstanceOf(UsageLimited)
              if (!(failure instanceof UsageLimited)) return
              expect(failure.resetsAt === null || DateTime.isDateTime(failure.resetsAt)).toBe(true)
            }),
          ).pipe(Effect.provide(layer(p.usageLimit))) // onScopeClose "stop"
          expect(isAlive(hostPid)).toBe(false)
          expect(hostFilesGone(sessionId)).toBe(true)
        }),
      timeout,
    )

    it.live(
      "detaching mid-turn fails the in-flight turn() AgentError; the turn keeps running and a fresh client awaits it",
      () =>
        Effect.gen(function* () {
          const opened = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
              started.add(session.hostPid)
              const events = yield* session.subscribe
              const inFlight = yield* session.turn("sleep for a long time").pipe(Effect.exit, Effect.forkDetach)
              const call = Option.getOrThrow(yield* events.pipe(Stream.filter((e) => e._tag === "ToolCall"), Stream.runHead))
              const turnId = call._tag === "ToolCall" ? call.turnId : null
              expect(turnId).not.toBeNull()
              yield* session.detach
              const failure = failureOf(yield* Fiber.join(inFlight))
              expect(failure).toBeInstanceOf(AgentError)
              expect(failureOf(yield* session.send("after detach").pipe(Effect.exit))).toBeInstanceOf(AgentError)
              return { sessionId: session.sessionId, hostPid: session.hostPid, turnId: turnId as TurnId }
            }),
          ).pipe(Effect.provide(layer(p.interrupt)))
          expect(isAlive(opened.hostPid)).toBe(true)

          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).attach(opened.sessionId)
              const waiting = yield* session.awaitTurn(opened.turnId).pipe(Effect.exit, Effect.forkChild)
              yield* Effect.sleep(Duration.millis(100))
              yield* session.interrupt
              expect(failureOf(yield* Fiber.join(waiting))).toMatchObject({ _tag: "Interrupted" })
              const next = yield* session.turn("Reply with just the word: pong")
              expect(next.finalText.length).toBeGreaterThan(0)
            }),
          ).pipe(Effect.provide(layer(p.interrupt)))
          expect(isAlive(opened.hostPid)).toBe(false)
        }),
      timeout,
    )

    it.live(
      "persistEvents: false: subscribeFrom an event the host no longer keeps fails EventsTrimmed",
      () =>
        Effect.gen(function* () {
          const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
          started.add(session.hostPid)
          yield* session.turn("Reply with just the word: pong")
          const info = yield* session.info
          expect(info.oldestSeq).toBe(info.lastSeq - 2)
          const failure = failureOf(yield* session.subscribeFrom(0).pipe(Stream.runCollect, Effect.exit))
          expect(failure).toBeInstanceOf(EventsTrimmed)
          expect(failure).toMatchObject({ requested: 0, oldest: info.oldestSeq })
          const kept = yield* session.subscribeFrom(info.oldestSeq).pipe(Stream.take(3), Stream.runCollect)
          expect(kept.map((e) => e.seq)).toEqual([info.lastSeq - 2, info.lastSeq - 1, info.lastSeq])
          expect(existsSync(HostSpec.eventsPath(join(dir, "unpersisted"), session.sessionId))).toBe(false)
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple, { maxEvents: 3, persistEvents: false, dir: join(dir, "unpersisted") }))),
      timeout,
    )

    it.live(
      "onScopeClose: stop ends the host; detach leaves it running",
      () =>
        Effect.gen(function* () {
          const stopped = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open({ cwd: p.cwd })
              const remote = session as RemoteAgent.RemoteSession
              started.add(remote.hostPid)
              return { sessionId: session.sessionId, hostPid: remote.hostPid }
            }),
          ).pipe(Effect.provide(layer(p.simple)))
          expect(isAlive(stopped.hostPid)).toBe(false)
          expect(hostFilesGone(stopped.sessionId)).toBe(true)

          const detached = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
              started.add(session.hostPid)
              return { sessionId: session.sessionId, hostPid: session.hostPid }
            }),
          ).pipe(Effect.provide(layer(p.simple, { onScopeClose: "detach" })))
          yield* Effect.sleep(Duration.millis(300))
          expect(isAlive(detached.hostPid)).toBe(true)

          // Clean up through the API.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).attach(detached.sessionId)
              yield* session.stop
            }),
          ).pipe(Effect.provide(layer(p.simple)))
          expect(isAlive(detached.hostPid)).toBe(false)
          expect(hostFilesGone(detached.sessionId)).toBe(true)
        }),
      timeout,
    )

    it.live(
      "an orphaned host ends its idle session after orphanTimeout, but not while a client is attached",
      () =>
        Effect.gen(function* () {
          const options = { onScopeClose: "detach", orphanTimeout: "700 millis" } as const
          const { sessionId, hostPid } = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
              started.add(session.hostPid)
              return { sessionId: session.sessionId, hostPid: session.hostPid }
            }),
          ).pipe(Effect.provide(layer(p.simple, options)))

          // Attached: kept alive past the timeout.
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* AgentHosts).attach(sessionId)
              yield* Effect.sleep(Duration.millis(1_500))
              expect(isAlive(hostPid)).toBe(true)
            }),
          ).pipe(Effect.provide(layer(p.simple, options)))

          yield* waitUntil(() => !isAlive(hostPid), "the orphaned host to exit")
          expect(hostFilesGone(sessionId)).toBe(true)
        }),
      timeout,
    )

    it.live(
      "when the host dies, calls fail AgentError and attach fails SessionNotFound",
      () =>
        Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const session = yield* hosts.open({ cwd: p.cwd })
          started.add(session.hostPid)
          const events = yield* session.subscribeFrom(0).pipe(Stream.runCollect, Effect.exit, Effect.forkScoped)
          yield* Effect.sleep(Duration.millis(100))

          process.kill(session.hostPid, "SIGKILL")
          yield* waitUntil(() => !isAlive(session.hostPid), "the host to die")

          expect(failureOf(yield* session.send("hello?").pipe(Effect.exit))).toBeInstanceOf(AgentError)
          expect(failureOf(yield* session.turn("hello?").pipe(Effect.exit))).toBeInstanceOf(AgentError)
          expect(failureOf(yield* session.lastSeq.pipe(Effect.exit))).toBeInstanceOf(AgentError)
          expect(failureOf(yield* Fiber.join(events).pipe(Effect.flatten, Effect.exit))).toBeInstanceOf(AgentError)

          // Its files were left behind; attach notices the dead pid and removes them.
          const failure = failureOf(yield* hosts.attach(session.sessionId).pipe(Effect.exit))
          expect(failure).toBeInstanceOf(SessionNotFound)
          expect(hostFilesGone(session.sessionId)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(layer(p.simple))),
      timeout,
    )

    it.live(
      "SIGTERM closes the session and the host exits, removing its files",
      () =>
        Effect.gen(function* () {
          const { sessionId, hostPid } = yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* (yield* AgentHosts).open({ cwd: p.cwd })
              started.add(session.hostPid)
              return { sessionId: session.sessionId, hostPid: session.hostPid }
            }),
          ).pipe(Effect.provide(layer(p.simple, { onScopeClose: "detach" })))
          process.kill(hostPid, "SIGTERM")
          yield* waitUntil(() => !isAlive(hostPid), "the host to exit")
          expect(hostFilesGone(sessionId)).toBe(true)
        }),
      timeout,
    )

    it.live("hooks are refused without starting a host", () =>
      Effect.gen(function* () {
        const before = (yield* (yield* AgentHosts).list).length
        const failure = failureOf(
          yield* (yield* Agent).open({ cwd: p.cwd, hooks: { beforeStop: () => Effect.succeedNone } }).pipe(Effect.scoped, Effect.exit),
        )
        expect(failure).toBeInstanceOf(AgentError)
        expect((yield* (yield* AgentHosts).list).length).toBe(before)
        const caps = yield* (yield* Agent).capabilities
        expect(caps).toMatchObject({ provider: p.name, reattach: true, hooks: false })
      }).pipe(Effect.provide(layer(p.simple))),
    )
  })
}

describe("host: attach", () => {
  it.live("an unknown session id is SessionNotFound", () =>
    Effect.gen(function* () {
      const id = SessionId.make("00000000-0000-4000-8000-000000000000")
      const failure = failureOf(yield* (yield* AgentHosts).attach(id).pipe(Effect.scoped, Effect.exit))
      expect(failure).toBeInstanceOf(SessionNotFound)
      expect(failure).toMatchObject({ sessionId: id })
    }).pipe(Effect.provide(RemoteAgent.layer({ provider: "codex", replay: fixture("codex", "simple"), dir }))),
  )
})
