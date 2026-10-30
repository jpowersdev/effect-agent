/**
 * The host: runs ONE session with the real provider layers and serves it
 * over effect/rpc on a unix socket, keeping its events in a numbered ring
 * buffer so a client that reattaches can catch up. `main.ts` is the process
 * entry point; this module is the program.
 *
 * Lifecycle: the host exits after its session ends (`End`, `Stop`, the agent
 * dying, the orphan timeout, SIGTERM), lingering briefly on `End`/`Stop`/agent
 * death so connected clients get the last events. It removes its socket and
 * manifest on the way out.
 */
import { NodeSocketServer } from "@effect/platform-node"
import { Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Scope, Stream } from "effect"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { Agent, type AgentSession } from "../Agent.ts"
import { AgentError, SessionNotFound, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnOutcome, TurnSucceeded } from "../AgentEvent.ts"
import {
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
} as const

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

export const makeLog = (max: number, provider: string) =>
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

    const oldest = () => Math.max(0, next - max)

    const append = (event: AgentEvent) =>
      Effect.suspend(() => {
        const entry: SeqEvent = { seq: next++, event }
        buffer[entry.seq % max] = entry
        lastActivity = Date.now()
        switch (event._tag) {
          case "SessionStarted":
            if (sessionStarted === null) sessionStarted = entry
            break
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
        return PubSub.publish(pubsub, entry)
      })

    const end = (error: AgentError | null) =>
      Effect.suspend(() => {
        if (ended !== null) return Effect.void
        ended = { error }
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
        return PubSub.publish(pubsub, End)
      })

    const tail = Stream.suspend(() => (ended?.error ? Stream.fail(ended.error) : Stream.empty))

    const subscribe = (fromSeq: number, live: boolean): Stream.Stream<SeqEvent, EventsTrimmed | AgentError> =>
      Stream.unwrap(
        Effect.gen(function* (): Effect.fn.Return<Stream.Stream<SeqEvent, EventsTrimmed | AgentError>, never, Scope.Scope> {
          const from = Math.max(0, Math.floor(fromSeq))
          if (from < oldest()) {
            return Stream.fail(
              new EventsTrimmed({
                message: `events before ${oldest()} are no longer kept (asked for ${from})`,
                requested: from,
                oldest: oldest(),
              }),
            )
          }
          const subscription = ended === null ? yield* PubSub.subscribe(pubsub) : null
          const last = next - 1
          const snapshot: Array<SeqEvent> = []
          for (let seq = from; seq <= last; seq++) snapshot.push(buffer[seq % max]!)
          const prefix = live && sessionStarted !== null && sessionStarted.seq < from ? [sessionStarted] : []
          if (subscription === null) return Stream.concat(Stream.fromIterable([...prefix, ...snapshot]), tail)
          const rest = Stream.fromSubscription(subscription).pipe(
            Stream.takeWhile((item): item is SeqEvent => item !== End),
            // Appended between subscribing and taking the snapshot: already in it.
            Stream.filter((entry) => entry.seq > last && entry.seq >= from),
          )
          return Stream.concat(Stream.fromIterable([...prefix, ...snapshot]), rest).pipe(Stream.concat(tail))
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

    const droppedError = (messageId: string, reason: string) =>
      new AgentError({ message: `message ${messageId} was ${reason} before it reached a turn`, provider })
    const neverLanded = (messageId: string) =>
      new AgentError({ message: `the session ended before message ${messageId} reached a turn`, provider })

    return {
      append,
      end,
      subscribe,
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
      const agentError = (message: string, cause?: unknown) =>
        new AgentError({ message, provider, ...(cause !== undefined && { cause }) })

      const agent = Context.get(yield* Layer.build(providerLayer(spec)), Agent)

      // ---- open ----
      const sessionScope = yield* Scope.make()
      const opened = yield* agent.open(toRunOptions(spec.run)).pipe(Scope.provide(sessionScope), Effect.exit)
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

      // ---- event log: subscribe before anything can be sent ----
      const log = yield* makeLog(maxEvents, provider)
      const events = yield* session.subscribe
      const consumer = yield* events.pipe(
        Stream.runForEach(log.append),
        Effect.exit,
        Effect.flatMap((exit) =>
          log.end(
            Exit.isSuccess(exit)
              ? null
              : Option.getOrElse(Cause.findErrorOption(exit.cause), () => agentError(`event stream failed: ${describe(exit.cause)}`)),
          ),
        ),
        Effect.andThen(Effect.logInfo("session ended")),
        Effect.andThen(Deferred.succeed(shutdown, "ended")),
        Effect.forkScoped,
      )

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
      if (Buffer.byteLength(socket) > 107) {
        const error = agentError(`socket path ${socket} is too long for a unix socket; use a shorter dir`)
        io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      rmSync(socket, { force: true })
      const cleanup = () => {
        const current = readManifest(manifestFile)
        if (current === undefined || current.pid === process.pid) {
          rmSync(manifestFile, { force: true })
          rmSync(socket, { force: true })
        }
      }
      process.once("exit", cleanup)
      yield* Effect.addFinalizer(() => Effect.sync(cleanup))

      // ---- server ----
      const sessionClosed = yield* Deferred.make<void>()
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
              capabilities: { ...capabilities, reattach: true, hooks: false },
              lastSeq: log.lastSeq(),
              oldestSeq: log.oldest(),
              ended: log.ended() !== null,
            }
          }),
        Subscribe: ({ fromSeq, live }) => log.subscribe(fromSeq, live),
        // Uninterruptible: a client that disconnects mid-call must not cut a provider
        // call in half; the turn goes on either way (as when a local `turn` is interrupted).
        Send: ({ input }) => session.send(input).pipe(Effect.tap((id) => Effect.sync(() => log.sent(id))), Effect.uninterruptible),
        Steer: ({ input }) =>
          session.steer(input).pipe(Effect.tap((o) => Effect.sync(() => log.sent(o.messageId))), Effect.uninterruptible),
        Interrupt: () => session.interrupt,
        End: () => session.end,
        Stop: () => Deferred.succeed(shutdown, "stop").pipe(Effect.andThen(Deferred.await(sessionClosed))),
        Turn: ({ input }) => Effect.uninterruptible(session.turn(input)),
        AwaitTurn: ({ turnId }) => log.awaitTurn(turnId).pipe(Effect.flatMap(settle)),
        AwaitMessage: ({ messageId }) => log.awaitMessage(messageId).pipe(Effect.flatMap(settle)),
      })

      const serverContext = yield* Layer.build(NodeSocketServer.layer({ path: socket })).pipe(Effect.exit)
      if (Exit.isFailure(serverContext)) {
        const error = agentError(`cannot listen on ${socket}: ${describe(serverContext.cause)}`)
        io.ready({ _tag: "Failed", error })
        yield* Scope.close(sessionScope, Exit.void)
        return 1
      }
      const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
        Effect.provideContext(serverContext.value),
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
