/**
 * `Agent` backed by Claude Code (`@anthropic-ai/claude-agent-sdk`).
 *
 * ```ts skip-type-checking
 * import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"
 * program.pipe(Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))))
 * ```
 *
 * Turns are defined by the CLI's `command_lifecycle` frames: a turn starts
 * when one of our messages goes `started` while no turn is running (its
 * `TurnId` is that message's id) and ends at the next `result`. A message that
 * goes `started` while a turn is running has landed in it (`MessageLanded`).
 *
 * Each session's CLI is started through `Launcher` (if provided) in its own
 * process group; `pid` is that process. `RunOptions.watchdog` interrupts a
 * turn that goes quiet, kills the process if the interrupt doesn't end it
 * within `stallGrace`, and ends the turn `Stalled` either way.
 * `RunOptions.hooks` become SDK hooks (`sdkHooks`).
 *
 * `status` starts an idle CLI (no prompt) and reads `accountInfo()` and the
 * experimental usage API. `history` reads a stored transcript.
 *
 * The pure parts (`buildOptions`, `sdkHooks`, `frameEvents`, `step`,
 * `classifyOutcome`, `accountStatus`, `historyEvents`) are exported for testing.
 *
 * @since 0.1.0
 */
import type {
  AccountInfo,
  EffortLevel,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  Options,
  SDKAssistantMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
  SessionMessage,
  SettingSource,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Clock, DateTime, Deferred, Duration, Effect, Fiber, Layer, Option, PubSub, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import {
  type AccountStatus,
  Agent,
  type AgentSession,
  type Capabilities,
  type Effort,
  type Hooks,
  type Input,
  type RunOptions,
} from "../Agent.ts"
import {
  AgentError,
  AgentFailed,
  AuthFailed,
  ContextExhausted,
  Interrupted,
  ProcessKilled,
  SessionNotFound,
  SpendCapReached,
  Stalled,
  Throttled,
  UsageLimited,
} from "../AgentError.ts"
import type { AgentEvent, TurnOutcome, TurnSucceeded } from "../AgentEvent.ts"
import { type LimitWindow, type LimitWindowStatus, MessageId, SessionId, type TokenUsage, TurnId } from "../Domain.ts"
import * as Launcher from "../Launcher.ts"
import * as Watchdog from "../Watchdog.ts"
import * as ClaudeSdk from "./ClaudeSdk.ts"

/**
 * The `Capabilities.provider` name.
 *
 * @since 0.1.0
 * @category constants
 */
export const provider = "claude"

/**
 * @since 0.1.0
 * @category models
 */
export interface ClaudeAgentOptions {
  /** Filesystem settings to load. Defaults to the CLI default (all sources, so project `CLAUDE.md` loads). MCP isolation holds regardless. */
  readonly settingSources?: ReadonlyArray<SettingSource>
  /** Use this `claude` binary instead of the one bundled with the SDK. */
  readonly pathToClaudeCodeExecutable?: string
  /** Model when `RunOptions.model` is not set. */
  readonly model?: string
  /**
   * Check that a resumed session exists (`getSessionInfo`) before spawning.
   * Default true; the CLI's own "No conversation found" is still mapped to `SessionNotFound` either way.
   */
  readonly checkResume?: boolean
  /**
   * Applied over the host environment for every process this layer starts
   * (sessions and `status`); `RunOptions.env` applies on top. `undefined`
   * removes a variable, e.g. `{ CLAUDE_CONFIG_DIR: "/path" }` for another account.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Default for `RunOptions.watchdog.grace` (10 seconds when neither is set). */
  readonly stallGrace?: Duration.Input
}

// ---------------------------------------------------------------------------
// RunOptions -> SDK Options
// ---------------------------------------------------------------------------

/**
 * Variables a parent Claude Code session sets that would make the child think it is nested.
 *
 * @internal
 */
export const nestingMarkers: ReadonlyArray<string> = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "AI_AGENT",
]

/**
 * The SDK replaces the child's environment with this, so it starts from the host's.
 *
 * @internal
 */
export const buildEnv = (
  host: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> => {
  const env: Record<string, string | undefined> = { ...host }
  for (const key of nestingMarkers) delete env[key]
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  // MCP isolation: no claude.ai connectors, whatever the caller passed.
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false"
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}

/**
 * `Effort` as the SDK's `EffortLevel`: `minimal` becomes `low`.
 *
 * @internal
 */
export const toEffortLevel = (effort: Effort): EffortLevel => (effort === "minimal" ? "low" : effort)

/**
 * `RunOptions.disable` as the SDK's `disallowedTools`.
 *
 * @internal
 */
export const disallowedTools = (disable: RunOptions["disable"]): Array<string> => {
  const tools = new Set<string>()
  if (disable?.askUser) tools.add("AskUserQuestion")
  // `Task` is the legacy name of `Agent`; `Workflow` runs multi-agent scripts.
  if (disable?.subagents) for (const t of ["Agent", "Task", "Workflow"]) tools.add(t)
  for (const t of disable?.tools ?? []) tools.add(t)
  return [...tools]
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Run a hook to completion; a failure, defect, throw or abort adds nothing. */
const runHook = (hook: () => Effect.Effect<Option.Option<string>>, signal: AbortSignal): Promise<string | undefined> =>
  Effect.runPromise(
    Effect.suspend(hook).pipe(
      Effect.map((text) => (Option.isSome(text) && text.value !== "" ? text.value : undefined)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
    { signal },
  ).catch(() => undefined)

/**
 * Tool output as text for `afterTool`: Bash's stdout/stderr, content blocks, or JSON.
 *
 * @internal
 */
export const toolResponseText = (response: unknown): string => {
  if (typeof response === "string") return response
  if (typeof response === "object" && response !== null) {
    const r = response as Record<string, unknown>
    if (typeof r.stdout === "string" || typeof r.stderr === "string") {
      return [r.stdout, r.stderr].filter((x): x is string => typeof x === "string" && x !== "").join("\n")
    }
    if ("content" in r) return flattenToolContent(r.content)
  }
  return flattenToolContent(response)
}

type ContextEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Stop"

const addContext = (hookEventName: ContextEvent, text: string | undefined): SyncHookJSONOutput =>
  text === undefined ? {} : ({ hookSpecificOutput: { hookEventName, additionalContext: text } } as SyncHookJSONOutput)

const matcher = <E extends HookEvent>(
  event: E,
  handle: (input: Extract<Parameters<HookCallback>[0], { readonly hook_event_name: E }>, signal: AbortSignal) => Promise<SyncHookJSONOutput>,
): Array<HookCallbackMatcher> => [
  {
    hooks: [
      (input, _toolUseId, { signal }) =>
        input.hook_event_name === event ? handle(input as never, signal) : Promise.resolve({}),
    ],
  },
]

/**
 * `RunOptions.hooks` as SDK hooks: `beforeTool` is PreToolUse, `afterTool`
 * PostToolUse (and PostToolUseFailure, with `isError`), `beforeStop` Stop.
 * Text a hook returns goes back as `additionalContext`; for Stop the CLI then
 * keeps the turn going so the model can act on it.
 *
 * @internal
 */
export const sdkHooks = (hooks: Hooks): NonNullable<Options["hooks"]> => {
  const out: NonNullable<Options["hooks"]> = {}
  const { beforeTool, afterTool, beforeStop } = hooks
  if (beforeTool !== undefined) {
    out.PreToolUse = matcher("PreToolUse", async (input, signal) =>
      addContext(
        "PreToolUse",
        await runHook(() => beforeTool({ callId: input.tool_use_id, name: input.tool_name, input: input.tool_input }), signal),
      ),
    )
  }
  if (afterTool !== undefined) {
    out.PostToolUse = matcher("PostToolUse", async (input, signal) =>
      addContext(
        "PostToolUse",
        await runHook(
          () =>
            afterTool({
              callId: input.tool_use_id,
              name: input.tool_name,
              input: input.tool_input,
              output: toolResponseText(input.tool_response),
              isError: false,
            }),
          signal,
        ),
      ),
    )
    out.PostToolUseFailure = matcher("PostToolUseFailure", async (input, signal) =>
      addContext(
        "PostToolUseFailure",
        await runHook(
          () => afterTool({ callId: input.tool_use_id, name: input.tool_name, input: input.tool_input, output: input.error, isError: true }),
          signal,
        ),
      ),
    )
  }
  if (beforeStop !== undefined) {
    out.Stop = matcher("Stop", async (_input, signal) => addContext("Stop", await runHook(beforeStop, signal)))
  }
  return out
}

// ---------------------------------------------------------------------------
// RunOptions -> SDK Options (continued)
// ---------------------------------------------------------------------------

/**
 * SDK `Options` for a session, from `RunOptions` and the layer's config.
 *
 * @internal
 */
export const buildOptions = (
  run: RunOptions,
  config: ClaudeAgentOptions,
  sessionId: SessionId,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Options => {
  const model = run.model ?? config.model
  const disallowed = disallowedTools(run.disable)
  return {
    cwd: run.cwd,
    env: buildEnv(hostEnv, { ...config.env, ...run.env }),
    ...(run.hooks !== undefined && { hooks: sdkHooks(run.hooks) }),
    ...(run.resume !== undefined ? { resume: run.resume } : { sessionId }),
    ...(model !== undefined && { model }),
    ...(run.effort !== undefined && { effort: toEffortLevel(run.effort) }),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(run.appendSystemPrompt !== undefined && { append: run.appendSystemPrompt }),
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(disallowed.length > 0 && { disallowedTools: disallowed }),
    strictMcpConfig: true,
    mcpServers: {},
    settings: { disableClaudeAiConnectors: true },
    ...(config.settingSources !== undefined && { settingSources: [...config.settingSources] }),
    ...(run.spendCapUsd !== undefined && { maxBudgetUsd: run.spendCapUsd }),
    ...(config.pathToClaudeCodeExecutable !== undefined && {
      pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
    }),
  }
}

/**
 * Options for `status`'s idle query: the same isolation as a session, nothing persisted.
 *
 * @internal
 */
export const buildStatusOptions = (
  config: ClaudeAgentOptions,
  cwd: string,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Options => ({
  cwd,
  env: buildEnv(hostEnv, config.env),
  strictMcpConfig: true,
  mcpServers: {},
  settings: { disableClaudeAiConnectors: true },
  persistSession: false,
  ...(config.settingSources !== undefined && { settingSources: [...config.settingSources] }),
  ...(config.pathToClaudeCodeExecutable !== undefined && {
    pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
  }),
})

/**
 * The transcript location for `RunOptions`, honouring a `CLAUDE_CONFIG_DIR` override in `env`.
 *
 * @internal
 */
export const location = (run: RunOptions, sessionId: SessionId, config: ClaudeAgentOptions = {}): string => {
  const env = { ...config.env, ...run.env }
  const configDir = "CLAUDE_CONFIG_DIR" in env ? env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR
  return ClaudeSdk.transcriptPath(run.cwd, sessionId, configDir)
}

/**
 * The CLI's text for resuming a session it has no record of. The one place it is recognized.
 *
 * @internal
 */
export const sessionNotFound = (text: string, sessionId: SessionId): SessionNotFound | undefined =>
  text.includes("No conversation found with session ID")
    ? new SessionNotFound({ message: text, sessionId })
    : undefined

// ---------------------------------------------------------------------------
// Frame -> events
// ---------------------------------------------------------------------------

const firstLine = (text: string, max = 200): string => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * One line for a tool call: the command, path, pattern or URL it acts on.
 *
 * @internal
 */
export const toolSummary = (name: string, input: unknown): string => {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
  const pick = (...keys: ReadonlyArray<string>) => {
    for (const k of keys) if (typeof i[k] === "string" && i[k] !== "") return firstLine(i[k])
    return undefined
  }
  const summary = (() => {
    switch (name) {
      case "Bash":
      case "PowerShell":
        return pick("command")
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit":
        return pick("file_path")
      case "NotebookEdit":
        return pick("notebook_path", "file_path")
      case "Grep":
      case "Glob":
        return pick("pattern")
      case "WebFetch":
        return pick("url")
      case "WebSearch":
        return pick("query")
      case "Agent":
      case "Task":
        return pick("description")
      default:
        return undefined
    }
  })()
  return summary ?? name
}

/**
 * Tool output as text: strings as-is, text blocks joined, other blocks named.
 *
 * @internal
 */
export const flattenToolContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content)
  return content
    .map((block: unknown) => {
      const b = (typeof block === "object" && block !== null ? block : {}) as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string") return b.text
      return `[${typeof b.type === "string" ? b.type : "content"}]`
    })
    .join("\n")
}

/**
 * A rate-limit window label as a `LimitWindow`.
 *
 * @internal
 */
export const normalizeWindow = (label: string): LimitWindow =>
  label === "five_hour" ? "five_hour" : label === "seven_day" ? "weekly" : "other"

const secondsToDateTime = (seconds: unknown): DateTime.Utc | null =>
  typeof seconds === "number" && Number.isFinite(seconds) ? DateTime.makeUnsafe(seconds * 1000) : null

/** A display name's family, e.g. `Fable` → `fable`, `Opus 5` → `opus`. */
const modelFamily = (displayName: string): string => displayName.trim().split(/\s+/)[0]!.toLowerCase()

/**
 * The model a window label caps: `seven_day_opus` → `opus`, `model_scoped:Fable` → `fable`; none for account-wide windows.
 *
 * @internal
 */
export const modelOfLabel = (label: string): Option.Option<string> => {
  if (label.startsWith("model_scoped:")) return Option.some(modelFamily(label.slice("model_scoped:".length)))
  const perModel = /^seven_day_(opus|sonnet|haiku|fable)$/.exec(label)
  return perModel !== null ? Option.some(perModel[1]!) : Option.none()
}

/**
 * Windows from a `rate_limit_info`. Prefers the undocumented `unifiedWindows`
 * (`utilization` is a fraction, `resetsAt` unix seconds); falls back to the
 * single documented window.
 *
 * @internal
 */
export const limitWindows = (info: SDKRateLimitInfo): Array<LimitWindowStatus> => {
  const unified = (info as { readonly unifiedWindows?: unknown }).unifiedWindows
  const window = (label: string, w: { readonly utilization?: unknown; readonly resetsAt?: unknown }) => ({
    window: normalizeWindow(label),
    label,
    usedPercent: typeof w.utilization === "number" ? Math.round(w.utilization * 10000) / 100 : null,
    resetsAt: secondsToDateTime(w.resetsAt),
    model: modelOfLabel(label),
  })
  if (typeof unified === "object" && unified !== null) {
    return Object.entries(unified as Record<string, unknown>).flatMap(([label, w]) =>
      typeof w === "object" && w !== null ? [window(label, w)] : [],
    )
  }
  return info.rateLimitType !== undefined ? [window(info.rateLimitType, info)] : []
}

const isHeartbeat = (frame: { readonly type: string; readonly subtype?: unknown }) =>
  frame.type === "tool_progress" ||
  (frame.type === "system" &&
    (frame.subtype === "thinking_tokens" || frame.subtype === "status" || frame.subtype === "task_progress"))

/**
 * Events for frames whose mapping does not depend on turn state. Lifecycle,
 * `init` and `result` frames are handled by `step`; heartbeats are throttled there.
 *
 * @internal
 */
export const frameEvents = (frame: ClaudeSdk.Frame, turnId: TurnId | null): Array<AgentEvent> => {
  const raw = frame
  switch (frame.type) {
    case "assistant": {
      const content = Array.isArray(frame.message?.content) ? frame.message.content : []
      const events = content.flatMap((block): Array<AgentEvent> => {
        if (block.type === "text") return [{ _tag: "Text", turnId, text: block.text, raw }]
        if (block.type === "tool_use") {
          return [
            {
              _tag: "ToolCall",
              turnId,
              callId: block.id,
              name: block.name,
              summary: toolSummary(block.name, block.input),
              input: block.input,
              raw,
            },
          ]
        }
        return []
      })
      return events.length > 0 ? events : [{ _tag: "Other", raw }]
    }
    case "user": {
      const content = frame.message?.content
      const events = Array.isArray(content)
        ? content.flatMap((block): Array<AgentEvent> =>
            block.type === "tool_result"
              ? [
                  {
                    _tag: "ToolResult",
                    turnId,
                    callId: block.tool_use_id,
                    isError: block.is_error === true,
                    output: flattenToolContent(block.content),
                    raw,
                  },
                ]
              : [],
          )
        : []
      return events.length > 0 ? events : [{ _tag: "Other", raw }]
    }
    case "rate_limit_event":
      return [{ _tag: "LimitsUpdated", windows: limitWindows(frame.rate_limit_info), raw }]
    case "system": {
      if (frame.subtype === "api_retry") {
        return [
          {
            _tag: "Retrying",
            turnId,
            attempt: frame.attempt,
            maxAttempts: frame.max_retries,
            delayMs: frame.retry_delay_ms,
            message: `${frame.error}${frame.error_status !== null ? ` (${frame.error_status})` : ""}`,
            raw,
          },
        ]
      }
      if (frame.subtype === "compact_boundary") {
        return [{ _tag: "Compacted", turnId, trigger: frame.compact_metadata?.trigger ?? null, raw }]
      }
      return isHeartbeat(frame) ? [{ _tag: "Heartbeat", turnId, raw }] : [{ _tag: "Other", raw }]
    }
    default:
      return isHeartbeat(frame) ? [{ _tag: "Heartbeat", turnId, raw }] : [{ _tag: "Other", raw }]
  }
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * How the CLI process died.
 *
 * @internal
 */
export interface ProcessFailure {
  readonly message: string
  readonly signal: string | null
  readonly exitCode: number | null
}

/**
 * The watchdog stopped the turn: how long it had been quiet, and whether a tool was running.
 *
 * @internal
 */
export interface Stall {
  readonly idleMs: number
  readonly inTool: boolean
}

/**
 * What `classifyOutcome` knows about a turn.
 *
 * @internal
 */
export interface OutcomeInput {
  readonly turnId: TurnId
  /** The turn's `result`, or null when the process died first. */
  readonly result: SDKResultMessage | null
  /** The assistant `error` seen during the turn (`SDKAssistantMessageError`). */
  readonly assistantError: string | null
  /** The latest rate-limit info: the assistant's `api_error_params` for this turn, else the latest `rate_limit_event`. */
  readonly rateLimit: SDKRateLimitInfo | null
  readonly interruptRequested: boolean
  readonly processError: ProcessFailure | null
  /** `RunOptions.spendCapUsd`. */
  readonly capUsd: number | null
  /** Set when the watchdog stopped this turn. */
  readonly stalled?: Stall | null
}

const stalledError = (stall: Stall, killed: boolean) =>
  new Stalled({
    message: `no events for ${(stall.idleMs / 1000).toFixed(1)}s${stall.inTool ? " while a tool was running" : ""}; ${
      killed ? "Claude Code did not stop after an interrupt and was killed" : "the turn was interrupted"
    }`,
    idleMs: stall.idleMs,
    inTool: stall.inTool,
  })

/**
 * Whether paid extra usage can take over from a rate limit; null when the info does not say.
 *
 * @internal
 */
export const overageAvailable = (info: SDKRateLimitInfo): boolean | null => {
  if (info.isUsingOverage === true || info.overageInUse === true) return true
  if (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning") return true
  if (info.overageStatus === "rejected" || info.overageDisabledReason !== undefined) return false
  return null
}

const resultMessage = (result: SDKResultMessage): string => {
  if (result.subtype === "success") return result.result ?? ""
  return Array.isArray(result.errors) && result.errors.length > 0 ? result.errors.join("; ") : result.subtype
}

/**
 * How a turn ended, from its `result` (or the process failure) and what was seen during it.
 *
 * @internal
 */
export const classifyOutcome = (input: OutcomeInput): TurnOutcome => {
  const { result, turnId } = input
  const stall = input.stalled ?? null
  if (input.processError !== null || result === null) {
    // We killed it ourselves after a stall: that is the turn's story, not the kill.
    if (stall !== null) return stalledError(stall, true)
    const p = input.processError ?? { message: "Claude Code exited mid-turn", signal: null, exitCode: null }
    return new ProcessKilled({ message: p.message, signal: p.signal, exitCode: p.exitCode })
  }
  const ok = result.subtype === "success" && !result.is_error
  if (stall !== null && !ok) return stalledError(stall, false)
  // An interrupted turn ends `error_during_execution` / `aborted_streaming` with diagnostics in
  // `errors`: classify by the fact that we asked for it, not by the text.
  if (input.interruptRequested && !ok) return new Interrupted({ message: "interrupted" })
  if (ok) return { _tag: "Succeeded", turnId, finalText: result.result ?? "" }

  const message = resultMessage(result)
  if (result.subtype === "error_max_budget_usd") {
    return new SpendCapReached({
      message,
      capUsd: input.capUsd,
      spentUsd: result.total_cost_usd,
      estimated: false,
    })
  }
  const rl = input.rateLimit
  if (rl !== null && rl.status === "rejected") {
    return new UsageLimited({
      message,
      window: normalizeWindow(rl.rateLimitType ?? "other"),
      resetsAt: secondsToDateTime(rl.resetsAt),
      overageAvailable: overageAvailable(rl),
    })
  }
  if (input.assistantError === "authentication_failed") return new AuthFailed({ message })
  if (result.terminal_reason === "prompt_too_long") return new ContextExhausted({ message })
  if (input.assistantError === "overloaded" || input.assistantError === "rate_limit") {
    return new Throttled({ message, retriesLeft: 0 })
  }
  return new AgentFailed({
    message,
    kind: result.terminal_reason ?? (result.subtype === "success" ? input.assistantError : null) ?? result.subtype,
  })
}

/**
 * This turn's tokens (`result.usage` is per turn in streaming-input mode); null if the CLI omitted it.
 *
 * @internal
 */
export const turnUsage = (result: SDKResultMessage): TokenUsage | null => {
  const u = result.usage as Partial<SDKResultMessage["usage"]> | undefined
  if (u === undefined || u === null) return null
  const cacheRead = u.cache_read_input_tokens ?? 0
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cacheRead,
    cachedInputTokens: cacheRead,
    outputTokens: u.output_tokens ?? 0,
    // Claude's output_tokens already include thinking.
    reasoningTokens: null,
  }
}

// ---------------------------------------------------------------------------
// Turn tracking (pure)
// ---------------------------------------------------------------------------

/**
 * The running turn, as tracked by `step`.
 *
 * @internal
 */
export interface TurnState {
  readonly turnId: TurnId
  readonly messages: ReadonlyArray<string>
  readonly interruptRequested: boolean
  readonly assistantError: string | null
  readonly rateLimit: SDKRateLimitInfo | null
  /** Set by `markStalled` when the watchdog stops the turn. */
  readonly stalled?: Stall | null
}

/**
 * Session state folded by `step`.
 *
 * @internal
 */
export interface State {
  readonly started: boolean
  /** Events from before the first `init` frame, emitted right after `SessionStarted`. */
  readonly held: ReadonlyArray<AgentEvent>
  readonly turn: TurnState | null
  /** Latest `rate_limit_event`. */
  readonly rateLimit: SDKRateLimitInfo | null
  readonly lastHeartbeatMs: number | null
  /** Whether the CLI sends `command_lifecycle` frames (CLIs before `msg_lifecycle_v1` don't). */
  readonly lifecycle: boolean
  /**
   * Messages that already landed in a turn. The CLI later reports an interrupted
   * turn's own message as `cancelled`; that is not a dropped message.
   */
  readonly landed: ReadonlySet<string>
}

/**
 * `State` before any frame.
 *
 * @internal
 */
export const initialState: State = {
  started: false,
  held: [],
  turn: null,
  rateLimit: null,
  lastHeartbeatMs: null,
  lifecycle: false,
  landed: new Set(),
}

const withLanded = (state: State, id: string): State => ({ ...state, landed: new Set(state.landed).add(id) })

/**
 * Per-frame input to `step`.
 *
 * @internal
 */
export interface StepContext {
  readonly sessionId: SessionId
  readonly resumed: boolean
  readonly capUsd: number | null
  readonly nowMs: number
  /** The oldest message sent but not yet landed, for CLIs without lifecycle frames. */
  readonly nextPending?: string | null
}

/**
 * The result of `step`: the new state, events to emit, and messages dropped.
 *
 * @internal
 */
export interface Step {
  readonly state: State
  readonly events: ReadonlyArray<AgentEvent>
  /** Messages the CLI cancelled, discarded or refused: they will never land. */
  readonly dropped: ReadonlyArray<{ readonly messageId: string; readonly state: ClaudeSdk.LifecycleState }>
}

const heartbeatIntervalMs = 1000

const newTurn = (turnId: string): TurnState => ({
  turnId: TurnId.make(turnId),
  messages: [turnId],
  interruptRequested: false,
  assistantError: null,
  rateLimit: null,
})

const endTurn = (ctx: StepContext, state: State, turn: TurnState, result: SDKResultMessage | null, processError: ProcessFailure | null, raw: unknown): Step => ({
  state: { ...state, turn: null },
  events: [
    {
      _tag: "TurnEnded",
      turnId: turn.turnId,
      outcome: classifyOutcome({
        turnId: turn.turnId,
        result,
        assistantError: turn.assistantError,
        rateLimit: turn.rateLimit ?? state.rateLimit,
        interruptRequested: turn.interruptRequested,
        processError,
        capUsd: ctx.capUsd,
        stalled: turn.stalled ?? null,
      }),
      usage: result !== null ? turnUsage(result) : null,
      cost: result !== null && typeof result.total_cost_usd === "number" ? { usd: result.total_cost_usd, source: "reported" } : null,
      raw,
    },
  ],
  dropped: [],
})

/**
 * Fold one frame into the session state. Events before the first `init`
 * (the first message's lifecycle frames) are held so `SessionStarted` comes first.
 *
 * @internal
 */
export const step = (ctx: StepContext, state: State, frame: ClaudeSdk.Frame): Step => {
  const next = stepFrame(ctx, state, frame)
  if (state.started) return next
  if (next.state.started) {
    return { ...next, state: { ...next.state, held: [] }, events: [...next.events, ...state.held] }
  }
  // Not started yet: hold, unless the turn just ended without an init (a startup failure).
  if (next.events.some((e) => e._tag === "TurnEnded")) {
    return { ...next, state: { ...next.state, held: [] }, events: [...state.held, ...next.events] }
  }
  return { ...next, state: { ...next.state, held: [...state.held, ...next.events] }, events: [] }
}

/** A message that starts a turn also lands in it, as with Codex. */
const startEvents = (messageId: string, turnId: TurnId, raw: unknown): ReadonlyArray<AgentEvent> => [
  { _tag: "TurnStarted", turnId, raw },
  { _tag: "MessageLanded", messageId: MessageId.make(messageId), turnId, raw },
]

const stepFrame = (ctx: StepContext, state: State, frame: ClaudeSdk.Frame): Step => {
  const raw = frame
  const lifecycle = ClaudeSdk.decodeLifecycle(frame)
  if (lifecycle !== undefined) {
    if (!state.lifecycle) state = { ...state, lifecycle: true }
    const id = lifecycle.command_uuid
    switch (lifecycle.state) {
      case "started": {
        if (state.turn === null) {
          const turn = newTurn(id)
          return { state: withLanded({ ...state, turn }, id), events: startEvents(id, turn.turnId, raw), dropped: [] }
        }
        if (state.turn.messages.includes(id)) return { state, events: [{ _tag: "Other", raw }], dropped: [] }
        const turn = { ...state.turn, messages: [...state.turn.messages, id] }
        return {
          state: withLanded({ ...state, turn }, id),
          events: [{ _tag: "MessageLanded", messageId: MessageId.make(id), turnId: turn.turnId, raw }],
          dropped: [],
        }
      }
      case "cancelled":
      case "discarded":
      case "refused":
        if (state.landed.has(id)) return { state, events: [{ _tag: "Other", raw }], dropped: [] }
        return {
          state,
          events: [{ _tag: "MessageDropped", messageId: MessageId.make(id), reason: lifecycle.state, raw }],
          dropped: [{ messageId: id, state: lifecycle.state }],
        }
      default:
        return { state, events: [{ _tag: "Other", raw }], dropped: [] }
    }
  }

  // Turn content with no turn running: a startup-failure result, or a CLI without lifecycle
  // frames (then bind it to our oldest pending message).
  if ((frame.type === "assistant" && (frame.parent_tool_use_id ?? null) === null) || frame.type === "result") {
    if (state.turn === null) {
      const id =
        frame.user_message_uuid ?? (state.lifecycle ? undefined : ctx.nextPending) ?? frame.uuid ?? "unknown"
      const turn = newTurn(id)
      const rest = stepFrame(ctx, withLanded({ ...state, turn }, id), frame)
      return { ...rest, events: [...startEvents(id, turn.turnId, raw), ...rest.events] }
    }
  }

  switch (frame.type) {
    case "system": {
      if (frame.subtype === "init") {
        if (state.started) return { state, events: [{ _tag: "Other", raw }], dropped: [] }
        return {
          state: { ...state, started: true },
          events: [
            {
              _tag: "SessionStarted",
              sessionId: ctx.sessionId,
              provider,
              version: frame.claude_code_version ?? null,
              model: frame.model ?? null,
              resumed: ctx.resumed,
              raw,
            },
          ],
          dropped: [],
        }
      }
      break
    }
    case "assistant": {
      const turn = state.turn
      const error = (frame as SDKAssistantMessage).error
      if (turn !== null && error !== undefined && (frame.parent_tool_use_id ?? null) === null) {
        const params = (frame as { readonly api_error_params?: { readonly rate_limit_info?: SDKRateLimitInfo } })
          .api_error_params
        const next: State = {
          ...state,
          turn: { ...turn, assistantError: error, rateLimit: params?.rate_limit_info ?? turn.rateLimit },
        }
        return { state: next, events: frameEvents(frame, turn.turnId), dropped: [] }
      }
      break
    }
    case "rate_limit_event":
      return { state: { ...state, rateLimit: frame.rate_limit_info }, events: frameEvents(frame, state.turn?.turnId ?? null), dropped: [] }
    case "result":
      if (state.turn !== null) return endTurn(ctx, state, state.turn, frame, null, raw)
      break
  }

  const turnId = state.turn?.turnId ?? null
  if (isHeartbeat(frame)) {
    if (state.lastHeartbeatMs !== null && ctx.nowMs - state.lastHeartbeatMs < heartbeatIntervalMs) {
      return { state, events: [], dropped: [] }
    }
    return { state: { ...state, lastHeartbeatMs: ctx.nowMs }, events: [{ _tag: "Heartbeat", turnId, raw }], dropped: [] }
  }
  return { state, events: frameEvents(frame, turnId), dropped: [] }
}

/**
 * The process ended: a running turn ends `ProcessKilled`.
 *
 * @internal
 */
export const stepExit = (ctx: StepContext, state: State, error: ProcessFailure | null): Step => {
  const held = { ...state, held: [] }
  if (state.turn === null) return { state: held, events: state.held, dropped: [] }
  const ended = endTurn(ctx, held, state.turn, null, error ?? { message: "Claude Code exited mid-turn", signal: null, exitCode: null }, error)
  return { ...ended, events: [...state.held, ...ended.events] }
}

/**
 * The CLI's exit code reflects its last result, so after a turn that ended in
 * a failure (an interrupt, a spend cap, ...) even a clean shutdown exits 1.
 * That is a normal end, not a crash, when we asked for it and no turn was running.
 *
 * @internal
 */
export const isCleanExitAfterFailedTurn = (
  error: { readonly exitCode: number | null; readonly signal: string | null },
  context: { readonly endRequested: boolean; readonly turnRunning: boolean; readonly lastTurnFailed: boolean },
): boolean =>
  context.endRequested && !context.turnRunning && context.lastTurnFailed && error.exitCode === 1 && error.signal === null

/**
 * Mark the running turn as interrupted by us.
 *
 * @internal
 */
export const markInterrupt = (state: State): State =>
  state.turn === null ? state : { ...state, turn: { ...state.turn, interruptRequested: true } }

/**
 * Mark the running turn as stopped by the watchdog (if it is still `turnId`).
 *
 * @internal
 */
export const markStalled = (state: State, turnId: TurnId, stall: Stall): State =>
  state.turn === null || state.turn.turnId !== turnId
    ? state
    : { ...state, turn: { ...state.turn, interruptRequested: true, stalled: stall } }

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Landing {
  readonly turnId: TurnId
}

const End = Symbol("End")

const agentError = (message: string, cause?: unknown) =>
  new AgentError({ message, provider, ...(cause !== undefined && { cause }) })

const fromSdkError = (e: ClaudeSdk.ClaudeSdkError) => agentError(`${e.operation}: ${e.message}`, e)

const openSession = Effect.fnUntraced(function* (sdk: ClaudeSdk.ClaudeSdk["Service"], config: ClaudeAgentOptions, run: RunOptions) {
  const sessionId = run.resume ?? SessionId.make(randomUUID())
  const transcript = location(run, sessionId, config)

  if (run.resume !== undefined && config.checkResume !== false) {
    const exists = yield* sdk.sessionExists({ sessionId: run.resume, cwd: run.cwd, transcript })
    if (!exists) {
      return yield* new SessionNotFound({ message: `No Claude Code session ${run.resume} for ${run.cwd}`, sessionId: run.resume })
    }
  }

  const wrap = yield* Launcher.prepare({ provider, cwd: run.cwd })
  const query = yield* sdk
    .open(buildOptions(run, config, sessionId), { wrap })
    .pipe(Effect.mapError((e) => sessionNotFound(e.message, sessionId) ?? fromSdkError(e)))
  const watchdog = run.watchdog !== undefined ? yield* Watchdog.make(run.watchdog) : null

  const ctx = { sessionId, resumed: run.resume !== undefined, capUsd: run.spendCapUsd ?? null }
  let state = initialState
  let closed: { readonly error: AgentError | null } | null = null
  const pending = new Map<string, Deferred.Deferred<Landing, AgentError>>()
  const turnEnds = new Map<string, Deferred.Deferred<TurnOutcome, AgentError>>()
  const pubsub = yield* PubSub.unbounded<AgentEvent | typeof End>()
  /** Replayed to subscriptions made after `init`, so every subscription starts with it. */
  let sessionStarted: AgentEvent | null = null
  /** For telling a clean `end` after a failed turn from a crash (see `isCleanExitAfterFailedTurn`). */
  let endRequested = false
  let lastTurnFailed = false

  const turnEnd = (turnId: string) => {
    let d = turnEnds.get(turnId)
    if (d === undefined) {
      d = Deferred.makeUnsafe<TurnOutcome, AgentError>()
      turnEnds.set(turnId, d)
    }
    return d
  }

  const land = (messageId: string, turnId: TurnId) => {
    const d = pending.get(messageId)
    pending.delete(messageId)
    return d === undefined ? Effect.void : Deferred.succeed(d, { turnId })
  }

  const apply = (result: Step) =>
    Effect.gen(function* () {
      state = result.state
      for (const event of result.events) {
        if (watchdog !== null) yield* watchdog.observe(event)
        if (event._tag === "TurnStarted") turnEnd(event.turnId)
        if (event._tag === "SessionStarted") sessionStarted = event
        if (event._tag === "TurnEnded") lastTurnFailed = event.outcome._tag !== "Succeeded"
        yield* PubSub.publish(pubsub, event)
        if (event._tag === "TurnStarted") yield* land(event.turnId, event.turnId)
        else if (event._tag === "MessageLanded") yield* land(event.messageId, event.turnId)
        else if (event._tag === "TurnEnded") yield* Deferred.succeed(turnEnd(event.turnId), event.outcome)
      }
      for (const { messageId, state: lifecycle } of result.dropped) {
        const d = pending.get(messageId)
        pending.delete(messageId)
        if (d !== undefined) yield* Deferred.fail(d, agentError(`message ${messageId} was ${lifecycle} by Claude Code`))
      }
    })

  /** How the frame stream ended. */
  type Ending =
    | { readonly _tag: "Exited" }
    | { readonly _tag: "Died"; readonly error: ClaudeSdk.ClaudeSdkError }
    | { readonly _tag: "Defect"; readonly cause: unknown }
    | { readonly _tag: "Closed" }

  const finish = (reported: Ending) =>
    Effect.gen(function* () {
      if (closed !== null) return
      const ending: Ending =
        reported._tag === "Died" &&
        isCleanExitAfterFailedTurn(reported.error, { endRequested, turnRunning: state.turn !== null, lastTurnFailed })
          ? { _tag: "Exited" }
          : reported
      const error =
        ending._tag === "Died"
          ? fromSdkError(ending.error)
          : ending._tag === "Defect"
            ? agentError(`bug while reading Claude Code frames: ${String(ending.cause)}`, ending.cause)
            : null
      // Closed first, so calls made as soon as the last turn resolves already fail.
      closed = { error }
      if (ending._tag !== "Closed") {
        const failure: ProcessFailure | null =
          ending._tag === "Died"
            ? { message: ending.error.message, signal: ending.error.signal, exitCode: ending.error.exitCode }
            : ending._tag === "Defect"
              ? { message: error!.message, signal: null, exitCode: null }
              : null
        yield* apply(stepExit({ ...ctx, nowMs: 0 }, state, failure))
      }
      const reason = error ?? agentError(ending._tag === "Closed" ? "session closed" : "Claude Code exited")
      for (const d of pending.values()) yield* Deferred.fail(d, reason)
      pending.clear()
      for (const d of turnEnds.values()) yield* Deferred.fail(d, reason)
      yield* PubSub.publish(pubsub, End)
    })

  const consumer = yield* query.frames.pipe(
    Stream.runForEach((frame) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          apply(step({ ...ctx, nowMs, nextPending: pending.keys().next().value ?? null }, state, frame)),
        ),
      ),
    ),
    Effect.matchCauseEffect({
      onSuccess: () => finish({ _tag: "Exited" }),
      onFailure: (cause) => {
        const failed = Cause.findErrorOption(cause)
        if (Option.isSome(failed)) return finish({ _tag: "Died", error: failed.value })
        const defect = cause.reasons.find(Cause.isDieReason)
        return finish(defect !== undefined ? { _tag: "Defect", cause: defect.defect } : { _tag: "Closed" })
      },
    }),
    Effect.onInterrupt(() => finish({ _tag: "Closed" })),
    Effect.forkScoped,
  )

  // Watchdog: a stalled turn is interrupted; if it hasn't ended after the
  // grace period, the process is killed (and the session ends with it).
  if (watchdog !== null) {
    const grace = run.watchdog?.grace ?? config.stallGrace ?? Duration.seconds(10)
    yield* watchdog.expirations.pipe(
      Stream.runForEach((expiry) =>
        Effect.gen(function* () {
          if (closed !== null || state.turn?.turnId !== expiry.turnId) return
          state = markStalled(state, expiry.turnId, { idleMs: expiry.idleMs, inTool: expiry.inTool })
          yield* query.interrupt.pipe(Effect.ignore)
          const ended = yield* Deferred.await(turnEnd(expiry.turnId)).pipe(
            Effect.exit,
            Effect.timeoutOption(grace),
          )
          if (Option.isNone(ended)) yield* query.kill
        }),
      ),
      Effect.forkScoped,
    )
  }

  const ensureOpen = Effect.suspend(() =>
    closed === null ? Effect.void : Effect.fail(closed.error ?? agentError("session has ended")),
  )

  const submit = (input: Input, priority: "next" | "later") =>
    Effect.gen(function* () {
      const uuid = randomUUID()
      const id = MessageId.make(uuid)
      const landed = Deferred.makeUnsafe<Landing, AgentError>()
      // Check and register in one step, so `finish` either sees this entry or we see `closed`.
      yield* Effect.suspend(() => {
        if (closed !== null) return Effect.fail(closed.error ?? agentError("session has ended"))
        pending.set(id, landed)
        return Effect.void
      })
      const message: SDKUserMessage = {
        type: "user",
        message: { role: "user", content: input },
        parent_tool_use_id: null,
        uuid,
        priority,
      }
      yield* query.send(message).pipe(
        Effect.mapError(fromSdkError),
        Effect.tapError(() => Effect.sync(() => pending.delete(id))),
      )
      return { id, landed }
    })

  const busy = () => state.turn !== null || pending.size > 0

  const send = (input: Input) =>
    Effect.suspend(() => submit(input, busy() ? "later" : "next")).pipe(Effect.map(({ id }) => id))

  const turn = (input: Input) =>
    Effect.gen(function* () {
      const { landed } = yield* submit(input, busy() ? "later" : "next")
      const { turnId } = yield* Deferred.await(landed)
      const outcome = yield* Deferred.await(turnEnd(turnId))
      if (outcome._tag === "Succeeded") return outcome satisfies TurnSucceeded
      return yield* Effect.fail(outcome)
    })

  const steer = (input: Input) =>
    Effect.gen(function* () {
      const running = state.turn?.turnId ?? null
      const { id, landed } = yield* submit(input, "next")
      const { turnId } = yield* Deferred.await(landed)
      return running !== null && turnId === running
        ? ({ _tag: "Landed", messageId: id, turnId } as const)
        : ({ _tag: "StartedNewTurn", messageId: id, turnId } as const)
    })

  const interrupt = ensureOpen.pipe(
    Effect.andThen(Effect.sync(() => (state = markInterrupt(state)))),
    Effect.andThen(query.interrupt.pipe(Effect.mapError(fromSdkError))),
  )

  const end = Effect.sync(() => {
    endRequested = true
  }).pipe(
    Effect.andThen(query.endInput),
    Effect.andThen(Fiber.await(consumer)),
    Effect.andThen(Effect.suspend(() => (closed?.error ? Effect.fail(closed.error) : Effect.void))),
  )

  const subscribe = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubsub)
    const tail = Stream.suspend(() => (closed?.error ? Stream.fail(closed.error) : Stream.empty))
    if (closed !== null) return tail
    const prefix = sessionStarted
    return Stream.fromSubscription(subscription).pipe(
      Stream.takeWhile((item): item is AgentEvent => item !== End),
      // Published between subscribing and reading `sessionStarted`: already in the prefix.
      Stream.filter((event) => event !== prefix),
      (live) => (prefix === null ? live : Stream.concat(Stream.make(prefix), live)),
      Stream.concat(tail),
    )
  })
  const events: Stream.Stream<AgentEvent, AgentError> = Stream.unwrap(subscribe)

  const session: AgentSession = {
    sessionId,
    provider,
    location: Option.some(transcript),
    pid: Effect.succeed(query.pid),
    subscribe,
    events,
    send,
    turn,
    steer,
    interrupt,
    end,
  }
  return session
})

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const isSet = (value: string | undefined) => value !== undefined && value !== "" && value !== "none"

/**
 * Whether the CLI has credentials. Signed out, `accountInfo()` is just
 * `{ tokenSource: "none", apiProvider: "firstParty" }`; an OAuth login adds
 * `email`, an API key `apiKeySource`. Third-party providers (Bedrock, Vertex,
 * a gateway) authenticate outside the CLI, so they count as signed in.
 *
 * @internal
 */
export const signedIn = (account: AccountInfo): boolean =>
  (account.apiProvider !== undefined && account.apiProvider !== "firstParty") ||
  isSet(account.email) ||
  isSet(account.apiKeySource) ||
  isSet(account.tokenSource)

const isoToDateTime = (iso: unknown): DateTime.Utc | null =>
  typeof iso === "string" ? Option.getOrNull(Option.map(DateTime.make(iso), DateTime.toUtc)) : null

const percent = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null)


/**
 * Windows from the usage API's `rate_limits`: every named window
 * (`five_hour`, `seven_day`, `seven_day_opus`, ...; `utilization` is already
 * 0-100, `resets_at` ISO), plus `model_scoped` entries labelled
 * `model_scoped:<name>`. Falls back to the `limits[]` list when no named
 * window is present.
 *
 * @internal
 */
export const usageWindows = (rateLimits: unknown): Array<LimitWindowStatus> => {
  if (typeof rateLimits !== "object" || rateLimits === null) return []
  const r = rateLimits as Record<string, unknown>
  const windows: Array<LimitWindowStatus> = []
  for (const [label, value] of Object.entries(r)) {
    if (label === "extra_usage" || typeof value !== "object" || value === null || Array.isArray(value)) continue
    const w = value as Record<string, unknown>
    if (!("utilization" in w) || !("resets_at" in w)) continue
    windows.push({
      window: normalizeWindow(label),
      label,
      usedPercent: percent(w.utilization),
      resetsAt: isoToDateTime(w.resets_at),
      model: modelOfLabel(label),
    })
  }
  if (Array.isArray(r.model_scoped)) {
    for (const value of r.model_scoped as ReadonlyArray<Record<string, unknown>>) {
      if (typeof value?.display_name !== "string") continue
      windows.push({
        window: "other",
        label: `model_scoped:${value.display_name}`,
        usedPercent: percent(value.utilization),
        resetsAt: isoToDateTime(value.resets_at),
        model: Option.some(modelFamily(value.display_name)),
      })
    }
  }
  if (windows.length === 0 && Array.isArray(r.limits)) {
    for (const value of r.limits as ReadonlyArray<Record<string, unknown>>) {
      if (typeof value?.kind !== "string") continue
      const model = (value.scope as { model?: { display_name?: unknown } } | null | undefined)?.model?.display_name
      const window: LimitWindow = value.kind === "session" ? "five_hour" : value.kind === "weekly_all" ? "weekly" : "other"
      windows.push({
        window,
        label: typeof model === "string" ? `model_scoped:${model}` : value.kind,
        usedPercent: percent(value.percent),
        resetsAt: isoToDateTime(value.resets_at),
        model: typeof model === "string" ? Option.some(modelFamily(model)) : Option.none(),
      })
    }
  }
  return windows
}

/**
 * `AccountStatus` from what an idle CLI reported. `usage_limited` when an
 * account-wide window is at 100% and paid extra usage can't take over;
 * `spend_limited` when extra usage says its spend limit is reached and it is
 * what meters this account (no plan window reports usage). A plan account
 * whose extra usage is exhausted is still usable while its windows have room.
 *
 * @internal
 */
export const accountStatus = (snapshot: ClaudeSdk.StatusSnapshot, checkedAt: DateTime.Utc): AccountStatus => {
  const usage = snapshot.usage as (ClaudeSdk.StatusSnapshot["usage"] & { readonly rate_limits?: unknown }) | null
  const windows = usageWindows(usage?.rate_limits)
  const extra = (usage?.rate_limits as { readonly extra_usage?: Record<string, unknown> | null } | null | undefined)
    ?.extra_usage
  const spendReached = extra?.spend_limit_reached === true
  const overage = extra?.is_enabled === true && !spendReached
  // A full per-model window stops only that model, so it doesn't make the account unusable.
  const accountWide = windows.filter((w) => Option.isNone(w.model))
  const reason: AccountStatus["reason"] = !signedIn(snapshot.account)
    ? "unauthenticated"
    : accountWide.some((w) => (w.usedPercent ?? 0) >= 100) && !overage
      ? "usage_limited"
      : spendReached && !accountWide.some((w) => w.usedPercent !== null)
        ? "spend_limited"
        : null
  const plan = usage?.subscription_type ?? snapshot.account.subscriptionType ?? null
  return { provider, usable: reason === null, reason, windows, plan, checkedAt }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The CLI's marker for an interrupted turn, e.g. `[Request interrupted by user for tool use]`. */
const interruptMarker = /^\[Request interrupted by user/

/** A real prompt's text: string content, or blocks with no `tool_result` (images count, as no text). */
const promptText = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content) || content.length === 0) return null
  const blocks = content as ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>
  if (blocks.some((b) => b?.type === "tool_result")) return null
  return blocks.flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n")
}

/** Output the CLI records for a local command (`/compact`, ...); not a prompt. */
const localCommandOutput = /^<local-command-(stdout|stderr|caveat)>/

/** A local command as typed: `<command-name>/compact</command-name>...<command-args>x</command-args>` is `/compact x`. */
const localCommand = (text: string): string => {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]
  if (name === undefined) return text
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ""
  return `${name} ${args}`.trim()
}

const historyTags: ReadonlySet<AgentEvent["_tag"]> = new Set(["Text", "ToolCall", "ToolResult", "Compacted"])

/**
 * A transcript (`getSessionMessages`) as events. Each prompt starts a turn
 * (its uuid, which for messages sent through this library is the `MessageId`,
 * is the `TurnId`) unless the CLI recorded it as delivered into the running
 * turn (`isQueuedCommand`, a steer); a local command such as `/compact` is
 * shown as typed, and its output skipped. The CLI's interrupt marker ends the turn
 * `Interrupted`; nothing else in a transcript records how a turn ended, so
 * other turns have no `TurnEnded`.
 *
 * @internal
 */
export const historyEvents = (messages: ReadonlyArray<SessionMessage>): Array<AgentEvent> => {
  const events: Array<AgentEvent> = []
  let turnId: TurnId | null = null
  let lastStop: unknown = null
  for (const m of messages) {
    const raw = m
    const flags = m as SessionMessage & {
      readonly isMeta?: boolean
      readonly is_meta?: boolean
      readonly isCompactSummary?: boolean
      readonly isQueuedCommand?: boolean
    }
    const meta = flags.isMeta === true || flags.is_meta === true || flags.isCompactSummary === true
    const message = (typeof m.message === "object" && m.message !== null ? m.message : {}) as {
      readonly content?: unknown
      readonly stop_reason?: unknown
    }
    if (m.type === "user" && m.parent_tool_use_id === null && !meta) {
      const content = promptText(message.content)
      if (content !== null && localCommandOutput.test(content.trim())) continue
      const text = content === null ? null : localCommand(content)
      if (text !== null) {
        if (interruptMarker.test(text.trim())) {
          if (turnId !== null) {
            events.push({ _tag: "TurnEnded", turnId, outcome: new Interrupted({ message: text.trim() }), usage: null, cost: null, raw })
            turnId = null
          }
          continue
        }
        const steered = turnId !== null && flags.isQueuedCommand === true && lastStop !== "end_turn"
        if (!steered) {
          turnId = TurnId.make(m.uuid)
          events.push({ _tag: "TurnStarted", turnId, raw })
        }
        events.push({ _tag: "UserMessage", turnId, messageId: MessageId.make(m.uuid), text, raw })
        continue
      }
    }
    if (m.type === "assistant" && m.parent_tool_use_id === null) lastStop = message.stop_reason ?? null
    for (const event of frameEvents(m as unknown as ClaudeSdk.Frame, turnId)) {
      if (historyTags.has(event._tag)) events.push({ ...event, raw } as AgentEvent)
    }
  }
  return events
}

/**
 * `Capabilities` for a Claude Code CLI version (null when unknown).
 *
 * @since 0.1.0
 * @category constructors
 */
export const capabilities = (version: string | null): Capabilities => ({
  provider,
  version,
  steer: true,
  queue: true,
  resume: true,
  cost: "reported",
  spendCap: "native",
  resetTimes: true,
  hooks: true,
  reattach: false,
  disable: { askUser: true, subagents: true, tools: "any" },
})

/**
 * `Agent` backed by Claude Code; requires `ClaudeSdk`.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: ClaudeAgentOptions = {}): Layer.Layer<Agent, never, ClaudeSdk.ClaudeSdk> =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const sdk = yield* ClaudeSdk.ClaudeSdk
      return Agent.of({
        provider,
        capabilities: (options.pathToClaudeCodeExecutable !== undefined ? Effect.succeed(null) : sdk.version).pipe(
          Effect.map(capabilities),
        ),
        open: (run) => openSession(sdk, options, run),
        status: (statusOptions = {}) =>
          Effect.gen(function* () {
          const cwd = tmpdir()
          const wrap = yield* Launcher.prepare({ provider, cwd })
          const config = { ...options, env: { ...options.env, ...statusOptions.env } }
          const snapshot = yield* sdk.status(buildStatusOptions(config, cwd), { wrap }).pipe(
            Effect.mapError(fromSdkError),
            Effect.timeoutOrElse({
              duration: Duration.seconds(30),
              orElse: () => Effect.fail(agentError("status: Claude Code did not answer within 30 seconds")),
            }),
          )
          return accountStatus(snapshot, yield* DateTime.now)
        }).pipe(Effect.scoped),
        history: (sessionId, { cwd }) =>
          sdk.history({ sessionId, cwd, transcript: location({ cwd }, sessionId, options) }).pipe(
            Effect.mapError(fromSdkError),
            Effect.flatMap((history) =>
              history === null
                ? Effect.fail(new SessionNotFound({ message: `No Claude Code session ${sessionId} for ${cwd}`, sessionId }))
                : Effect.succeed(historyEvents(history.messages)),
            ),
          ),
      })
    }),
  )
