/**
 * `Agent` backed by `codex app-server` (JSON-RPC over stdio), one app-server
 * process per session.
 *
 *   import { CodexAgent, CodexAppServer } from "@jpowersdev/effect-agent/codex"
 *   CodexAgent.layer({ pricing }).pipe(
 *     Layer.provide(CodexAppServer.layer()),
 *     Layer.provide(NodeServices.layer),
 *   )
 *
 * Every thread runs with approvals and the sandbox off
 * (`approvalPolicy: "never"`, `sandbox: "danger-full-access"`) and with MCP
 * isolated (no configured MCP servers, no built-in `codex_apps`).
 *
 * `status` and `history` each start a short-lived app-server (through the
 * `Launcher`, if any) and stop it before returning. `RunOptions.hooks` is
 * refused: Codex hooks are config-only, with no runtime callbacks.
 */
import { Cause, Clock, Deferred, Duration, Effect, Exit, Layer, Option, PubSub, Scope, Semaphore, Stream } from "effect"
import {
  type AccountStatus,
  Agent,
  type AgentSession,
  type Capabilities,
  type Effort,
  type RunOptions,
  type SteerOutcome,
} from "../Agent.ts"
import { AgentError, ProcessKilled, SessionNotFound, SpendCapReached, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnOutcome, TurnSucceeded } from "../AgentEvent.ts"
import { MessageId, SessionId, type TokenUsage, TurnId } from "../Domain.ts"
import * as Pricing from "../Pricing.ts"
import * as Watchdog from "../Watchdog.ts"
import { CodexAppServer, CodexRpcError, type Connection, type ProcessExit, parseUserAgentVersion } from "./CodexAppServer.ts"
import * as Events from "./CodexEvents.ts"
import * as P from "./protocol.ts"

const provider = "codex"

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

/** effect-agent effort -> Codex `model_reasoning_effort`. `max` maps to `xhigh` (Codex's `ultra` also turns on multi-agent). */
export const codexEffort = (effort: Effort): string => (effort === "max" ? "xhigh" : effort)

/**
 * `disable.tools` names -> per-thread config that removes them. Verified on
 * 0.162.1 by listing the model's tools with each switch off. Names not in
 * this table (e.g. `apply_patch`, `spawn_agent`) can't be removed per thread.
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

/** Thread overrides shared by `thread/start` and `thread/resume`. Fails on tool names Codex can't disable. */
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

const nestingMarkers = new Set([
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
])

/**
 * Host variables that describe a parent agent session (Claude Code sets
 * `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, ...; Codex sets
 * `CODEX_THREAD_ID`/`CODEX_SESSION_ID` in its commands).
 */
export const isNestingMarker = (name: string): boolean => nestingMarkers.has(name) || name.startsWith("CLAUDE_CODE_")

/**
 * The env overrides for app-server (applied over the host env by the
 * spawner): nesting markers removed, then `RunOptions.env`.
 */
export const sessionEnv = (
  host: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {}
  for (const name of Object.keys(host)) if (isNestingMarker(name)) env[name] = undefined
  return { ...env, ...overrides }
}

const hostEnv = (): Readonly<Record<string, string | undefined>> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

/** app-server's answers for a thread it has no record of. */
export const isSessionNotFoundError = (e: CodexRpcError): boolean =>
  /no rollout found|invalid session id|thread not found|thread not loaded|invalid thread id/i.test(e.message)

/** Codex has no runtime hook callbacks; refuse rather than silently ignore them. */
export const hooksError = (options: RunOptions): string | null => {
  const hooks = options.hooks
  if (hooks === undefined) return null
  const set = (["beforeTool", "afterTool", "beforeStop"] as const).filter((k) => hooks[k] !== undefined)
  return set.length === 0
    ? null
    : `Codex does not support RunOptions.hooks (${set.join(", ")}): its hooks are config-only (capabilities.hooks is false)`
}

/** `turn/steer` failed because the expected turn is no longer running. */
export const isStaleSteerError = (e: CodexRpcError): boolean =>
  e.code === P.INVALID_REQUEST && /no active turn|expected active turn id|not steerable/i.test(e.message)

const textInput = (text: string): ReadonlyArray<P.UserInput> => [{ type: "text", text, text_elements: [] }]

const agentError = (message: string, cause?: unknown) =>
  new AgentError({ message, provider, ...(cause !== undefined ? { cause } : {}) })

const toAgentError = (what: string) => (e: CodexRpcError | AgentError) =>
  e._tag === "AgentError" ? e : agentError(`${what}: ${e.message}`, e)

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Queued {
  readonly messageId: MessageId
  readonly input: string
  /** The turn the message started or landed in. */
  readonly started: Deferred.Deferred<TurnId, AgentError>
  readonly outcome: Deferred.Deferred<TurnOutcome, AgentError>
}

interface RunningTurn {
  turnId: TurnId | null
  readonly messages: Array<Queued>
  /** Messages whose `userMessage` item hasn't arrived yet. */
  readonly unlanded: Array<MessageId>
  announced: boolean
  interruptRequested: boolean
  spendCap: { readonly capUsd: number; readonly spentUsd: number } | null
  /** The watchdog stopped this turn. */
  stalled: { readonly idleMs: number; readonly inTool: boolean } | null
  readonly agentMessages: Array<{ readonly text: string; readonly phase: string | null }>
  /** commandExecution items started in this turn. */
  readonly commandItems: Set<string>
  readonly usageAtStart: TokenUsage
  sawUsage: boolean
  readonly ended: Deferred.Deferred<void>
}

type Published =
  | { readonly _tag: "event"; readonly event: AgentEvent }
  | { readonly _tag: "end" }
  | { readonly _tag: "fail"; readonly error: AgentError }

let messageCounter = 0
const messagePrefix = Math.random().toString(36).slice(2, 10)
const nextMessageId = () => MessageId.make(`ea-${messagePrefix}-${++messageCounter}`)

const openSession = Effect.fnUntraced(function* (
  server: CodexAppServer["Service"],
  agentOptions: CodexAgentOptions,
  options: RunOptions,
) {
  const built = threadOverrides(options, agentOptions.config)
  if ("error" in built) return yield* agentError(built.error)
  const hooksRefused = hooksError(options)
  if (hooksRefused !== null) return yield* agentError(hooksRefused)
  const pricing = agentOptions.pricing
  const cap = options.spendCapUsd
  if (cap !== undefined) {
    if (pricing === undefined) return yield* agentError("spendCapUsd needs CodexAgent.layer({ pricing }) on Codex")
    if (options.model !== undefined && Pricing.priceFor(pricing, options.model) === undefined) {
      return yield* agentError(`spendCapUsd: no price for model ${options.model}`)
    }
  }

  const conn: Connection = yield* server.connect({ cwd: options.cwd, env: sessionEnv(hostEnv(), options.env) })
  const version = parseUserAgentVersion(conn.initialize.userAgent)
  // A failed open must not leave app-server running until the caller's scope closes.
  const closeOnError = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.tapError(self, () => conn.close)

  const resumed = options.resume !== undefined
  const started: P.ThreadStartResponse = resumed
    ? yield* conn
        .request("thread/resume", { threadId: options.resume!, excludeTurns: true, ...built.overrides })
        .pipe(
          Effect.catchTag("CodexRpcError", (e) =>
            Effect.fail(
              isSessionNotFoundError(e)
                ? new SessionNotFound({ message: e.message, sessionId: options.resume! })
                : agentError(`thread/resume failed: ${e.message}`, e),
            ),
          ),
          closeOnError,
        )
    : yield* conn
        .request("thread/start", { ...built.overrides, ephemeral: false })
        .pipe(Effect.mapError(toAgentError("thread/start failed")), closeOnError)

  const threadId = started.thread.id
  const model = started.model ?? started.thread.model ?? null
  const price = pricing !== undefined ? Pricing.priceFor(pricing, model) : undefined
  if (cap !== undefined && price === undefined) {
    yield* conn.close
    return yield* agentError(`spendCapUsd: no price for model ${model ?? "(unknown)"}`)
  }

  const sessionStarted: AgentEvent = {
    _tag: "SessionStarted",
    sessionId: SessionId.make(threadId),
    provider,
    version,
    model,
    resumed,
    raw: { method: resumed ? "thread/resume" : "thread/start", result: started },
  }

  // ---- state (owned by this session's fibers; JS runs them one at a time) ----
  const pubsub = yield* PubSub.unbounded<Published>()
  const lock = yield* Semaphore.make(1)
  const mapState = Events.makeMapState()
  const queue: Array<Queued> = []
  const state = {
    running: null as RunningTurn | null,
    ending: false,
    closed: false,
    dead: null as ProcessKilled | null,
    finished: null as Published | null,
    /** Thread total before this session's first model call (resumed threads carry history). */
    usageBase: null as TokenUsage | null,
    sessionUsage: Events.zeroUsage,
    capReached: null as number | null,
  }

  const dog = options.watchdog !== undefined ? yield* Watchdog.make(options.watchdog) : null
  const stallGrace = options.watchdog?.grace ?? agentOptions.stallGrace ?? Duration.seconds(10)
  const publish = (event: AgentEvent) =>
    dog === null
      ? PubSub.publish(pubsub, { _tag: "event", event })
      : Effect.andThen(dog.observe(event), PubSub.publish(pubsub, { _tag: "event", event }))
  const finish = (item: Published) =>
    Effect.suspend(() => {
      if (state.finished !== null) return Effect.void
      state.finished = item
      return PubSub.publish(pubsub, item)
    })
  const costNow = () =>
    price !== undefined ? { usd: Pricing.costOf(price, state.sessionUsage), source: "estimated" as const } : null

  const unavailable = (): AgentError | null =>
    state.dead !== null
      ? agentError(`session is gone: ${state.dead.message}`)
      : state.closed || state.ending
        ? agentError("session has ended")
        : null

  const makeQueued = (input: string): Queued => ({
    messageId: nextMessageId(),
    input,
    started: Deferred.makeUnsafe(),
    outcome: Deferred.makeUnsafe(),
  })

  const newRun = (messages: Array<Queued>): RunningTurn => ({
    turnId: null,
    messages,
    unlanded: messages.map((m) => m.messageId),
    announced: false,
    interruptRequested: false,
    spendCap: null,
    stalled: null,
    agentMessages: [],
    commandItems: new Set(),
    usageAtStart: state.sessionUsage,
    sawUsage: false,
    ended: Deferred.makeUnsafe(),
  })

  const capFailure = (spent: number) =>
    new SpendCapReached({
      message: `estimated spend $${spent.toFixed(4)} reached the cap of $${cap}`,
      capUsd: cap ?? 0,
      spentUsd: spent,
      estimated: true,
    })

  /** Start the next queued message if idle. Run with `lock` held. */
  const startNext: Effect.Effect<void> = Effect.gen(function* () {
    while (state.running === null && queue.length > 0 && state.dead === null && !state.closed) {
      if (state.capReached !== null) {
        const failure = capFailure(state.capReached)
        for (const q of queue.splice(0)) {
          yield* Deferred.fail(q.started, agentError(failure.message))
          yield* Deferred.succeed(q.outcome, failure)
        }
        return
      }
      const q = queue.shift()!
      const run = newRun([q])
      state.running = run
      const exit = yield* conn
        .request("turn/start", {
          threadId,
          input: textInput(q.input),
          clientUserMessageId: q.messageId,
          ...(options.effort !== undefined ? { effort: codexEffort(options.effort) } : {}),
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        if (state.running === run) state.running = null
        const error = toAgentError("turn/start failed")(Cause.squash(exit.cause) as CodexRpcError | AgentError)
        yield* Deferred.fail(q.started, error)
        yield* Deferred.fail(q.outcome, error)
        yield* Deferred.succeed(run.ended, undefined)
        continue
      }
      run.turnId ??= TurnId.make(exit.value.turn.id)
      yield* Deferred.succeed(q.started, run.turnId)
    }
  })

  /** Kill the commands an interrupted turn left running (app-server doesn't). */
  const killTurnCommands = (run: RunningTurn) =>
    Effect.gen(function* () {
      if (run.commandItems.size === 0) return
      const list = yield* conn.request("thread/backgroundTerminals/list", { threadId }).pipe(Effect.option)
      if (Option.isNone(list)) return
      for (const terminal of list.value.data) {
        if (!run.commandItems.has(terminal.itemId)) continue
        yield* Effect.ignore(
          conn.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }),
        )
      }
    })

  const resolveRun = (run: RunningTurn, outcome: TurnOutcome) =>
    Effect.gen(function* () {
      for (const q of run.messages) {
        if (run.turnId !== null) yield* Deferred.succeed(q.started, run.turnId)
        else yield* Deferred.fail(q.started, agentError("turn never started"))
        yield* Deferred.succeed(q.outcome, outcome)
      }
      yield* Deferred.succeed(run.ended, undefined)
    })

  const onTokenUsage = (n: P.TokenUsageNotification) =>
    Effect.gen(function* () {
      const total = Events.toTokenUsage(n.tokenUsage.total)
      state.usageBase ??= Events.subtractUsage(total, Events.toTokenUsage(n.tokenUsage.last))
      state.sessionUsage = Events.subtractUsage(total, state.usageBase)
      const run = state.running
      if (run !== null) run.sawUsage = true
      if (cap === undefined || price === undefined) return
      const spent = Pricing.costOf(price, state.sessionUsage)
      if (spent < cap) return
      state.capReached ??= spent
      if (run !== null && run.turnId !== null && run.spendCap === null && run.stalled === null && !run.interruptRequested) {
        run.spendCap = { capUsd: cap, spentUsd: spent }
        yield* conn
          .request("turn/interrupt", { threadId, turnId: run.turnId })
          .pipe(Effect.ignore, Effect.forkScoped)
      }
    })

  const finishTurn = (msg: P.Notification) =>
    Effect.gen(function* () {
      const turn: P.Turn = msg.params.turn
      const run = state.running
      if (run === null || (run.turnId !== null && run.turnId !== turn.id)) return yield* publish({ _tag: "Other", raw: msg })
      run.turnId ??= TurnId.make(turn.id)
      if (!run.announced) {
        run.announced = true
        yield* publish({ _tag: "TurnStarted", turnId: run.turnId, raw: msg })
      }
      if (turn.status === "interrupted") yield* killTurnCommands(run)
      const kind = Events.errorKind(turn.error?.codexErrorInfo)
      const rateLimits =
        turn.status === "failed" && kind === "usageLimitExceeded"
          ? Option.getOrNull(yield* conn.request("account/rateLimits/read", undefined).pipe(Effect.option))
          : null
      // An interrupt we didn't ask for usually means app-server is shutting down.
      const processExit =
        turn.status === "interrupted" && !run.interruptRequested && run.spendCap === null && run.stalled === null
          ? Option.getOrNull(yield* conn.exit.pipe(Effect.timeoutOption(Duration.seconds(1))))
          : null
      const messages =
        run.agentMessages.length > 0
          ? run.agentMessages
          : turn.items.flatMap((i) => (i.type === "agentMessage" ? [{ text: (i as any).text ?? "", phase: (i as any).phase ?? null }] : []))
      const outcome = Events.classifyOutcome(turn, {
        interruptRequested: run.interruptRequested,
        spendCap: run.spendCap,
        capUsd: cap ?? null,
        processExit,
        finalText: Events.finalTextOf(messages),
        rateLimits,
        stalled: run.stalled,
      })
      yield* publish({
        _tag: "TurnEnded",
        turnId: run.turnId,
        outcome,
        usage: run.sawUsage ? Events.subtractUsage(state.sessionUsage, run.usageAtStart) : null,
        cost: costNow(),
        raw: msg,
      })
      state.running = null
      yield* resolveRun(run, outcome)
      yield* lock.withPermit(startNext).pipe(Effect.forkScoped)
    })

  const handle = (msg: P.Incoming): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const params: any = msg.params ?? {}
      // Subagent threads share the connection; their turns aren't ours.
      if (typeof params.threadId === "string" && params.threadId !== threadId) {
        return yield* publish({ _tag: "Other", raw: msg })
      }
      const run = state.running
      const item: P.ThreadItem | undefined = params.item
      if (!("id" in msg && msg.id !== undefined)) {
        switch (msg.method as P.NotificationMethod) {
          case "turn/started": {
            const turnId = TurnId.make(params.turn.id)
            const current = run ?? (state.running = newRun([]))
            current.turnId ??= turnId
            if (current.turnId !== turnId || current.announced) return yield* publish({ _tag: "Other", raw: msg })
            current.announced = true
            return yield* publish({ _tag: "TurnStarted", turnId, raw: msg })
          }
          case "turn/completed":
            return yield* finishTurn(msg)
          case "thread/tokenUsage/updated":
            yield* onTokenUsage(params)
            break
          case "item/started":
            if (item?.type === "userMessage") {
              const clientId = (item as any).clientId as string | null
              const messageId =
                run === null
                  ? undefined
                  : clientId !== null && run.unlanded.includes(clientId as MessageId)
                    ? (clientId as MessageId)
                    : run.unlanded[0]
              if (run === null || messageId === undefined || run.turnId === null) {
                return yield* publish({ _tag: "Other", raw: msg })
              }
              run.unlanded.splice(run.unlanded.indexOf(messageId), 1)
              return yield* publish({ _tag: "MessageLanded", messageId, turnId: run.turnId, raw: msg })
            }
            if (item?.type === "commandExecution") run?.commandItems.add(item.id)
            break
          case "item/completed":
            if (item?.type === "agentMessage") {
              run?.agentMessages.push({ text: (item as any).text ?? "", phase: (item as any).phase ?? null })
            }
            break
        }
      }
      const now = yield* Clock.currentTimeMillis
      for (const event of Events.mapNotification(msg, mapState, now)) yield* publish(event)
    })

  /** After app-server's output ends: either we closed it, or it died. */
  const onTransportEnd = Effect.gen(function* () {
    const exit: ProcessExit = yield* conn.exit
    if (state.closed) return yield* finish({ _tag: "end" })
    const dead = new ProcessKilled({
      message: `codex app-server exited (${exit.signal ?? `code ${exit.exitCode}`})`,
      signal: exit.signal,
      exitCode: exit.exitCode,
    })
    state.dead = dead
    const run = state.running
    state.running = null
    if (run !== null) {
      // A stalled turn whose app-server we killed ended Stalled, not ProcessKilled.
      const outcome = run.stalled !== null ? Events.stalledFailure(run.stalled) : dead
      if (run.turnId !== null) {
        yield* publish({
          _tag: "TurnEnded",
          turnId: run.turnId,
          outcome,
          usage: run.sawUsage ? Events.subtractUsage(state.sessionUsage, run.usageAtStart) : null,
          cost: costNow(),
          raw: { exit },
        })
      }
      yield* resolveRun(run, outcome)
    }
    for (const q of queue.splice(0)) {
      yield* Deferred.fail(q.started, agentError(dead.message))
      yield* Deferred.succeed(q.outcome, dead)
    }
    yield* finish({ _tag: "fail", error: agentError(dead.message) })
  })

  // Closing the session's scope without `end`: release everyone still waiting.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (state.finished !== null) return
      state.closed = true
      const error = agentError("session closed")
      const run = state.running
      state.running = null
      for (const q of [...(run?.messages ?? []), ...queue.splice(0)]) {
        yield* Deferred.fail(q.started, error)
        yield* Deferred.fail(q.outcome, error)
      }
      if (run !== null) yield* Deferred.succeed(run.ended, undefined)
      yield* finish({ _tag: "end" })
    }),
  )

  yield* conn.incoming.pipe(
    Stream.runForEach(handle),
    Effect.andThen(onTransportEnd),
    Effect.forkScoped,
  )

  /**
   * Watchdog expiry: mark the turn stalled and interrupt it (`finishTurn`
   * then terminates its commands, as for any interrupt). If it hasn't ended
   * within `stallGrace`, app-server is unresponsive: kill it, which ends the
   * turn (still `Stalled`) and the session.
   */
  const onStall = (expiry: Watchdog.Expiry) =>
    Effect.gen(function* () {
      const run = state.running
      if (run === null || run.turnId !== expiry.turnId || run.stalled !== null) return
      run.stalled = { idleMs: expiry.idleMs, inTool: expiry.inTool }
      yield* conn.request("turn/interrupt", { threadId, turnId: expiry.turnId }).pipe(Effect.ignore, Effect.forkScoped)
      const ended = yield* Deferred.await(run.ended).pipe(Effect.timeoutOption(stallGrace))
      if (Option.isNone(ended)) yield* conn.kill
    })
  if (dog !== null) yield* dog.expirations.pipe(Stream.runForEach(onStall), Effect.forkScoped)

  // ---- public API ----

  // `sessionStarted` is never published live, only replayed first to every subscription.
  const subscribe = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubsub)
    const finished = state.finished
    if (finished !== null) {
      return finished._tag === "fail" ? Stream.fail(finished.error) : Stream.empty
    }
    const prefix: Published = { _tag: "event", event: sessionStarted }
    return Stream.concat(Stream.make(prefix), Stream.fromSubscription(subscription)).pipe(
      Stream.mapEffect((item) => (item._tag === "fail" ? Effect.fail(item.error) : Effect.succeed(item))),
      Stream.takeWhile((item) => item._tag === "event"),
      Stream.map((item) => (item as Extract<Published, { _tag: "event" }>).event),
    )
  })
  const events: Stream.Stream<AgentEvent, AgentError> = Stream.unwrap(subscribe)

  const submit = (q: Queued, front: boolean) =>
    Effect.gen(function* () {
      if (front) queue.unshift(q)
      else queue.push(q)
      yield* startNext
    })

  const send = (input: string): Effect.Effect<MessageId, AgentError> =>
    Effect.gen(function* () {
      const error = unavailable()
      if (error !== null) return yield* error
      if (state.capReached !== null) return yield* agentError(capFailure(state.capReached).message)
      const q = makeQueued(input)
      yield* lock.withPermit(submit(q, false))
      // turn/start failures surface here; a queued message returns at once.
      const failed = yield* Deferred.isDone(q.started)
      if (failed) yield* Effect.asVoid(Deferred.await(q.started))
      return q.messageId
    })

  const turn = (input: string): Effect.Effect<TurnSucceeded, TurnFailure | AgentError> =>
    Effect.gen(function* () {
      const error = unavailable()
      if (error !== null) return yield* error
      if (state.capReached !== null) return yield* capFailure(state.capReached)
      const q = makeQueued(input)
      yield* lock.withPermit(submit(q, false))
      const outcome = yield* Deferred.await(q.outcome)
      if (outcome._tag === "Succeeded") return outcome
      return yield* Effect.fail(outcome)
    })

  const steer = (input: string): Effect.Effect<SteerOutcome, AgentError> =>
    Effect.gen(function* () {
      const error = unavailable()
      if (error !== null) return yield* error
      if (state.capReached !== null) return yield* agentError(capFailure(state.capReached).message)
      const q = makeQueued(input)
      const landed = yield* lock.withPermit(
        Effect.gen(function* () {
          const run = state.running
          if (run !== null && run.turnId !== null && !run.interruptRequested && run.spendCap === null && run.stalled === null) {
            const turnId = run.turnId
            run.messages.push(q)
            run.unlanded.push(q.messageId)
            const exit = yield* conn
              .request("turn/steer", { threadId, input: textInput(input), expectedTurnId: turnId, clientUserMessageId: q.messageId })
              .pipe(Effect.exit)
            if (Exit.isSuccess(exit)) {
              return Option.some<SteerOutcome>({ _tag: "Landed", messageId: q.messageId, turnId: TurnId.make(exit.value.turnId) })
            }
            run.messages.splice(run.messages.indexOf(q), 1)
            if (run.unlanded.includes(q.messageId)) run.unlanded.splice(run.unlanded.indexOf(q.messageId), 1)
            const e = Cause.squash(exit.cause) as CodexRpcError | AgentError
            if (e._tag !== "CodexRpcError" || !isStaleSteerError(e)) return yield* toAgentError("turn/steer failed")(e)
            // The turn ended first: this message starts the next turn, ahead of anything queued.
          }
          yield* submit(q, true)
          return Option.none<SteerOutcome>()
        }),
      )
      if (Option.isSome(landed)) return landed.value
      const turnId = yield* Deferred.await(q.started)
      return { _tag: "StartedNewTurn", messageId: q.messageId, turnId } satisfies SteerOutcome
    })

  const interrupt: Effect.Effect<void, AgentError> = Effect.gen(function* () {
    if (state.dead !== null) return yield* agentError(`session is gone: ${state.dead.message}`)
    if (state.closed) return yield* agentError("session has ended")
    const run = yield* lock.withPermit(
      Effect.gen(function* () {
        const run = state.running
        if (run === null || run.turnId === null) return null
        if (!run.interruptRequested) {
          run.interruptRequested = true
          yield* conn.request("turn/interrupt", { threadId, turnId: run.turnId }).pipe(
            // Already finished: the turn ends on its own.
            Effect.catchTag("CodexRpcError", () => Effect.void),
          )
        }
        return run
      }),
    )
    if (run !== null) yield* Deferred.await(run.ended)
  })

  const end: Effect.Effect<void, AgentError> = Effect.gen(function* () {
    if (state.closed || state.dead !== null) return
    state.ending = true
    while (state.dead === null) {
      const run = state.running
      if (run !== null) yield* Deferred.await(run.ended)
      else if (queue.length > 0) yield* Effect.sleep(Duration.millis(10))
      else break
    }
    state.closed = true
    yield* conn.close
    yield* finish({ _tag: "end" })
  })

  return {
    sessionId: SessionId.make(threadId),
    provider,
    location: Option.fromNullishOr(started.thread.path),
    pid: Effect.map(conn.exited, (exited) => (Option.isSome(exited) ? Option.none() : Option.fromNullishOr(conn.pid))),
    subscribe,
    events,
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

const requestTimeout = Duration.seconds(60)

/** Where to run app-server when there's no session cwd: a neutral directory, not the caller's project. */
const neutralCwd = () => hostEnv()["TMPDIR"] ?? "/tmp"

const timed = <A, E>(what: string, self: Effect.Effect<A, E>) =>
  self.pipe(
    Effect.timeoutOrElse({ duration: requestTimeout, orElse: () => Effect.fail(agentError(`${what} timed out`)) }),
  )

export const readStatus = (
  server: CodexAppServer["Service"],
  env?: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AccountStatus, AgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* server.connect({ cwd: neutralCwd(), env: sessionEnv(hostEnv(), env) })
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
  )

/**
 * Reads the stored turns with `thread/turns/list`, which works on threads
 * that aren't loaded: no `thread/resume`, so the thread is not touched.
 */
export const readHistory = (
  server: CodexAppServer["Service"],
  sessionId: SessionId,
  options: { readonly cwd: string },
): Effect.Effect<ReadonlyArray<AgentEvent>, SessionNotFound | AgentError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* server.connect({ cwd: options.cwd, env: sessionEnv(hostEnv()) })
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
  )

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

export const layer = (options: CodexAgentOptions = {}): Layer.Layer<Agent, never, CodexAppServer> =>
  Layer.effect(Agent, make(options))
