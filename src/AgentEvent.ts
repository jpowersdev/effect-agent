/**
 * The normalized event stream. Every event keeps the provider's original
 * frame in `raw` so it can be persisted as-is; anything not mapped comes
 * through as `Other`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { SessionId } from "./AgentSession.ts"
import { MessageId } from "./Message.ts"
import { TurnId, TurnOutcome } from "./Turn.ts"
import { Cost, TokenUsage } from "./Usage.ts"
import { LimitWindowStatus } from "./UsageLimit.ts"

const raw = Schema.Unknown

/**
 * @since 0.1.0
 * @category events
 */
export const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  sessionId: SessionId,
  provider: Schema.String,
  /** The agent tool's version, e.g. Claude Code `2.1.312`. */
  version: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  resumed: Schema.Boolean,
  raw,
})

/**
 * @since 0.1.0
 * @category events
 */
export const TurnStarted = Schema.TaggedStruct("TurnStarted", { turnId: TurnId, raw })

/**
 * A message from `send`, `steer` or `turn` was taken into a turn.
 *
 * @since 0.1.0
 * @category events
 */
export const MessageLanded = Schema.TaggedStruct("MessageLanded", {
  messageId: MessageId,
  turnId: TurnId,
  raw,
})

/**
 * The provider refused, cancelled or discarded a message before it reached a turn.
 *
 * @since 0.1.0
 * @category events
 */
export const MessageDropped = Schema.TaggedStruct("MessageDropped", {
  messageId: MessageId,
  reason: Schema.String,
  raw,
})

/**
 * A user message. Emitted by `history`; live sessions report their own messages as `MessageLanded`.
 *
 * @since 0.1.0
 * @category events
 */
export const UserMessage = Schema.TaggedStruct("UserMessage", {
  turnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
  text: Schema.String,
  raw,
})

/**
 * A complete block of assistant text.
 *
 * @since 0.1.0
 * @category events
 */
export const Text = Schema.TaggedStruct("Text", { turnId: Schema.NullOr(TurnId), text: Schema.String, raw })

/**
 * @since 0.1.0
 * @category events
 */
export const ToolCall = Schema.TaggedStruct("ToolCall", {
  turnId: Schema.NullOr(TurnId),
  callId: Schema.String,
  name: Schema.String,
  /** One line for humans, e.g. the shell command or the file being edited. */
  summary: Schema.String,
  input: Schema.Unknown,
  raw,
})

/**
 * The result of a `ToolCall` with the same `callId`.
 *
 * @since 0.1.0
 * @category events
 */
export const ToolResult = Schema.TaggedStruct("ToolResult", {
  turnId: Schema.NullOr(TurnId),
  callId: Schema.String,
  isError: Schema.Boolean,
  /** Text form of the output (may be truncated by the provider). */
  output: Schema.String,
  raw,
})

/**
 * The provider is retrying a failed request; not an error unless the turn later ends `Throttled`.
 *
 * @since 0.1.0
 * @category events
 */
export const Retrying = Schema.TaggedStruct("Retrying", {
  turnId: Schema.NullOr(TurnId),
  attempt: Schema.NullOr(Schema.Number),
  maxAttempts: Schema.NullOr(Schema.Number),
  delayMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
  raw,
})

/**
 * The provider reported new usage-limit window status.
 *
 * @since 0.1.0
 * @category events
 */
export const LimitsUpdated = Schema.TaggedStruct("LimitsUpdated", {
  windows: Schema.Array(LimitWindowStatus),
  raw,
})

/**
 * The provider compacted the session's context.
 *
 * @since 0.1.0
 * @category events
 */
export const Compacted = Schema.TaggedStruct("Compacted", {
  turnId: Schema.NullOr(TurnId),
  trigger: Schema.NullOr(Schema.Literals(["auto", "manual"])),
  raw,
})

/**
 * The agent is alive and working (thinking, streaming, tool progress) without a user-visible event.
 *
 * @since 0.1.0
 * @category events
 */
export const Heartbeat = Schema.TaggedStruct("Heartbeat", { turnId: Schema.NullOr(TurnId), raw })

/**
 * A provider frame with no normalized mapping.
 *
 * @since 0.1.0
 * @category events
 */
export const Other = Schema.TaggedStruct("Other", { raw })

/**
 * Terminal event for a turn. `usage` is this turn's; `cost` is cumulative for the session when known.
 *
 * @since 0.1.0
 * @category events
 */
export const TurnEnded = Schema.TaggedStruct("TurnEnded", {
  turnId: TurnId,
  outcome: TurnOutcome,
  usage: Schema.NullOr(TokenUsage),
  cost: Schema.NullOr(Cost),
  raw,
})

/**
 * Every event a session or `Agent.history` emits.
 *
 * @since 0.1.0
 * @category events
 */
export const AgentEvent = Schema.Union([
  SessionStarted,
  TurnStarted,
  MessageLanded,
  MessageDropped,
  UserMessage,
  Text,
  ToolCall,
  ToolResult,
  Retrying,
  LimitsUpdated,
  Compacted,
  Heartbeat,
  TurnEnded,
  Other,
])
/**
 * @since 0.1.0
 * @category events
 */
export type AgentEvent = typeof AgentEvent.Type
