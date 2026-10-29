/**
 * Provider-neutral coding agent. Each provider module exports a `layer` that
 * provides `Agent`:
 *
 *   import * as ClaudeAgent from "effect-agent/claude"
 *   program.pipe(Effect.provide(ClaudeAgent.layer()))
 *
 * A session is a scoped resource: closing its Scope stops the agent process.
 */
import { Context, Effect, Option, Schema, Scope, Stream } from "effect"
import type { AgentError, SessionNotFound, TurnFailure } from "./AgentError.ts"
import type { AgentEvent, TurnSucceeded } from "./AgentEvent.ts"
import { MessageId, type SessionId, TurnId } from "./Domain.ts"

export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"])
export type Effort = typeof Effort.Type

export interface RunOptions {
  readonly cwd: string
  /**
   * Applied over the host environment. `undefined` removes a variable.
   * Host markers that make an agent think it is nested (e.g. `CLAUDECODE`)
   * are always removed.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly model?: string
  readonly effort?: Effort
  /** Added to the provider's default system prompt; never replaces it. */
  readonly appendSystemPrompt?: string
  readonly disable?: {
    /** The agent's ask-the-user tool (Claude `AskUserQuestion`). */
    readonly askUser?: boolean
    /** Subagent tools (Claude `Agent`/`Task`, Codex multi-agent). */
    readonly subagents?: boolean
    /** Provider-native tool names. */
    readonly tools?: ReadonlyArray<string>
  }
  /** Spend cap in USD. Native for Claude; estimated from tokens for Codex. */
  readonly spendCapUsd?: number
  /** Resume an existing session; fails with `SessionNotFound` if the provider has no record of it. */
  readonly resume?: SessionId
}

/** Message content. Text only for now. */
export type Input = string

export const Capabilities = Schema.Struct({
  provider: Schema.String,
  /** The agent tool's version, when known without a turn. */
  version: Schema.NullOr(Schema.String),
  steer: Schema.Boolean,
  queue: Schema.Boolean,
  resume: Schema.Boolean,
  cost: Schema.Literals(["reported", "estimated", "none"]),
  spendCap: Schema.Literals(["native", "estimated", "none"]),
  resetTimes: Schema.Boolean,
  hooks: Schema.Boolean,
  reattach: Schema.Boolean,
})
export type Capabilities = typeof Capabilities.Type

export const SteerOutcome = Schema.Union([
  /** Landed in the turn that was running when `steer` was called. */
  Schema.TaggedStruct("Landed", { messageId: MessageId, turnId: TurnId }),
  /** That turn ended first, so the message started a new one. */
  Schema.TaggedStruct("StartedNewTurn", { messageId: MessageId, turnId: TurnId }),
])
export type SteerOutcome = typeof SteerOutcome.Type

export interface AgentSession {
  readonly sessionId: SessionId
  readonly provider: string
  /** Where the provider stores this session (a transcript file), when known. */
  readonly location: Option.Option<string>
  /**
   * Live events from the moment the stream is run; run it before sending if
   * you need every event. Each run is an independent subscription.
   */
  readonly events: Stream.Stream<AgentEvent, AgentError>
  /** Start a turn now if idle, otherwise after the running turn. */
  readonly send: (input: Input) => Effect.Effect<MessageId, AgentError>
  /** `send`, then wait for that message's turn to end. */
  readonly turn: (input: Input) => Effect.Effect<TurnSucceeded, TurnFailure | AgentError>
  /** Deliver into the running turn at its next tool boundary; starts a new turn if none is running. */
  readonly steer: (input: Input) => Effect.Effect<SteerOutcome, AgentError>
  /** Stop the running turn (it ends `Interrupted`); the session stays usable. */
  readonly interrupt: Effect.Effect<void, AgentError>
  /** No more input: let queued work finish, then end the session. */
  readonly end: Effect.Effect<void, AgentError>
}

export class Agent extends Context.Service<
  Agent,
  {
    readonly provider: string
    readonly capabilities: Effect.Effect<Capabilities, AgentError>
    readonly open: (options: RunOptions) => Effect.Effect<AgentSession, SessionNotFound | AgentError, Scope.Scope>
  }
>()("effect-agent/Agent") {}
