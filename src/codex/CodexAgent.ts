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
import { Cause, Clock, Deferred, Duration, Effect, Exit, Layer, Option, Stream } from "effect"
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
 * spawner): nesting markers removed, then `RunOptions.env`.
 *
 * @internal
 */
export const sessionEnv: (
  host: Readonly<Record<string, string | undefined>>,
  overrides?: Readonly<Record<string, string | undefined>>,
) => Record<string, string | undefined> = Env.overrides

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
 * `turn/start` failed: no turn is running.
 *
 * @internal
 */
export const runFailed = (state: State, seq: number): State =>
  state.run?.seq === seq ? { ...state, run: null } : state

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
    readonly turn: P.Turn
    readonly raw: P.Incoming
    readonly price: Pricing.ModelPrice | undefined
    readonly rateLimits: P.GetAccountRateLimitsResponse | null
    readonly processExit: ProcessExit | null
  },
): { readonly state: State; readonly events: ReadonlyArray<AgentEvent> } => {
  const run = state.run
  if (run === null || run.turnId === null) return { state, events: [] }
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

  const conn: Connection = yield* server.connect({ cwd: options.cwd, env: Env.overrides(Env.host(), options.env) })
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

  // ---- state: changed only synchronously, so no lock is needed (or held across a request) ----
  const mapState = Events.makeMapState()
  let state = initialState
  /** Messages waiting for the running turn to end. */
  const queue: Array<Queued> = []
  /** `end` was called: no new messages. */
  let ending = false
  /** The connection was closed (by `end`, or the scope). */
  let closed = false
  let dead: ProcessKilled | null = null
  /** Completed (and replaced) whenever a turn ends or the queue empties; `end` waits on it. */
  let changed = Deferred.makeUnsafe<void>()
  const notify = () => {
    Deferred.doneUnsafe(changed, Exit.void)
    changed = Deferred.makeUnsafe<void>()
  }

  const capFailure = (spent: number) =>
    new SpendCapReached({
      message: `estimated spend $${spent.toFixed(4)} reached the cap of $${capUsd}`,
      capUsd: capUsd ?? null,
      spentUsd: spent,
      estimated: true,
    })

  const unavailable = (): SessionClosed | null =>
    dead !== null ? sessionClosed(`session is gone: ${dead.message}`) : closed || ending ? sessionClosed("session has ended") : null

  /**
   * Take the next queued message as the running turn, if nothing is running.
   * Synchronous, so two callers can't both start one; `startTurn` sends it.
   */
  const claimNext = (): { readonly q: Queued; readonly seq: number } | null => {
    if (state.run !== null || dead !== null || closed) return null
    if (state.capReached !== null) {
      const failure = capFailure(state.capReached)
      for (const q of queue.splice(0)) Deferred.doneUnsafe(q.started, Exit.fail(failure))
    }
    const q = queue.shift()
    if (q === undefined) {
      notify()
      return null
    }
    state = startRun(state, q.messageId)
    return { q, seq: state.nextSeq - 1 }
  }

  /** `turn/start` for a claimed message; on failure, the next one goes. Runs in the session's scope, not the caller's. */
  const startTurn = ({ q, seq }: { readonly q: Queued; readonly seq: number }): Effect.Effect<void> =>
    timed(
      "turn/start",
      conn.request("turn/start", {
        threadId,
        input: textInput(q.input),
        clientUserMessageId: q.messageId,
        ...(options.effort !== undefined ? { effort: codexEffort(options.effort) } : {}),
      }),
    ).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.suspend(() => {
            state = runFailed(state, seq)
            Deferred.doneUnsafe(q.started, Exit.fail(causeError("turn/start failed", cause)))
            return startNext
          }),
        onSuccess: (response) =>
          Effect.sync(() => {
            state = runStarted(state, seq, response.turn.id)
            Deferred.doneUnsafe(q.started, Exit.succeed(TurnId.make(response.turn.id)))
          }),
      }),
    )

  const startNext: Effect.Effect<void> = Effect.suspend(() => {
    const claimed = claimNext()
    return claimed === null ? Effect.void : startTurn(claimed).pipe(Effect.forkIn(scope), Effect.asVoid)
  })

  /** Kill the commands an interrupted turn left running (app-server doesn't). */
  const killTurnCommands = (run: Run) =>
    Effect.gen(function* () {
      const list = yield* timed("thread/backgroundTerminals/list", conn.request("thread/backgroundTerminals/list", { threadId })).pipe(
        Effect.option,
      )
      if (Option.isNone(list)) return
      for (const terminal of list.value.data) {
        if (!run.commandItems.has(terminal.itemId)) continue
        yield* timed(
          "thread/backgroundTerminals/terminate",
          conn.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }),
        ).pipe(Effect.ignore)
      }
    })

  const command = (c: Command): Effect.Effect<void> => {
    switch (c._tag) {
      case "Interrupt":
        return timed("turn/interrupt", conn.request("turn/interrupt", { threadId, turnId: c.turnId })).pipe(
          Effect.ignore,
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      case "Complete":
        return Effect.gen(function* () {
          const run = state.run
          if (run === null) return
          const needs = completionNeeds(run, c.turn)
          if (needs.killCommands) yield* killTurnCommands(run)
          const rateLimits = needs.rateLimits
            ? Option.getOrNull(yield* timed("account/rateLimits/read", conn.request("account/rateLimits/read", undefined)).pipe(Effect.option))
            : null
          const processExit = needs.processExit ? Option.getOrNull(yield* conn.exit.pipe(Effect.timeoutOption(Duration.seconds(1)))) : null
          const done = completeTurn({ cap }, state, { turn: c.turn, raw: c.raw, price, rateLimits, processExit })
          state = done.state
          yield* runtime.emitAll(done.events)
          yield* startNext
        })
    }
  }

  const handle = (msg: P.Incoming) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const result = step({ threadId, nowMs, mapState, cap }, state, msg)
      state = result.state
      yield* runtime.emitAll(result.events)
      for (const c of result.commands) yield* command(c)
    })

  /** After app-server's output ends: either we closed it, or it died. */
  const onTransportEnd = Effect.gen(function* () {
    const exit: ProcessExit = yield* conn.exit
    if (closed) return yield* runtime.end(null)
    dead = new ProcessKilled({
      message: `codex app-server exited (${exit.signal ?? `code ${exit.exitCode}`})`,
      signal: exit.signal,
      exitCode: exit.exitCode,
    })
    const ended = stepExit(state, dead, exit, price)
    state = ended.state
    yield* runtime.emitAll(ended.events)
    for (const q of queue.splice(0)) Deferred.doneUnsafe(q.started, Exit.fail(dead))
    notify()
    yield* runtime.end(agentError(dead.message))
  })

  // Closing the session's scope without `end`: release everyone still waiting.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      if (runtime.ended() !== null) return Effect.void
      closed = true
      const error = sessionClosed("session closed")
      for (const q of queue.splice(0)) Deferred.doneUnsafe(q.started, Exit.fail(error))
      notify()
      return runtime.end(null, error)
    }),
  )

  yield* conn.incoming.pipe(Stream.runForEach(handle), Effect.andThen(onTransportEnd), Effect.forkScoped)

  // A stalled turn is interrupted (`Complete` then terminates its commands, as
  // for any interrupt). If it hasn't ended within the grace period, app-server
  // is unresponsive: kill it, which ends the turn (still `Stalled`) and the session.
  yield* runtime.supervise({
    stall: (expiry) =>
      Effect.sync(() => {
        const marked = markStalled(state, expiry.turnId, expiry)
        state = marked.state
        return marked.marked
      }),
    interrupt: (expiry) => timed("turn/interrupt", conn.request("turn/interrupt", { threadId, turnId: expiry.turnId })),
    kill: conn.kill,
  })

  // ---- public API ----

  /**
   * Queue a message (at the front for a steer) and start it if nothing is
   * running. A steer that lost its turn keeps the id it was steered with.
   */
  const enqueue = (input: string, front: boolean, messageId: MessageId = Session.newMessageId()) =>
    Effect.suspend(() => {
      const error = unavailable()
      if (error !== null) return Effect.fail(error)
      const q: Queued = { messageId, input, started: Deferred.makeUnsafe() }
      if (front) queue.unshift(q)
      else queue.push(q)
      return Effect.as(startNext, q)
    })

  const send = Effect.fn("CodexAgent.send")(function* (input: string) {
    if (state.capReached !== null && unavailable() === null) return yield* agentError(capFailure(state.capReached).message)
    const q = yield* enqueue(input, false)
    // A message that started a turn reports a failed `turn/start`; a queued one returns at once.
    if (state.run?.unlanded[0] === q.messageId || (yield* Deferred.isDone(q.started))) {
      yield* Deferred.await(q.started).pipe(Effect.mapError(asAgentError))
    }
    return q.messageId
  })

  const turn = Effect.fn("CodexAgent.turn")(function* (input: string) {
    if (state.capReached !== null && unavailable() === null) return yield* capFailure(state.capReached)
    const q = yield* enqueue(input, false)
    const turnId = yield* Deferred.await(q.started)
    const outcome = yield* turns.outcome(turnId)
    if (outcome._tag === "Succeeded") return outcome satisfies TurnSucceeded
    return yield* Effect.fail(outcome)
  })

  const steer = Effect.fn("CodexAgent.steer")(function* (input: string) {
    const error = unavailable()
    if (error !== null) return yield* error
    if (state.capReached !== null) return yield* agentError(capFailure(state.capReached).message)
    const run = state.run
    const messageId = Session.newMessageId()
    if (steerable(run)) {
      state = addSteer(state, run.seq, messageId)
      const exit = yield* timed(
        "turn/steer",
        conn.request("turn/steer", { threadId, input: textInput(input), expectedTurnId: run.turnId, clientUserMessageId: messageId }),
      ).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) {
        return { _tag: "Landed", messageId, turnId: TurnId.make(exit.value.turnId) } satisfies SteerOutcome
      }
      state = removeSteer(state, run.seq, messageId)
      const failure = Cause.findErrorOption(exit.cause)
      const stale = Option.isSome(failure) && failure.value._tag === "CodexRpcError" && isStaleSteerError(failure.value)
      if (!stale) return yield* causeError("turn/steer failed", exit.cause)
      // The turn ended first: this message starts the next turn, ahead of anything queued.
    }
    const q = yield* enqueue(input, true, messageId)
    const turnId = yield* Deferred.await(q.started).pipe(Effect.mapError(asAgentError))
    return { _tag: "StartedNewTurn", messageId: q.messageId, turnId } satisfies SteerOutcome
  })

  const interrupt = Effect.gen(function* () {
    const error = closed || dead !== null ? unavailable() : null
    if (error !== null) return yield* error
    const run = state.run
    if (run === null || run.turnId === null) return
    if (!run.interruptRequested) {
      state = markInterrupt(state, run.seq)
      yield* timed("turn/interrupt", conn.request("turn/interrupt", { threadId, turnId: run.turnId })).pipe(
        // Already finished: the turn ends on its own.
        Effect.catchTag("CodexRpcError", () => Effect.void),
      )
    }
    yield* turns.outcome(run.turnId).pipe(Effect.ignore)
  }).pipe(Effect.withSpan("CodexAgent.interrupt"))

  // Ending an ended session reports how it ended.
  const end: Effect.Effect<void, AgentError> = Effect.gen(function* () {
    if (dead === null && !closed) {
      ending = true
      while (dead === null && (state.run !== null || queue.length > 0)) yield* Deferred.await(changed)
    }
    if (dead !== null) return yield* agentError(`session is gone: ${dead.message}`)
    if (closed) return
    closed = true
    yield* conn.close
    yield* runtime.end(null)
  }).pipe(Effect.withSpan("CodexAgent.end"))

  return {
    sessionId: SessionId.make(threadId),
    provider,
    location: Option.fromNullishOr(started.thread.path),
    pid: Effect.map(conn.exited, (exited) => (Option.isSome(exited) ? Option.none() : Option.fromNullishOr(conn.pid))),
    subscribe: runtime.subscribe,
    events: Stream.unwrap(runtime.subscribe),
    send,
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
      const conn = yield* server.connect({ cwd: neutralCwd(), env: Env.overrides(Env.host(), env) })
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
      const conn = yield* server.connect({ cwd: options.cwd, env: Env.overrides(Env.host()) })
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
