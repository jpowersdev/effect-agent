/**
 * How a turn can end, as Schema-described tagged errors. `AgentSession.turn`
 * fails with `TurnFailure`; the `TurnEnded` event carries the same values in
 * `outcome`, so a runner can persist and replay them.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { LimitWindow, SessionId } from "./Domain.ts"

/**
 * The agent's own failure: model/API error, a failed tool loop, max turns, and so on.
 *
 * @since 0.1.0
 * @category errors
 */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()("AgentFailed", {
  message: Schema.String,
  /** Provider's own classification (e.g. Claude `terminal_reason`, Codex `codexErrorInfo`). */
  kind: Schema.NullOr(Schema.String),
}) {}

/**
 * A subscription usage limit stopped the turn.
 *
 * @since 0.1.0
 * @category errors
 */
export class UsageLimited extends Schema.TaggedError<UsageLimited>()("UsageLimited", {
  message: Schema.String,
  window: LimitWindow,
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  /** Whether paid overage or credits could have kept it going; null when the provider doesn't say. */
  overageAvailable: Schema.NullOr(Schema.Boolean),
}) {}

/**
 * Throttled or overloaded, and the provider gave up retrying. Retries in progress are `Retrying` events.
 *
 * @since 0.1.0
 * @category errors
 */
export class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {
  message: Schema.String,
  retriesLeft: Schema.NullOr(Schema.Number),
}) {}

/**
 * @since 0.1.0
 * @category errors
 */
export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  message: Schema.String,
}) {}

/**
 * The run's spend cap was reached. `estimated` when the cost is computed from tokens (Codex).
 *
 * @since 0.1.0
 * @category errors
 */
export class SpendCapReached extends Schema.TaggedError<SpendCapReached>()("SpendCapReached", {
  message: Schema.String,
  /** Null when the provider enforced its own budget without saying what it was. */
  capUsd: Schema.NullOr(Schema.Number),
  spentUsd: Schema.NullOr(Schema.Number),
  estimated: Schema.Boolean,
}) {}

/**
 * @since 0.1.0
 * @category errors
 */
export class ContextExhausted extends Schema.TaggedError<ContextExhausted>()("ContextExhausted", {
  message: Schema.String,
}) {}

/**
 * The agent process died (signal, OOM killer, crash) rather than ending the turn itself.
 *
 * @since 0.1.0
 * @category errors
 */
export class ProcessKilled extends Schema.TaggedError<ProcessKilled>()("ProcessKilled", {
  message: Schema.String,
  signal: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
}) {}

/**
 * No events for longer than `RunOptions.watchdog` allows, so the turn was stopped.
 *
 * @since 0.1.0
 * @category errors
 */
export class Stalled extends Schema.TaggedError<Stalled>()("Stalled", {
  message: Schema.String,
  idleMs: Schema.Number,
  /** Whether a tool call was running (so `toolIdle` applied). */
  inTool: Schema.Boolean,
}) {}

/**
 * The caller interrupted the turn.
 *
 * @since 0.1.0
 * @category errors
 */
export class Interrupted extends Schema.TaggedError<Interrupted>()("Interrupted", {
  message: Schema.String,
}) {}

/**
 * Every way a turn can fail: the error of `AgentSession.turn`, and the failed `TurnEnded` outcomes.
 *
 * @since 0.1.0
 * @category errors
 */
export const TurnFailure = Schema.Union([
  AgentFailed,
  UsageLimited,
  Throttled,
  AuthFailed,
  SpendCapReached,
  ContextExhausted,
  ProcessKilled,
  Stalled,
  Interrupted,
])
/**
 * @since 0.1.0
 * @category errors
 */
export type TurnFailure = typeof TurnFailure.Type

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
 * Infrastructure or protocol failure: couldn't spawn, unexpected frame, transport closed, and so on.
 *
 * @since 0.1.0
 * @category errors
 */
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  provider: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The session can't take this call: it has ended (`end`, its Scope closed,
 * or the agent process died, which `message` then says) or, for a remote
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
 * Lost the connection to the process running the session (a `RemoteAgent`
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
