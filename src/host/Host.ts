/**
 * The host: runs ONE session with the real provider layers and serves it
 * over effect/rpc on a unix socket, numbering its events and appending them
 * to the session's events file (`EventFile.ts`), with the latest in a ring
 * buffer, so a client that reattaches (or reconnects) can catch up from any
 * seq. `Send` / `Steer` / `Turn` are answered once per client request id, so
 * a client may retry them after a reconnect. `SessionHost.run` wraps this
 * for a process (stdin spec, readiness line, log file, signals).
 *
 * Lifecycle: the host exits after its session ends (`End`, `Stop`, the agent
 * dying, the orphan timeout, SIGTERM), lingering briefly on `End`/`Stop`/agent
 * death so connected clients get the last events. It removes its socket and
 * manifest on the way out; the events file stays for `retainEvents`.
 *
 * @since 0.1.0
 */
// The unix-socket server Effect's Node and Bun platforms both use.
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
import * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
import { Cause, Clock, Context, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, PubSub, Schedule, Schema, Scope, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SocketServer } from "effect/socket"
import type { Socket as NetSocket } from "node:net"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { Agent, type AgentSession, type Hooks, type RunOptions } from "../Agent.ts"
import { AgentError, type SessionClosed, SessionNotFound, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnOutcome, TurnSucceeded } from "../AgentEvent.ts"
import * as Session from "../internal/session.ts"
import * as TurnTracker from "../internal/turnTracker.ts"
import * as ProcessTree from "../ProcessTree.ts"
import * as EventFile from "./EventFile.ts"
import * as HookBridge from "./HookBridge.ts"
import {
  eventsPath,
  type HostSpec,
  Manifest,
  manifestPath,
  type ReadyLine,
  socketPath,
  toDuration,
} from "./HostSpec.ts"
import { providerLayer } from "./providers.ts"
import { EventsTrimmed, HostRpcs, type SeqEvent } from "./protocol.ts"

/**
 * Defaults for the optional `HostSpec` settings.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaults = {
  maxEvents: 50_000,
  orphanTimeout: Duration.minutes(30),
  linger: Duration.seconds(5),
  retainEvents: Duration.hours(24),
  /** Results of `Send` / `Steer` / `Turn` remembered by `requestId`. */
  requestResults: 1_000,
} as const

/**
 * Prune expired events files in `dir` (those of live hosts are kept).
 *
 * @since 0.1.0
 * @category utils
 */
export const pruneEvents = (dir: string, retainEvents: Duration.Duration): void =>
  EventFile.prune(dir, Duration.toMillis(retainEvents), (sessionId) => {
    const manifest = readManifest(manifestPath(dir, sessionId))
    return manifest !== undefined && isLive(manifest)
  })

/**
 * Run `effect` once per `requestId` of an RPC: a repeated id (a client
 * retrying after a reconnect) waits for, and gets, the first run's result.
 * Ids are scoped to the RPC, so the same id sent to two RPCs runs both. The
 * effect runs in `scope`, not in the request, so a client that disconnects
 * doesn't cut it short. The last `limit` ids are remembered.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeOnce = (scope: Scope.Scope, limit: number) => {
  const results = new Map<string, Deferred.Deferred<unknown, unknown>>()
  return <A, E>(rpc: string, requestId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const key = `${rpc}:${requestId}`
      // Only `rpc` stores results under `key`, and it always stores an `Exit<A, E>`.
      const existing = results.get(key) as Deferred.Deferred<A, E> | undefined
      if (existing !== undefined) return Deferred.await(existing)
      const result = Deferred.makeUnsafe<A, E>()
      results.set(key, result as Deferred.Deferred<unknown, unknown>)
      if (results.size > limit) results.delete(results.keys().next().value!)
      return effect.pipe(
        Effect.onExit((exit) => Deferred.done(result, exit)),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(result)),
      )
    })
}

/**
 * How the host reports to whatever runs it (`SessionHost.run`).
 *
 * @since 0.1.0
 * @category models
 */
export interface HostIO {
  /** Report readiness (or the open failure) to whoever started the host. Called once. */
  readonly ready: (line: ReadyLine) => Effect.Effect<void>
  /** The session id is known (e.g. to name the log file). */
  readonly opened: (sessionId: string) => void
}

type Reason = "ended" | "stop" | "sigterm" | "orphan"

/**
 * Read a manifest file; undefined if missing or unreadable.
 *
 * @since 0.1.0
 * @category utils
 */
export const readManifest = (path: string): Manifest | undefined => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  return Option.getOrUndefined(decodeManifest(text))
}

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))

/**
 * Whether the manifest's host process is still running.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isLive = (manifest: Manifest): boolean => ProcessTree.isAlive(manifest.pid)

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

const End = null

/**
 * The session's numbered events: the last `max` in memory (a ring buffer),
 * and, with `persist`, every one in the events file, written before it is
 * published. A subscription older than the ring reads the missing range from
 * the file, then continues from the ring and live events.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeLog = (
  max: number,
  provider: string,
  /** `resumed`: continue the file an earlier host of this session left, rather than starting it afresh. */
  persist: { readonly path: string; readonly resumed: boolean } | null = null,
) =>
  Effect.gen(function* () {
    const buffer: Array<SeqEvent | undefined> = []
    let next = 0
    let sessionStarted: SeqEvent | null = null
    let ended: { readonly error: AgentError | null } | null = null
    let lastActivity = yield* Clock.currentTimeMillis
    const pubsub = yield* PubSub.unbounded<SeqEvent | typeof End>()
    /** Where messages sent through this host landed, and how turns ended: for `AwaitTurn` / `AwaitMessage`. */
    const turns = TurnTracker.make({ provider, owner: "host" })

    // A resumed session's earlier hosts may have left events: number on from them.
    let file: EventFile.Writer | null = null
    if (persist !== null) {
      file = EventFile.openWriter(persist.path, persist.resumed ? (entry) => turns.observe(entry.event) : null)
      next = file.next
      // Those hosts are gone: nothing of theirs is still running.
      turns.clearRunning()
    }
    /** The first seq this host logged; the ring never holds anything older. */
    const firstOwn = next

    const cacheOldest = () => Math.max(firstOwn, next - max)
    const oldest = () => (file !== null ? 0 : cacheOldest())

    const fileFailed = (error: unknown) =>
      Effect.suspend(() => {
        if (file === null) return Effect.void
        const path = file.path
        try {
          file.close()
        } catch {
          // Already broken.
        }
        // A file with a hole in it would pass for the whole log after the host exits.
        rmSync(path, { force: true })
        file = null
        return Effect.logError(`cannot write ${path}; events are no longer persisted`, error)
      })

    const append = (event: AgentEvent) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const entry: SeqEvent = { seq: next++, event }
        let failure: { readonly error: unknown } | null = null
        if (file !== null) {
          try {
            file.append(entry)
          } catch (error) {
            failure = { error }
          }
        }
        buffer[entry.seq % max] = entry
        lastActivity = now
        if (event._tag === "SessionStarted" && sessionStarted === null) sessionStarted = entry
        turns.observe(event)
        const publish = PubSub.publish(pubsub, entry)
        return failure !== null ? Effect.andThen(fileFailed(failure.error), publish) : publish
      })

    const end = (error: AgentError | null) =>
      Effect.suspend(() => {
        if (ended !== null) return Effect.void
        ended = { error }
        // How it ended, for readers of the file once the host is gone.
        let written: Effect.Effect<void> = Effect.void
        if (file !== null) {
          try {
            file.end(error)
          } catch (e) {
            written = fileFailed(e)
          }
        }
        turns.end(error)
        return Effect.andThen(written, PubSub.end(pubsub, End))
      })

    const tail = Stream.suspend(() => (ended?.error ? Stream.fail(ended.error) : Stream.empty))

    const subscribe = (fromSeq: number, live: boolean): Stream.Stream<SeqEvent, EventsTrimmed | AgentError> =>
      Stream.unwrap(
        Effect.gen(function* (): Effect.fn.Return<Stream.Stream<SeqEvent, EventsTrimmed | AgentError>, never, Scope.Scope> {
          const from = Math.max(0, Math.floor(fromSeq))
          // Everything from here is decided synchronously, so no event can slip between the parts.
          const boundary = cacheOldest()
          const trimmed = (why: string) =>
            new EventsTrimmed({ message: `events before ${boundary} ${why} (asked for ${from})`, requested: from, oldest: boundary })
          if (from < boundary && file === null) return Stream.fail(trimmed("are no longer kept"))
          const subscription = ended === null ? yield* PubSub.subscribe(pubsub) : null
          const last = next - 1
          const snapshot: Array<SeqEvent> = []
          for (let seq = Math.max(from, boundary); seq <= last; seq++) snapshot.push(buffer[seq % max]!)
          // [from, boundary) from the file; it has every seq up to `last` already.
          const fromFile =
            from < boundary && file !== null
              ? EventFile.read(file.path, from, { until: boundary, startOffset: file.offsetFor(from) }).pipe(
                  Stream.mapError((e) => trimmed(`could not be read from the events file: ${e.message}`)),
                )
              : Stream.empty
          const prefix = live && sessionStarted !== null && sessionStarted.seq < from ? [sessionStarted] : []
          const kept = Stream.concat(Stream.fromIterable(prefix), fromFile).pipe(Stream.concat(Stream.fromIterable(snapshot)))
          if (subscription === null) return Stream.concat(kept, tail)
          const rest = Stream.fromSubscription(subscription).pipe(
            Stream.takeWhile((item): item is SeqEvent => item !== End),
            // Appended between subscribing and taking the snapshot: already in it.
            Stream.filter((entry) => entry.seq > last && entry.seq >= from),
          )
          return Stream.concat(kept, rest).pipe(Stream.concat(tail))
        }),
      )

    /** The ending of the turn a message landed in, found by the `MessageId` that `send` returned. */
    const awaitMessage = (messageId: string): Effect.Effect<TurnOutcome, AgentError | SessionClosed> =>
      Effect.flatMap(turns.landing(messageId), turns.outcome)

    return {
      append,
      end,
      subscribe,
      /** Stamp and close the events file (it stays, for `retainEvents`). */
      closeFile: () => {
        try {
          file?.close()
        } catch {
          // Best effort.
        }
      },
      awaitTurn: turns.outcome,
      awaitMessage,
      lastSeq: () => next - 1,
      oldest,
      ended: () => ended,
      /** Something is running or waiting to run. */
      busy: turns.busy,
      lastActivity: () => lastActivity,
      touch: Effect.map(Clock.currentTimeMillis, (now) => {
        lastActivity = now
      }),
      sent: turns.expect,
    }
  })

/**
 * @since 0.1.0
 * @category models
 */
export type EventLog = Effect.Success<ReturnType<typeof makeLog>>

const settle = (outcome: TurnOutcome): Effect.Effect<TurnSucceeded, TurnFailure> =>
  outcome._tag === "Succeeded" ? Effect.succeed(outcome) : Effect.fail(outcome)

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Every hook kind, each going through `bridge` to an attached client that
 * has it. With none attached, `bridge` answers "nothing" at once, in-process.
 *
 * @since 0.1.0
 * @category constructors
 */
export const remoteHooks = (bridge: HookBridge.HookBridge): Hooks => ({
  beforeTool: (call) => bridge.call("beforeTool", call),
  afterTool: (call) => bridge.call("afterTool", call),
  beforeStop: () => bridge.call("beforeStop", null),
})

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open the session, serve it, and return the process exit code once the
 * host is done. `shutdown` is completed by signal handlers.
 *
 * @since 0.1.0
 * @category running
 */
export const run = (spec: HostSpec, io: HostIO, shutdown: Deferred.Deferred<Reason>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const provider = spec.provider
      const maxEvents = spec.maxEvents ?? defaults.maxEvents
      const orphanTimeout = Duration.toMillis(spec.orphanTimeout !== undefined ? toDuration(spec.orphanTimeout) : defaults.orphanTimeout)
      const linger = Duration.toMillis(spec.linger !== undefined ? toDuration(spec.linger) : defaults.linger)
      const persist = spec.persistEvents ?? true
      pruneEvents(spec.dir, spec.retainEvents !== undefined ? toDuration(spec.retainEvents) : defaults.retainEvents)
      const agentError = Session.agentError(provider)

      const agent = Context.get(yield* Layer.build(providerLayer(spec)), Agent)

      // ---- hooks: forwarded to an attached client ----
      /** Bound once connections are tracked (below). */
      let dropHookDelivery = () => false
      const hookBridge = yield* HookBridge.make({ dropDelivery: () => dropHookDelivery() })
      // Registered whether or not `open` passed hooks, so any client can supply any hook later.
      const hasHooks = yield* agent.capabilities.pipe(
        Effect.map((c) => c.hooks),
        Effect.orElseSucceed(() => false),
      )
      const runOptions: RunOptions = { ...spec.run, ...(hasHooks && { hooks: remoteHooks(hookBridge) }) }

      // ---- open ----
      // A child of `run`'s scope: however `run` ends (even interrupted, as
      // `NodeRuntime.runMain` does on SIGTERM), the session is closed.
      const sessionScope = yield* Scope.fork(yield* Effect.scope)
      const opened = yield* agent.open(runOptions).pipe(Scope.provide(sessionScope), Effect.exit)
      if (Exit.isFailure(opened)) {
        const failure = Cause.findErrorOption(opened.cause)
        const error =
          Option.isSome(failure) && (failure.value instanceof SessionNotFound || failure.value instanceof AgentError)
            ? failure.value
            : agentError(`open failed: ${describe(opened.cause)}`)
        yield* Effect.logError("open failed", error)
        yield* io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      const session: AgentSession = opened.value
      const sessionId = session.sessionId
      io.opened(sessionId)
      yield* Effect.logInfo(`session ${sessionId} opened (${provider}, cwd ${spec.run.cwd})`)

      // ---- files ----
      const socket = socketPath(spec.dir, sessionId)
      const manifestFile = manifestPath(spec.dir, sessionId)
      const existing = readManifest(manifestFile)
      if (existing !== undefined && existing.pid !== process.pid && isLive(existing)) {
        const error = agentError(`session ${sessionId} is already hosted by pid ${existing.pid}; attach to it instead`)
        yield* io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }

      // ---- event log: subscribe before anything can be sent ----
      const madeLog = yield* makeLog(
        maxEvents,
        provider,
        persist ? { path: eventsPath(spec.dir, sessionId), resumed: spec.run.resume !== undefined } : null,
      ).pipe(Effect.exit)
      if (Exit.isFailure(madeLog)) {
        const error = agentError(`cannot open the events file: ${describe(madeLog.cause)}`)
        yield* io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      const log = madeLog.value
      const events = yield* session.subscribe
      const consumer = yield* events.pipe(
        Stream.runForEach(log.append),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.andThen(
            hookBridge.close,
            log.end(
              Exit.isSuccess(exit)
                ? null
                : Option.match(Cause.findErrorOption(exit.cause), {
                    onNone: () => agentError(`event stream failed: ${describe(exit.cause)}`),
                    // A local session's stream fails only with how the session died.
                    onSome: (e) => (e._tag === "AgentError" ? e : agentError(e.message, e)),
                  }),
            ),
          ),
        ),
        Effect.andThen(Effect.logInfo("session ended")),
        Effect.andThen(Deferred.succeed(shutdown, "ended")),
        Effect.forkScoped,
      )

      if (Buffer.byteLength(socket) > 107) {
        const error = agentError(`socket path ${socket} is too long for a unix socket; use a shorter dir`)
        yield* io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      rmSync(socket, { force: true })
      const cleanup = () => {
        // The events file stays, for `retainEvents`.
        log.closeFile()
        const current = readManifest(manifestFile)
        if (current === undefined || current.pid === process.pid) {
          rmSync(manifestFile, { force: true })
          rmSync(socket, { force: true })
        }
      }
      process.once("exit", cleanup)
      yield* Effect.addFinalizer(() => Effect.sync(cleanup))

      // ---- connections ----
      const connections = new Set<NetSocket>()
      const services = yield* Effect.context<never>()
      const dropConnections = () => {
        Effect.runForkWith(services)(Effect.logInfo(`dropping ${connections.size} client connection(s)`))
        for (const connection of connections) connection.destroy()
      }
      // Internal, tests only: SIGUSR2 drops every client connection (the host keeps running).
      const onUsr2 = () => dropConnections()
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGUSR2", onUsr2)),
        () => Effect.sync(() => process.off("SIGUSR2", onUsr2)),
      )
      // Internal, tests only: drop them right before replying to the first call of each of these.
      const dropBeforeReply = new Set(spec.testDropBeforeReply ?? [])
      dropHookDelivery = () => {
        if (!dropBeforeReply.delete("HookRequest")) return false
        dropConnections()
        return true
      }
      const replyOrDrop = (rpc: string) =>
        Effect.ensuring(
          Effect.sync(() => {
            if (dropBeforeReply.delete(rpc)) dropConnections()
          }),
        )

      // ---- server ----
      const sessionClosed = yield* Deferred.make<void>()
      const once = makeOnce(yield* Effect.scope, defaults.requestResults)
      /** A span per call (the RPC server's own tracing is off: clients don't send trace context). */
      const traced = (rpc: string) => Effect.withSpan(`Host.${rpc}`, { attributes: { provider, sessionId } })
      const handlers = HostRpcs.toLayer({
        Info: () =>
          Effect.gen(function* () {
            const capabilities = yield* agent.capabilities
            const pid = yield* session.pid
            return {
              sessionId,
              provider,
              location: Option.getOrNull(session.location),
              pid: Option.getOrNull(pid),
              hostPid: process.pid,
              capabilities: { ...capabilities, reattach: true },
              lastSeq: log.lastSeq(),
              oldestSeq: log.oldest(),
              ended: log.ended() !== null,
            }
          }).pipe(traced("Info")),
        Subscribe: ({ fromSeq, live }) => log.subscribe(fromSeq, live),
        // `once`: a client that disconnects mid-call doesn't cut a provider call in half,
        // and one that retries it after reconnecting gets the first call's result.
        Send: ({ input, requestId }) =>
          once("Send", requestId, session.send(input).pipe(Effect.tap((id) => Effect.sync(() => log.sent(id))))).pipe(replyOrDrop("Send"), traced("Send")),
        Steer: ({ input, requestId }) =>
          once("Steer", requestId, session.steer(input).pipe(Effect.tap((o) => Effect.sync(() => log.sent(o.messageId))))).pipe(
            replyOrDrop("Steer"),
            traced("Steer"),
          ),
        // Deduped like `Send`: a retry after a reconnect must not interrupt a newer turn.
        Interrupt: ({ requestId }) => once("Interrupt", requestId, session.interrupt).pipe(replyOrDrop("Interrupt"), traced("Interrupt")),
        End: () => session.end.pipe(traced("End")),
        Stop: () => Deferred.succeed(shutdown, "stop").pipe(Effect.andThen(Deferred.await(sessionClosed)), traced("Stop")),
        // A retried `Turn` waits on the original turn.
        Turn: ({ input, requestId }) => once("Turn", requestId, session.turn(input)).pipe(replyOrDrop("Turn"), traced("Turn")),
        AwaitTurn: ({ turnId }) => log.awaitTurn(turnId).pipe(Effect.flatMap(settle), replyOrDrop("AwaitTurn"), traced("AwaitTurn")),
        AwaitMessage: ({ messageId }) => log.awaitMessage(messageId).pipe(Effect.flatMap(settle), replyOrDrop("AwaitMessage"), traced("AwaitMessage")),
        HookRequests: (answerer) => hookBridge.register(answerer),
        HookResponse: ({ hookId, result }) => hookBridge.respond(hookId, result),
        TestInvokeHook: ({ requestId, hook, call }) =>
          spec.testInvokeHook === true
            ? once("TestInvokeHook", requestId, hookBridge.call(hook, call).pipe(Effect.map(Option.getOrNull)))
            : Effect.fail(agentError("TestInvokeHook is for tests only")),
      })

      const serverContext = yield* Layer.build(NodeSocketServer.layer({ path: socket })).pipe(Effect.exit)
      if (Exit.isFailure(serverContext)) {
        const error = agentError(`cannot listen on ${socket}: ${describe(serverContext.cause)}`)
        yield* io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      // Track each connection's net.Socket, so they can be dropped.
      const server = Context.get(serverContext.value, SocketServer.SocketServer)
      const tracked = SocketServer.SocketServer.of({
        ...server,
        run: (handler) =>
          server.run((socket) =>
            Effect.flatMap(Effect.serviceOption(NodeSocket.NetSocket), (connection) => {
              if (Option.isNone(connection)) return handler(socket)
              connections.add(connection.value)
              return handler(socket).pipe(Effect.ensuring(Effect.sync(() => connections.delete(connection.value))))
            }),
          ),
      })
      const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
        Effect.provideService(SocketServer.SocketServer, tracked),
        Effect.provide(RpcSerialization.layerNdjson),
      )
      yield* RpcServer.make(HostRpcs, { concurrency: "unbounded", disableTracing: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(handlers),
        Effect.forkScoped,
      )
      const clients = Effect.map(protocol.clientIds, (ids) => ids.size)

      const manifest: Manifest = {
        sessionId,
        provider,
        socket,
        pid: process.pid,
        cwd: spec.run.cwd,
        startedAt: yield* DateTime.now,
      }
      writeFileSync(`${manifestFile}.tmp`, Schema.encodeSync(Schema.fromJsonString(Manifest))(manifest), { mode: 0o600 })
      renameSync(`${manifestFile}.tmp`, manifestFile)

      yield* io.ready({ _tag: "Ready", sessionId, socket, pid: process.pid })
      yield* Effect.logInfo(`serving on ${socket}`)

      // ---- orphan timeout ----
      const tick = Math.max(10, Math.min(1000, Math.floor(orphanTimeout / 4)))
      const orphaned = Effect.gen(function* () {
        if ((yield* clients) > 0 || log.busy()) {
          yield* log.touch
          return false
        }
        return (yield* Clock.currentTimeMillis) - log.lastActivity() >= orphanTimeout
      })
      yield* orphaned.pipe(
        Effect.repeat({ schedule: Schedule.spaced(Duration.millis(tick)), until: (orphan) => orphan }),
        Effect.andThen(Effect.logInfo(`orphaned: no client and idle for ${orphanTimeout} ms`)),
        Effect.andThen(Deferred.succeed(shutdown, "orphan")),
        Effect.forkScoped,
      )

      // ---- shutdown ----
      let closing = false
      /** Close the session and let its last events reach the log. Runs once. */
      const closeSession = (reason: Reason) =>
        Effect.gen(function* () {
          if (closing) return
          closing = true
          yield* Effect.logInfo(`shutting down: ${reason}`)
          if (reason === "orphan") {
            yield* session.end.pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.ignore)
          }
          yield* Scope.close(sessionScope, Exit.void)
          const drained = yield* Fiber.await(consumer).pipe(Effect.timeoutOption(Duration.seconds(5)))
          yield* hookBridge.close
          if (Option.isNone(drained)) yield* log.end(agentError("session closed"))
          else if (log.ended() === null) yield* log.end(null)
          yield* Deferred.succeed(sessionClosed, undefined)
        })
      // Interrupted (e.g. SIGTERM under `runMain`) rather than asked to stop: close the
      // session the same way. Added last, so it runs before the consumer is interrupted.
      yield* Effect.addFinalizer(() => closeSession("sigterm"))
      const reason = yield* Deferred.await(shutdown)
      yield* Effect.uninterruptible(closeSession(reason))

      // Linger so connected clients read the last events and replies; a
      // restarting client also gets a short window to reattach.
      if (reason === "ended" || reason === "stop") {
        // Until the clients that were connected have gone (or none came), at most `linger`.
        let hadClients = false
        yield* clients.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(25)),
            until: (n) => {
              if (n > 0) hadClients = true
              return n === 0 && hadClients
            },
          }),
          Effect.timeoutOption(Duration.millis(linger)),
        )
      }
      cleanup()
      yield* Effect.logInfo("exiting")
      return 0
    }),
  )
