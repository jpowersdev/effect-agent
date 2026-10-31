/**
 * A turn: the agent's work on a message, from `TurnStarted` to `TurnEnded`,
 * and how it ended. `AgentSession.turn` succeeds with `TurnSucceeded` or
 * fails with a `TurnFailure`, a Schema-described tagged error. The
 * `TurnEnded` event carries the same values in `outcome`, so a runner can
 * persist and replay them.
 *
 * @since 0.3.0
 */
import { Schema } from "effect"
import { LimitWindow } from "./UsageLimit.ts"

/**
 * @since 0.1.0
 * @category models
 */
export const TurnId = Schema.String.pipe(Schema.brand("effect-agent/TurnId"))

/**
 * @since 0.1.0
 * @category models
 */
export type TurnId = typeof TurnId.Type

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
 * The successful `TurnOutcome`.
 *
 * @since 0.1.0
 * @category models
 */
export const TurnSucceeded = Schema.TaggedStruct("Succeeded", {
  turnId: TurnId,
  finalText: Schema.String,
})

/**
 * @since 0.1.0
 * @category models
 */
export type TurnSucceeded = typeof TurnSucceeded.Type

/**
 * How a turn ended: `TurnSucceeded` or a `TurnFailure`.
 *
 * @since 0.1.0
 * @category models
 */
export const TurnOutcome = Schema.Union([TurnSucceeded, TurnFailure])

/**
 * @since 0.1.0
 * @category models
 */
export type TurnOutcome = typeof TurnOutcome.Type
