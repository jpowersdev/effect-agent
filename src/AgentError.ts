/**
 * How a turn can end, as Schema-described tagged errors. `AgentSession.turn`
 * fails with `TurnFailure`; the `TurnEnded` event carries the same values in
 * `outcome`, so a runner can persist and replay them.
 */
import { Schema } from "effect"
import { LimitWindow, SessionId } from "./Domain.ts"

/** The agent's own failure: model/API error, a failed tool loop, max turns, and so on. */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()("AgentFailed", {
  message: Schema.String,
  /** Provider's own classification (e.g. Claude `terminal_reason`, Codex `codexErrorInfo`). */
  kind: Schema.NullOr(Schema.String),
}) {}

/** A subscription usage limit stopped the turn. */
export class UsageLimited extends Schema.TaggedError<UsageLimited>()("UsageLimited", {
  message: Schema.String,
  window: LimitWindow,
  resetsAt: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  /** Whether paid overage or credits could have kept it going; null when the provider doesn't say. */
  overageAvailable: Schema.NullOr(Schema.Boolean),
}) {}

/** Throttled or overloaded, and the provider gave up retrying. Retries in progress are `Retrying` events. */
export class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {
  message: Schema.String,
  retriesLeft: Schema.NullOr(Schema.Number),
}) {}

export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  message: Schema.String,
}) {}

/** The run's spend cap was reached. `estimated` when the cost is computed from tokens (Codex). */
export class SpendCapReached extends Schema.TaggedError<SpendCapReached>()("SpendCapReached", {
  message: Schema.String,
  /** Null when the provider enforced its own budget without saying what it was. */
  capUsd: Schema.NullOr(Schema.Number),
  spentUsd: Schema.NullOr(Schema.Number),
  estimated: Schema.Boolean,
}) {}

export class ContextExhausted extends Schema.TaggedError<ContextExhausted>()("ContextExhausted", {
  message: Schema.String,
}) {}

/** The agent process died (signal, OOM killer, crash) rather than ending the turn itself. */
export class ProcessKilled extends Schema.TaggedError<ProcessKilled>()("ProcessKilled", {
  message: Schema.String,
  signal: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
}) {}

/** No events for longer than `RunOptions.watchdog` allows, so the turn was stopped. */
export class Stalled extends Schema.TaggedError<Stalled>()("Stalled", {
  message: Schema.String,
  idleMs: Schema.Number,
  /** Whether a tool call was running (so `toolIdle` applied). */
  inTool: Schema.Boolean,
}) {}

/** The caller interrupted the turn. */
export class Interrupted extends Schema.TaggedError<Interrupted>()("Interrupted", {
  message: Schema.String,
}) {}

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
export type TurnFailure = typeof TurnFailure.Type

/** Resuming a session that the provider has no record of. */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  message: Schema.String,
  sessionId: SessionId,
}) {}

/** Infrastructure or protocol failure: couldn't spawn, unexpected frame, transport closed, and so on. */
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  provider: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
