import type { SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { type AgentEvent, SessionId, TurnId } from "../src/index.ts"

const sessionId = SessionId.make("11111111-1111-4111-8111-111111111111")
const turnId = TurnId.make("t1")

const result = (fields: Record<string, unknown> = {}): SDKResultMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    errors: [],
    total_cost_usd: 0.01,
    usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 },
    uuid: "r1",
    session_id: sessionId,
    ...fields,
  }) as unknown as SDKResultMessage

const outcomeInput = (fields: Partial<ClaudeAgent.OutcomeInput> = {}): ClaudeAgent.OutcomeInput => ({
  turnId,
  result: result(),
  assistantError: null,
  rateLimit: null,
  interruptRequested: false,
  processError: null,
  capUsd: null,
  ...fields,
})

describe("ClaudeAgent.buildEnv", () => {
  const host = {
    PATH: "/bin",
    HOME: "/home/u",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
    CLAUDE_PID: "42",
    AI_AGENT: "claude-code_2-1-301_agent",
    CLAUDE_CODE_OAUTH_TOKEN: "keep-me",
    ENABLE_CLAUDEAI_MCP_SERVERS: "true",
  }

  it("removes nesting markers but keeps real configuration", () => {
    const env = ClaudeAgent.buildEnv(host)
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID", "AI_AGENT"]) {
      expect(env).not.toHaveProperty(k)
    }
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", CLAUDE_CODE_OAUTH_TOKEN: "keep-me" })
  })

  it("applies overrides, undefined unsets, and always disables claude.ai MCP", () => {
    const env = ClaudeAgent.buildEnv(host, { HOME: undefined, FOO: "bar", ENABLE_CLAUDEAI_MCP_SERVERS: "true" })
    expect(env).not.toHaveProperty("HOME")
    expect(env.FOO).toBe("bar")
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
  })
})

describe("ClaudeAgent.buildOptions", () => {
  it("maps RunOptions with permissions off and MCP isolated", () => {
    const options = ClaudeAgent.buildOptions(
      {
        cwd: "/tmp/x",
        model: "claude-haiku-5-5",
        effort: "minimal",
        appendSystemPrompt: "Be brief.",
        disable: { askUser: true, subagents: true, tools: ["WebSearch"] },
        spendCapUsd: 0.5,
        env: { FOO: "1" },
      },
      {},
      sessionId,
      { PATH: "/bin", CLAUDECODE: "1" },
    )
    expect(options).toMatchObject({
      cwd: "/tmp/x",
      sessionId,
      model: "claude-haiku-5-5",
      effort: "low",
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be brief." },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      maxBudgetUsd: 0.5,
      env: { PATH: "/bin", FOO: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    })
    expect(options.disallowedTools).toEqual(["AskUserQuestion", "Agent", "Task", "Workflow", "WebSearch"])
    expect(options).not.toHaveProperty("resume")
    expect(options).not.toHaveProperty("settingSources")
    expect(options).not.toHaveProperty("pathToClaudeCodeExecutable")
    expect(options.env).not.toHaveProperty("CLAUDECODE")
  })

  it("resumes instead of preassigning, and passes layer options through", () => {
    const options = ClaudeAgent.buildOptions(
      { cwd: "/tmp/x", resume: sessionId },
      { settingSources: [], pathToClaudeCodeExecutable: "/opt/claude", model: "m" },
      SessionId.make("other"),
      {},
    )
    expect(options).toMatchObject({ resume: sessionId, settingSources: [], pathToClaudeCodeExecutable: "/opt/claude", model: "m" })
    expect(options).not.toHaveProperty("sessionId")
    expect(options).not.toHaveProperty("disallowedTools")
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" })
  })

  it("lists Workflow among the SDK's builtin tools", async () => {
    const { BUILTIN_TOOL_NAMES } = await import("@anthropic-ai/claude-agent-sdk")
    expect(BUILTIN_TOOL_NAMES).toContain("Workflow")
    expect(BUILTIN_TOOL_NAMES).toContain("Agent")
  })
})

describe("transcript location", () => {
  it("encodes the cwd like Claude Code", () => {
    expect(ClaudeSdk.encodeProjectDir("/home/u/github.com/a_b/.local")).toBe("-home-u-github-com-a-b--local")
    const long = "/" + "x".repeat(250)
    const encoded = ClaudeSdk.encodeProjectDir(long)
    expect(encoded.startsWith("-" + "x".repeat(199) + "-")).toBe(true)
    expect(encoded.length).toBeGreaterThan(201)
  })

  it("joins config dir, project dir and session id", () => {
    expect(ClaudeSdk.transcriptPath("/nonexistent/a.b", "s1", "/cfg")).toBe("/cfg/projects/-nonexistent-a-b/s1.jsonl")
    expect(ClaudeAgent.location({ cwd: "/nonexistent/p", env: { CLAUDE_CONFIG_DIR: "/c2" } }, sessionId)).toBe(
      `/c2/projects/-nonexistent-p/${sessionId}.jsonl`,
    )
  })
})

describe("frame mapping", () => {
  it("summarizes tool calls in one line", () => {
    expect(ClaudeAgent.toolSummary("Bash", { command: "ls -la\necho hi" })).toBe("ls -la")
    expect(ClaudeAgent.toolSummary("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts")
    expect(ClaudeAgent.toolSummary("Grep", { pattern: "foo.*" })).toBe("foo.*")
    expect(ClaudeAgent.toolSummary("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts")
    expect(ClaudeAgent.toolSummary("WebFetch", { url: "https://x.dev" })).toBe("https://x.dev")
    expect(ClaudeAgent.toolSummary("Agent", { description: "Find bugs" })).toBe("Find bugs")
    expect(ClaudeAgent.toolSummary("TodoWrite", { todos: [] })).toBe("TodoWrite")
  })

  it("flattens tool_result content", () => {
    expect(ClaudeAgent.flattenToolContent("plain")).toBe("plain")
    expect(ClaudeAgent.flattenToolContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe(
      "a\n[image]\nb",
    )
  })

  it("maps assistant and user frames to Text, ToolCall and ToolResult", () => {
    const assistant = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: "hi" },
          { type: "tool_use", id: "c1", name: "Bash", input: { command: "echo 1" } },
        ],
      },
      parent_tool_use_id: null,
    } as unknown as ClaudeSdk.Frame
    expect(ClaudeAgent.frameEvents(assistant, turnId).map((e) => e._tag)).toEqual(["Text", "ToolCall"])
    const user = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "1\n", is_error: false }] },
      parent_tool_use_id: null,
    } as unknown as ClaudeSdk.Frame
    expect(ClaudeAgent.frameEvents(user, turnId)).toMatchObject([
      { _tag: "ToolResult", callId: "c1", isError: false, output: "1\n", turnId },
    ])
  })

  it("maps api_retry, compact_boundary and unknown frames", () => {
    const retry = { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" }
    expect(ClaudeAgent.frameEvents(retry as unknown as ClaudeSdk.Frame, turnId)).toMatchObject([
      { _tag: "Retrying", attempt: 2, maxAttempts: 10, delayMs: 500, message: "overloaded (529)" },
    ])
    const compact = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } }
    expect(ClaudeAgent.frameEvents(compact as unknown as ClaudeSdk.Frame, turnId)).toMatchObject([{ _tag: "Compacted", trigger: "auto" }])
    expect(ClaudeAgent.frameEvents({ type: "mystery" } as unknown as ClaudeSdk.Frame, null)).toMatchObject([{ _tag: "Other" }])
  })

  it("normalizes rate-limit windows (fraction to percent, seconds to millis)", () => {
    const info = {
      status: "allowed",
      resetsAt: 1793319600,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.33, resetsAt: 1793319600, status: "allowed" },
        seven_day: { utilization: 0.19, resetsAt: 1793844000, status: "allowed" },
        seven_day_opus: { utilization: 0.5 },
      },
    } as unknown as SDKRateLimitInfo
    const windows = ClaudeAgent.limitWindows(info)
    expect(windows.map((w) => [w.window, w.label, w.usedPercent])).toEqual([
      ["five_hour", "five_hour", 33],
      ["weekly", "seven_day", 19],
      ["other", "seven_day_opus", 50],
    ])
    expect(DateTime.toEpochMillis(windows[0]!.resetsAt!)).toBe(1793319600_000)
    expect(ClaudeAgent.limitWindows({ status: "allowed", rateLimitType: "seven_day", resetsAt: 10 })).toMatchObject([
      { window: "weekly", label: "seven_day", usedPercent: null },
    ])
  })

  it("decodes lifecycle frames defensively", () => {
    expect(ClaudeSdk.decodeLifecycle({ type: "command_lifecycle", command_uuid: "u", state: "started" })).toBeDefined()
    expect(ClaudeSdk.decodeLifecycle({ type: "command_lifecycle", command_uuid: "u", state: "weird" })).toBeUndefined()
    expect(ClaudeSdk.decodeLifecycle({ type: "command_lifecycle", state: "started" })).toBeUndefined()
    expect(ClaudeSdk.decodeLifecycle(null)).toBeUndefined()
  })
})

describe("ClaudeAgent.classifyOutcome", () => {
  it("success", () => {
    expect(ClaudeAgent.classifyOutcome(outcomeInput())).toEqual({ _tag: "Succeeded", turnId, finalText: "done" })
  })

  it("spend cap", () => {
    const o = ClaudeAgent.classifyOutcome(
      outcomeInput({
        capUsd: 0.0001,
        result: result({ subtype: "error_max_budget_usd", errors: ["Reached maximum budget ($0.0001)"], total_cost_usd: 0.00012, terminal_reason: "budget_exhausted" }),
      }),
    )
    expect(o).toMatchObject({ _tag: "SpendCapReached", capUsd: 0.0001, spentUsd: 0.00012, estimated: false })
  })

  it("usage limit from the assistant error and rate-limit info", () => {
    const o = ClaudeAgent.classifyOutcome(
      outcomeInput({
        result: result({ is_error: true, result: "You've hit your session limit" }),
        assistantError: "rate_limit",
        rateLimit: { status: "rejected", resetsAt: 1792993200, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "out_of_credits" },
      }),
    )
    expect(o._tag).toBe("UsageLimited")
    if (o._tag !== "UsageLimited") return
    expect(o.window).toBe("five_hour")
    expect(DateTime.toEpochMillis(o.resetsAt!)).toBe(1792993200_000)
    expect(o.overageAvailable).toBe(false)
    expect(o.message).toBe("You've hit your session limit")
  })

  it("weekly usage limit from a rejected rate_limit_event, overage unknown", () => {
    const o = ClaudeAgent.classifyOutcome(
      outcomeInput({
        result: result({ is_error: true }),
        rateLimit: { status: "rejected", rateLimitType: "seven_day" },
      }),
    )
    expect(o).toMatchObject({ _tag: "UsageLimited", window: "weekly", resetsAt: null, overageAvailable: null })
  })

  it("auth, context, throttling and other failures", () => {
    const failed = result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: result({ is_error: true }), assistantError: "authentication_failed" }))._tag).toBe("AuthFailed")
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: result({ ...failed, terminal_reason: "prompt_too_long" }) }))._tag).toBe("ContextExhausted")
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: result({ is_error: true }), assistantError: "overloaded" }))).toMatchObject({ _tag: "Throttled", retriesLeft: 0 })
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: result({ is_error: true }), assistantError: "rate_limit" }))._tag).toBe("Throttled")
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: result({ ...failed, terminal_reason: "max_turns" }) }))).toMatchObject({ _tag: "AgentFailed", kind: "max_turns", message: "boom" })
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: failed }))).toMatchObject({ _tag: "AgentFailed", kind: "error_during_execution" })
  })

  it("interrupt is classified by our request, not the error text", () => {
    const aborted = result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] …"] })
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: aborted, interruptRequested: true }))._tag).toBe("Interrupted")
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ result: aborted }))).toMatchObject({ _tag: "AgentFailed", kind: "aborted_streaming" })
    // Interrupt arrived after the turn finished: still a success.
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ interruptRequested: true }))._tag).toBe("Succeeded")
  })

  it("process death", () => {
    expect(
      ClaudeAgent.classifyOutcome(
        outcomeInput({ result: null, processError: { message: "Claude Code process terminated by signal SIGKILL", signal: "SIGKILL", exitCode: null } }),
      ),
    ).toMatchObject({ _tag: "ProcessKilled", signal: "SIGKILL", exitCode: null })
  })

  it("per-turn usage includes cache tokens in input", () => {
    expect(ClaudeAgent.turnUsage(result())).toEqual({ inputTokens: 113, cachedInputTokens: 100, outputTokens: 7, reasoningTokens: null })
  })

  it("recognizes the CLI's missing-session text", () => {
    expect(ClaudeAgent.sessionNotFound(`No conversation found with session ID: ${sessionId}`, sessionId)?._tag).toBe("SessionNotFound")
    expect(ClaudeAgent.sessionNotFound("something else", sessionId)).toBeUndefined()
  })
})

describe("ClaudeAgent.step", () => {
  const ctx = (nowMs = 0): ClaudeAgent.StepContext => ({ sessionId, resumed: false, capUsd: null, nowMs })
  const lifecycle = (command_uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid, state }) as unknown as ClaudeSdk.Frame
  const init = { type: "system", subtype: "init", claude_code_version: "2.1.312", model: "m", session_id: sessionId } as unknown as ClaudeSdk.Frame
  const run = (frames: ReadonlyArray<ClaudeSdk.Frame>, nowMs: (i: number) => number = () => 0) => {
    let state = ClaudeAgent.initialState
    const events: Array<AgentEvent> = []
    const dropped: Array<string> = []
    frames.forEach((frame, i) => {
      const s = ClaudeAgent.step(ctx(nowMs(i)), state, frame)
      state = s.state
      events.push(...s.events)
      dropped.push(...s.dropped.map((d) => `${d.messageId}:${d.state}`))
    })
    return { state, events, dropped }
  }
  const tagsOf = (events: ReadonlyArray<AgentEvent>) => events.filter((e) => e._tag !== "Other").map((e) => e._tag)

  it("starts a turn on lifecycle started, lands a mid-turn message, ends at result", () => {
    const { events, state } = run([
      lifecycle("u1", "queued"),
      lifecycle("u1", "started"),
      init,
      lifecycle("u2", "queued"),
      lifecycle("u2", "started"),
      result({ user_message_uuids: ["u1", "u2"] }),
      lifecycle("u1", "completed"),
      lifecycle("u3", "started"),
      init,
    ])
    expect(tagsOf(events)).toEqual(["SessionStarted", "TurnStarted", "MessageLanded", "MessageLanded", "TurnEnded", "TurnStarted", "MessageLanded"])
    expect(events.filter((e) => e._tag === "TurnStarted").map((e) => e._tag === "TurnStarted" && e.turnId)).toEqual(["u1", "u3"])
    expect(events.find((e) => e._tag === "MessageLanded" && e.messageId === "u2")).toMatchObject({ turnId: "u1" })
    expect(events.find((e) => e._tag === "TurnEnded")).toMatchObject({
      turnId: "u1",
      outcome: { _tag: "Succeeded" },
      cost: { usd: 0.01, source: "reported" },
      usage: { inputTokens: 113 },
    })
    expect(state.turn?.turnId).toBe("u3")
  })

  it("holds events until the first init, so SessionStarted comes first", () => {
    const { events } = run([lifecycle("u1", "queued"), lifecycle("u1", "started"), init])
    expect(events.map((e) => e._tag)).toEqual(["SessionStarted", "Other", "TurnStarted", "MessageLanded"])
  })

  it("reports dropped messages", () => {
    expect(run([init, lifecycle("u1", "cancelled"), lifecycle("u2", "refused")]).dropped).toEqual(["u1:cancelled", "u2:refused"])
  })

  it("doesn't report an interrupted turn's own message as dropped", () => {
    // After an interrupt the CLI marks the turn's (already landed) message `cancelled`.
    const { events, dropped } = run([
      init,
      lifecycle("u1", "started"),
      result({ subtype: "error_during_execution", terminal_reason: "aborted_tools", user_message_uuids: ["u1"] }),
      lifecycle("u1", "cancelled"),
      lifecycle("u2", "cancelled"),
    ])
    expect(dropped).toEqual(["u2:cancelled"])
    expect(events.filter((e) => e._tag === "MessageDropped")).toMatchObject([{ messageId: "u2", reason: "cancelled" }])
  })

  it("throttles heartbeats to one per second", () => {
    const hb = { type: "system", subtype: "thinking_tokens", estimated_tokens: 1, estimated_tokens_delta: 1 } as unknown as ClaudeSdk.Frame
    const times = [0, 0, 0, 500, 1000, 1500, 2100]
    const { events } = run([init, init, ...times.slice(2).map(() => hb)], (i) => times[i]!)
    expect(events.filter((e) => e._tag === "Heartbeat")).toHaveLength(3)
  })

  it("marks interrupts on the running turn", () => {
    const { state } = run([init, lifecycle("u1", "started")])
    const marked = ClaudeAgent.markInterrupt(state)
    const ended = ClaudeAgent.step(ctx(), marked, result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }))
    expect(ended.events).toMatchObject([{ _tag: "TurnEnded", outcome: { _tag: "Interrupted" } }])
  })

  it("ends a running turn ProcessKilled when the process exits", () => {
    const { state } = run([init, lifecycle("u1", "started")])
    const exit = ClaudeAgent.stepExit(ctx(), state, { message: "killed", signal: "SIGKILL", exitCode: null })
    expect(exit.events).toMatchObject([{ _tag: "TurnEnded", turnId: "u1", outcome: { _tag: "ProcessKilled", signal: "SIGKILL" }, usage: null, cost: null }])
    expect(exit.state.turn).toBeNull()
  })

  it("without lifecycle frames (older CLIs), binds turn content to the oldest pending message", () => {
    const assistant = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null } as unknown as ClaudeSdk.Frame
    let s = ClaudeAgent.step(ctx(), ClaudeAgent.initialState, init)
    s = ClaudeAgent.step({ ...ctx(), nextPending: "u9" }, s.state, assistant)
    expect(s.events).toMatchObject([{ _tag: "TurnStarted", turnId: "u9" }, { _tag: "MessageLanded", messageId: "u9", turnId: "u9" }, { _tag: "Text", turnId: "u9" }])
  })

  it("SessionStarted only once, with resumed from context", () => {
    const s1 = ClaudeAgent.step({ ...ctx(), resumed: true }, ClaudeAgent.initialState, init)
    expect(s1.events).toMatchObject([{ _tag: "SessionStarted", sessionId, version: "2.1.312", model: "m", resumed: true, provider: "claude" }])
    expect(ClaudeAgent.step(ctx(), s1.state, init).events).toMatchObject([{ _tag: "Other" }])
  })
})

describe("capabilities", () => {
  it("reads the bundled CLI version from the SDK manifest", () => {
    expect(Effect.runSync(ClaudeSdk.bundledVersion)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("reports Claude's features", () => {
    expect(ClaudeAgent.capabilities("2.1.312")).toEqual({
      provider: "claude",
      version: "2.1.312",
      steer: true,
      queue: true,
      resume: true,
      cost: "reported",
      spendCap: "native",
      resetTimes: true,
      hooks: false,
      reattach: false,
      disable: { askUser: true, subagents: true, tools: "any" },
    })
  })
})
