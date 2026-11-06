/**
 * Provider-neutral coding agent. Each provider module exports a `layer` that
 * provides `Agent`:
 *
 * ```ts skip-type-checking
 * import * as ClaudeAgent from "@jpowersdev/effect-agent/claude"
 * program.pipe(Effect.provide(ClaudeAgent.layer()))
 * ```
 *
 * A session is a scoped resource: closing its Scope stops the agent process.
 *
 * @since 0.1.0
 */
import { Context, Effect, Option, Schema, Scope } from "effect"
import type { AgentError } from "./AgentError.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import { type AgentSession, SessionId, type SessionNotFound } from "./AgentSession.ts"
import { DurationInput, EnvOverrides } from "./internal/schema.ts"
import { LimitWindowStatus } from "./UsageLimit.ts"

/**
 * Reasoning effort for a turn.
 *
 * @since 0.1.0
 * @category models
 */
export const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"])
/**
 * @since 0.1.0
 * @category models
 */
export type Effort = typeof Effort.Type

/**
 * Everything in `RunOptions` but `hooks`, as a Schema: plain data that can
 * be stored or sent to another process (`DetachedAgent` sends it to its host).
 * Durations encode as millis; an `env` value of `undefined` as `null`.
 *
 * @since 0.2.0
 * @category models
 */
export const RunSettings = Schema.Struct({
  cwd: Schema.String,
  /**
   * Applied over the host environment. `undefined` removes a variable.
   * Host markers that make an agent think it is nested (e.g. `CLAUDECODE`)
   * are always removed.
   */
  env: Schema.optionalKey(EnvOverrides),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  /** Added to the provider's default system prompt; never replaces it. */
  appendSystemPrompt: Schema.optionalKey(Schema.String),
  disable: Schema.optionalKey(
    Schema.Struct({
      /** The agent's ask-the-user tools (Claude `AskUserQuestion`, Codex `request_user_input`); on Codex, some are refused when called. */
      askUser: Schema.optionalKey(Schema.Boolean),
      /** Subagent tools (Claude `Agent`/`Task`, Codex multi-agent). */
      subagents: Schema.optionalKey(Schema.Boolean),
      /** Provider-native tool names. Removed where the provider can; on Codex, some are refused when called instead. */
      tools: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /**
   * MCP servers and connectors from the machine's own setup. Without this, a
   * session asks for none: no MCP servers, no claude.ai connectors, no ChatGPT
   * apps (Codex 0.162.1 still loads the servers in its `config.toml`). With
   * it, the session loads the servers its provider is configured with (on
   * Claude, also the account's claude.ai connectors), and checks every call to
   * their tools in this process: refused unless its `server/tool` name matches
   * an `allow` glob and no `deny` glob. On Codex the check is a hook, so `open`
   * fails where hooks can't run.
   *
   * `server/tool` is the provider's `mcp__<server>__<tool>` split at the first
   * `__`, with every character outside `[A-Za-z0-9_-]` already `_`; a claude.ai
   * connector's server is `claude_ai_<Name>`, as `claude_ai_Slack`. A name
   * with another `__` must pass under every reading. Globs are `effect/Glob`'s:
   * `*` stays within the server or the tool, `{a,b}` is either. Reading MCP
   * resources is always refused. Built-in tools are unaffected.
   */
  mcp: Schema.optionalKey(
    Schema.Struct({
      /** `server/tool` globs a call must match, as `claude_ai_Slack/slack_{read,search}_*`. `[]` loads the servers, but nothing can be called. */
      allow: Schema.Array(Schema.String),
      /** Refused even when allowed, as `*\/*{send,reply,delete,trash}*`. */
      deny: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** Spend cap in USD. Native for Claude; estimated from tokens for Codex. */
  spendCapUsd: Schema.optionalKey(Schema.Number),
  /** Resume an existing session; fails with `SessionNotFound` if the provider has no record of it. */
  resume: Schema.optionalKey(SessionId),
  /**
   * End a running turn `Stalled` after this long with no events. `Heartbeat`
   * events count, so a model that is thinking is not idle. While a tool call
   * is running (a `ToolCall` without its `ToolResult`) the limit is `toolIdle`,
   * which defaults to `idle`. A stalled turn is interrupted; if it hasn't
   * ended after `grace` (default 10 seconds) the agent process is killed,
   * which ends the session.
   */
  watchdog: Schema.optionalKey(
    Schema.Struct({
      idle: DurationInput,
      toolIdle: Schema.optionalKey(DurationInput),
      grace: Schema.optionalKey(DurationInput),
    }),
  ),
})
/**
 * @since 0.2.0
 * @category models
 */
export type RunSettings = typeof RunSettings.Type

/**
 * Options for `Agent.open`: `RunSettings`, plus hooks.
 *
 * @since 0.1.0
 * @category models
 */
export interface RunOptions extends RunSettings {
  /** Callbacks that can add context to the turn. Only where `capabilities.hooks` is true. */
  readonly hooks?: Hooks
}

/**
 * `RunOptions` without its hooks (functions can't leave the process).
 *
 * @since 0.2.0
 * @category utils
 */
export const settingsOf = ({ hooks: _, ...settings }: RunOptions): RunSettings => settings

/**
 * The tool call passed to `Hooks.beforeTool` and `Hooks.afterTool`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ToolHookInput {
  readonly callId: string
  readonly name: string
  readonly input: unknown
}

/**
 * What `Hooks.beforeTool` returns to stop a call: the tool doesn't run, and the
 * model gets `reason` as its result. Make one with `refuseTool`.
 *
 * @since 0.7.0
 * @category models
 */
export interface ToolRefusal {
  readonly _tag: "ToolRefusal"
  readonly reason: string
}

/**
 * Refuse a tool call from `Hooks.beforeTool`, with the reason the model gets
 * as the tool's result. An empty reason is replaced, as Codex needs one.
 *
 * @since 0.7.0
 * @category constructors
 */
export const refuseTool = (reason: string): ToolRefusal => ({
  _tag: "ToolRefusal",
  reason: reason.trim() === "" ? "This tool call was refused." : reason,
})

/**
 * Whether a `beforeTool` result refuses the call.
 *
 * @since 0.7.0
 * @category guards
 */
export const isToolRefusal = (u: unknown): u is ToolRefusal =>
  typeof u === "object" && u !== null && (u as { readonly _tag?: unknown })._tag === "ToolRefusal"

/**
 * What `Hooks.beforeTool` returns: text to add to the model's context (or
 * none), or a `ToolRefusal`.
 *
 * @since 0.7.0
 * @category models
 */
export type BeforeToolResult = Option.Option<string> | ToolRefusal

/**
 * Each hook may return text that is added to the model's context. Hooks run
 * inside the agent's tool loop, so keep them fast; a failing hook adds nothing.
 *
 * `beforeTool` may instead refuse the call (`refuseTool`): the tool doesn't
 * run, and the model gets the reason as its result. A refusal holds with
 * permissions bypassed, as for `mcp`. It fails open: a hook that fails, times
 * out, or (on a detached session) has no client to answer it refuses nothing.
 * Where `capabilities.refuseTool` isn't true, as on a host from an older
 * release, a refusal is only added to the model's context, and the tool runs.
 *
 * @since 0.1.0
 * @category models
 */
export interface Hooks {
  readonly beforeTool?: (call: ToolHookInput) => Effect.Effect<BeforeToolResult>
  readonly afterTool?: (
    call: ToolHookInput & { readonly output: string; readonly isError: boolean },
  ) => Effect.Effect<Option.Option<string>>
  /** The agent is about to end its turn. Returning text keeps the turn going with that text as context. */
  readonly beforeStop?: () => Effect.Effect<Option.Option<string>>
}

/**
 * What a provider supports, from `Agent.capabilities`.
 *
 * @since 0.1.0
 * @category models
 */
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
  /** `beforeTool` can refuse a call (`refuseTool`). Absent from a host on a release before 0.7.0. */
  refuseTool: Schema.optionalKey(Schema.Boolean),
  reattach: Schema.Boolean,
  /** Which `RunOptions.disable` settings are enforced (not merely requested). */
  disable: Schema.Struct({
    askUser: Schema.Boolean,
    subagents: Schema.Boolean,
    /** `any`: every native tool name; `some`: only names the provider can turn off (others fail `open`). See `disable.tools`. */
    tools: Schema.Literals(["any", "some"]),
  }),
})
/**
 * @since 0.1.0
 * @category models
 */
export type Capabilities = typeof Capabilities.Type

/**
 * Sign-in and usage-limit status, from `Agent.status`.
 *
 * @since 0.1.0
 * @category models
 */
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
/**
 * @since 0.1.0
 * @category models
 */
export type AccountStatus = typeof AccountStatus.Type

/**
 * Whether a limit window applies to `model`: windows without a model apply
 * to all; a per-model window applies when the model id contains its family
 * name (e.g. `claude-fable-5-1` and `fable`).
 *
 * @example
 * ```ts
 * import { appliesTo } from "@jpowersdev/effect-agent"
 * import { Option } from "effect"
 * import assert from "node:assert"
 *
 * const weeklyFable = {
 *   window: "weekly",
 *   label: "seven_day_fable",
 *   usedPercent: 100,
 *   resetsAt: null,
 *   model: Option.some("fable")
 * } as const
 *
 * assert.strictEqual(appliesTo(weeklyFable, "claude-fable-5-1"), true)
 * assert.strictEqual(appliesTo(weeklyFable, "claude-sonnet-5-5"), false)
 * ```
 *
 * @since 0.1.0
 * @category predicates
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
 *
 * @since 0.1.0
 * @category predicates
 */
export const usableFor = (status: AccountStatus, model: string): boolean =>
  status.usable &&
  !status.windows.some((w) => Option.isSome(w.model) && appliesTo(w, model) && (w.usedPercent ?? 0) >= 100)

/**
 * Options for `Agent.status`.
 *
 * @since 0.1.0
 * @category models
 */
export interface StatusOptions {
  /**
   * Applied over the host environment like `RunOptions.env`, e.g. to check
   * another account: `{ CLAUDE_CONFIG_DIR: "..." }` or `{ CODEX_HOME: "..." }`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * The provider-neutral agent service; each provider module's `layer` provides it.
 *
 * @example
 * ```ts
 * import { Agent } from "@jpowersdev/effect-agent"
 * import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"
 * import { Effect, Layer, Stream } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const agent = yield* Agent
 *   const session = yield* agent.open({ cwd: process.cwd(), spendCapUsd: 5 })
 *   // Subscribe before sending, so no event is missed
 *   const events = yield* session.subscribe
 *   yield* events.pipe(
 *     Stream.runForEach(Effect.logInfo),
 *     Effect.forkScoped
 *   )
 *   return yield* session.turn("Fix the failing test")
 * }).pipe(
 *   // Closing the scope ends the session and stops the agent process
 *   Effect.scoped,
 *   Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer())))
 * )
 * ```
 *
 * @since 0.1.0
 * @category services
 */
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
