/**
 * The RPC group a host serves over its unix socket (effect/rpc, NDJSON).
 * Every payload, result and error is a Schema, so typed failures
 * (`TurnFailure` members, `AgentError`, `EventsTrimmed`) arrive as the same
 * classes on the client.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Capabilities, SteerOutcome } from "../Agent.ts"
import { AgentError, TurnFailure } from "../AgentError.ts"
import { AgentEvent, TurnSucceeded } from "../AgentEvent.ts"
import { MessageId, SessionId, TurnId } from "../Domain.ts"

/** `subscribeFrom` asked for events the host no longer keeps (see `HostSpec.maxEvents`). */
export class EventsTrimmed extends Schema.TaggedError<EventsTrimmed>()("EventsTrimmed", {
  message: Schema.String,
  /** The `fromSeq` asked for. */
  requested: Schema.Number,
  /** The oldest sequence number still kept. */
  oldest: Schema.Number,
}) {}

/** An event and its position in the session's log (0, 1, 2, ...). */
export const SeqEvent = Schema.Struct({ seq: Schema.Number, event: AgentEvent })
export type SeqEvent = typeof SeqEvent.Type

export const HostInfo = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  location: Schema.NullOr(Schema.String),
  /** The agent process's pid, when it has one. */
  pid: Schema.NullOr(Schema.Number),
  /** The host process's pid. */
  hostPid: Schema.Number,
  capabilities: Capabilities,
  /** The last event's sequence number; -1 before the first event. */
  lastSeq: Schema.Number,
  /** The oldest sequence number still kept. */
  oldestSeq: Schema.Number,
  /** The session has ended (the host is about to exit). */
  ended: Schema.Boolean,
})
export type HostInfo = typeof HostInfo.Type

const Input = { input: Schema.String }
const TurnError = Schema.Union([TurnFailure, AgentError])

export class HostRpcs extends RpcGroup.make(
  Rpc.make("Info", { success: HostInfo, error: AgentError }),
  /**
   * Events with `seq >= fromSeq`, then live ones, until the session ends
   * (failing with the session's `AgentError` if it ended in one). `live`
   * prepends the session's `SessionStarted` when it is older than `fromSeq`,
   * as `AgentSession.subscribe` does (`RemoteSession.subscribe` pins `fromSeq`
   * to `Info.lastSeq + 1`, and sets `live` unless the session had ended).
   */
  Rpc.make("Subscribe", {
    payload: { fromSeq: Schema.Number, live: Schema.Boolean },
    success: SeqEvent,
    error: Schema.Union([EventsTrimmed, AgentError]),
    stream: true,
  }),
  Rpc.make("Send", { payload: Input, success: MessageId, error: AgentError }),
  Rpc.make("Steer", { payload: Input, success: SteerOutcome, error: AgentError }),
  Rpc.make("Interrupt", { error: AgentError }),
  /** Graceful: finish queued work, end the session; the host then exits. */
  Rpc.make("End", { error: AgentError }),
  /** Hard: close the session now (killing its processes); the host then exits. */
  Rpc.make("Stop"),
  Rpc.make("Turn", { payload: Input, success: TurnSucceeded, error: TurnError }),
  /** A turn's ending: from the log if it already ended, otherwise when it does. */
  Rpc.make("AwaitTurn", { payload: { turnId: TurnId }, success: TurnSucceeded, error: TurnError }),
  /** The ending of the turn a message landed in, by the `MessageId` that `Send` returned. */
  Rpc.make("AwaitMessage", { payload: { messageId: MessageId }, success: TurnSucceeded, error: TurnError }),
) {}
