/**
 * A session: one agent process working in one directory, from `Agent.open`.
 * It stays open until its Scope closes. Its calls fail with `SessionError`.
 *
 * @since 0.3.0
 */
import { Effect, Option, Schema, Scope, Stream } from "effect"
import { AgentError } from "./AgentError.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import type { Input, MessageId, SteerOutcome } from "./Message.ts"
import type { TurnFailure, TurnSucceeded } from "./Turn.ts"

/**
 * The provider's id for a session, used to resume it.
 *
 * @since 0.1.0
 * @category models
 */
export const SessionId = Schema.String.pipe(Schema.brand("effect-agent/SessionId"))

/**
 * @since 0.1.0
 * @category models
 */
export type SessionId = typeof SessionId.Type

/**
 * An open session, from `Agent.open`. Calls fail with `SessionClosed` once
 * the session has ended, with `ConnectionLost` when a detached session's host
 * can't be reached, and with `AgentError` for anything else.
 *
 * @since 0.1.0
 * @category models
 */
export interface AgentSession {
  readonly sessionId: SessionId
  readonly provider: string
  /** Where the provider stores this session (a transcript file), when known. */
  readonly location: Option.Option<string>
  /** The agent process's pid (the wrapped command's, if a `Launcher` wraps it). */
  readonly pid: Effect.Effect<Option.Option<number>>
  /**
   * Subscribe now; the returned stream holds every event from this point on,
   * starting with the session's `SessionStarted` once it is known. Use this
   * (then fork the stream) when you must not miss events after a `send`.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent, SessionError>, never, Scope.Scope>
  /** `subscribe`, deferred until the stream runs. Events sent before it runs are missed. */
  readonly events: Stream.Stream<AgentEvent, SessionError>
  /** Start a turn now if idle, otherwise after the running turn. */
  readonly send: (input: Input) => Effect.Effect<MessageId, SessionError>
  /** `send`, then wait for that message's turn to end. */
  readonly turn: (input: Input) => Effect.Effect<TurnSucceeded, TurnFailure | SessionError>
  /** Deliver into the running turn at its next tool boundary; starts a new turn if none is running. */
  readonly steer: (input: Input) => Effect.Effect<SteerOutcome, SessionError>
  /** Stop the running turn (it ends `Interrupted`); the session stays usable. */
  readonly interrupt: Effect.Effect<void, SessionError>
  /**
   * No more input: let queued work finish, then end the session. On a
   * session that already ended, succeeds if it ended cleanly and fails with
   * what ended it otherwise.
   */
  readonly end: Effect.Effect<void, SessionError>
}

/**
 * Resuming a session that the provider has no record of.
 *
 * @since 0.1.0
 * @category errors
 */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  message: Schema.String,
  sessionId: SessionId,
}) {}

/**
 * The session can't take this call: it has ended (`end`, its Scope closed,
 * or the agent process died, which `message` then says) or, for a detached
 * session, this handle was detached.
 *
 * @since 0.2.0
 * @category errors
 */
export class SessionClosed extends Schema.TaggedError<SessionClosed>()("SessionClosed", {
  message: Schema.String,
  provider: Schema.String,
}) {}

/**
 * Lost the connection to the process running the session (a `DetachedAgent`
 * host) and could not get it back. The session itself may still be running:
 * `AgentHosts.attach` it again.
 *
 * @since 0.2.0
 * @category errors
 */
export class ConnectionLost extends Schema.TaggedError<ConnectionLost>()("ConnectionLost", {
  message: Schema.String,
  provider: Schema.String,
}) {}

/**
 * How an `AgentSession` call can fail, besides a turn's own `TurnFailure`.
 *
 * @since 0.2.0
 * @category errors
 */
export const SessionError = Schema.Union([AgentError, SessionClosed, ConnectionLost])

/**
 * @since 0.2.0
 * @category errors
 */
export type SessionError = typeof SessionError.Type
