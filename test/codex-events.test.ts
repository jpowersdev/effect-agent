import { describe, expect, it } from "@effect/vitest"
import { DateTime, Option, Schema } from "effect"
import { AccountStatus, AgentEvent, MessageId, ProcessKilled, TurnId } from "../src/index.ts"
import { ClaudeAgent } from "../src/claude/index.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import * as CodexEvents from "../src/codex/CodexEvents.ts"
import type * as P from "../src/codex/protocol.ts"

const turn = (status: P.TurnStatus, error: P.TurnError | null = null): P.Turn => ({ id: "t-1", items: [], status, error })
const ctx = (over: Partial<CodexEvents.OutcomeContext> = {}): CodexEvents.OutcomeContext => ({
  interruptRequested: false,
  spendCap: null,
  capUsd: null,
  processExit: null,
  finalText: "done",
  rateLimits: null,
  ...over,
})
const err = (codexErrorInfo: P.CodexErrorInfo | null, message = "boom"): P.TurnError => ({
  message,
  codexErrorInfo,
  additionalDetails: null,
})

describe("classifyOutcome", () => {
  it("completed -> Succeeded with the final text", () => {
    expect(CodexEvents.classifyOutcome(turn("completed"), ctx())).toEqual({ _tag: "Succeeded", turnId: "t-1", finalText: "done" })
  })

  it("interrupted: ours, spend cap, process death, unrequested", () => {
    expect(CodexEvents.classifyOutcome(turn("interrupted"), ctx({ interruptRequested: true }))._tag).toBe("Interrupted")
    const cap = CodexEvents.classifyOutcome(turn("interrupted"), ctx({ spendCap: { capUsd: 1, spentUsd: 1.2 } }))
    expect(cap).toMatchObject({ _tag: "SpendCapReached", capUsd: 1, spentUsd: 1.2, estimated: true })
    const killed = CodexEvents.classifyOutcome(turn("interrupted"), ctx({ processExit: { exitCode: null, signal: "SIGKILL" } }))
    expect(killed).toMatchObject({ _tag: "ProcessKilled", signal: "SIGKILL", exitCode: null })
    expect(CodexEvents.classifyOutcome(turn("interrupted"), ctx())._tag).toBe("Interrupted")
  })

  it("maps codexErrorInfo", () => {
    const failed = (info: P.CodexErrorInfo | null) => CodexEvents.classifyOutcome(turn("failed", err(info)), ctx({ capUsd: 5 }))
    expect(failed("unauthorized")._tag).toBe("AuthFailed")
    expect(failed("contextWindowExceeded")._tag).toBe("ContextExhausted")
    expect(failed("sessionBudgetExceeded")).toMatchObject({ _tag: "SpendCapReached", estimated: false, capUsd: 5, spentUsd: null })
    expect(failed("rateLimitExceeded")).toMatchObject({ _tag: "Throttled", retriesLeft: 0 })
    expect(failed("serverOverloaded")._tag).toBe("Throttled")
    expect(failed({ responseStreamDisconnected: { httpStatusCode: 502 } })._tag).toBe("Throttled")
    expect(failed("cyberPolicy")).toMatchObject({ _tag: "AgentFailed", kind: "cyberPolicy", message: "boom" })
    expect(failed({ httpConnectionFailed: { httpStatusCode: null } })).toMatchObject({ _tag: "AgentFailed", kind: "httpConnectionFailed" })
    expect(failed(null)).toMatchObject({ _tag: "AgentFailed", kind: null })
  })

  it("usageLimitExceeded takes the exhausted window from account/rateLimits/read", () => {
    const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt })
    const limits: P.GetAccountRateLimitsResponse = {
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: "codex",
        primary: window(40, 300, 1_000),
        secondary: window(100, 10080, 1793803680),
        credits: { hasCredits: true, unlimited: false, balance: "5" },
        rateLimitReachedType: "rate_limit_reached",
      },
    }
    const outcome = CodexEvents.classifyOutcome(turn("failed", err("usageLimitExceeded", "limit")), ctx({ rateLimits: limits }))
    expect(outcome._tag).toBe("UsageLimited")
    if (outcome._tag !== "UsageLimited") return
    expect(outcome.window).toBe("weekly")
    expect(DateTime.toEpochMillis(outcome.resetsAt!)).toBe(1793803680_000)
    expect(outcome.overageAvailable).toBe(true)
    expect(CodexEvents.usageLimitDetails(null)).toEqual({ window: "other", resetsAt: null, overageAvailable: null })
  })
})

describe("mapNotification", () => {
  const state = () => CodexEvents.makeMapState()
  const n = (method: string, params: unknown): P.Notification => ({ method, params })
  const cmd = (status: string, exitCode: number | null, aggregatedOutput: string | null) => ({
    type: "commandExecution",
    id: "exec-1",
    command: "/bin/zsh -lc 'echo hi'",
    cwd: "/tmp",
    processId: "1",
    status,
    commandActions: [{ type: "unknown", command: "echo hi" }],
    aggregatedOutput,
    exitCode,
  })

  it("maps a command to ToolCall on start and ToolResult on completion", () => {
    const s = state()
    const [call] = CodexEvents.mapNotification(n("item/started", { threadId: "th", turnId: "t-1", item: cmd("inProgress", null, null) }), s, 0)
    expect(call).toMatchObject({ _tag: "ToolCall", turnId: "t-1", callId: "exec-1", name: "shell", summary: "echo hi" })
    const done = CodexEvents.mapNotification(n("item/completed", { threadId: "th", turnId: "t-1", item: cmd("completed", 0, "hi\n") }), s, 0)
    expect(done.map((e) => e._tag)).toEqual(["ToolResult"])
    expect(done[0]).toMatchObject({ isError: false, output: "hi\n" })
    const failed = CodexEvents.mapNotification(n("item/completed", { turnId: "t-1", item: { ...cmd("completed", 2, ""), id: "exec-2" } }), s, 0)
    expect(failed.map((e) => e._tag)).toEqual(["ToolCall", "ToolResult"]) // never seen started
    expect(failed[1]).toMatchObject({ isError: true })
  })

  it("maps file changes, MCP, web search and dynamic tools", () => {
    const s = state()
    const file = CodexEvents.mapNotification(
      n("item/completed", { turnId: "t", item: { type: "fileChange", id: "f", status: "completed", changes: [{ path: "/a.ts", kind: { type: "add" }, diff: "+x" }] } }),
      s,
      0,
    )
    expect(file[0]).toMatchObject({ _tag: "ToolCall", name: "apply_patch", summary: "/a.ts" })
    expect(file[1]).toMatchObject({ _tag: "ToolResult", output: "+x", isError: false })
    const mcp = CodexEvents.mapNotification(
      n("item/completed", {
        turnId: "t",
        item: { type: "mcpToolCall", id: "m", server: "docs", tool: "search", status: "failed", arguments: { q: 1 }, result: null, error: { message: "nope" } },
      }),
      s,
      0,
    )
    expect(mcp[0]).toMatchObject({ name: "mcp__docs__search", input: { q: 1 } })
    expect(mcp[1]).toMatchObject({ isError: true, output: "nope" })
    const web = CodexEvents.mapNotification(n("item/started", { turnId: "t", item: { type: "webSearch", id: "w", query: "effect", action: null, results: null } }), s, 0)
    expect(web[0]).toMatchObject({ name: "web_search", summary: "effect" })
    const dyn = CodexEvents.mapNotification(
      n("item/completed", {
        turnId: "t",
        item: { type: "dynamicToolCall", id: "d", namespace: "ns", tool: "go", arguments: {}, status: "completed", contentItems: [{ type: "inputText", text: "ok" }], success: true },
      }),
      s,
      0,
    )
    expect(dyn[0]).toMatchObject({ name: "ns.go" })
    expect(dyn[1]).toMatchObject({ output: "ok", isError: false })
  })

  it("Text, Compacted, Retrying, Other", () => {
    const s = state()
    expect(
      CodexEvents.mapNotification(n("item/completed", { turnId: "t", item: { type: "agentMessage", id: "a", text: "hi", phase: "final_answer" } }), s, 0)[0],
    ).toMatchObject({ _tag: "Text", text: "hi", turnId: "t" })
    expect(CodexEvents.mapNotification(n("item/completed", { turnId: "t", item: { type: "contextCompaction", id: "c" } }), s, 0)[0]?._tag).toBe("Compacted")
    const retry = CodexEvents.mapNotification(
      n("error", { threadId: "th", turnId: "t", willRetry: true, error: err("responseStreamDisconnected", "Reconnecting... 2/5 (stream disconnected)") }),
      s,
      0,
    )
    expect(retry[0]).toMatchObject({ _tag: "Retrying", attempt: 2, maxAttempts: 5, delayMs: null })
    expect(CodexEvents.mapNotification(n("error", { turnId: "t", willRetry: false, error: err("other") }), s, 0)[0]?._tag).toBe("Other")
    expect(CodexEvents.mapNotification(n("thread/status/changed", {}), s, 0)[0]?._tag).toBe("Other")
    const raw = n("thread/name/updated", { x: 1 })
    expect((CodexEvents.mapNotification(raw, s, 0)[0] as Extract<AgentEvent, { _tag: "Other" }>).raw).toBe(raw)
  })

  it("throttles heartbeats to one per second", () => {
    const s = state()
    const delta = n("item/agentMessage/delta", { turnId: "t", delta: "x" })
    const at = (ms: number) => CodexEvents.mapNotification(delta, s, ms).length
    expect([at(0), at(500), at(999), at(1000), at(1500), at(2100)]).toEqual([1, 0, 0, 1, 0, 1])
  })

  it("merges sparse rate-limit updates", () => {
    const s = state()
    const first = CodexEvents.mapNotification(
      n("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1793803680 },
          secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1793300000 },
          credits: null,
          rateLimitReachedType: null,
        },
      }),
      s,
      0,
    )[0] as Extract<AgentEvent, { _tag: "LimitsUpdated" }>
    expect(first.windows.map((w) => [w.window, w.label, w.usedPercent])).toEqual([
      ["weekly", "primary", 17],
      ["five_hour", "secondary", 3],
    ])
    expect(DateTime.toEpochMillis(first.windows[0]!.resetsAt!)).toBe(1793803680_000)
    const sparse = CodexEvents.mapNotification(
      n("account/rateLimits/updated", {
        rateLimits: { limitId: "codex", primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1793803680 }, secondary: null, credits: null, rateLimitReachedType: null },
      }),
      s,
      0,
    )[0] as Extract<AgentEvent, { _tag: "LimitsUpdated" }>
    expect(sparse.windows.map((w) => w.usedPercent)).toEqual([18, 3])
  })
})

describe("helpers", () => {
  it("token usage keeps reasoning out of output", () => {
    expect(
      CodexEvents.toTokenUsage({ totalTokens: 0, inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 10 }),
    ).toEqual({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 10 })
  })

  it("final text prefers the last final_answer", () => {
    expect(
      CodexEvents.finalTextOf([
        { text: "a", phase: "final_answer" },
        { text: "b", phase: "commentary" },
      ]),
    ).toBe("a")
    expect(CodexEvents.finalTextOf([{ text: "x", phase: null }])).toBe("x")
  })

  it("parses the version from userAgent", () => {
    expect(CodexAppServer.parseUserAgentVersion("effect_agent/0.162.1 (NixOS 26.11.0; x86_64) unknown (effect_agent; 0.0.0)")).toBe("0.162.1")
  })

  it("decodes only JSON-RPC objects from app-server's output", () => {
    // Anything else would have killed the reader (and hung the session) before.
    for (const line of ["", "not json", "42", "null", "[1]", '{"id":{}}', '{"error":"boom","id":1}']) {
      expect(Option.isNone(CodexAppServer.decodeMessage(line))).toBe(true)
    }
    expect(CodexAppServer.decodeMessage('{"id":1,"result":{"ok":true},"error":null}')).toEqual(
      Option.some({ id: 1, result: { ok: true } }),
    )
    expect(CodexAppServer.decodeMessage('{"id":2,"error":{"code":-32600,"message":"no"}}')).toEqual(
      Option.some({ id: 2, error: { code: -32600, message: "no" } }),
    )
    expect(CodexAppServer.decodeMessage('{"method":"turn/started","params":{"x":1}}')).toEqual(
      Option.some({ method: "turn/started", params: { x: 1 } }),
    )
  })

  it("builds thread overrides", () => {
    const built = CodexAgent.threadOverrides({
      cwd: "/w",
      model: "gpt-x",
      effort: "max",
      appendSystemPrompt: "Be brief.",
      disable: { askUser: true, subagents: true, tools: ["web_search", "shell"] },
    })
    expect("overrides" in built).toBe(true)
    if (!("overrides" in built)) return
    expect(built.overrides).toMatchObject({ cwd: "/w", model: "gpt-x", approvalPolicy: "never", sandbox: "danger-full-access" })
    expect(built.overrides.config).toMatchObject({
      mcp_servers: {},
      "features.apps": false,
      model_reasoning_effort: "xhigh",
      "features.default_mode_request_user_input": false,
      "features.multi_agent": false,
      web_search: "disabled",
      "features.shell_tool": false,
    })
    expect(built.overrides.developerInstructions).toMatch(/^Be brief\.\n\nDo not spawn sub-agents/)
    expect("baseInstructions" in built.overrides).toBe(false)
    expect(CodexAgent.threadOverrides({ cwd: "/w", disable: { tools: ["apply_patch"] } })).toMatchObject({ error: expect.stringMatching(/apply_patch/) })
  })

  it("removes the same nesting markers as Claude, and Claude's login token", () => {
    const host = { AI_AGENT: "claude-code", CLAUDE_CODE_SESSION_ID: "p", CLAUDE_CODE_OAUTH_TOKEN: "token", CLAUDE_CONFIG_DIR: "/c" }
    // Codex hands its env to every command it runs, so Claude's token stays out of it.
    expect(CodexAgent.sessionEnv(host)).toEqual({ AI_AGENT: undefined, CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined })
    // Claude Code signs in with it.
    expect(Object.keys(ClaudeAgent.buildEnv(host)).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ENABLE_CLAUDEAI_MCP_SERVERS"])
    // An override wins over removal.
    expect(CodexAgent.sessionEnv(host, { AI_AGENT: "mine", CLAUDE_CODE_OAUTH_TOKEN: "on purpose" })).toMatchObject({
      AI_AGENT: "mine",
      CLAUDE_CODE_OAUTH_TOKEN: "on purpose",
    })
  })

  it("removes nesting markers and applies env overrides", () => {
    const env = CodexAgent.sessionEnv(
      { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "9", CODEX_THREAD_ID: "x", KEEP: "k" },
      { ADD: "a", KEEP: undefined },
    )
    expect(env).toEqual({ CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDE_PID: undefined, CODEX_THREAD_ID: undefined, ADD: "a", KEEP: undefined })
  })

  it("recognizes session-not-found and stale-steer errors", () => {
    const rpc = (message: string) => new CodexAppServer.CodexRpcError({ method: "m", code: -32600, message })
    expect(CodexAgent.isSessionNotFoundError(rpc("no rollout found for thread id 019a"))).toBe(true)
    expect(CodexAgent.isSessionNotFoundError(rpc("invalid session id: invalid character"))).toBe(true)
    expect(CodexAgent.isSessionNotFoundError(rpc("thread not loaded: 019a0000-0000-7000-8000-000000000000"))).toBe(true)
    expect(CodexAgent.isSessionNotFoundError(rpc("invalid thread id: invalid character: expected"))).toBe(true)
    expect(CodexAgent.isSessionNotFoundError(rpc("something else"))).toBe(false)
    expect(CodexAgent.isStaleSteerError(rpc("no active turn to steer"))).toBe(true)
    expect(CodexAgent.isStaleSteerError(rpc("expected active turn id `a` but found `b`"))).toBe(true)
    expect(CodexAgent.isStaleSteerError(rpc("input too long"))).toBe(false)
  })
})

describe("stall classification", () => {
  const stalled = { idleMs: 3_500, inTool: true }
  it("a stalled turn ends Stalled however it stopped", () => {
    for (const t of [turn("interrupted"), turn("failed", err("other"))]) {
      expect(CodexEvents.classifyOutcome(t, ctx({ stalled }))).toMatchObject({ _tag: "Stalled", idleMs: 3_500, inTool: true })
    }
    // killed after the grace period: still Stalled, not ProcessKilled
    const killed = CodexEvents.classifyOutcome(turn("interrupted"), ctx({ stalled, processExit: { exitCode: null, signal: "SIGKILL" } }))
    expect(killed).toMatchObject({ _tag: "Stalled", inTool: true })
    // and not Interrupted even if the caller also interrupted
    expect(CodexEvents.classifyOutcome(turn("interrupted"), ctx({ stalled, interruptRequested: true }))._tag).toBe("Stalled")
  })

  it("a stalled turn that completed anyway succeeded", () => {
    expect(CodexEvents.classifyOutcome(turn("completed"), ctx({ stalled }))._tag).toBe("Succeeded")
  })

  it("describes the stall", () => {
    expect(CodexEvents.stalledFailure(stalled).message).toMatch(/3\.5s while a tool call was running/)
    expect(CodexEvents.stalledFailure({ idleMs: 30_000, inTool: false }).message).not.toMatch(/tool/)
  })
})

describe("accountStatus", () => {
  const signedIn: P.GetAccountResponse = { account: { type: "chatgpt", email: "user@example.com", planType: "pro" }, requiresOpenaiAuth: true }
  const snapshot = (over: Partial<P.RateLimitSnapshot> = {}): P.RateLimitSnapshot => ({
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1793803680 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: "100" },
    spendControlReached: false,
    planType: "pro",
    rateLimitReachedType: null,
    ...over,
  })
  const limits = (over: Partial<P.RateLimitSnapshot> = {}, ordinaryUsageAllowed: boolean | null = true): P.GetAccountRateLimitsResponse => ({
    ordinaryUsageAllowed,
    rateLimits: snapshot(over),
    rateLimitsByLimitId: { codex: snapshot(over) },
  })
  const status = (account: P.GetAccountResponse, l: P.GetAccountRateLimitsResponse | null) => {
    const s = CodexEvents.accountStatus(account, l, 1_793_300_000_000)
    Schema.encodeUnknownSync(AccountStatus)(s)
    return s
  }

  it("maps the audit's sample", () => {
    const s = status(signedIn, limits())
    expect(s).toMatchObject({ provider: "codex", usable: true, reason: null, plan: "pro" })
    expect(s.windows).toHaveLength(1)
    expect(s.windows[0]).toMatchObject({ window: "weekly", label: "primary", usedPercent: 17 })
    expect(DateTime.toEpochMillis(s.windows[0]!.resetsAt!)).toBe(1793803680_000)
    expect(DateTime.toEpochMillis(s.checkedAt)).toBe(1_793_300_000_000)
  })

  it("maps window durations", () => {
    const s = status(signedIn, limits({
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 1, windowDurationMins: 1440, resetsAt: 1 },
    }))
    expect(s.windows.map((w) => [w.window, w.label, w.resetsAt === null])).toEqual([
      ["five_hour", "primary", true],
      ["other", "secondary", false],
    ])
  })

  it("reports other limit buckets with their id in the label", () => {
    const l = limits()
    const other = snapshot({ limitId: "codex_other", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 } })
    const s = status(signedIn, { ...l, rateLimitsByLimitId: { ...l.rateLimitsByLimitId, codex_other: other } })
    expect(s.windows.map((w) => w.label)).toEqual(["primary", "codex_other.primary"])
    expect(s.usable).toBe(true) // only the codex bucket decides
  })

  it("no account is unauthenticated", () => {
    expect(status({ account: null, requiresOpenaiAuth: true }, null)).toMatchObject({ usable: false, reason: "unauthenticated", plan: null, windows: [] })
    // a provider that needs no OpenAI sign-in
    expect(status({ account: null, requiresOpenaiAuth: false }, null)).toMatchObject({ usable: true, reason: null })
  })

  it("usage_limited: reached type, an exhausted window, or ordinary usage refused; credits don't help", () => {
    expect(status(signedIn, limits({ rateLimitReachedType: "rate_limit_reached" }))).toMatchObject({ usable: false, reason: "usage_limited" })
    const full = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 }
    expect(status(signedIn, limits({ secondary: full, credits: { hasCredits: true, unlimited: true, balance: null } }))).toMatchObject({
      usable: false,
      reason: "usage_limited",
    })
    expect(status(signedIn, limits({}, false))).toMatchObject({ usable: false, reason: "usage_limited" })
    expect(status(signedIn, limits({}, null)).usable).toBe(true) // unknown is not limited
  })

  it("spend_limited when spend control is reached", () => {
    expect(status(signedIn, limits({ spendControlReached: true }))).toMatchObject({ usable: false, reason: "spend_limited" })
    expect(status(signedIn, limits({ spendControlReached: null })).usable).toBe(true)
  })

  it("an API-key account without subscription limits is usable", () => {
    expect(status({ account: { type: "apiKey" }, requiresOpenaiAuth: true }, null)).toMatchObject({ usable: true, plan: null, windows: [] })
  })
})

describe("historyEvents", () => {
  it("skips user-message content that isn't a text block, null included", () => {
    const turn: P.Turn = {
      id: "t-1",
      items: [{ type: "userMessage", id: "u-1", clientId: null, content: [null, 7, { type: "image" }, { type: "text", text: "kept" }] }],
      status: "inProgress",
      error: null,
    }
    expect(CodexEvents.historyEvents([turn])).toMatchObject([{ _tag: "TurnStarted" }, { _tag: "UserMessage", text: "kept" }])
  })

  const user = (id: string, text: string, clientId: string | null = null): P.ThreadItem => ({
    type: "userMessage",
    id,
    clientId,
    content: [{ type: "text", text, text_elements: [] }],
  })
  const agentText = (id: string, text: string, phase: P.MessagePhase | null = "final_answer"): P.ThreadItem => ({ type: "agentMessage", id, text, phase })
  const command = (id: string, status: "completed" | "failed" | "inProgress", exitCode: number | null, output: string | null): P.ThreadItem => ({
    type: "commandExecution",
    id,
    command: "/bin/zsh -lc 'echo hi'",
    cwd: "/w",
    processId: "1",
    status,
    commandActions: [{ type: "unknown", command: "echo hi" }],
    aggregatedOutput: output,
    exitCode,
  })
  const stored = (id: string, status: P.TurnStatus, items: ReadonlyArray<P.ThreadItem>, error: P.TurnError | null = null): P.Turn => ({
    id,
    items,
    itemsView: "full",
    status,
    error,
  })

  it("maps turns, items and outcomes", () => {
    const events = CodexEvents.historyEvents([
      stored("t1", "completed", [
        user("u1", "run it", "ea-1"),
        { type: "reasoning", id: "r1" },
        agentText("a1", "running", "commentary"),
        command("c1", "completed", 0, "hi\n"),
        { type: "contextCompaction", id: "x1" },
        agentText("a2", "done"),
      ]),
      stored("t2", "interrupted", [user("u2", "sleep"), command("c2", "failed", -1, null)]),
      stored("t3", "failed", [user("u3", "hello")], err("usageLimitExceeded", "You've hit your usage limit")),
      stored("t4", "inProgress", [user("u4", "still going"), command("c4", "inProgress", null, null)]),
    ])
    for (const e of events) Schema.encodeUnknownSync(AgentEvent)(e)
    expect(events.map((e) => e._tag)).toEqual([
      "TurnStarted", "UserMessage", "Text", "ToolCall", "ToolResult", "Compacted", "Text", "TurnEnded",
      "TurnStarted", "UserMessage", "ToolCall", "ToolResult", "TurnEnded",
      "TurnStarted", "UserMessage", "TurnEnded",
      "TurnStarted", "UserMessage", "ToolCall",
    ])
    expect(events[1]).toMatchObject({ _tag: "UserMessage", turnId: "t1", messageId: "ea-1", text: "run it" })
    expect(events[3]).toMatchObject({ _tag: "ToolCall", callId: "c1", name: "shell", summary: "echo hi" })
    expect(events[4]).toMatchObject({ _tag: "ToolResult", callId: "c1", isError: false, output: "hi\n" })
    const ends = events.filter((e): e is Extract<AgentEvent, { _tag: "TurnEnded" }> => e._tag === "TurnEnded")
    expect(ends.map((e) => e.outcome._tag)).toEqual(["Succeeded", "Interrupted", "UsageLimited"])
    expect(ends[0]).toMatchObject({ usage: null, cost: null, outcome: { finalText: "done" } })
    expect(ends[1]!.outcome).toMatchObject({ message: "interrupted" })
    expect(events[11]).toMatchObject({ _tag: "ToolResult", isError: true })
    expect(events[9]).toMatchObject({ messageId: null })
    // raw keeps the stored turn, without duplicating its items
    expect(events[0]!.raw).toMatchObject({ id: "t1", status: "completed" })
    expect((events[0]!.raw as any).items).toBeUndefined()
  })
})

describe("hooks", () => {
  it("refuses any hook, accepts none", () => {
    expect(CodexAgent.hooksError({ cwd: "/w" })).toBeNull()
    expect(CodexAgent.hooksError({ cwd: "/w", hooks: {} })).toBeNull()
    expect(CodexAgent.hooksError({ cwd: "/w", hooks: { afterTool: () => null as any } })).toMatch(/afterTool.*config-only/)
  })
})

describe("CodexAgent.step", () => {
  const threadId = "th-1"
  const price = { input: 1_000_000, output: 1_000_000 }
  const stepCtx = (cap: CodexAgent.StepContext["cap"] = null): CodexAgent.StepContext => ({
    threadId,
    nowMs: 0,
    mapState: CodexEvents.makeMapState(),
    cap,
  })
  const note = (method: string, params: unknown): P.Incoming => ({ method, params })
  const messageId = MessageId.make("m-1")
  const running = (state = CodexAgent.initialState) => {
    const claimed = CodexAgent.startRun(state, messageId)
    return CodexAgent.runStarted(claimed, claimed.run!.seq, "t-1")
  }
  const usage = (input: number) => ({
    total: { totalTokens: input, inputTokens: input, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    last: { totalTokens: input, inputTokens: input, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  })

  it("announces the turn once and lands its message from the userMessage item", () => {
    const ctx = stepCtx()
    const started = CodexAgent.step(ctx, running(), note("turn/started", { threadId, turn: turn("inProgress") }))
    expect(started.events).toMatchObject([{ _tag: "TurnStarted", turnId: "t-1" }])
    const again = CodexAgent.step(ctx, started.state, note("turn/started", { threadId, turn: turn("inProgress") }))
    expect(again.events).toMatchObject([{ _tag: "Other" }])
    const item = { type: "userMessage", id: "i-1", clientId: messageId, content: [] }
    const landed = CodexAgent.step(ctx, started.state, note("item/started", { threadId, turnId: "t-1", item }))
    expect(landed.events).toMatchObject([{ _tag: "MessageLanded", messageId, turnId: "t-1" }])
    expect(landed.state.run?.unlanded).toEqual([])
  })

  it("ignores other threads' frames", () => {
    const result = CodexAgent.step(stepCtx(), running(), note("turn/completed", { threadId: "sub", turn: turn("completed") }))
    expect(result.events).toMatchObject([{ _tag: "Other" }])
    expect(result.commands).toEqual([])
  })

  it("asks to complete our turn, and completeTurn ends it", () => {
    const state = running()
    const completed = CodexAgent.step(stepCtx(), state, note("turn/completed", { threadId, turn: turn("completed") }))
    expect(completed.commands).toMatchObject([{ _tag: "Complete" }])
    // Not announced yet: the TurnStarted comes first.
    expect(completed.events).toMatchObject([{ _tag: "TurnStarted", turnId: "t-1" }])
    const done = CodexAgent.completeTurn({ cap: null }, completed.state, {
      seq: completed.state.run!.seq,
      turn: turn("completed"),
      raw: null as never,
      price: undefined,
      rateLimits: null,
      processExit: null,
    })
    expect(done.state.run).toBeNull()
    expect(done.events).toMatchObject([{ _tag: "TurnEnded", turnId: "t-1", outcome: { _tag: "Succeeded" } }])
  })

  it("interrupts the turn once the estimated spend reaches the cap", () => {
    const ctx = stepCtx({ capUsd: 1, price })
    const under = CodexAgent.step(ctx, running(), note("thread/tokenUsage/updated", { threadId, turnId: "t-1", tokenUsage: usage(0) }))
    expect(under.commands).toEqual([])
    const over = CodexAgent.step(ctx, under.state, note("thread/tokenUsage/updated", { threadId, turnId: "t-1", tokenUsage: usage(2) }))
    expect(over.commands).toEqual([{ _tag: "Interrupt", turnId: "t-1" }])
    expect(over.state.capReached).toBeGreaterThanOrEqual(1)
    expect(CodexAgent.steerable(over.state.run)).toBe(false)
    // Only once.
    const later = CodexAgent.step(ctx, over.state, note("thread/tokenUsage/updated", { threadId, turnId: "t-1", tokenUsage: usage(3) }))
    expect(later.commands).toEqual([])
  })

  it("a stall marks the running turn once; app-server dying then ends it Stalled", () => {
    const state = running()
    const stall = { idleMs: 5_000, inTool: true }
    const marked = CodexAgent.markStalled(state, TurnId.make("t-1"), stall)
    expect(marked.marked).toBe(true)
    expect(CodexAgent.markStalled(marked.state, TurnId.make("t-1"), stall).marked).toBe(false)
    expect(CodexAgent.markStalled(state, TurnId.make("other"), stall).marked).toBe(false)
    const dead = new ProcessKilled({ message: "gone", signal: "SIGKILL", exitCode: null })
    const exited = CodexAgent.stepExit(marked.state, dead, { exitCode: null, signal: "SIGKILL" }, undefined)
    expect(exited.events).toMatchObject([{ _tag: "TurnEnded", outcome: { _tag: "Stalled", inTool: true } }])
  })

  it("a failed turn/start frees the run only if it is still that run, and not once its turn started", () => {
    const claimed = CodexAgent.startRun(CodexAgent.initialState, messageId)
    const seq = claimed.run!.seq
    expect(CodexAgent.runFailed(claimed, seq)).toEqual({ state: { ...claimed, run: null }, running: null })
    expect(CodexAgent.runFailed(claimed, seq + 1).state.run).not.toBeNull()
    const announced = CodexAgent.step(stepCtx(), claimed, note("turn/started", { threadId, turn: turn("inProgress") })).state
    expect(CodexAgent.runFailed(announced, seq)).toEqual({ state: announced, running: "t-1" })
  })

  it("completeTurn only ends the run it was issued for", () => {
    const state = running()
    const input = { turn: turn("completed"), raw: null as never, price: undefined, rateLimits: null, processExit: null }
    expect(CodexAgent.completeTurn({ cap: null }, state, { ...input, seq: state.run!.seq + 1 })).toEqual({ state, events: [] })
    expect(CodexAgent.completeTurn({ cap: null }, state, { ...input, seq: state.run!.seq }).events).toHaveLength(1)
  })
})
