/**
 * An infrastructure or protocol failure, for anything without a more
 * specific error. How a turn ends is in `Turn`, and why a session can't take
 * a call is in `AgentSession`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

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
