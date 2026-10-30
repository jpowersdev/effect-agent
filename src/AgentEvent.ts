/**
 * The normalized event stream. Every event keeps the provider's original
 * frame in `raw` so it can be persisted as-is; anything not mapped comes
 * through as `Other`.
 */
import { Schema } from "effect"
import { TurnFailure } from "./AgentError.ts"
import { Cost, LimitWindowStatus, MessageId, SessionId, TokenUsage, TurnId } from "./Domain.ts"

const raw = Schema.Unknown

export const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  sessionId: SessionId,
  provider: Schema.String,
  /** The agent tool's version, e.g. Claude Code `2.1.312`. */
  version: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  resumed: Schema.Boolean,
  raw,
})

export const TurnStarted = Schema.TaggedStruct("TurnStarted", { turnId: TurnId, raw })

/** A message from `send`, `steer` or `turn` was taken into a turn. */
export const MessageLanded = Schema.TaggedStruct("MessageLanded", {
  messageId: MessageId,
  turnId: TurnId,
  raw,
})

/** The provider refused, cancelled or discarded a message before it reached a turn. */
export const MessageDropped = Schema.TaggedStruct("MessageDropped", {
  messageId: MessageId,
  reason: Schema.String,
  raw,
})

/** A user message. Emitted by `history`; live sessions report their own messages as `MessageLanded`. */
export const UserMessage = Schema.TaggedStruct("UserMessage", {
  turnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
  text: Schema.String,
  raw,
})

/** A complete block of assistant text. */
export const Text = Schema.TaggedStruct("Text", { turnId: Schema.NullOr(TurnId), text: Schema.String, raw })

export const ToolCall = Schema.TaggedStruct("ToolCall", {
  turnId: Schema.NullOr(TurnId),
  callId: Schema.String,
  name: Schema.String,
  /** One line for humans, e.g. the shell command or the file being edited. */
  summary: Schema.String,
  input: Schema.Unknown,
  raw,
})

export const ToolResult = Schema.TaggedStruct("ToolResult", {
  turnId: Schema.NullOr(TurnId),
  callId: Schema.String,
  isError: Schema.Boolean,
  /** Text form of the output (may be truncated by the provider). */
  output: Schema.String,
  raw,
})

/** The provider is retrying a failed request; not an error unless the turn later ends `Throttled`. */
export const Retrying = Schema.TaggedStruct("Retrying", {
  turnId: Schema.NullOr(TurnId),
  attempt: Schema.NullOr(Schema.Number),
  maxAttempts: Schema.NullOr(Schema.Number),
  delayMs: Schema.NullOr(Schema.Number),
  message: Schema.String,
  raw,
})

export const LimitsUpdated = Schema.TaggedStruct("LimitsUpdated", {
  windows: Schema.Array(LimitWindowStatus),
  raw,
})

export const Compacted = Schema.TaggedStruct("Compacted", {
  turnId: Schema.NullOr(TurnId),
  trigger: Schema.NullOr(Schema.Literals(["auto", "manual"])),
  raw,
})

/** The agent is alive and working (thinking, streaming, tool progress) without a user-visible event. */
export const Heartbeat = Schema.TaggedStruct("Heartbeat", { turnId: Schema.NullOr(TurnId), raw })

export const TurnSucceeded = Schema.TaggedStruct("Succeeded", {
  turnId: TurnId,
  finalText: Schema.String,
})
export type TurnSucceeded = typeof TurnSucceeded.Type

export const Other = Schema.TaggedStruct("Other", { raw })

export const TurnOutcome = Schema.Union([TurnSucceeded, TurnFailure])
export type TurnOutcome = typeof TurnOutcome.Type

/** Terminal event for a turn. `usage` is this turn's; `cost` is cumulative for the session when known. */
export const TurnEnded = Schema.TaggedStruct("TurnEnded", {
  turnId: TurnId,
  outcome: TurnOutcome,
  usage: Schema.NullOr(TokenUsage),
  cost: Schema.NullOr(Cost),
  raw,
})

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
export type AgentEvent = typeof AgentEvent.Type
