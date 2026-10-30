/**
 * Pure mapping from app-server frames to `AgentEvent`s, and classification
 * of a completed turn into a `TurnOutcome`. No effects: the session in
 * `CodexAgent` owns the state and the turn lifecycle (TurnStarted,
 * MessageLanded, TurnEnded); this module maps everything else.
 *
 * @since 0.1.0
 */
import { DateTime, Option } from "effect"
import type { AccountStatus } from "../Agent.ts"
import {
  AgentFailed,
  AuthFailed,
  ContextExhausted,
  Interrupted,
  ProcessKilled,
  SpendCapReached,
  Stalled,
  Throttled,
  UsageLimited,
} from "../AgentError.ts"
import type { AgentEvent, TurnOutcome } from "../AgentEvent.ts"
import { type LimitWindow, type LimitWindowStatus, MessageId, type TokenUsage, TurnId } from "../Domain.ts"
import * as P from "./protocol.ts"

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `codexErrorInfo` as a string: the tag, or the key of a single-key object variant.
 *
 * @since 0.1.0
 * @category utils
 */
export const errorKind = (info: P.CodexErrorInfo | null | undefined): string | null => {
  if (info === null || info === undefined) return null
  if (typeof info === "string") return info
  const keys = Object.keys(info)
  return keys.length > 0 ? keys[0]! : null
}

/**
 * Codex counts reasoning tokens inside `outputTokens`. `TokenUsage` keeps them
 * apart (`Pricing.costOf` bills `reasoningTokens` on top of `outputTokens`), so
 * `outputTokens` here excludes reasoning and the sum is unchanged.
 *
 * @since 0.1.0
 * @category usage
 */
export const toTokenUsage = (b: P.TokenUsageBreakdown): TokenUsage => ({
  inputTokens: b.inputTokens,
  cachedInputTokens: b.cachedInputTokens,
  outputTokens: Math.max(0, b.outputTokens - b.reasoningOutputTokens),
  reasoningTokens: b.reasoningOutputTokens,
})

/**
 * @since 0.1.0
 * @category usage
 */
export const zeroUsage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }

/**
 * `a - b` per field, floored at zero.
 *
 * @since 0.1.0
 * @category usage
 */
export const subtractUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  reasoningTokens: Math.max(0, (a.reasoningTokens ?? 0) - (b.reasoningTokens ?? 0)),
})

/**
 * `windowDurationMins`: 300 -> five_hour, 10080 -> weekly, anything else -> other.
 *
 * @since 0.1.0
 * @category rate limits
 */
export const limitWindowOf = (mins: number | null | undefined): LimitWindow =>
  mins === 300 ? "five_hour" : mins === 10080 ? "weekly" : "other"

const resetsAtOf = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined ? null : DateTime.makeUnsafe(seconds * 1000)

/**
 * "Reconnecting... 2/5 (...)" -> { attempt: 2, maxAttempts: 5 }
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseRetry = (message: string): { attempt: number | null; maxAttempts: number | null } => {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(message)
  return m ? { attempt: Number(m[1]), maxAttempts: Number(m[2]) } : { attempt: null, maxAttempts: null }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Merge a sparse `account/rateLimits/updated` snapshot into the previous one:
 * null fields don't clear known values.
 *
 * @since 0.1.0
 * @category rate limits
 */
export const mergeRateLimits = (prev: P.RateLimitSnapshot | null, next: P.RateLimitSnapshot): P.RateLimitSnapshot =>
  prev === null || (prev.limitId !== null && next.limitId !== null && prev.limitId !== next.limitId)
    ? next
    : {
        limitId: next.limitId ?? prev.limitId,
        limitName: next.limitName ?? prev.limitName ?? null,
        primary: next.primary ?? prev.primary,
        secondary: next.secondary ?? prev.secondary,
        credits: next.credits ?? prev.credits,
        planType: next.planType ?? prev.planType ?? null,
        rateLimitReachedType: next.rateLimitReachedType ?? prev.rateLimitReachedType,
      }

/**
 * A snapshot's primary and secondary windows. Labels are prefixed with the limit id unless it is `codex`.
 *
 * @since 0.1.0
 * @category rate limits
 */
export const limitWindows = (snapshot: P.RateLimitSnapshot): Array<LimitWindowStatus> => {
  const prefix = snapshot.limitId === null || snapshot.limitId === "codex" ? "" : `${snapshot.limitId}.`
  const out: Array<LimitWindowStatus> = []
  for (const [label, w] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    if (w === null || w === undefined) continue
    out.push({
      window: limitWindowOf(w.windowDurationMins),
      label: `${prefix}${label}`,
      usedPercent: w.usedPercent,
      resetsAt: resetsAtOf(w.resetsAt),
      // Codex reports no per-model windows.
      model: Option.none(),
    })
  }
  return out
}

/**
 * The exhausted window for a `usageLimitExceeded` turn, from
 * `account/rateLimits/read`: the window at >= 100%, else the most used one.
 *
 * `overageAvailable` is true when the account has credits (or unlimited
 * credits) that could have paid past the included usage, false when it has
 * none, and null when the snapshot doesn't say. `ordinaryUsageAllowed` is
 * about included usage, which is by definition exhausted here, so it isn't
 * used.
 *
 * @since 0.1.0
 * @category rate limits
 */
export const usageLimitDetails = (
  limits: P.GetAccountRateLimitsResponse | null,
): Pick<UsageLimited, "window" | "resetsAt" | "overageAvailable"> => {
  if (limits === null) return { window: "other", resetsAt: null, overageAvailable: null }
  const snapshot = limits.rateLimitsByLimitId?.["codex"] ?? limits.rateLimits
  const windows = [snapshot.primary, snapshot.secondary].filter((w): w is P.RateLimitWindow => w !== null && w !== undefined)
  const exhausted =
    windows.find((w) => w.usedPercent >= 100) ?? [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
  const credits = snapshot.credits
  return {
    window: exhausted ? limitWindowOf(exhausted.windowDurationMins) : "other",
    resetsAt: exhausted ? resetsAtOf(exhausted.resetsAt) : null,
    overageAvailable: credits === null || credits === undefined ? null : credits.unlimited || credits.hasCredits,
  }
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * What the session knows about a turn beyond the turn itself, for `classifyOutcome`.
 *
 * @since 0.1.0
 * @category models
 */
export interface OutcomeContext {
  /** We sent `turn/interrupt` for this turn (via `interrupt`). */
  readonly interruptRequested: boolean
  /** The estimated spend cap stopped the turn: the cap and the spend when it was hit. */
  readonly spendCap: { readonly capUsd: number; readonly spentUsd: number } | null
  /** `RunOptions.spendCapUsd`, reported if Codex's own session budget stops the turn. */
  readonly capUsd: number | null
  /** app-server died; set when the turn ends because the process exited. */
  readonly processExit: { readonly exitCode: number | null; readonly signal: string | null } | null
  /** Last `final_answer` (else last) agent message of the turn. */
  readonly finalText: string
  /** `account/rateLimits/read`, fetched for `usageLimitExceeded`. */
  readonly rateLimits: P.GetAccountRateLimitsResponse | null
  /** The watchdog stopped the turn (by interrupt, or by killing app-server). */
  readonly stalled?: { readonly idleMs: number; readonly inTool: boolean } | null
}

/**
 * The `Stalled` failure for a turn the watchdog stopped.
 *
 * @since 0.1.0
 * @category outcomes
 */
export const stalledFailure = (stall: { readonly idleMs: number; readonly inTool: boolean }): Stalled =>
  new Stalled({
    message: `no events for ${(stall.idleMs / 1000).toFixed(1)}s${stall.inTool ? " while a tool call was running" : ""}; the watchdog stopped the turn`,
    idleMs: stall.idleMs,
    inTool: stall.inTool,
  })

const throttleKinds: ReadonlySet<string> = new Set<P.CodexErrorKind>([
  "rateLimitExceeded",
  "serverOverloaded",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
])

/**
 * Classifies a completed turn: watchdog stall, process exit, success, interruption or spend cap, then by `codexErrorInfo`.
 *
 * @since 0.1.0
 * @category outcomes
 */
export const classifyOutcome = (turn: P.Turn, ctx: OutcomeContext): TurnOutcome => {
  const turnId = TurnId.make(turn.id)
  // A stalled turn that still completed on its own is a success; anything else
  // (interrupted, failed, app-server killed) is the watchdog's doing.
  if (ctx.stalled != null && turn.status !== "completed") return stalledFailure(ctx.stalled)
  if (ctx.processExit !== null) {
    const { exitCode, signal } = ctx.processExit
    return new ProcessKilled({
      message: `codex app-server exited (${signal ?? `code ${exitCode}`})`,
      signal,
      exitCode,
    })
  }
  if (turn.status === "completed") return { _tag: "Succeeded", turnId, finalText: ctx.finalText }
  if (turn.status === "interrupted") {
    if (ctx.spendCap !== null) {
      return new SpendCapReached({
        message: `estimated spend $${ctx.spendCap.spentUsd.toFixed(4)} reached the cap of $${ctx.spendCap.capUsd}`,
        capUsd: ctx.spendCap.capUsd,
        spentUsd: ctx.spendCap.spentUsd,
        estimated: true,
      })
    }
    return new Interrupted({ message: ctx.interruptRequested ? "interrupted" : "interrupted by codex app-server" })
  }
  const error = turn.error
  const message = error?.message ?? `turn ${turn.status}`
  const kind = errorKind(error?.codexErrorInfo)
  // Typed so each case must be a kind protocol.ts names.
  switch (kind as P.CodexErrorKind | null) {
    case "usageLimitExceeded":
      return new UsageLimited({ message, ...usageLimitDetails(ctx.rateLimits) })
    case "unauthorized":
      return new AuthFailed({ message })
    case "contextWindowExceeded":
      return new ContextExhausted({ message })
    case "sessionBudgetExceeded":
      return new SpendCapReached({ message, capUsd: ctx.capUsd ?? 0, spentUsd: null, estimated: false })
  }
  if (kind !== null && throttleKinds.has(kind)) return new Throttled({ message, retriesLeft: 0 })
  return new AgentFailed({ message, kind })
}

// ---------------------------------------------------------------------------
// Items -> tool events
// ---------------------------------------------------------------------------

/**
 * The `name`, `summary` and `input` of a `ToolCall` event.
 *
 * @since 0.1.0
 * @category models
 */
export interface ToolCallInfo {
  readonly name: string
  readonly summary: string
  readonly input: unknown
}

/**
 * The tool call an item represents, or null if it isn't a tool call.
 *
 * @since 0.1.0
 * @category mapping
 */
export const toolCallOf = (item: P.ThreadItem): ToolCallInfo | null => {
  // Fields are read defensively (`??`): servers may leave out ones the protocol marks required.
  if (P.isItem(item, "commandExecution")) {
    const actions = item.commandActions ?? []
    // `command` is wrapped in the login shell (`zsh -lc '...'`); the parsed actions are what the model wrote.
    const summary = actions.length > 0 ? actions.map((a) => a.command).join(" | ") : item.command
    return { name: "shell", summary, input: { command: item.command, cwd: item.cwd } }
  }
  if (P.isItem(item, "fileChange")) {
    return { name: "apply_patch", summary: (item.changes ?? []).map((c) => c.path).join(", "), input: { changes: item.changes } }
  }
  if (P.isItem(item, "mcpToolCall")) {
    return { name: `mcp__${item.server}__${item.tool}`, summary: `${item.server}.${item.tool}`, input: item.arguments }
  }
  if (P.isItem(item, "dynamicToolCall")) {
    const name = item.namespace ? `${item.namespace}.${item.tool}` : item.tool
    return { name, summary: name, input: item.arguments }
  }
  if (P.isItem(item, "webSearch")) return { name: "web_search", summary: item.query ?? "", input: { query: item.query, action: item.action } }
  if (P.isItem(item, "collabAgentToolCall")) {
    return { name: `collab.${item.tool}`, summary: item.prompt ?? item.tool, input: { prompt: item.prompt } }
  }
  return null
}

const textOf = (c: unknown): string | undefined =>
  typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : undefined

const textOfContent = (content: ReadonlyArray<unknown> | null | undefined): string =>
  (content ?? []).map((c) => textOf(c) ?? JSON.stringify(c)).join("\n")

/**
 * The result of a tool-call item, or null if it isn't a tool call.
 *
 * @since 0.1.0
 * @category mapping
 */
export const toolResultOf = (item: P.ThreadItem): { readonly isError: boolean; readonly output: string } | null => {
  if (P.isItem(item, "commandExecution")) {
    return {
      isError: item.status === "failed" || item.status === "declined" || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0),
      output: item.aggregatedOutput ?? "",
    }
  }
  if (P.isItem(item, "fileChange")) {
    return {
      isError: item.status === "failed" || item.status === "declined",
      output: (item.changes ?? []).map((c) => c.diff ?? c.path).join("\n"),
    }
  }
  if (P.isItem(item, "mcpToolCall")) {
    return {
      isError: item.status === "failed" || (item.error !== null && item.error !== undefined),
      output: item.error?.message ?? textOfContent(item.result?.content),
    }
  }
  if (P.isItem(item, "dynamicToolCall")) {
    return { isError: item.status === "failed" || item.success === false, output: textOfContent(item.contentItems) }
  }
  if (P.isItem(item, "webSearch")) return { isError: false, output: item.results ? JSON.stringify(item.results) : "" }
  if (P.isItem(item, "collabAgentToolCall")) return { isError: item.status === "failed", output: item.status ?? "" }
  return null
}

// ---------------------------------------------------------------------------
// Notification -> events
// ---------------------------------------------------------------------------

/**
 * Mutable state `mapNotification` carries across a session's frames.
 *
 * @since 0.1.0
 * @category models
 */
export interface MapState {
  /** Tool calls already announced (by item id). */
  readonly announced: Set<string>
  lastHeartbeatMs: number
  rateLimits: P.RateLimitSnapshot | null
}

/**
 * @since 0.1.0
 * @category constructors
 */
export const makeMapState = (): MapState => ({ announced: new Set(), lastHeartbeatMs: -Infinity, rateLimits: null })

/**
 * Minimum time between `Heartbeat` events.
 *
 * @since 0.1.0
 * @category constants
 */
export const HEARTBEAT_INTERVAL_MS = 1000

const heartbeatMethods: ReadonlySet<string> = new Set<P.NotificationMethod>([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "thread/tokenUsage/updated",
  "turn/plan/updated",
  "turn/diff/updated",
])

/**
 * Maps one frame that isn't part of the turn lifecycle. Returns the events
 * to emit (possibly none: throttled heartbeats are dropped). `turn/started`,
 * `turn/completed` and `userMessage` items are the session's job.
 *
 * @since 0.1.0
 * @category mapping
 */
export const mapNotification = (msg: P.Incoming, state: MapState, nowMs: number): Array<AgentEvent> => {
  const raw = msg
  const params: unknown = msg.params
  const scoped = (typeof params === "object" && params !== null ? params : {}) as { readonly turnId?: unknown }
  const turnId = typeof scoped.turnId === "string" && scoped.turnId !== "" ? TurnId.make(scoped.turnId) : null

  const heartbeat = (): Array<AgentEvent> => {
    if (nowMs - state.lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return []
    state.lastHeartbeatMs = nowMs
    return [{ _tag: "Heartbeat", turnId, raw }]
  }
  const call = (item: P.ThreadItem): Array<AgentEvent> => {
    const info = toolCallOf(item)
    if (info === null || state.announced.has(item.id)) return []
    state.announced.add(item.id)
    return [{ _tag: "ToolCall", turnId, callId: item.id, ...info, raw }]
  }

  if ("id" in msg && msg.id !== undefined) return [{ _tag: "Other", raw }] // server request

  // Typed so each case must be a method protocol.ts names.
  switch (msg.method as P.NotificationMethod) {
    case "item/started": {
      const item = (params as P.ItemNotification).item
      if (item.type === "reasoning" || item.type === "agentMessage") return heartbeat()
      const events = call(item)
      return events.length > 0 ? events : [{ _tag: "Other", raw }]
    }
    case "item/completed": {
      const item = (params as P.ItemNotification).item
      if (P.isItem(item, "agentMessage")) return [{ _tag: "Text", turnId, text: item.text ?? "", raw }]
      if (item.type === "contextCompaction") return [{ _tag: "Compacted", turnId, trigger: null, raw }]
      if (item.type === "reasoning") return heartbeat()
      const result = toolResultOf(item)
      if (result === null) return [{ _tag: "Other", raw }]
      return [...call(item), { _tag: "ToolResult", turnId, callId: item.id, ...result, raw }]
    }
    case "account/rateLimits/updated": {
      state.rateLimits = mergeRateLimits(state.rateLimits, (params as P.RateLimitsUpdatedNotification).rateLimits)
      return [{ _tag: "LimitsUpdated", windows: limitWindows(state.rateLimits), raw }]
    }
    case "error": {
      const n = params as P.ErrorNotification
      if (!n.willRetry) return [{ _tag: "Other", raw }]
      const message = n.error?.message ?? "retrying"
      return [{ _tag: "Retrying", turnId, ...parseRetry(message), delayMs: null, message, raw }]
    }
  }
  if (heartbeatMethods.has(msg.method)) return heartbeat()
  return [{ _tag: "Other", raw }]
}

/**
 * The final text of a turn: the last `final_answer` message, else the last message.
 *
 * @since 0.1.0
 * @category utils
 */
export const finalTextOf = (messages: ReadonlyArray<{ readonly text: string; readonly phase: string | null }>): string => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.phase === "final_answer") return messages[i]!.text
  return messages.at(-1)?.text ?? ""
}

// ---------------------------------------------------------------------------
// Account status (`account/read` + `account/rateLimits/read`)
// ---------------------------------------------------------------------------

/** The snapshot that governs Codex usage: the `codex` bucket, else the single-bucket view. */
const mainSnapshot = (limits: P.GetAccountRateLimitsResponse): P.RateLimitSnapshot =>
  limits.rateLimitsByLimitId?.["codex"] ?? limits.rateLimits

/**
 * `limits` is null when it couldn't be read (not signed in, or an API-key
 * account without subscription limits).
 *
 * Usability is decided by included usage only: credits that could pay past
 * an exhausted window don't make the account usable, because effect-agent
 * reports limits and never opts into spending credits.
 *
 * @since 0.1.0
 * @category mapping
 */
export const accountStatus = (
  account: P.GetAccountResponse,
  limits: P.GetAccountRateLimitsResponse | null,
  checkedAtMs: number,
): AccountStatus => {
  const main = limits === null ? null : mainSnapshot(limits)
  const others =
    limits === null
      ? []
      : Object.entries(limits.rateLimitsByLimitId ?? {}).flatMap(([id, snapshot]) =>
          snapshot === undefined || id === "codex" || id === main?.limitId ? [] : [snapshot],
        )
  const windows = [...(main === null ? [] : limitWindows(main)), ...others.flatMap(limitWindows)]
  const mainWindows = [main?.primary, main?.secondary].filter((w): w is P.RateLimitWindow => w != null)
  const signedIn = account.account !== null || !account.requiresOpenaiAuth
  const usageLimited =
    main !== null &&
    ((main.rateLimitReachedType ?? null) !== null ||
      mainWindows.some((w) => w.usedPercent >= 100) ||
      limits?.ordinaryUsageAllowed === false)
  const spendLimited = main?.spendControlReached === true
  const reason: AccountStatus["reason"] = !signedIn
    ? "unauthenticated"
    : usageLimited
      ? "usage_limited"
      : spendLimited
        ? "spend_limited"
        : null
  const acct = account.account as { readonly planType?: string | null } | null
  return {
    provider: "codex",
    usable: reason === null,
    reason,
    windows,
    plan: acct?.planType ?? main?.planType ?? null,
    checkedAt: DateTime.makeUnsafe(checkedAtMs),
  }
}

// ---------------------------------------------------------------------------
// Stored history (`thread/turns/list` with `itemsView: "full"`)
// ---------------------------------------------------------------------------

const userText = (content: ReadonlyArray<unknown>): string =>
  content
    .flatMap((c) => {
      const text = textOf(c)
      return typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" && text !== undefined ? [text] : []
    })
    .join("\n")

/**
 * Stored turns -> `TurnStarted`, then each turn's user messages, assistant
 * text, tool calls with their results and compactions, then `TurnEnded`
 * (unless the turn is still in progress). Usage and cost aren't stored per
 * turn, so they are null. Every `raw` is the stored item or the turn
 * (without its items).
 *
 * @since 0.1.0
 * @category mapping
 */
export const historyEvents = (turns: ReadonlyArray<P.Turn>): Array<AgentEvent> => {
  const out: Array<AgentEvent> = []
  for (const turn of turns) {
    const turnId = TurnId.make(turn.id)
    const { items, ...turnRaw } = turn
    out.push({ _tag: "TurnStarted", turnId, raw: turnRaw })
    const messages: Array<{ text: string; phase: string | null }> = []
    for (const item of items) {
      if (P.isItem(item, "userMessage")) {
        out.push({
          _tag: "UserMessage",
          turnId,
          messageId: typeof item.clientId === "string" ? MessageId.make(item.clientId) : null,
          text: userText(item.content ?? []),
          raw: item,
        })
        continue
      }
      if (P.isItem(item, "agentMessage")) {
        messages.push({ text: item.text ?? "", phase: item.phase ?? null })
        out.push({ _tag: "Text", turnId, text: item.text ?? "", raw: item })
        continue
      }
      if (P.isItem(item, "contextCompaction")) {
        out.push({ _tag: "Compacted", turnId, trigger: null, raw: item })
        continue
      }
      const call = toolCallOf(item)
      if (call === null) continue
      out.push({ _tag: "ToolCall", turnId, callId: item.id, ...call, raw: item })
      const result = toolResultOf(item)
      if (result !== null && (item as { readonly status?: unknown }).status !== "inProgress") {
        out.push({ _tag: "ToolResult", turnId, callId: item.id, ...result, raw: item })
      }
    }
    if (turn.status === "inProgress") continue
    const outcome = classifyOutcome(turn, {
      // Who interrupted isn't stored; report it plainly.
      interruptRequested: true,
      spendCap: null,
      capUsd: null,
      processExit: null,
      finalText: finalTextOf(messages),
      rateLimits: null,
    })
    out.push({ _tag: "TurnEnded", turnId, outcome, usage: null, cost: null, raw: turnRaw })
  }
  return out
}
