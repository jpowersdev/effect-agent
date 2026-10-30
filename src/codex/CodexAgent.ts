/**
 * `Agent` backed by `codex app-server` (JSON-RPC over stdio), one app-server
 * process per session.
 *
 * ```ts skip-type-checking
 * import { CodexAgent, CodexAppServer } from "@jpowersdev/effect-agent/codex"
 * CodexAgent.layer({ pricing }).pipe(
 *   Layer.provide(CodexAppServer.layer()),
 *   Layer.provide(NodeServices.layer),
 * )
 * ```
 *
 * Every thread runs with approvals and the sandbox off
 * (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`) and with MCP
 * isolated (no configured MCP servers, no built-in `codex_apps`).
 *
 * `status` and `history` each start a short-lived app-server (through the
 * `Launcher`, if any) and stop it before returning. `RunOptions.hooks` is
 * refused: Codex hooks are config-only, with no runtime callbacks.
 *
 * @since 0.1.0
 */
import { Cause, Clock, Deferred, Duration, Effect, Exit, Layer, Option, Queue, Stream } from "effect"
import {
  type AccountStatus,
  Agent,
  type AgentSession,
  type Capabilities,
  type Effort,
  type RunOptions,
  type SteerOutcome,
} from "../Agent.ts"
import { AgentError, ProcessKilled, type SessionClosed, SessionNotFound, SpendCapReached, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnSucceeded } from "../AgentEvent.ts"
import { MessageId, SessionId, type TokenUsage, TurnId } from "../Domain.ts"
import * as Env from "../internal/env.ts"
import * as Session from "../internal/session.ts"
import * as Pricing from "../Pricing.ts"
import type * as Watchdog from "../Watchdog.ts"
import { CodexAppServer, CodexRpcError, type Connection, type ProcessExit, parseUserAgentVersion } from "./CodexAppServer.ts"
import * as Events from "./CodexEvents.ts"
import * as P from "./protocol.ts"

const provider = "codex"

/**
 * Options for `make` and `layer`.
 *
 * @since 0.1.0
 * @category models
 */
export interface CodexAgentOptions {
  /** Token prices for estimated cost and `spendCapUsd`. Without them cost is unknown and spend caps are refused. */
  readonly pricing?: Pricing.PriceTable
  /** Extra per-thread config overrides (dotted config.toml keys). effect-agent's own settings win on conflict. */
  readonly config?: Readonly<Record<string, P.JsonValue>>
  /** Default for `RunOptions.watchdog.grace` (10 seconds when neither is set). */
  readonly stallGrace?: Duration.Input
}

// ---------------------------------------------------------------------------
// RunOptions -> app-server params (pure)
// ---------------------------------------------------------------------------

/**
 * effect-agent effort -> Codex `model_reasoning_effort`. `max` maps to `xhigh` (Codex's `ultra` also turns on multi-agent).
 *
 * @internal
 */
export const codexEffort = (effort: Effort): string => (effort === "max" ? "xhigh" : effort)

/**
 * `disable.tools` names -> per-thread config that removes them. Verified on
 * 0.162.1 by listing the model's tools with each switch off. Names not in
 * this table (e.g. `apply_patch`, `spawn_agent`) can't be removed per thread.
 *
 * @internal
 */
export const toolSwitches: Readonly<Record<string, Readonly<Record<string, P.JsonValue>>>> = {
  shell: { "features.shell_tool": false, "features.unified_exec": false },
  exec_command: { "features.shell_tool": false, "features.unified_exec": false },
  write_stdin: { "features.shell_tool": false, "features.unified_exec": false },
  web_search: { web_search: "disabled" },
  image_generation: { "features.image_generation": false },
  view_image: { "features.view_image": false },
  sleep: { "features.sleep_tool": false },
  goals: { "features.goals": false },
  request_user_input: { "features.default_mode_request_user_input": false },
}

const subagentNote =
  "Do not spawn sub-agents or use the collaboration tools (spawn_agent, send_message, followup_task, wait_agent); do the work yourself."

/**
 * Thread overrides shared by `thread/start` and `thread/resume`. Fails on tool names Codex can't disable.
 *
 * @internal
 */
export const threadOverrides = (
  options: RunOptions,
  extraConfig: Readonly<Record<string, P.JsonValue>> = {},
): { readonly overrides: P.ThreadOverrides } | { readonly error: string } => {
  const tools: Record<string, P.JsonValue> = {}
  const unknown: Array<string> = []
  for (const name of options.disable?.tools ?? []) {
    const sw = toolSwitches[name]
    if (sw === undefined) unknown.push(name)
    else Object.assign(tools, sw)
  }
  if (unknown.length > 0) {
    return {
      error: `Codex cannot disable tool(s) ${unknown.join(", ")}; supported: ${Object.keys(toolSwitches).join(", ")}`,
    }
  }
  const config: Record<string, P.JsonValue> = {
    ...extraConfig,
    // MCP isolation: no configured servers, and no built-in codex_apps (ChatGPT apps/connectors).
    mcp_servers: {},
    "features.apps": false,
    ...(options.effort !== undefined ? { model_reasoning_effort: codexEffort(options.effort) } : {}),
    // `request_user_input` is already refused in Default mode; this keeps it off if the default changes.
    ...(options.disable?.askUser ? { "features.default_mode_request_user_input": false } : {}),
    // Not honored by 0.162.1 (subagents still spawn); kept for servers that do honor it.
    ...(options.disable?.subagents ? { "features.multi_agent": false } : {}),
    ...tools,
  }
  const instructions = [options.appendSystemPrompt, options.disable?.subagents ? subagentNote : undefined].filter(
    (s): s is string => s !== undefined && s !== "",
  )
  return {
    overrides: {
      cwd: options.cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config,
      // Appends to Codex's instructions; `baseInstructions` would replace them.
      ...(instructions.length > 0 ? { developerInstructions: instructions.join("\n\n") } : {}),
    },
  }
}

/**
 * Host variables that describe a parent agent session.
 *
 * @internal
 */
export const isNestingMarker: (name: string) => boolean = Env.isNestingMarker

/**
 * The env overrides for app-server (applied over the host env by the
 * spawner): nesting markers and Claude Code's credentials removed (Codex
 * would pass them to every command it runs), then `RunOptions.env`.
 *
 * @internal
 */
export const sessionEnv = (
  host: Readonly<Record<string, string | undefined>>,
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => Env.overrides(host, overrides, Env.claudeCredentials)

/**
 * app-server's answers for a thread it has no record of.
 *
 * @internal
 */
export const isSessionNotFoundError = (e: CodexRpcError): boolean =>
  /no rollout found|invalid session id|thread not found|thread not loaded|invalid thread id/i.test(e.message)

/**
 * Codex has no runtime hook callbacks; refuse rather than silently ignore them.
 *
 * @internal
 */
export const hooksError = (options: RunOptions): string | null => {
  const hooks = options.hooks
  if (hooks === undefined) return null
  const set = (["beforeTool", "afterTool", "beforeStop"] as const).filter((k) => hooks[k] !== undefined)
  return set.length === 0
    ? null
    : `Codex does not support RunOptions.hooks (${set.join(", ")}): its hooks are config-only (capabilities.hooks is false)`
}

/**
 * `turn/steer` failed because the expected turn is no longer running.
 *
 * @internal
 */
export const isStaleSteerError = (e: CodexRpcError): boolean =>
  e.code === P.INVALID_REQUEST && /no active turn|expected active turn id|not steerable/i.test(e.message)

const textInput = (text: string): ReadonlyArray<P.UserInput> => [{ type: "text", text, text_elements: [] }]

const agentError = Session.agentError(provider)
const sessionClosed = Session.sessionClosed(provider)
const timed = Session.timed(provider)

const toAgentError = (what: string) => (e: CodexRpcError | AgentError) =>
  e._tag === "AgentError" ? e : agentError(`${what}: ${e.message}`, e)

// ---------------------------------------------------------------------------
// Turn tracking (pure)
// ---------------------------------------------------------------------------

/**
 * The turn this session is running (or starting: `turnId` is null until
 * `turn/start` answers or `turn/started` arrives).
 *
 * @internal
 */
export interface Run {
  /** Tells runs apart while `turn/start` is in flight. */
  readonly seq: number
  readonly turnId: TurnId | null
  /** Messages sent into this turn whose `userMessage` item hasn't arrived yet. */
  readonly unlanded: ReadonlyArray<MessageId>
  readonly announced: boolean
  readonly interruptRequested: boolean
  readonly spendCap: { readonly capUsd: number; readonly spentUsd: number } | null
  /** The watchdog stopped this turn. */
  readonly stalled: { readonly idleMs: number; readonly inTool: boolean } | null
  readonly agentMessages: ReadonlyArray<{ readonly text: string; readonly phase: string | null }>
  /** commandExecution items started in this turn. */
  readonly commandItems: ReadonlySet<string>
  readonly usageAtStart: TokenUsage
  readonly sawUsage: boolean
}

/**
 * Session state folded by `step`.
 *
 * @internal
 */
export interface State {
  readonly run: Run | null
  readonly nextSeq: number
  /** Thread total before this session's first model call (resumed threads carry history). */
  readonly usageBase: TokenUsage | null
  readonly sessionUsage: TokenUsage
  /** Estimated spend when the cap was reached. */
  readonly capReached: number | null
}

/**
 * `State` before any frame.
 *
 * @internal
 */
export const initialState: State = { run: null, nextSeq: 1, usageBase: null, sessionUsage: Events.zeroUsage, capReached: null }

/**
 * Per-frame input to `step`.
 *
 * @internal
 */
export interface StepContext {
  readonly threadId: string
  readonly nowMs: number
  /** `mapNotification`'s own bookkeeping (announced tool calls, heartbeat throttle, rate limits). */
  readonly mapState: Events.MapState
  /** `RunOptions.spendCapUsd`, when there is a price to estimate spend with. */
  readonly cap: { readonly capUsd: number; readonly price: Pricing.ModelPrice } | null
}

/**
 * What the session must do for a frame besides emitting events.
 *
 * @internal
 */
export type Command =
  /** The spend cap was reached mid-turn: stop it. */
  | { readonly _tag: "Interrupt"; readonly turnId: TurnId }
  /** Our turn completed: gather what `completeTurn` needs, then end it. */
  | { readonly _tag: "Complete"; readonly turn: P.Turn; readonly raw: P.Incoming }

/**
 * The result of `step`.
 *
 * @internal
 */
export interface Step {
  readonly state: State
  readonly events: ReadonlyArray<AgentEvent>
  readonly commands: ReadonlyArray<Command>
}

const newRun = (state: State, messages: ReadonlyArray<MessageId>): Run => ({
  seq: state.nextSeq,
  turnId: null,
  unlanded: messages,
  announced: false,
  interruptRequested: false,
  spendCap: null,
  stalled: null,
  agentMessages: [],
  commandItems: new Set(),
  usageAtStart: state.sessionUsage,
  sawUsage: false,
})

/**
 * A run for `messageId`, about to be sent with `turn/start`.
 *
 * @internal
 */
export const startRun = (state: State, messageId: MessageId): State => ({
  ...state,
  run: newRun(state, [messageId]),
  nextSeq: state.nextSeq + 1,
})

const updateRun = (state: State, seq: number, f: (run: Run) => Run): State =>
  state.run === null || state.run.seq !== seq ? state : { ...state, run: f(state.run) }

/**
 * `turn/start` answered: the run's turn id, unless `turn/started` already gave it.
 *
 * @internal
 */
export const runStarted = (state: State, seq: number, turnId: string): State =>
  updateRun(state, seq, (run) => ({ ...run, turnId: run.turnId ?? TurnId.make(turnId) }))

/**
 * `turn/start` failed (or timed out). If app-server announced the turn
 * anyway (`turn/started`), it is running: keep it and return its id.
 * Otherwise no turn is running.
 *
 * @internal
 */
export const runFailed = (state: State, seq: number): { readonly state: State; readonly running: TurnId | null } => {
  const run = state.run
  if (run === null || run.seq !== seq) return { state, running: null }
  if (run.announced && run.turnId !== null) return { state, running: run.turnId }
  return { state: { ...state, run: null }, running: null }
}

/**
 * Whether `steer` can go into the running turn.
 *
 * @internal
 */
export const steerable = (run: Run | null): run is Run & { readonly turnId: TurnId } =>
  run !== null && run.turnId !== null && !run.interruptRequested && run.spendCap === null && run.stalled === null

/**
 * A message steered into the run: it lands when its `userMessage` item arrives.
 *
 * @internal
 */
export const addSteer = (state: State, seq: number, messageId: MessageId): State =>
  updateRun(state, seq, (run) => ({ ...run, unlanded: [...run.unlanded, messageId] }))

/**
 * A steer that didn't go through.
 *
 * @internal
 */
export const removeSteer = (state: State, seq: number, messageId: MessageId): State =>
  updateRun(state, seq, (run) => ({ ...run, unlanded: run.unlanded.filter((id) => id !== messageId) }))

/**
 * The caller interrupted the run.
 *
 * @internal
 */
export const markInterrupt = (state: State, seq: number): State =>
  updateRun(state, seq, (run) => ({ ...run, interruptRequested: true }))

/**
 * The watchdog is stopping turn `turnId`; unchanged (and `false`) if that turn isn't running or is already stopping.
 *
 * @internal
 */
export const markStalled = (
  state: State,
  turnId: TurnId,
  stall: { readonly idleMs: number; readonly inTool: boolean },
): { readonly state: State; readonly marked: boolean } => {
  const run = state.run
  if (run === null || run.turnId !== turnId || run.stalled !== null) return { state, marked: false }
  return { state: { ...state, run: { ...run, stalled: stall } }, marked: true }
}

const other = (state: State, raw: P.Incoming): Step => ({ state, events: [{ _tag: "Other", raw }], commands: [] })

const tokenUsage = (ctx: StepContext, state: State, n: P.TokenUsageNotification): { readonly state: State; readonly commands: ReadonlyArray<Command> } => {
  const total = Events.toTokenUsage(n.tokenUsage.total)
  const usageBase = state.usageBase ?? Events.subtractUsage(total, Events.toTokenUsage(n.tokenUsage.last))
  const sessionUsage = Events.subtractUsage(total, usageBase)
  const run = state.run !== null ? { ...state.run, sawUsage: true } : null
  const next: State = { ...state, usageBase, sessionUsage, run }
  if (ctx.cap === null) return { state: next, commands: [] }
  const spent = Pricing.costOf(ctx.cap.price, sessionUsage)
  if (spent < ctx.cap.capUsd) return { state: next, commands: [] }
  const capped: State = { ...next, capReached: next.capReached ?? spent }
  if (run === null || run.turnId === null || run.spendCap !== null || run.stalled !== null || run.interruptRequested) {
    return { state: capped, commands: [] }
  }
  return {
    state: { ...capped, run: { ...run, spendCap: { capUsd: ctx.cap.capUsd, spentUsd: spent } } },
    commands: [{ _tag: "Interrupt", turnId: run.turnId }],
  }
}

/**
 * Fold one frame from app-server into the session state. A completed turn
 * isn't ended here: `Complete` asks the session to gather what
 * `completeTurn` needs first.
 *
 * @internal
 */
export const step = (ctx: StepContext, state: State, msg: P.Incoming): Step => {
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as {
    readonly threadId?: unknown
  }
  // Subagent threads share the connection; their turns aren't ours.
  if (typeof params.threadId === "string" && params.threadId !== ctx.threadId) return other(state, msg)
  let commands: ReadonlyArray<Command> = []
  if (!("id" in msg && msg.id !== undefined)) {
    switch (msg.method as P.NotificationMethod) {
      case "turn/started": {
        const turnId = TurnId.make((msg.params as P.TurnNotification).turn.id)
        // A turn we didn't start (e.g. app-server continuing one) still gets tracked.
        const run = state.run ?? newRun(state, [])
        const nextSeq = state.run === null ? state.nextSeq + 1 : state.nextSeq
        const current = { ...run, turnId: run.turnId ?? turnId }
        if (current.turnId !== turnId || current.announced) return other({ ...state, run: current, nextSeq }, msg)
        return {
          state: { ...state, nextSeq, run: { ...current, announced: true } },
          events: [{ _tag: "TurnStarted", turnId, raw: msg }],
          commands: [],
        }
      }
      case "turn/completed": {
        const turn = (msg.params as P.TurnNotification).turn
        const run = state.run
        if (run === null || (run.turnId !== null && run.turnId !== turn.id)) return other(state, msg)
        const turnId = run.turnId ?? TurnId.make(turn.id)
        return {
          state: { ...state, run: { ...run, turnId, announced: true } },
          events: run.announced ? [] : [{ _tag: "TurnStarted", turnId, raw: msg }],
          commands: [{ _tag: "Complete", turn, raw: msg }],
        }
      }
      case "thread/tokenUsage/updated": {
        const next = tokenUsage(ctx, state, msg.params as P.TokenUsageNotification)
        state = next.state
        commands = next.commands
        break
      }
      case "item/started": {
        const item = (msg.params as P.ItemNotification).item
        const run = state.run
        if (P.isItem(item, "userMessage")) {
          const messageId =
            run === null
              ? undefined
              : item.clientId !== null && run.unlanded.includes(item.clientId as MessageId)
                ? (item.clientId as MessageId)
                : run.unlanded[0]
          if (run === null || messageId === undefined || run.turnId === null) return other(state, msg)
          return {
            state: { ...state, run: { ...run, unlanded: run.unlanded.filter((id) => id !== messageId) } },
            events: [{ _tag: "MessageLanded", messageId, turnId: run.turnId, raw: msg }],
            commands: [],
          }
        }
        if (item.type === "commandExecution" && run !== null) {
          state = { ...state, run: { ...run, commandItems: new Set(run.commandItems).add(item.id) } }
        }
        break
      }
      case "item/completed": {
        const item = (msg.params as P.ItemNotification).item
        if (P.isItem(item, "agentMessage") && state.run !== null) {
          const run = state.run
          state = { ...state, run: { ...run, agentMessages: [...run.agentMessages, { text: item.text ?? "", phase: item.phase ?? null }] } }
        }
        break
      }
    }
  }
  return { state, events: Events.mapNotification(msg, ctx.mapState, ctx.nowMs), commands }
}

/**
 * What `completeTurn` needs from outside the frame: where the session must look before ending the turn.
 *
 * @internal
 */
export const completionNeeds = (run: Run, turn: P.Turn) => ({
  /** Interrupted with commands started: app-server leaves them running. */
  killCommands: turn.status === "interrupted" && run.commandItems.size > 0,
  /** A usage-limit failure: the reset time is in the rate limits. */
  rateLimits: turn.status === "failed" && Events.errorKind(turn.error?.codexErrorInfo) === "usageLimitExceeded",
  /** An interrupt nobody asked for usually means app-server is shutting down. */
  processExit: turn.status === "interrupted" && !run.interruptRequested && run.spendCap === null && run.stalled === null,
})

const turnUsageOf = (state: State, run: Run) => (run.sawUsage ? Events.subtractUsage(state.sessionUsage, run.usageAtStart) : null)

const costOf = (price: Pricing.ModelPrice | undefined, state: State) =>
  price !== undefined ? { usd: Pricing.costOf(price, state.sessionUsage), source: "estimated" as const } : null

/**
 * End the running turn from its `turn/completed`.
 *
 * @internal
 */
export const completeTurn = (
  ctx: Pick<StepContext, "cap">,
  state: State,
  input: {
    /** The run `Complete` was issued for. */
    readonly seq: number
    readonly turn: P.Turn
    readonly raw: P.Incoming
    readonly price: Pricing.ModelPrice | undefined
    readonly rateLimits: P.GetAccountRateLimitsResponse | null
    readonly processExit: ProcessExit | null
  },
): { readonly state: State; readonly events: ReadonlyArray<AgentEvent> } => {
  const run = state.run
  // Only the run the completion was for: if it was ended meanwhile (app-server died), nothing to do.
  if (run === null || run.seq !== input.seq || run.turnId === null) return { state, events: [] }
  const { turn } = input
  const messages =
    run.agentMessages.length > 0
      ? run.agentMessages
      : turn.items.flatMap((i) => (P.isItem(i, "agentMessage") ? [{ text: i.text ?? "", phase: i.phase ?? null }] : []))
  const outcome = Events.classifyOutcome(turn, {
    interruptRequested: run.interruptRequested,
    spendCap: run.spendCap,
    capUsd: ctx.cap?.capUsd ?? null,
    processExit: input.processExit,
    finalText: Events.finalTextOf(messages),
    rateLimits: input.rateLimits,
    stalled: run.stalled,
  })
  return {
    state: { ...state, run: null },
    events: [
      {
        _tag: "TurnEnded",
        turnId: run.turnId,
        outcome,
        usage: turnUsageOf(state, run),
        cost: costOf(input.price, state),
        raw: input.raw,
      },
    ],
  }
}

/**
 * app-server died: the running turn ends `dead` (or `Stalled`, if the watchdog killed it).
 *
 * @internal
 */
export const stepExit = (
  state: State,
  dead: ProcessKilled,
  exit: ProcessExit,
  price: Pricing.ModelPrice | undefined,
): { readonly state: State; readonly events: ReadonlyArray<AgentEvent> } => {
  const run = state.run
  if (run === null || run.turnId === null) return { state: { ...state, run: null }, events: [] }
  const outcome = run.stalled !== null ? Events.stalledFailure(run.stalled) : dead
  return {
    state: { ...state, run: null },
    events: [
      { _tag: "TurnEnded", turnId: run.turnId, outcome, usage: turnUsageOf(state, run), cost: costOf(price, state), raw: { exit } },
    ],
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A message waiting for its turn: `started` is the turn it started or landed in, or why it never did. */
interface Queued {
  readonly messageId: MessageId
  readonly input: string
  readonly started: Deferred.Deferred<TurnId, AgentError | SessionClosed | TurnFailure>
}

/** A message that never reached a turn, as `send` and `steer` report it. */
const asAgentError = (e: AgentError | SessionClosed | TurnFailure): AgentError | SessionClosed =>
  e._tag === "AgentError" || e._tag === "SessionClosed" ? e : agentError(e.message, e)

/** A failed request's cause as an `AgentError`. */
const causeError = (what: string, cause: Cause.Cause<CodexRpcError | AgentError>): AgentError => {
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) ? toAgentError(what)(error.value) : agentError(`${what}: ${Cause.pretty(cause)}`, Cause.squash(cause))
}

/** How a session's lifetime is going (owned by its actor). */
type Life =
  | { readonly _tag: "Open" }
  /** `end` is closing the connection. */
  | { readonly _tag: "Closing" }
  /**
   * The session gave up on app-server (`reason`: it stopped answering; null:
   * a stalled turn's kill, or a lost connection) and waits for the transport
   * to finish ending. Nothing more is started.
   */
  | { readonly _tag: "Failing"; readonly reason: string | null }
  /** Over: `error` is what `end` reports (null: ended cleanly). */
  | { readonly _tag: "Ended"; readonly error: AgentError | null }

/** A request's result as the actor gets it: none if it timed out. */
type Answer<A> = Option.Option<Exit.Exit<A, CodexRpcError | AgentError>>

/** The actor's answer to `send`, `turn` and `steer`. */
type SubmitReply =
  | { readonly _tag: "Unavailable"; readonly error: SessionClosed }
  | { readonly _tag: "CapReached"; readonly spent: number }
  | { readonly _tag: "Queued"; readonly q: Queued; readonly starting: boolean }
  | { readonly _tag: "Landed"; readonly turnId: TurnId }
  | { readonly _tag: "Failed"; readonly error: AgentError }

/** Everything the session's actor handles, one at a time. */
type Input =
  | { readonly _tag: "Frame"; readonly msg: P.Incoming }
  | { readonly _tag: "TransportEnded"; readonly exit: ProcessExit }
  | { readonly _tag: "Started"; readonly seq: number; readonly answer: Answer<P.TurnStartResponse> }
  | {
      readonly _tag: "Completed"
      readonly seq: number
      readonly rateLimits: P.GetAccountRateLimitsResponse | null
      readonly processExit: ProcessExit | null
      /** A request found the connection gone. */
      readonly lost: boolean
    }
  | { readonly _tag: "Submit"; readonly input: string; readonly front: boolean; readonly messageId: MessageId; readonly reply: Deferred.Deferred<SubmitReply> }
  | { readonly _tag: "Steer"; readonly input: string; readonly messageId: MessageId; readonly reply: Deferred.Deferred<SubmitReply> }
  | {
      readonly _tag: "Steered"
      readonly input: string
      readonly messageId: MessageId
      readonly seq: number
      readonly answer: Answer<P.TurnSteerResponse>
      readonly reply: Deferred.Deferred<SubmitReply>
      /** Its entry in `outstanding`. */
      readonly token: object
    }
  | { readonly _tag: "Interrupt"; readonly reply: Deferred.Deferred<TurnId | null, SessionClosed | AgentError> }
  | {
      readonly _tag: "Interrupted"
      readonly turnId: TurnId
      readonly answer: Answer<P.ClientRequests["turn/interrupt"]["result"]>
      readonly reply: Deferred.Deferred<TurnId | null, SessionClosed | AgentError>
      /** Its entry in `outstanding`. */
      readonly token: object
    }
  | { readonly _tag: "Stall"; readonly expiry: Watchdog.Expiry; readonly reply: Deferred.Deferred<boolean> }
  | { readonly _tag: "Kill" }
  | { readonly _tag: "End"; readonly reply: Deferred.Deferred<void, AgentError> }
  | { readonly _tag: "Closed" }

/** A request failed because the connection is gone (the transport's own error), not with app-server's answer. */
const lostIn = (exit: Exit.Exit<unknown, CodexRpcError | AgentError>): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), (e) => e._tag === "AgentError")

const openSession = Effect.fn("CodexAgent.open")(function* (
  server: CodexAppServer["Service"],
  agentOptions: CodexAgentOptions,
  options: RunOptions,
) {
  const built = threadOverrides(options, agentOptions.config)
  if ("error" in built) return yield* agentError(built.error)
  const hooksRefused = hooksError(options)
  if (hooksRefused !== null) return yield* agentError(hooksRefused)
  const pricing = agentOptions.pricing
  const capUsd = options.spendCapUsd
  if (capUsd !== undefined) {
    if (pricing === undefined) return yield* agentError("spendCapUsd needs CodexAgent.layer({ pricing }) on Codex")
    if (options.model !== undefined && Pricing.priceFor(pricing, options.model) === undefined) {
      return yield* agentError(`spendCapUsd: no price for model ${options.model}`)
    }
  }

  const conn: Connection = yield* server.connect({ cwd: options.cwd, env: sessionEnv(Env.host(), options.env) })
  const version = parseUserAgentVersion(conn.initialize.userAgent)
  // A failed open must not leave app-server running until the caller's scope closes.
  const closeOnError = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.tapError(self, () => conn.close)

  const resumed = options.resume !== undefined
  const started: P.ThreadStartResponse = resumed
    ? yield* timed("thread/resume", conn.request("thread/resume", { threadId: options.resume!, excludeTurns: true, ...built.overrides })).pipe(
        Effect.catchTag("CodexRpcError", (e) =>
          Effect.fail(
            isSessionNotFoundError(e)
              ? new SessionNotFound({ message: e.message, sessionId: options.resume! })
              : agentError(`thread/resume failed: ${e.message}`, e),
          ),
        ),
        closeOnError,
      )
    : yield* timed("thread/start", conn.request("thread/start", { ...built.overrides, ephemeral: false })).pipe(
        Effect.mapError(toAgentError("thread/start failed")),
        closeOnError,
      )

  const threadId = started.thread.id
  yield* Effect.annotateCurrentSpan({ provider, sessionId: threadId, resume: resumed })
  const model = started.model ?? started.thread.model ?? null
  const price = pricing !== undefined ? Pricing.priceFor(pricing, model) : undefined
  if (capUsd !== undefined && price === undefined) {
    yield* conn.close
    return yield* agentError(`spendCapUsd: no price for model ${model ?? "(unknown)"}`)
  }
  const cap = capUsd !== undefined && price !== undefined ? { capUsd, price } : null

  const runtime = yield* Session.make({ provider, watchdog: options.watchdog, stallGrace: agentOptions.stallGrace })
  const { turns } = runtime
  const scope = yield* Effect.scope
  yield* runtime.emit({
    _tag: "SessionStarted",
    sessionId: SessionId.make(threadId),
    provider,
    version,
    model,
    resumed,
    raw: { method: resumed ? "thread/resume" : "thread/start", result: started },
  })

  // ---- the session actor ----
  //
  // One fiber owns all of the state below and handles one input at a time,
  // without waiting on anything outside it: requests run in their own fibers
  // and come back as inputs. So there is no window between deciding on the
  // state and acting on it for another fiber to change it in.

  const mapState = Events.makeMapState()
  let state = initialState
  /** Messages waiting for the running turn to end. */
  const queue: Array<Queued> = []
  /** Messages whose turn/start was sent, by run, until their start is settled. */
  const claimed = new Map<number, Queued>()
  /** `end` was called: no new messages; close once the queue and the running turn are done. */
  let endRequested = false
  const endWaiters: Array<Deferred.Deferred<void, AgentError>> = []
  /** app-server's death, once seen (it is final before the transport has finished ending). */
  let dead: ProcessKilled | null = null
  /** The turn whose completion is gathering what it needs, and frames that arrived meanwhile. */
  let completing: { readonly seq: number; readonly turn: P.Turn; readonly raw: P.Incoming } | null = null
  const held: Array<P.Incoming> = []
  let life: Life = { _tag: "Open" }
  /**
   * Callers whose reply went with a request (steer, interrupt), until its
   * answer comes back. If the session's scope closes first, that request's
   * fiber is interrupted and never answers, so the finalizer settles these.
   */
  const outstanding = new Map<object, (error: SessionClosed) => void>()

  const inbox = yield* Queue.unbounded<Input>()
  const tell = (input: Input) => Effect.asVoid(Queue.offer(inbox, input))
  /** Ask the actor, and wait for its answer; at once if the session is over. */
  const ask = <A, E>(make: (reply: Deferred.Deferred<A, E>) => Input, over: () => Exit.Exit<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      if (life._tag === "Ended") return over()
      const reply = Deferred.makeUnsafe<A, E>()
      Queue.offerUnsafe(inbox, make(reply))
      return Deferred.await(reply)
    })
  /** Run `self` in the session's scope, sending its result back to the actor. */
  const launch = <A>(self: Effect.Effect<A>, back?: (a: A) => Input) =>
    Effect.asVoid(Effect.forkIn(back === undefined ? self : Effect.flatMap(self, (a) => tell(back(a))), scope))

  /** A request to app-server, under the request timeout: none if it timed out, else how it ended. */
  const send = <M extends P.ClientMethod>(method: M, params: P.ClientRequests[M]["params"]) =>
    conn.request(method, params).pipe(Effect.exit, Effect.timeoutOption(Session.requestTimeout))

  const capFailure = (spent: number) =>
    new SpendCapReached({
      message: `estimated spend $${spent.toFixed(4)} reached the cap of $${capUsd}`,
      capUsd: capUsd ?? null,
      spentUsd: spent,
      estimated: true,
    })

  const deathOf = (exit: ProcessExit) =>
    new ProcessKilled({
      message: `codex app-server exited (${exit.signal ?? `code ${exit.exitCode}`})`,
      signal: exit.signal,
      exitCode: exit.exitCode,
    })

  /** Why a call can't go in now; null if it can. `interrupt` still can while `end` waits. */
  const unavailable = (forInterrupt = false): SessionClosed | null => {
    switch (life._tag) {
      case "Ended":
        return sessionClosed(dead !== null ? `session is gone: ${dead.message}` : life.error !== null ? life.error.message : "session has ended")
      case "Failing":
        return sessionClosed(`session is gone: ${life.reason ?? (dead !== null ? dead.message : "lost the connection to codex app-server")}`)
      case "Closing":
        return sessionClosed("session has ended")
      case "Open":
        return endRequested && !forInterrupt ? sessionClosed("session has ended") : null
    }
  }

  /** Settle the start of run `seq`'s message (the answer, or the turn's announcement, whichever is first). */
  const settleStart = (seq: number, exit: Exit.Exit<TurnId, AgentError | SessionClosed | TurnFailure>) => {
    const q = claimed.get(seq)
    if (q === undefined) return false
    claimed.delete(seq)
    Deferred.doneUnsafe(q.started, exit)
    return true
  }

  /** Every message still waiting to start (queued, or with its turn/start in flight) fails with `error`. */
  const failWaiting = (error: AgentError | SessionClosed | TurnFailure) => {
    for (const q of queue.splice(0)) Deferred.doneUnsafe(q.started, Exit.fail(error))
    for (const seq of [...claimed.keys()]) settleStart(seq, Exit.fail(error))
  }

  /** The session gave up on app-server, or lost it: nothing more is started, and the transport's end finishes it. */
  const fail = (reason: string | null) => {
    if (life._tag === "Open") life = { _tag: "Failing", reason }
  }

  /** The session is over: `end` callers get `error` (none: it ended cleanly). */
  const finish = (error: AgentError | null, streamError: AgentError | null = error, waiters?: AgentError | SessionClosed) =>
    Effect.suspend(() => {
      life = { _tag: "Ended", error }
      for (const w of endWaiters.splice(0)) Deferred.doneUnsafe(w, error === null ? Exit.void : Exit.fail(error))
      return runtime.end(streamError, waiters)
    })

  /** Kill the commands an interrupted turn left running (app-server doesn't). Whether the connection was lost meanwhile. */
  const killTurnCommands = (run: Run) =>
    Effect.gen(function* () {
      const list = yield* send("thread/backgroundTerminals/list", { threadId })
      if (Option.isNone(list) || Exit.isFailure(list.value)) return Option.isSome(list) && lostIn(list.value)
      for (const terminal of list.value.value.data) {
        if (!run.commandItems.has(terminal.itemId)) continue
        const done = yield* send("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId })
        if (Option.isSome(done) && lostIn(done.value)) return true
      }
      return false
    })

  /** Gather what a completed turn needs from outside the frame (a separate fiber: it may wait on app-server). */
  const gatherCompletion = (run: Run, c: Extract<Command, { _tag: "Complete" }>) =>
    Effect.gen(function* () {
      const needs = completionNeeds(run, c.turn)
      let lost = needs.killCommands ? yield* killTurnCommands(run) : false
      let rateLimits: P.GetAccountRateLimitsResponse | null = null
      if (needs.rateLimits && !lost) {
        const read = yield* send("account/rateLimits/read", undefined)
        if (Option.isSome(read)) {
          if (Exit.isSuccess(read.value)) rateLimits = read.value.value
          else lost = lostIn(read.value)
        }
      }
      const processExit = needs.processExit ? Option.getOrNull(yield* conn.exit.pipe(Effect.timeoutOption(Duration.seconds(1)))) : null
      return { _tag: "Completed", seq: run.seq, rateLimits, processExit, lost } satisfies Input
    })

  /** Start the next queued message if nothing is running, or close if `end` is waiting and nothing is left. */
  const drive: Effect.Effect<void> = Effect.suspend(() => {
    if (life._tag !== "Open" || dead !== null || state.run !== null) return Effect.void
    if (state.capReached !== null) {
      const failure = capFailure(state.capReached)
      for (const q of queue.splice(0)) Deferred.doneUnsafe(q.started, Exit.fail(failure))
    }
    const q = queue.shift()
    if (q !== undefined) {
      state = startRun(state, q.messageId)
      const seq = state.nextSeq - 1
      claimed.set(seq, q)
      return launch(
        send("turn/start", {
          threadId,
          input: textInput(q.input),
          clientUserMessageId: q.messageId,
          ...(options.effort !== undefined ? { effort: codexEffort(options.effort) } : {}),
        }),
        (answer): Input => ({ _tag: "Started", seq, answer }),
      )
    }
    if (!endRequested) return Effect.void
    life = { _tag: "Closing" }
    return launch(conn.close, (): Input => ({ _tag: "Closed" }))
  })

  /** A frame from app-server: fold it into the state; a completed turn first gathers what it needs. */
  const onFrame = (msg: P.Incoming): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (completing !== null) {
        held.push(msg)
        return
      }
      const nowMs = yield* Clock.currentTimeMillis
      const result = step({ threadId, nowMs, mapState, cap }, state, msg)
      state = result.state
      yield* runtime.emitAll(result.events)
      // app-server announced the turn: its message has started, answer or not.
      const run = state.run
      if (run !== null && run.announced && run.turnId !== null) settleStart(run.seq, Exit.succeed(run.turnId))
      for (const c of result.commands) {
        if (c._tag === "Interrupt") {
          yield* launch(Effect.asVoid(send("turn/interrupt", { threadId, turnId: c.turnId })))
        } else if (state.run !== null) {
          completing = { seq: state.run.seq, turn: c.turn, raw: c.raw }
          yield* launch(gatherCompletion(state.run, c), (input) => input)
        }
      }
    })

  /** End the completing turn with what is known, then take the frames held while it gathered. */
  const complete = (rateLimits: P.GetAccountRateLimitsResponse | null, processExit: ProcessExit | null) =>
    Effect.gen(function* () {
      if (completing === null) return
      const { seq, turn, raw } = completing
      completing = null
      // app-server is gone: final before the turn ends and anyone is told.
      if (processExit !== null) dead ??= deathOf(processExit)
      const done = completeTurn({ cap }, state, { seq, turn, raw, price, rateLimits, processExit })
      state = done.state
      yield* runtime.emitAll(done.events)
      for (const msg of held.splice(0)) yield* onFrame(msg)
    })

  const process = (input: Input): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (life._tag === "Ended") return reject(input)
      switch (input._tag) {
        case "Frame":
          yield* onFrame(input.msg)
          return yield* drive
        case "Completed":
          if (completing?.seq !== input.seq) return
          if (input.lost) fail(null)
          yield* complete(input.rateLimits, input.processExit)
          return yield* drive
        case "Started": {
          const { seq, answer } = input
          if (Option.isSome(answer) && Exit.isSuccess(answer.value)) {
            const turnId = answer.value.value.turn.id
            state = runStarted(state, seq, turnId)
            settleStart(seq, Exit.succeed(TurnId.make(turnId)))
            return
          }
          // `turn/started` already settled it: the turn ran (or runs), whatever this answer is.
          if (!claimed.has(seq)) return
          state = runFailed(state, seq).state
          if (Option.isSome(answer) && Exit.isFailure(answer.value)) {
            const exit = answer.value
            settleStart(seq, Exit.fail(causeError("turn/start failed", exit.cause)))
            // An error answer: the next message goes. The connection gone: wait for the transport to end.
            if (lostIn(exit)) fail(null)
            return yield* drive
          }
          // No answer, and no `turn/started`: whether that turn will run can't be known, and
          // starting another could run two at once. app-server has stopped answering: stop it.
          const error = agentError(`turn/start: no answer within ${Duration.format(Session.requestTimeout)}; stopping codex app-server`)
          settleStart(seq, Exit.fail(error))
          fail("codex app-server stopped answering")
          yield* Effect.logError(error.message)
          return yield* launch(conn.kill)
        }
        case "Submit": {
          const error = unavailable()
          if (error !== null) return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "Unavailable", error }))
          if (state.capReached !== null && !input.front) {
            return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "CapReached", spent: state.capReached }))
          }
          const q: Queued = { messageId: input.messageId, input: input.input, started: Deferred.makeUnsafe() }
          if (input.front) queue.unshift(q)
          else queue.push(q)
          yield* drive
          return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "Queued", q, starting: claimed.get(state.run?.seq ?? -1) === q }))
        }
        case "Steer": {
          const error = unavailable()
          if (error !== null) return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "Unavailable", error }))
          if (state.capReached !== null) {
            return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "CapReached", spent: state.capReached }))
          }
          const run = state.run
          if (!steerable(run)) return yield* process({ _tag: "Submit", input: input.input, front: true, messageId: input.messageId, reply: input.reply })
          state = addSteer(state, run.seq, input.messageId)
          const steering = send("turn/steer", {
            threadId,
            input: textInput(input.input),
            expectedTurnId: run.turnId,
            clientUserMessageId: input.messageId,
          })
          const token = {}
          outstanding.set(token, (error) => Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "Unavailable", error })))
          return yield* launch(steering, (answer): Input => ({ ...input, _tag: "Steered", seq: run.seq, answer, token }))
        }
        case "Steered": {
          outstanding.delete(input.token)
          const { answer, reply } = input
          if (Option.isSome(answer) && Exit.isSuccess(answer.value)) {
            return Deferred.doneUnsafe(reply, Exit.succeed({ _tag: "Landed", turnId: TurnId.make(answer.value.value.turnId) }))
          }
          state = removeSteer(state, input.seq, input.messageId)
          if (Option.isNone(answer)) {
            return Deferred.doneUnsafe(reply, Exit.succeed({ _tag: "Failed", error: agentError(`turn/steer: no answer within ${Duration.format(Session.requestTimeout)}`) }))
          }
          const exit = answer.value
          if (Exit.isSuccess(exit)) return
          const failure = Cause.findErrorOption(exit.cause)
          // The turn ended first: this message starts the next turn, ahead of anything queued.
          if (Option.isSome(failure) && failure.value._tag === "CodexRpcError" && isStaleSteerError(failure.value)) {
            return yield* process({ _tag: "Submit", input: input.input, front: true, messageId: input.messageId, reply })
          }
          if (lostIn(exit)) fail(null)
          return Deferred.doneUnsafe(reply, Exit.succeed({ _tag: "Failed", error: causeError("turn/steer failed", exit.cause) }))
        }
        case "Interrupt": {
          const error = unavailable(true)
          if (error !== null) return Deferred.doneUnsafe(input.reply, Exit.fail(error))
          const run = state.run
          if (run === null || run.turnId === null) return Deferred.doneUnsafe(input.reply, Exit.succeed(null))
          if (run.interruptRequested) return Deferred.doneUnsafe(input.reply, Exit.succeed(run.turnId))
          state = markInterrupt(state, run.seq)
          const turnId = run.turnId
          const token = {}
          outstanding.set(token, (error) => Deferred.doneUnsafe(input.reply, Exit.fail(error)))
          return yield* launch(send("turn/interrupt", { threadId, turnId }), (answer): Input => ({
            _tag: "Interrupted",
            turnId,
            answer,
            reply: input.reply,
            token,
          }))
        }
        case "Interrupted": {
          outstanding.delete(input.token)
          const { answer, reply } = input
          if (Option.isNone(answer)) {
            return Deferred.doneUnsafe(reply, Exit.fail(agentError(`turn/interrupt: no answer within ${Duration.format(Session.requestTimeout)}`)))
          }
          const exit = answer.value
          // An error answer: already finished, so the turn ends on its own.
          if (Exit.isSuccess(exit) || !lostIn(exit)) return Deferred.doneUnsafe(reply, Exit.succeed(input.turnId))
          fail(null)
          return Deferred.doneUnsafe(reply, Exit.fail(causeError("turn/interrupt failed", exit.cause)))
        }
        case "Stall": {
          const marked = markStalled(state, input.expiry.turnId, input.expiry)
          state = marked.state
          return Deferred.doneUnsafe(input.reply, Exit.succeed(marked.marked && life._tag === "Open"))
        }
        case "Kill":
          if (life._tag !== "Open" && life._tag !== "Closing") return
          life = { _tag: "Failing", reason: null }
          return yield* launch(conn.kill)
        case "End":
          switch (life._tag) {
            case "Failing":
              // Already a failure; with a reason, it is known now.
              if (life.reason !== null) return Deferred.doneUnsafe(input.reply, Exit.fail(agentError(`session is gone: ${life.reason}`)))
              endWaiters.push(input.reply)
              return
            case "Closing":
              endWaiters.push(input.reply)
              return
            case "Open":
              endRequested = true
              endWaiters.push(input.reply)
              return yield* drive
          }
          return
        case "Closed":
          if (life._tag === "Closing") return yield* finish(null)
          return
        case "TransportEnded": {
          // Our own close: app-server has exited, but the close still cleans up (stops what
          // it left running, flushes the recording). `Closed` ends the session once it has.
          if (life._tag === "Closing") return
          // A turn completing as app-server goes: it ends with what is known.
          if (completing !== null) yield* complete(null, input.exit)
          const death = (dead ??= deathOf(input.exit))
          const ended = stepExit(state, death, input.exit, price)
          state = ended.state
          yield* runtime.emitAll(ended.events)
          failWaiting(death)
          const reason = life._tag === "Failing" ? life.reason : null
          return yield* finish(agentError(`session is gone: ${reason ?? death.message}`), agentError(death.message))
        }
      }
    })

  /** An input that arrived after the end: its caller is told the session is over. */
  const reject = (input: Input) => {
    const error = unavailable(input._tag === "Interrupt") ?? sessionClosed("session has ended")
    switch (input._tag) {
      case "Submit":
      case "Steer":
      case "Steered":
        return Deferred.doneUnsafe(input.reply, Exit.succeed({ _tag: "Unavailable", error }))
      case "Interrupt":
      case "Interrupted":
        return Deferred.doneUnsafe(input.reply, Exit.fail(error))
      case "Stall":
        return Deferred.doneUnsafe(input.reply, Exit.succeed(false))
      case "End":
        return Deferred.doneUnsafe(input.reply, life._tag === "Ended" && life.error !== null ? Exit.fail(life.error) : Exit.void)
    }
  }

  // Closing the session's scope: the actor has been interrupted (waiting for an input) by now, so
  // this is the only one touching the state. A failure already recorded stays the ending.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      // Inputs the actor didn't get to: their callers are told the session is over.
      const left: Array<Input> = []
      for (let next = Queue.takeUnsafe(inbox); next !== undefined && Exit.isSuccess(next); next = Queue.takeUnsafe(inbox)) {
        left.push(next.value)
      }
      const settleOutstanding = () => {
        const error = unavailable(true) ?? sessionClosed("session closed")
        for (const settle of outstanding.values()) settle(error)
        outstanding.clear()
      }
      if (life._tag === "Ended") {
        for (const input of left) reject(input)
        settleOutstanding()
        return Effect.void
      }
      const failure =
        life._tag === "Failing" || dead !== null
          ? agentError(`session is gone: ${(life._tag === "Failing" ? life.reason : null) ?? dead?.message ?? "lost the connection to codex app-server"}`)
          : null
      const waiting = failure ?? sessionClosed("session closed")
      failWaiting(waiting)
      return finish(failure, failure, waiting).pipe(
        Effect.andThen(
          Effect.sync(() => {
            left.forEach(reject)
            settleOutstanding()
          }),
        ),
      )
    }),
  )

  // Interruptible only while waiting for an input: once one is taken it is handled, so its
  // caller's reply can't be dropped between the take and the handling.
  yield* Effect.uninterruptibleMask((restore) => restore(Queue.take(inbox)).pipe(Effect.flatMap(process))).pipe(
    Effect.forever,
    Effect.forkScoped,
  )
  yield* conn.incoming.pipe(
    Stream.runForEach((msg) => tell({ _tag: "Frame", msg })),
    Effect.andThen(conn.exit),
    Effect.flatMap((exit) => tell({ _tag: "TransportEnded", exit })),
    Effect.forkScoped,
  )

  // A stalled turn is interrupted (its completion then terminates its commands, as for
  // any interrupt). If it hasn't ended within the grace period, app-server is
  // unresponsive: kill it, which ends the turn (still `Stalled`) and the session.
  yield* runtime.supervise({
    stall: (expiry) => ask<boolean, never>((reply) => ({ _tag: "Stall", expiry, reply }), () => Exit.succeed(false)),
    interrupt: (expiry) => timed("turn/interrupt", conn.request("turn/interrupt", { threadId, turnId: expiry.turnId })),
    kill: tell({ _tag: "Kill" }),
  })

  // ---- public API: each call asks the actor ----

  const over = <A>(): Exit.Exit<A, SessionClosed | AgentError> => Exit.fail(unavailable(true) ?? sessionClosed("session has ended"))

  const submit = (input: string) =>
    ask<SubmitReply, never>(
      (reply) => ({ _tag: "Submit", input, front: false, messageId: Session.newMessageId(), reply }),
      () => Exit.succeed({ _tag: "Unavailable", error: unavailable() ?? sessionClosed("session has ended") }),
    )

  const sendMessage = Effect.fn("CodexAgent.send")(function* (input: string) {
    const r = yield* submit(input)
    if (r._tag === "Unavailable") return yield* r.error
    if (r._tag === "CapReached") return yield* agentError(capFailure(r.spent).message)
    if (r._tag !== "Queued") return yield* agentError("unexpected answer")
    // A message that started a turn reports a failed `turn/start`; a queued one returns at once.
    if (r.starting || (yield* Deferred.isDone(r.q.started))) {
      yield* Deferred.await(r.q.started).pipe(Effect.mapError(asAgentError))
    }
    return r.q.messageId
  })

  const turn = Effect.fn("CodexAgent.turn")(function* (input: string) {
    const r = yield* submit(input)
    if (r._tag === "Unavailable") return yield* r.error
    if (r._tag === "CapReached") return yield* capFailure(r.spent)
    if (r._tag !== "Queued") return yield* agentError("unexpected answer")
    const turnId = yield* Deferred.await(r.q.started)
    const outcome = yield* turns.outcome(turnId)
    if (outcome._tag === "Succeeded") return outcome satisfies TurnSucceeded
    return yield* Effect.fail(outcome)
  })

  const steer = Effect.fn("CodexAgent.steer")(function* (input: string) {
    const messageId = Session.newMessageId()
    const r = yield* ask<SubmitReply, never>(
      (reply) => ({ _tag: "Steer", input, messageId, reply }),
      () => Exit.succeed({ _tag: "Unavailable", error: unavailable() ?? sessionClosed("session has ended") }),
    )
    switch (r._tag) {
      case "Unavailable":
        return yield* r.error
      case "CapReached":
        return yield* agentError(capFailure(r.spent).message)
      case "Failed":
        return yield* r.error
      case "Landed":
        return { _tag: "Landed", messageId, turnId: r.turnId } satisfies SteerOutcome
      case "Queued": {
        const turnId = yield* Deferred.await(r.q.started).pipe(Effect.mapError(asAgentError))
        return { _tag: "StartedNewTurn", messageId: r.q.messageId, turnId } satisfies SteerOutcome
      }
    }
  })

  const interrupt = Effect.gen(function* () {
    const turnId = yield* ask<TurnId | null, SessionClosed | AgentError>((reply) => ({ _tag: "Interrupt", reply }), over)
    if (turnId !== null) yield* turns.outcome(turnId).pipe(Effect.ignore)
  }).pipe(Effect.withSpan("CodexAgent.interrupt"))

  // Ending an ended session reports how it ended.
  const end: Effect.Effect<void, AgentError> = ask<void, AgentError>(
    (reply) => ({ _tag: "End", reply }),
    () => (life._tag === "Ended" && life.error !== null ? Exit.fail(life.error) : Exit.void),
  ).pipe(Effect.withSpan("CodexAgent.end"))

  return {
    sessionId: SessionId.make(threadId),
    provider,
    location: Option.fromNullishOr(started.thread.path),
    pid: Effect.map(conn.exited, (exited) => (Option.isSome(exited) ? Option.none() : Option.fromNullishOr(conn.pid))),
    subscribe: runtime.subscribe,
    events: Stream.unwrap(runtime.subscribe),
    send: sendMessage,
    turn,
    steer,
    interrupt,
    end,
  } satisfies AgentSession
})

// ---------------------------------------------------------------------------
// status and history: short-lived app-servers
// ---------------------------------------------------------------------------

/** Where to run app-server when there's no session cwd: a neutral directory, not the caller's project. */
const neutralCwd = () => Env.host()["TMPDIR"] ?? "/tmp"

/**
 * `Agent.status`: `account/read` and `account/rateLimits/read` on a short-lived app-server.
 *
 * @internal
 */
export const readStatus = (
  server: CodexAppServer["Service"],
  env?: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AccountStatus, AgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* server.connect({ cwd: neutralCwd(), env: sessionEnv(Env.host(), env) })
      const account = yield* timed("account/read", conn.request("account/read", {})).pipe(
        Effect.mapError(toAgentError("account/read failed")),
      )
      // Not signed in (or an API-key account) fails with -32600; that just means no windows.
      const limits =
        account.account === null
          ? null
          : yield* timed("account/rateLimits/read", conn.request("account/rateLimits/read", undefined)).pipe(
              Effect.catchTag("CodexRpcError", () => Effect.succeed(null)),
            )
      const now = yield* Clock.currentTimeMillis
      yield* conn.close
      return Events.accountStatus(account, limits, now)
    }),
  ).pipe(Effect.withSpan("CodexAgent.status"))

/**
 * Reads the stored turns with `thread/turns/list`, which works on threads
 * that aren't loaded: no `thread/resume`, so the thread is not touched.
 *
 * @internal
 */
export const readHistory = (
  server: CodexAppServer["Service"],
  sessionId: SessionId,
  options: { readonly cwd: string },
): Effect.Effect<ReadonlyArray<AgentEvent>, SessionNotFound | AgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* server.connect({ cwd: options.cwd, env: sessionEnv(Env.host()) })
      const turns: Array<P.Turn> = []
      let cursor: string | null = null
      for (let page = 0; page < 10_000; page++) {
        const result: P.ThreadTurnsListResponse = yield* timed(
          "thread/turns/list",
          conn.request("thread/turns/list", { threadId: sessionId, sortDirection: "asc", itemsView: "full", limit: 100, cursor }),
        ).pipe(
          Effect.catchTag("CodexRpcError", (e) =>
            Effect.fail(
              isSessionNotFoundError(e)
                ? new SessionNotFound({ message: e.message, sessionId })
                : agentError(`thread/turns/list failed: ${e.message}`, e),
            ),
          ),
        )
        turns.push(...result.data)
        if (result.nextCursor === null || result.nextCursor === cursor) break
        cursor = result.nextCursor
      }
      yield* conn.close
      return Events.historyEvents(turns)
    }),
  ).pipe(Effect.withSpan("CodexAgent.history"))

/**
 * The Codex `Agent`, on top of a `CodexAppServer`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: CodexAgentOptions = {}) =>
  Effect.gen(function* () {
    const server = yield* CodexAppServer
    const capabilities: Effect.Effect<Capabilities, AgentError> = server.version.pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((version) => ({
        provider,
        version,
        steer: true,
        queue: true,
        resume: true,
        cost: options.pricing !== undefined ? ("estimated" as const) : ("none" as const),
        spendCap: options.pricing !== undefined ? ("estimated" as const) : ("none" as const),
        resetTimes: true,
        hooks: false,
        reattach: false,
        // request_user_input is off in Default mode; subagents can't be turned off per thread (probed).
        disable: { askUser: true, subagents: false, tools: "some" },
      })),
    )
    return Agent.of({
      provider,
      capabilities,
      open: (runOptions) => openSession(server, options, runOptions),
      status: (statusOptions = {}) => readStatus(server, statusOptions.env),
      history: (sessionId, historyOptions) => readHistory(server, sessionId, historyOptions),
    })
  })

/**
 * `Agent` backed by `codex app-server`; requires `CodexAppServer`.
 *
 * @example
 * ```ts
 * import { NodeServices } from "@effect/platform-node"
 * import { Layer } from "effect"
 * import { CodexAgent, CodexAppServer } from "@jpowersdev/effect-agent/codex"
 *
 * // Codex reports tokens, not cost: prices (USD per million tokens) make
 * // cost estimates and `spendCapUsd` possible.
 * const layer = CodexAgent.layer({
 *   pricing: { "*": { input: 1.25, cachedInput: 0.125, output: 10 } },
 * }).pipe(
 *   Layer.provide(CodexAppServer.layer()),
 *   Layer.provide(NodeServices.layer),
 * )
 * ```
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: CodexAgentOptions = {}): Layer.Layer<Agent, never, CodexAppServer> =>
  Layer.effect(Agent, make(options))
