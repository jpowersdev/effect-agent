/**
 * CodexAgent's session under races a recording can't stage: a `turn/start`
 * that doesn't answer, a caller that gives up mid-request, and a steer that
 * loses to the end of its turn. The app-server here is scripted: each test
 * takes the client's requests one by one and decides when, and how, they are
 * answered.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer, Option, Queue } from "effect"
import { TestClock } from "effect/testing"
import { Agent, type AgentSession, SessionClosed } from "../src/index.ts"
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

/** A scripted app-server: one connection, driven by the test. */
const scripted = Effect.gen(function* () {
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
  const stop = Effect.andThen(rpc.failPending("closed"), rpc.endIncoming)
  const connection: CodexAppServer.Connection = {
    pid: null,
    initialize: { userAgent: "effect_agent/0.162.1 (test)" },
    request: rpc.request,
    incoming: rpc.incomingStream,
    exit: Effect.never,
    exited: Effect.succeedNone,
    close: stop,
    kill: stop,
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
  const completed = (id: string) => notify("turn/completed", { threadId, turn: turn(id, "completed") })
  const landed = (turnId: string, clientId: string) =>
    notify("item/started", { threadId, turnId, item: { type: "userMessage", id: `item-${clientId}`, clientId, content: [] } })

  const layer = CodexAgent.layer().pipe(
    Layer.provide(
      Layer.succeed(CodexAppServer.CodexAppServer, CodexAppServer.CodexAppServer.of({ connect: () => Effect.succeed(connection), version: Effect.succeed("0.162.1") })),
    ),
  )
  return { next, idle, started, completed, landed, layer }
})

type Server = Effect.Success<typeof scripted>

/** Open a session against `server`, answering its `thread/start`. */
const open = (server: Server) =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const opening = yield* agent.open({ cwd: "/w" }).pipe(Effect.forkScoped)
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
  it.effect("a turn/start that doesn't answer blocks neither send nor interrupt, and times out", () =>
    Effect.gen(function* () {
      const server = yield* scripted
      const session = yield* open(server)
      const first = yield* session.send("first").pipe(Effect.exit, Effect.forkScoped)
      const stuck = yield* server.next("turn/start")
      // Nothing holds a lock across that request: these return at once.
      const queued = yield* session.send("second")
      yield* session.interrupt
      expect(queued).toBeTypeOf("string")
      expect(yield* server.idle).toBe(true)
      // After the request timeout the first message fails, and the queued one goes.
      yield* TestClock.adjust("61 seconds")
      const failed = yield* Fiber.join(first)
      expect(Exit.isFailure(failed) && failed.cause.toString()).toMatch(/turn\/start.*no answer/)
      const nextStart = yield* server.next("turn/start")
      expect(nextStart.params.clientUserMessageId).toBe(queued)
      expect(stuck.method).toBe("turn/start")
    }).pipe(Effect.scoped),
  )

  it.effect("a caller that gives up during turn/start doesn't cut the turn short", () =>
    Effect.gen(function* () {
      const server = yield* scripted
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
      const server = yield* scripted
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
      const server = yield* scripted
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
      const server = yield* scripted
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
