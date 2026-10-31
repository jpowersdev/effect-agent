/**
 * A message: input you give a session, identified by a `MessageId`. It lands
 * in a turn, or is dropped.
 *
 * @since 0.3.0
 */
import { Schema } from "effect"
import { TurnId } from "./Turn.ts"

/**
 * Client-assigned id for a message passed to `send`, `steer` or `turn`.
 *
 * @since 0.1.0
 * @category models
 */
export const MessageId = Schema.String.pipe(Schema.brand("effect-agent/MessageId"))

/**
 * @since 0.1.0
 * @category models
 */
export type MessageId = typeof MessageId.Type

/**
 * Message content. Text only for now.
 *
 * @since 0.1.0
 * @category models
 */
export type Input = string

/**
 * Where a `steer` message went.
 *
 * @since 0.1.0
 * @category models
 */
export const SteerOutcome = Schema.Union([
  /** Landed in the turn that was running when `steer` was called. */
  Schema.TaggedStruct("Landed", { messageId: MessageId, turnId: TurnId }),
  /** That turn ended first, so the message started a new one. */
  Schema.TaggedStruct("StartedNewTurn", { messageId: MessageId, turnId: TurnId }),
])

/**
 * @since 0.1.0
 * @category models
 */
export type SteerOutcome = typeof SteerOutcome.Type
