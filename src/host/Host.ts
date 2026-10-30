/**
 * The host: runs ONE session with the real provider layers and serves it
 * over effect/rpc on a unix socket, numbering its events and appending them
 * to the session's events file (`EventFile.ts`), with the latest in a ring
 * buffer, so a client that reattaches (or reconnects) can catch up from any
 * seq. `Send` / `Steer` / `Turn` are answered once per client request id, so
 * a client may retry them after a reconnect. `main.ts` is the process entry
 * point; this module is the program.
 *
 * Lifecycle: the host exits after its session ends (`End`, `Stop`, the agent
 * dying, the orphan timeout, SIGTERM), lingering briefly on `End`/`Stop`/agent
 * death so connected clients get the last events. It removes its socket and
 * manifest on the way out; the events file stays for `retainEvents`.
 */
import { NodeSocket, NodeSocketServer } from "@effect/platform-node"
import { Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Scope, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { SocketServer } from "effect/socket"
import type { Socket as NetSocket } from "node:net"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { Agent, type AgentSession, type Hooks, type RunOptions } from "../Agent.ts"
import { AgentError, SessionNotFound, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnOutcome, TurnSucceeded } from "../AgentEvent.ts"
import * as EventFile from "./EventFile.ts"
import * as HookBridge from "./HookBridge.ts"
import {
  eventsPath,
  type HostSpec,
  Manifest,
  manifestPath,
  providerLayer,
  type ReadyLine,
  socketPath,
  toDuration,
  toRunOptions,
} from "./HostSpec.ts"
import { EventsTrimmed, HostRpcs, type SeqEvent } from "./protocol.ts"

export const defaults = {
  maxEvents: 50_000,
  orphanTimeout: Duration.minutes(30),
  linger: Duration.seconds(5),
  retainEvents: Duration.hours(24),
  /** Results of `Send` / `Steer` / `Turn` remembered by `requestId`. */
  requestResults: 1_000,
} as const

/** Prune expired events files in `dir` (those of live hosts are kept). */
export const pruneEvents = (dir: string, retainEvents: Duration.Duration): void =>
  EventFile.prune(dir, Duration.toMillis(retainEvents), (sessionId) => {
    const manifest = readManifest(manifestPath(dir, sessionId))
    return manifest !== undefined && isLive(manifest)
  })

/**
 * Run `effect` once per `requestId`: a repeated id (a client retrying after a
 * reconnect) waits for, and gets, the first run's result. The effect runs in
 * `scope`, not in the request, so a client that disconnects doesn't cut it
 * short. The last `limit` ids are remembered.
 */
export const makeOnce = (scope: Scope.Scope, limit: number) => {
  const results = new Map<string, Deferred.Deferred<unknown, unknown>>()
  return <A, E>(requestId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const existing = results.get(requestId) as Deferred.Deferred<A, E> | undefined
      if (existing !== undefined) return Deferred.await(existing)
      const result = Deferred.makeUnsafe<A, E>()
      results.set(requestId, result as Deferred.Deferred<unknown, unknown>)
      if (results.size > limit) results.delete(results.keys().next().value!)
      return effect.pipe(
        Effect.onExit((exit) => Deferred.done(result, exit)),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(result)),
      )
    })
}

export interface HostIO {
  /** Report readiness (or the open failure) to whoever started the host. Called once. */
  readonly ready: (line: ReadyLine) => void
  /** The session id is known (e.g. to name the log file). */
  readonly opened: (sessionId: string) => void
}

type Reason = "ended" | "stop" | "sigterm" | "orphan"

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Read a manifest file; undefined if missing or unreadable. */
export const readManifest = (path: string): Manifest | undefined => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

export const isLive = (manifest: Manifest): boolean => isAlive(manifest.pid)

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

const End = null

/**
 * The session's numbered events: the last `max` in memory (a ring buffer),
 * and, with `persist`, every one in the events file, written before it is
 * published. A subscription older than the ring reads the missing range from
 * the file, then continues from the ring and live events.
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
    let running: string | null = null
    let lastActivity = Date.now()
    const pubsub = yield* PubSub.unbounded<SeqEvent | typeof End>()
    const outcomes = new Map<string, TurnOutcome>()
    const waiters = new Map<string, Deferred.Deferred<TurnOutcome, AgentError>>()
    /** Messages sent through this host that haven't landed or been dropped. */
    const unlanded = new Set<string>()
    /** Where each message landed, or why it was dropped; and who is waiting to find out. */
    const landedIn = new Map<string, string>()
    const droppedMessages = new Map<string, string>()
    const messageWaiters = new Map<string, Deferred.Deferred<string, AgentError>>()

    const droppedError = (messageId: string, reason: string) =>
      new AgentError({ message: `message ${messageId} was ${reason} before it reached a turn`, provider })
    const neverLanded = (messageId: string) =>
      new AgentError({ message: `the session ended before message ${messageId} reached a turn`, provider })

    /** Keep the maps that `awaitTurn` / `awaitMessage` read up to date. */
    const index = (event: AgentEvent) => {
      switch (event._tag) {
        case "TurnStarted":
          running = event.turnId
          unlanded.delete(event.turnId)
          break
        case "MessageLanded": {
          unlanded.delete(event.messageId)
          landedIn.set(event.messageId, event.turnId)
          const waiter = messageWaiters.get(event.messageId)
          messageWaiters.delete(event.messageId)
          if (waiter !== undefined) Deferred.doneUnsafe(waiter, Exit.succeed(event.turnId))
          break
        }
        case "MessageDropped": {
          unlanded.delete(event.messageId)
          droppedMessages.set(event.messageId, event.reason)
          const waiter = messageWaiters.get(event.messageId)
          messageWaiters.delete(event.messageId)
          if (waiter !== undefined) Deferred.doneUnsafe(waiter, Exit.fail(droppedError(event.messageId, event.reason)))
          break
        }
        case "TurnEnded": {
          if (running === event.turnId) running = null
          outcomes.set(event.turnId, event.outcome)
          const waiter = waiters.get(event.turnId)
          waiters.delete(event.turnId)
          if (waiter !== undefined) Deferred.doneUnsafe(waiter, Exit.succeed(event.outcome))
          break
        }
      }
    }

    // A resumed session's earlier hosts may have left events: number on from them.
    let file: EventFile.Writer | null = null
    if (persist !== null) {
      file = EventFile.openWriter(persist.path, persist.resumed ? (entry) => index(entry.event) : null)
      next = file.next
      // Those hosts are gone: nothing of theirs is still running.
      running = null
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
      Effect.suspend(() => {
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
        lastActivity = Date.now()
        if (event._tag === "SessionStarted" && sessionStarted === null) sessionStarted = entry
        index(event)
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
        running = null
        for (const [turnId, waiter] of waiters) {
          Deferred.doneUnsafe(
            waiter,
            Exit.fail(error ?? new AgentError({ message: `the session ended before turn ${turnId} did`, provider })),
          )
        }
        waiters.clear()
        for (const [messageId, waiter] of messageWaiters) {
          Deferred.doneUnsafe(waiter, Exit.fail(error ?? neverLanded(messageId)))
        }
        messageWaiters.clear()
        return Effect.andThen(written, PubSub.publish(pubsub, End))
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

    const awaitTurn = (turnId: string): Effect.Effect<TurnOutcome, AgentError> =>
      Effect.suspend(() => {
        const outcome = outcomes.get(turnId)
        if (outcome !== undefined) return Effect.succeed(outcome)
        if (ended !== null) {
          return Effect.fail(ended.error ?? new AgentError({ message: `turn ${turnId} did not end in this session`, provider }))
        }
        let waiter = waiters.get(turnId)
        if (waiter === undefined) {
          waiter = Deferred.makeUnsafe<TurnOutcome, AgentError>()
          waiters.set(turnId, waiter)
        }
        return Deferred.await(waiter)
      })

    /** The ending of the turn a message landed in, found by the `MessageId` that `send` returned. */
    const awaitMessage = (messageId: string): Effect.Effect<TurnOutcome, AgentError> =>
      Effect.suspend(() => {
        const turnId = landedIn.get(messageId)
        if (turnId !== undefined) return awaitTurn(turnId)
        const reason = droppedMessages.get(messageId)
        if (reason !== undefined) return Effect.fail(droppedError(messageId, reason))
        if (ended !== null) return Effect.fail(ended.error ?? neverLanded(messageId))
        if (!unlanded.has(messageId)) {
          return Effect.fail(new AgentError({ message: `message ${messageId} was not sent through this host`, provider }))
        }
        let waiter = messageWaiters.get(messageId)
        if (waiter === undefined) {
          waiter = Deferred.makeUnsafe<string, AgentError>()
          messageWaiters.set(messageId, waiter)
        }
        return Deferred.await(waiter).pipe(Effect.flatMap(awaitTurn))
      })

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
      awaitTurn,
      awaitMessage,
      lastSeq: () => next - 1,
      oldest,
      ended: () => ended,
      /** Something is running or waiting to run. */
      busy: () => running !== null || unlanded.size > 0,
      lastActivity: () => lastActivity,
      touch: () => {
        lastActivity = Date.now()
      },
      sent: (messageId: string) => {
        unlanded.add(messageId)
      },
    }
  })

export type EventLog = Effect.Success<ReturnType<typeof makeLog>>

const settle = (outcome: TurnOutcome): Effect.Effect<TurnSucceeded, TurnFailure> =>
  outcome._tag === "Succeeded" ? Effect.succeed(outcome) : Effect.fail(outcome)

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Every hook kind, each going through `bridge` to an attached client that
 * has it. With none attached, `bridge` answers "nothing" at once, in-process.
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
      const agentError = (message: string, cause?: unknown) =>
        new AgentError({ message, provider, ...(cause !== undefined && { cause }) })

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
      const runOptions: RunOptions = { ...toRunOptions(spec.run), ...(hasHooks && { hooks: remoteHooks(hookBridge) }) }

      // ---- open ----
      const sessionScope = yield* Scope.make()
      const opened = yield* agent.open(runOptions).pipe(Scope.provide(sessionScope), Effect.exit)
      if (Exit.isFailure(opened)) {
        const failure = Cause.findErrorOption(opened.cause)
        const error =
          Option.isSome(failure) && (failure.value instanceof SessionNotFound || failure.value instanceof AgentError)
            ? failure.value
            : agentError(`open failed: ${describe(opened.cause)}`)
        yield* Effect.logError("open failed", error)
        io.ready({ _tag: "Failed", error })
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
        io.ready({ _tag: "Failed", error })
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
        io.ready({ _tag: "Failed", error })
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
                : Option.getOrElse(Cause.findErrorOption(exit.cause), () => agentError(`event stream failed: ${describe(exit.cause)}`)),
            ),
          ),
        ),
        Effect.andThen(Effect.logInfo("session ended")),
        Effect.andThen(Deferred.succeed(shutdown, "ended")),
        Effect.forkScoped,
      )

      if (Buffer.byteLength(socket) > 107) {
        const error = agentError(`socket path ${socket} is too long for a unix socket; use a shorter dir`)
        io.ready({ _tag: "Failed", error })
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
          }),
        Subscribe: ({ fromSeq, live }) => log.subscribe(fromSeq, live),
        // `once`: a client that disconnects mid-call doesn't cut a provider call in half,
        // and one that retries it after reconnecting gets the first call's result.
        Send: ({ input, requestId }) =>
          once(requestId, session.send(input).pipe(Effect.tap((id) => Effect.sync(() => log.sent(id))))).pipe(replyOrDrop("Send")),
        Steer: ({ input, requestId }) =>
          once(requestId, session.steer(input).pipe(Effect.tap((o) => Effect.sync(() => log.sent(o.messageId))))).pipe(
            replyOrDrop("Steer"),
          ),
        // Deduped like `Send`: a retry after a reconnect must not interrupt a newer turn.
        Interrupt: ({ requestId }) => once(requestId, session.interrupt).pipe(replyOrDrop("Interrupt")),
        End: () => session.end,
        Stop: () => Deferred.succeed(shutdown, "stop").pipe(Effect.andThen(Deferred.await(sessionClosed))),
        // A retried `Turn` waits on the original turn.
        Turn: ({ input, requestId }) => once(requestId, session.turn(input)).pipe(replyOrDrop("Turn")),
        AwaitTurn: ({ turnId }) => log.awaitTurn(turnId).pipe(Effect.flatMap(settle), replyOrDrop("AwaitTurn")),
        AwaitMessage: ({ messageId }) => log.awaitMessage(messageId).pipe(Effect.flatMap(settle), replyOrDrop("AwaitMessage")),
        HookRequests: (answerer) => hookBridge.register(answerer),
        HookResponse: ({ hookId, result }) => hookBridge.respond(hookId, result),
        TestInvokeHook: ({ requestId, hook, call }) =>
          spec.testInvokeHook === true
            ? once(requestId, hookBridge.call(hook, call).pipe(Effect.map(Option.getOrNull)))
            : Effect.fail(agentError("TestInvokeHook is for tests only")),
      })

      const serverContext = yield* Layer.build(NodeSocketServer.layer({ path: socket })).pipe(Effect.exit)
      if (Exit.isFailure(serverContext)) {
        const error = agentError(`cannot listen on ${socket}: ${describe(serverContext.cause)}`)
        io.ready({ _tag: "Failed", error })
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

      io.ready({ _tag: "Ready", sessionId, socket, pid: process.pid })
      yield* Effect.logInfo(`serving on ${socket}`)

      // ---- orphan timeout ----
      const tick = Math.max(10, Math.min(1000, Math.floor(orphanTimeout / 4)))
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(tick))
          if ((yield* clients) > 0 || log.busy()) log.touch()
          else if (Date.now() - log.lastActivity() >= orphanTimeout) {
            yield* Effect.logInfo(`orphaned: no client and idle for ${orphanTimeout} ms`)
            return yield* Deferred.succeed(shutdown, "orphan")
          }
        }
      }).pipe(Effect.forkScoped)

      // ---- shutdown ----
      const reason = yield* Deferred.await(shutdown)
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

      // Linger so connected clients read the last events and replies; a
      // restarting client also gets a short window to reattach.
      if (reason === "ended" || reason === "stop") {
        const deadline = Date.now() + linger
        let hadClients = (yield* clients) > 0
        while (Date.now() < deadline) {
          const n = yield* clients
          if (n > 0) hadClients = true
          else if (hadClients) break
          yield* Effect.sleep(Duration.millis(25))
        }
      }
      cleanup()
      yield* Effect.logInfo("exiting")
      return 0
    }),
  )
