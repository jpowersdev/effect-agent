/**
 * CodexAgent's session under races a recording can't stage: a `turn/start`
 * that doesn't answer, a caller that gives up mid-request, and a steer that
 * loses to the end of its turn. The app-server here is scripted: each test
 * takes the client's requests one by one and decides when, and how, they are
 * answered.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent, type AgentSession, type RunOptions, SessionClosed } from "../src/index.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import type * as P from "../src/codex/protocol.ts"

const threadId = "th-1"

/** A request the client sent, and how to answer it. */
interface Pending {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly reply: (result: unknown) => Effect.Effect<void>
  readonly fail: (code: number, message: string) => Effect.Effect<void>
}

/**
 * A scripted app-server: one connection, driven by the test. With
 * `holdStop`, stopping it (close or kill) waits for `releaseStop`, as a
 * process slow to die would.
 */
const scripted = (options: { readonly holdStop?: boolean; readonly holdCleanup?: boolean } = {}) => Effect.gen(function* () {
  const stopReleased = yield* Deferred.make<void>()
  if (options.holdStop !== true) yield* Deferred.succeed(stopReleased, undefined)
  // With `holdCleanup`, stopping signals the exit and then waits, as the real transport's
  // `close` still sweeps processes and flushes the recording after app-server has exited.
  const cleanupReleased = yield* Deferred.make<void>()
  if (options.holdCleanup !== true) yield* Deferred.succeed(cleanupReleased, undefined)
  const requests = yield* Queue.unbounded<Pending>()
  let core: Effect.Success<ReturnType<typeof CodexAppServer.makeRpcCore>> | undefined
  const write = (msg: P.Message) =>
    msg.method !== undefined && msg.id !== undefined
      ? Queue.offer(requests, {
          method: msg.method,
          params: (msg.params ?? {}) as Record<string, unknown>,
          reply: (result) => Effect.asVoid(core!.dispatch({ id: msg.id!, result })),
          fail: (code, message) => Effect.asVoid(core!.dispatch({ id: msg.id!, error: { code, message } })),
        }).pipe(Effect.asVoid)
      : Effect.void
  core = yield* CodexAppServer.makeRpcCore(write)
  const rpc = core
  /** How many times the session stopped app-server (`close` or `kill`). */
  let stops = 0
  const stop = (signal: string) =>
    Effect.suspend(() => {
      stops++
      return Deferred.await(stopReleased).pipe(
        Effect.andThen(rpc.failPending("closed")),
        Effect.andThen(rpc.endIncoming),
        Effect.andThen(Deferred.succeed(rpc.exitSignal, { exitCode: null, signal })),
        Effect.andThen(Deferred.await(cleanupReleased)),
        Effect.asVoid,
      )
    })
  const connection: CodexAppServer.Connection = {
    pid: null,
    initialize: { userAgent: "effect_agent/0.162.1 (test)" },
    request: rpc.request,
    incoming: rpc.incomingStream,
    exit: Deferred.await(rpc.exitSignal),
    exited: Effect.map(Deferred.isDone(rpc.exitSignal), (done) => (done ? Option.some({ exitCode: null, signal: "SIGTERM" }) : Option.none())),
    close: stop("SIGTERM"),
    kill: stop("SIGKILL"),
  }

  /** The next request the client sent; it must be `method`. */
  const next = (method: string) =>
    Queue.take(requests).pipe(
      Effect.tap((request) =>
        Effect.sync(() => {
          if (request.method !== method) throw new Error(`expected ${method}, got ${request.method}`)
        }),
      ),
    )
  /** Whether the client has sent anything not taken yet. */
  const idle = Effect.map(Queue.size(requests), (n) => n === 0)
  const notify = (method: string, params: unknown) => Effect.asVoid(rpc.dispatch({ method, params }))
  const turn = (id: string, status: P.TurnStatus = "inProgress"): P.Turn => ({ id, items: [], status, error: null })
  const started = (id: string) => notify("turn/started", { threadId, turn: turn(id) })
  const completed = (id: string, status: P.TurnStatus = "completed") => notify("turn/completed", { threadId, turn: turn(id, status) })
  const landed = (turnId: string, clientId: string) =>
    notify("item/started", { threadId, turnId, item: { type: "userMessage", id: `item-${clientId}`, clientId, content: [] } })

  const layer = CodexAgent.layer().pipe(
    Layer.provide(
      Layer.succeed(CodexAppServer.CodexAppServer, CodexAppServer.CodexAppServer.of({ connect: () => Effect.succeed(connection), version: Effect.succeed("0.162.1") })),
    ),
  )
  /** app-server dies on its own, in the real transport's order: pending requests fail, output ends, then the exit. */
  const die = (exitCode: number) =>
    rpc.failPending(`codex app-server exited (code ${exitCode})`).pipe(
      Effect.andThen(rpc.endIncoming),
      Effect.andThen(Deferred.succeed(rpc.exitSignal, { exitCode, signal: null })),
      Effect.asVoid,
    )
  return { next, idle, notify, started, completed, landed, die, layer, stops: () => stops, releaseStop: Deferred.succeed(stopReleased, undefined), releaseCleanup: Deferred.succeed(cleanupReleased, undefined) }
})

type Server = Effect.Success<ReturnType<typeof scripted>>

/** Open a session against `server`, answering its `thread/start`. */
const open = (server: Server, options: Partial<RunOptions> = {}) =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const opening = yield* agent.open({ cwd: "/w", ...options }).pipe(Effect.forkScoped)
    const start = yield* server.next("thread/start")
    yield* start.reply({ thread: { id: threadId, path: null }, model: "gpt-test" } satisfies P.ThreadStartResponse)
    return yield* Fiber.join(opening)
  }).pipe(Effect.provide(server.layer))

/** Send `input` as a turn the server starts as `turnId`; returns the pending turn() and its turn/start. */
const startTurn = (server: Server, session: AgentSession, input: string, turnId: string) =>
  Effect.gen(function* () {
    const turn = yield* session.turn(input).pipe(Effect.exit, Effect.forkScoped)
    const request = yield* server.next("turn/start")
    yield* request.reply({ turn: { id: turnId, items: [], status: "inProgress", error: null } } satisfies P.TurnStartResponse)
    yield* server.started(turnId)
    yield* server.landed(turnId, request.params.clientUserMessageId as string)
    return { turn, request }
  })

describe("CodexAgent session races", () => {
  it.effect("a turn/start that never answers blocks neither send nor interrupt; then app-server is stopped", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const first = yield* session.send("first").pipe(Effect.exit, Effect.forkScoped)
      yield* server.next("turn/start")
      // Nothing holds a lock across that request: these return at once.
      const second = yield* session.turn("second").pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* session.interrupt
      expect(yield* server.idle).toBe(true)
      // No answer, and no turn/started: whether that turn will run can't be known, so
      // rather than start "second" alongside it, the session stops app-server.
      yield* TestClock.adjust("61 seconds")
      const failed = yield* Fiber.join(first)
      expect(Exit.isFailure(failed) && failed.cause.toString()).toMatch(/turn\/start: no answer.*stopping codex app-server/)
      expect(Exit.isFailure(yield* Fiber.join(second))).toBe(true)
      expect(server.stops()).toBe(1)
      expect(yield* server.idle).toBe(true)
      expect(yield* session.send("third").pipe(Effect.flip)).toBeInstanceOf(SessionClosed)
    }).pipe(Effect.scoped),
  )

  it.effect("a session stopping a stuck app-server doesn't report a clean end", () =>
    Effect.gen(function* () {
      const server = yield* scripted({ holdStop: true })
      const session = yield* open(server)
      const first = yield* session.send("first").pipe(Effect.exit, Effect.forkScoped)
      yield* server.next("turn/start")
      yield* TestClock.adjust("61 seconds")
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
      // app-server is slow to die: meanwhile the session is gone, not idle.
      expect(server.stops()).toBe(1)
      expect(yield* session.interrupt.pipe(Effect.flip)).toBeInstanceOf(SessionClosed)
      expect(yield* session.end.pipe(Effect.flip)).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/stopped answering/) })
      yield* server.releaseStop
    }).pipe(Effect.scoped),
  )

  it.effect("a turn/start whose turn already ran doesn't time out the session later", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const first = yield* session.turn("first").pipe(Effect.exit, Effect.forkScoped)
      const start = yield* server.next("turn/start")
      // Its answer never comes, but the turn runs and ends.
      yield* server.started("t-1")
      yield* server.landed("t-1", start.params.clientUserMessageId as string)
      yield* server.completed("t-1")
      const done = yield* Fiber.join(first)
      expect(Exit.isSuccess(done) && done.value).toMatchObject({ _tag: "Succeeded", turnId: "t-1" })
      const second = yield* startTurn(server, session, "second", "t-2")
      // The first request's timeout passes while the second turn runs: nothing happens.
      yield* TestClock.adjust("61 seconds")
      expect(server.stops()).toBe(0)
      yield* server.completed("t-2")
      const outcome = yield* Fiber.join(second.turn)
      expect(Exit.isSuccess(outcome) && outcome.value).toMatchObject({ _tag: "Succeeded", turnId: "t-2" })
    }).pipe(Effect.scoped),
  )

  it.effect("closing the session releases a turn() whose turn/start is in flight", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const sessionScope = yield* Scope.make()
      const session = yield* open(server).pipe(Scope.provide(sessionScope))
      // The caller outlives the session's scope.
      const turn = yield* session.turn("hello").pipe(Effect.exit, Effect.forkScoped)
      yield* server.next("turn/start")
      yield* Scope.close(sessionScope, Exit.void)
      const result = yield* Fiber.join(turn).pipe(Effect.timeoutOption("1 second"), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      const exit = yield* Fiber.join(result)
      expect(Option.isSome(exit) && Exit.isFailure(exit.value) && Option.getOrUndefined(Exit.findErrorOption(exit.value))).toBeInstanceOf(SessionClosed)
    }).pipe(Effect.scoped),
  )

  it.effect("closing the session releases an end() waiting for the running turn", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const sessionScope = yield* Scope.make()
      const session = yield* open(server).pipe(Scope.provide(sessionScope))
      yield* startTurn(server, session, "running", "t-1")
      // end waits for the running turn; the caller outlives the session's scope.
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Scope.close(sessionScope, Exit.void)
      const result = yield* Fiber.join(ending).pipe(Effect.timeoutOption("1 second"), Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      // Closed by its scope: a clean end, so `end` succeeds.
      expect(yield* Fiber.join(result)).toEqual(Option.some(Exit.void))
    }).pipe(Effect.scoped),
  )

  it.effect("app-server dying as a turn completes ends the session with that death, not cleanly", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const events = yield* session.subscribe
      const stream = yield* events.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      // Interrupted without being asked: the session checks whether app-server is exiting...
      yield* server.completed("t-1", "interrupted")
      // ...and it is.
      yield* server.die(9)
      expect(Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.join(turn)))).toMatchObject({ _tag: "ProcessKilled", exitCode: 9 })
      expect(Exit.isFailure(yield* Fiber.join(ending))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(stream))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(session.end))).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect("a turn/start answered with an error lets the next message go", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const first = yield* session.send("first").pipe(Effect.exit, Effect.forkScoped)
      const start = yield* server.next("turn/start")
      const second = yield* session.send("second").pipe(Effect.forkScoped)
      // "second" is queued behind "first".
      yield* Effect.yieldNow
      yield* start.fail(-32600, "nope")
      expect(Exit.isFailure(yield* Fiber.join(first))).toBe(true)
      const next = yield* server.next("turn/start")
      yield* next.reply({ turn: { id: "t-2", items: [], status: "inProgress", error: null } } satisfies P.TurnStartResponse)
      expect(next.params.clientUserMessageId).toBe(yield* Fiber.join(second))
    }).pipe(Effect.scoped),
  )

  it.effect("a turn/start that times out after its turn started keeps that turn, even mid-completion", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const first = yield* session.turn("first").pipe(Effect.exit, Effect.forkScoped)
      const start = yield* server.next("turn/start")
      // app-server runs the turn but its answer to turn/start never comes.
      yield* server.started("t-1")
      yield* server.landed("t-1", start.params.clientUserMessageId as string)
      yield* server.notify("item/started", {
        threadId,
        turnId: "t-1",
        item: { type: "commandExecution", id: "cmd-1", command: "sleep 60", cwd: "/w", processId: null, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null },
      })
      const second = yield* session.turn("second").pipe(Effect.exit, Effect.forkScoped)
      // It ends interrupted with a command started, so the session looks for that command first...
      yield* server.completed("t-1", "interrupted")
      yield* server.next("thread/backgroundTerminals/list")
      // ...and while it does, turn/start times out. The turn it started is still t-1.
      yield* TestClock.adjust("61 seconds")
      yield* TestClock.adjust("2 seconds")
      const ended = yield* Fiber.join(first)
      expect(Exit.isFailure(ended) && Option.getOrUndefined(Exit.findErrorOption(ended))).toMatchObject({ _tag: "Interrupted" })
      // Only now does the queued message start, as the next turn.
      const next = yield* server.next("turn/start")
      yield* next.reply({ turn: { id: "t-2", items: [], status: "inProgress", error: null } } satisfies P.TurnStartResponse)
      yield* server.started("t-2")
      yield* server.completed("t-2")
      const outcome = yield* Fiber.join(second)
      expect(Exit.isSuccess(outcome) && outcome.value).toMatchObject({ _tag: "Succeeded", turnId: "t-2" })
    }).pipe(Effect.scoped),
  )

  it.effect("a caller that gives up during turn/start doesn't cut the turn short", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const sending = yield* session.send("hello").pipe(Effect.forkScoped)
      const request = yield* server.next("turn/start")
      yield* Fiber.interrupt(sending)
      // app-server got it and starts the turn anyway; the session follows.
      yield* request.reply({ turn: { id: "t-1", items: [], status: "inProgress", error: null } } satisfies P.TurnStartResponse)
      yield* server.started("t-1")
      yield* server.completed("t-1")
      // The session is idle again: the next message starts a turn.
      const second = yield* startTurn(server, session, "again", "t-2")
      yield* server.completed("t-2")
      const outcome = yield* Fiber.join(second.turn)
      expect(Exit.isSuccess(outcome) && outcome.value._tag).toBe("Succeeded")
    }).pipe(Effect.scoped),
  )

  it.effect("a steer that loses to the end of its turn starts the next turn", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      const steering = yield* session.steer("also this").pipe(Effect.forkScoped)
      const steer = yield* server.next("turn/steer")
      // The turn ends while the steer is in flight; app-server then refuses it as stale.
      yield* server.completed("t-1")
      expect(Exit.isSuccess(yield* Fiber.join(turn))).toBe(true)
      yield* steer.fail(-32600, "no active turn to steer")
      const restart = yield* server.next("turn/start")
      expect(restart.params.clientUserMessageId).toBe(steer.params.clientUserMessageId)
      yield* restart.reply({ turn: { id: "t-2", items: [], status: "inProgress", error: null } } satisfies P.TurnStartResponse)
      const outcome = yield* Fiber.join(steering)
      expect(outcome).toEqual({ _tag: "StartedNewTurn", messageId: steer.params.clientUserMessageId, turnId: "t-2" })
    }).pipe(Effect.scoped),
  )

  it.effect("a steer that wins lands in the running turn, which then ends for both callers", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      const steering = yield* session.steer("also this").pipe(Effect.forkScoped)
      const steer = yield* server.next("turn/steer")
      yield* steer.reply({ turnId: "t-1" } satisfies P.TurnSteerResponse)
      expect(yield* Fiber.join(steering)).toMatchObject({ _tag: "Landed", turnId: "t-1" })
      yield* server.landed("t-1", steer.params.clientUserMessageId as string)
      yield* server.completed("t-1")
      expect(Exit.isSuccess(yield* Fiber.join(turn))).toBe(true)
      expect(yield* server.idle).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.effect("closing the session releases a turn waiting in the queue with SessionClosed", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* open(server)
          yield* startTurn(server, session, "running", "t-1")
          return yield* session.turn("queued").pipe(Effect.exit, Effect.forkDetach)
        }),
      ).pipe(Effect.flatMap(Fiber.join))
      expect(Exit.isFailure(result) && Option.getOrUndefined(Exit.findErrorOption(result))).toBeInstanceOf(SessionClosed)
    }),
  )
})

/**
 * The session's lifecycle contract, for orderings an independent review
 * found (round 7): every waiting caller settles; `end` succeeds only after a
 * clean end and otherwise fails with what ended the session; the event
 * stream completes after a clean end and fails otherwise; app-server is
 * stopped exactly when the session gives up on it.
 */
describe("CodexAgent session lifecycle", () => {
  /** Drain the session's events in the background. */
  const drain = (session: AgentSession) =>
    Effect.flatMap(session.subscribe, (events) => events.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped))

  /** The session ended in a failure: a waiting `end`, the stream and a later `end` all say so. */
  const failedEnding = (
    session: AgentSession,
    ending: Fiber.Fiber<Exit.Exit<void, unknown>>,
    stream: Fiber.Fiber<Exit.Exit<void, unknown>>,
  ) =>
    Effect.gen(function* () {
      expect(Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.join(ending)))).toMatchObject({ _tag: "AgentError" })
      expect(Exit.isFailure(yield* Fiber.join(stream))).toBe(true)
      expect(Option.getOrUndefined(Exit.findErrorOption(yield* Effect.exit(session.end)))).toMatchObject({ _tag: "AgentError" })
    })

  const commandItem = (turnId: string) => ({
    threadId,
    turnId,
    item: { type: "commandExecution", id: "cmd-1", command: "sleep 60", cwd: "/w", processId: null, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null },
  })

  it.effect("app-server dying while a turn/start is in flight, with end waiting, is a failed ending", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const stream = yield* drain(session)
      const turn = yield* session.turn("work").pipe(Effect.exit, Effect.forkScoped)
      yield* server.next("turn/start")
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* server.die(9)
      expect(Exit.isFailure(yield* Fiber.join(turn))).toBe(true)
      yield* failedEnding(session, ending, stream)
    }).pipe(Effect.scoped),
  )

  it.effect("app-server dying while an interrupted turn's commands are cleaned up, with end waiting, is a failed ending", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const stream = yield* drain(session)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      yield* server.notify("item/started", commandItem("t-1"))
      const interrupting = yield* session.interrupt.pipe(Effect.exit, Effect.forkScoped)
      const interrupt = yield* server.next("turn/interrupt")
      yield* interrupt.reply({})
      yield* server.completed("t-1", "interrupted")
      // Held: the session is looking for the turn's commands when app-server dies.
      yield* server.next("thread/backgroundTerminals/list")
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* server.die(9)
      yield* Fiber.join(interrupting)
      expect(Exit.isFailure(yield* Fiber.join(turn))).toBe(true)
      yield* failedEnding(session, ending, stream)
    }).pipe(Effect.scoped),
  )

  it.effect("app-server dying while a usage-limited turn reads the rate limits, with end waiting, is a failed ending", () =>
    Effect.gen(function* () {
      const server = yield* scripted()
      const session = yield* open(server)
      const stream = yield* drain(session)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      yield* server.notify("turn/completed", {
        threadId,
        turn: { id: "t-1", items: [], status: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded", additionalDetails: null } },
      })
      yield* server.next("account/rateLimits/read")
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* server.die(9)
      expect(Exit.isFailure(yield* Fiber.join(turn))).toBe(true)
      yield* failedEnding(session, ending, stream)
    }).pipe(Effect.scoped),
  )

  it.effect("a watchdog kill is a failed ending even if the turn completes while app-server is being stopped", () =>
    Effect.gen(function* () {
      const server = yield* scripted({ holdStop: true })
      const session = yield* open(server, { watchdog: { idle: "1 second", grace: "1 second" } })
      const stream = yield* drain(session)
      const { turn } = yield* startTurn(server, session, "work", "t-1")
      const queued = yield* session.send("next").pipe(Effect.exit, Effect.forkScoped)
      const ending = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      // Quiet for a second: the watchdog interrupts (unanswered), and a second later kills.
      yield* TestClock.adjust("1100 millis")
      yield* server.next("turn/interrupt")
      yield* TestClock.adjust("1100 millis")
      expect(server.stops()).toBe(1)
      // The turn ends while app-server is being stopped: still a failed ending, nothing new starts.
      yield* server.completed("t-1", "interrupted")
      yield* TestClock.adjust("2 seconds")
      expect(yield* server.idle).toBe(true)
      yield* server.releaseStop
      expect(Option.getOrUndefined(Exit.findErrorOption(yield* Fiber.join(turn)))).toMatchObject({ _tag: "Stalled" })
      expect(Exit.isFailure(yield* Fiber.join(queued))).toBe(false)
      yield* failedEnding(session, ending, stream)
      expect(server.stops()).toBe(1)
    }).pipe(Effect.scoped),
  )

  it.effect("closing the scope keeps a failure already recorded", () =>
    Effect.gen(function* () {
      const server = yield* scripted({ holdStop: true })
      const sessionScope = yield* Scope.make()
      const session = yield* open(server).pipe(Scope.provide(sessionScope))
      const stream = yield* drain(session)
      const first = yield* session.send("first").pipe(Effect.exit, Effect.forkScoped)
      yield* server.next("turn/start")
      // No answer: the session gives up on app-server and starts stopping it.
      yield* TestClock.adjust("61 seconds")
      yield* Fiber.join(first)
      yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* server.releaseStop
      expect(Exit.isFailure(yield* Fiber.join(stream))).toBe(true)
      expect(Option.getOrUndefined(Exit.findErrorOption(yield* Effect.exit(session.end)))).toMatchObject({ _tag: "AgentError" })
    }).pipe(Effect.scoped),
  )

  it.effect("a second end waits for the first one's close, and both succeed", () =>
    Effect.gen(function* () {
      const server = yield* scripted({ holdStop: true })
      const session = yield* open(server)
      const stream = yield* drain(session)
      const first = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      const second = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      yield* Effect.yieldNow
      expect(second.pollUnsafe()).toBeUndefined()
      yield* server.releaseStop
      expect(yield* Fiber.join(first)).toEqual(Exit.void)
      expect(yield* Fiber.join(second)).toEqual(Exit.void)
      expect(yield* Fiber.join(stream)).toEqual(Exit.void)
      expect(server.stops()).toBe(1)
    }).pipe(Effect.scoped),
  )

  for (const call of ["steer", "interrupt"] as const) {
    it.effect(`closing the scope releases a ${call} waiting for app-server's answer`, () =>
      Effect.gen(function* () {
        const server = yield* scripted()
        const sessionScope = yield* Scope.make()
        const session = yield* open(server).pipe(Scope.provide(sessionScope))
        yield* startTurn(server, session, "work", "t-1").pipe(Scope.provide(sessionScope))
        // The caller outlives the session's scope; app-server never answers.
        const waiting = yield* (call === "steer" ? Effect.asVoid(session.steer("also")) : session.interrupt).pipe(
          Effect.exit,
          Effect.forkScoped,
        )
        yield* server.next(call === "steer" ? "turn/steer" : "turn/interrupt")
        yield* Scope.close(sessionScope, Exit.void)
        const result = yield* Fiber.join(waiting).pipe(Effect.timeoutOption("1 second"), Effect.forkChild)
        yield* TestClock.adjust("2 seconds")
        const exit = yield* Fiber.join(result)
        expect(Option.isSome(exit) && Option.getOrUndefined(Exit.findErrorOption(exit.value))).toBeInstanceOf(SessionClosed)
      }).pipe(Effect.scoped),
    )
  }

  it.effect("end returns only once the connection's close has finished, not when app-server exits", () =>
    Effect.gen(function* () {
      const server = yield* scripted({ holdCleanup: true })
      const session = yield* open(server)
      const first = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      const second = yield* session.end.pipe(Effect.exit, Effect.forkScoped)
      // app-server has exited, but the close is still cleaning up.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()
      yield* server.releaseCleanup
      expect(yield* Fiber.join(first)).toEqual(Exit.void)
      expect(yield* Fiber.join(second)).toEqual(Exit.void)
    }).pipe(Effect.scoped),
  )
})
