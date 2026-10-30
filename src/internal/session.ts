/**
 * The provider-neutral part of a live session: the event fan-out, where
 * messages landed and how turns ended, and the watchdog. A provider folds its
 * transport's frames into events and `emit`s them; `end` settles everyone
 * still waiting.
 *
 * @internal
 */
import { Duration, Effect, type Scope, type Stream } from "effect"
import { randomUUID } from "node:crypto"
import type { RunOptions } from "../Agent.ts"
import { AgentError, SessionClosed } from "../AgentError.ts"
import type { AgentEvent } from "../AgentEvent.ts"
import { MessageId } from "../Domain.ts"
import * as Watchdog from "../Watchdog.ts"
import * as EventHub from "./eventHub.ts"
import * as TurnTracker from "./turnTracker.ts"

/**
 * An `AgentError` from `provider`.
 *
 * @internal
 */
export const agentError =
  (provider: string) =>
  (message: string, cause?: unknown): AgentError =>
    new AgentError({ message, provider, ...(cause !== undefined && { cause }) })

/**
 * A `SessionClosed` from `provider`.
 *
 * @internal
 */
export const sessionClosed =
  (provider: string) =>
  (message: string): SessionClosed =>
    new SessionClosed({ message, provider })

/**
 * A fresh client-side `MessageId`.
 *
 * @internal
 */
export const newMessageId = (): MessageId => MessageId.make(randomUUID())

/**
 * How long a request to an agent process (an RPC, a status read) may take.
 *
 * @internal
 */
export const requestTimeout = Duration.seconds(60)

/**
 * `self`, failing with an `AgentError` after `requestTimeout`.
 *
 * @internal
 */
export const timed =
  (provider: string) =>
  <A, E, R>(what: string, self: Effect.Effect<A, E, R>): Effect.Effect<A, E | AgentError, R> =>
    self.pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () => Effect.fail(agentError(provider)(`${what}: no answer within ${Duration.format(requestTimeout)}`)),
      }),
    )

/**
 * Default for `RunOptions.watchdog.grace`.
 *
 * @internal
 */
export const defaultStallGrace = Duration.seconds(10)

/** @internal */
export interface SessionRuntime {
  readonly turns: TurnTracker.TurnTracker
  /** Publish an event (fed to the watchdog and the turn tracker first). */
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
  readonly emitAll: (events: Iterable<AgentEvent>) => Effect.Effect<void>
  /**
   * The session ended (null: cleanly): subscriptions end, and waiters fail
   * (with `waiters`, if given, else `error`). Only the first call counts.
   */
  readonly end: (error: AgentError | null, waiters?: AgentError | SessionClosed) => Effect.Effect<void>
  readonly ended: () => { readonly error: AgentError | null } | null
  readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent, AgentError>, never, Scope.Scope>
  /** Stop stalled turns (`Watchdog.supervise`), when `RunOptions.watchdog` asks for it. */
  readonly supervise: (supervisor: Omit<Watchdog.Supervisor, "grace" | "turnEnded">) => Effect.Effect<void, never, Scope.Scope>
}

/** @internal */
export const make = Effect.fnUntraced(function* (options: {
  readonly provider: string
  readonly watchdog: RunOptions["watchdog"]
  /** The provider layer's default for `watchdog.grace`. */
  readonly stallGrace?: Duration.Input | undefined
}) {
  const hub = yield* EventHub.make
  const turns = TurnTracker.make({ provider: options.provider })
  const watchdog = options.watchdog !== undefined ? yield* Watchdog.make(options.watchdog) : null

  const emit = (event: AgentEvent) =>
    Effect.suspend(() => {
      const published = hub.publish(event).pipe(
        // Published first, so a subscriber has the event before a waiter on it resumes.
        Effect.andThen(Effect.sync(() => turns.observe(event))),
      )
      return watchdog === null ? published : Effect.andThen(watchdog.observe(event), published)
    })

  const end = (error: AgentError | null, waiters?: AgentError | SessionClosed) =>
    Effect.suspend(() => {
      turns.end(waiters ?? error)
      return hub.end(error)
    })

  const supervise = (supervisor: Omit<Watchdog.Supervisor, "grace" | "turnEnded">) =>
    watchdog === null
      ? Effect.void
      : Watchdog.supervise(watchdog, {
          ...supervisor,
          grace: options.watchdog?.grace ?? options.stallGrace ?? defaultStallGrace,
          turnEnded: turns.outcome,
        })

  const runtime: SessionRuntime = {
    turns,
    emit,
    emitAll: (events) => Effect.forEach(events, emit, { discard: true }),
    end,
    ended: hub.ended,
    subscribe: hub.subscribe,
    supervise,
  }
  return runtime
})
