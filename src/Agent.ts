/**
 * Provider-neutral coding agent. Each provider module exports a `layer` that
 * provides `Agent`:
 *
 *   import * as ClaudeAgent from "@jpowersdev/effect-agent/claude"
 *   program.pipe(Effect.provide(ClaudeAgent.layer()))
 *
 * A session is a scoped resource: closing its Scope stops the agent process.
 */
import { Context, type Duration, Effect, Option, Schema, Scope, Stream } from "effect"
import type { AgentError, SessionNotFound, TurnFailure } from "./AgentError.ts"
import type { AgentEvent, TurnSucceeded } from "./AgentEvent.ts"
import { LimitWindowStatus, MessageId, type SessionId, TurnId } from "./Domain.ts"

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
  /**
   * End a running turn `Stalled` after this long with no events. `Heartbeat`
   * events count, so a model that is thinking is not idle. While a tool call
   * is running (a `ToolCall` without its `ToolResult`) the limit is `toolIdle`,
   * which defaults to `idle`. A stalled turn is interrupted; if it hasn't
   * ended after `grace` (default 10 seconds) the agent process is killed,
   * which ends the session.
   */
  readonly watchdog?: {
    readonly idle: Duration.Input
    readonly toolIdle?: Duration.Input
    readonly grace?: Duration.Input
  }
  /** Callbacks that can add context to the turn. Only where `capabilities.hooks` is true. */
  readonly hooks?: Hooks
}

export interface ToolHookInput {
  readonly callId: string
  readonly name: string
  readonly input: unknown
}

/**
 * Each hook may return text that is added to the model's context. Hooks run
 * inside the agent's tool loop, so keep them fast; a failing hook adds nothing.
 */
export interface Hooks {
  readonly beforeTool?: (call: ToolHookInput) => Effect.Effect<Option.Option<string>>
  readonly afterTool?: (
    call: ToolHookInput & { readonly output: string; readonly isError: boolean },
  ) => Effect.Effect<Option.Option<string>>
  /** The agent is about to end its turn. Returning text keeps the turn going with that text as context. */
  readonly beforeStop?: () => Effect.Effect<Option.Option<string>>
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
  /** Which `RunOptions.disable` settings are enforced (not merely requested). */
  disable: Schema.Struct({
    askUser: Schema.Boolean,
    subagents: Schema.Boolean,
    /** `any`: every native tool name; `some`: only names the provider can turn off (others fail `open`). */
    tools: Schema.Literals(["any", "some"]),
  }),
})
export type Capabilities = typeof Capabilities.Type

export const AccountStatus = Schema.Struct({
  provider: Schema.String,
  /** Signed in, and no limit window or spend control is exhausted. */
  usable: Schema.Boolean,
  reason: Schema.NullOr(Schema.Literals(["unauthenticated", "usage_limited", "spend_limited"])),
  windows: Schema.Array(LimitWindowStatus),
  /** Subscription or plan name, e.g. `pro` or `max`. */
  plan: Schema.NullOr(Schema.String),
  checkedAt: Schema.DateTimeUtcFromMillis,
})
export type AccountStatus = typeof AccountStatus.Type

/**
 * Whether a limit window applies to `model`: windows without a model apply
 * to all; a per-model window applies when the model id contains its family
 * name (e.g. `claude-fable-5-1` and `fable`).
 */
export const appliesTo = (window: LimitWindowStatus, model: string): boolean =>
  Option.match(window.model, {
    onNone: () => true,
    onSome: (family) => model.toLowerCase().includes(family.toLowerCase()),
  })

/**
 * `status.usable`, and no exhausted per-model window caps `model`. A full
 * per-model window doesn't make the whole account unusable (other models
 * still run), but it does stop a run on that model.
 */
export const usableFor = (status: AccountStatus, model: string): boolean =>
  status.usable &&
  !status.windows.some((w) => Option.isSome(w.model) && appliesTo(w, model) && (w.usedPercent ?? 0) >= 100)

export interface StatusOptions {
  /**
   * Applied over the host environment like `RunOptions.env`, e.g. to check
   * another account: `{ CLAUDE_CONFIG_DIR: "..." }` or `{ CODEX_HOME: "..." }`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
}

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
  /** The agent process's pid (the wrapped command's, if a `Launcher` wraps it). */
  readonly pid: Effect.Effect<Option.Option<number>>
  /**
   * Subscribe now; the returned stream holds every event from this point on,
   * starting with the session's `SessionStarted` once it is known. Use this
   * (then fork the stream) when you must not miss events after a `send`.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent, AgentError>, never, Scope.Scope>
  /** `subscribe`, deferred until the stream runs. Events sent before it runs are missed. */
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
    /** Sign-in and usage-limit status, without running a turn. */
    readonly status: (options?: StatusOptions) => Effect.Effect<AccountStatus, AgentError>
    /**
     * A stored session's history as events: `UserMessage`, `Text`, `ToolCall`,
     * `ToolResult`, `Compacted`, grouped by `TurnStarted`, with `TurnEnded`
     * where the provider recorded how the turn ended.
     */
    readonly history: (
      sessionId: SessionId,
      options: { readonly cwd: string },
    ) => Effect.Effect<ReadonlyArray<AgentEvent>, SessionNotFound | AgentError>
  }
>()("effect-agent/Agent") {}
