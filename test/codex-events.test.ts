import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { AgentEvent } from "../src/index.ts"
import { CodexAgent, CodexAppServer, CodexEvents } from "../src/codex/index.ts"
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
    expect(CodexAgent.isSessionNotFoundError(rpc("something else"))).toBe(false)
    expect(CodexAgent.isStaleSteerError(rpc("no active turn to steer"))).toBe(true)
    expect(CodexAgent.isStaleSteerError(rpc("expected active turn id `a` but found `b`"))).toBe(true)
    expect(CodexAgent.isStaleSteerError(rpc("input too long"))).toBe(false)
  })
})
