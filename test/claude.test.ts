import type { HookCallback, SDKRateLimitInfo, SDKResultMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option, Schema } from "effect"
import { join } from "node:path"
import { ClaudeAgent, ClaudeReplay, ClaudeSdk } from "../src/claude/index.ts"
import { AccountStatus, AgentEvent, SessionId, TurnId } from "../src/index.ts"

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
      hooks: true,
      reattach: false,
      disable: { askUser: true, subagents: true, tools: "any" },
    })
  })
})

// ---------------------------------------------------------------------------
// Phase 2: hooks, stalls, status, history
// ---------------------------------------------------------------------------

const fixture = (name: string) => ClaudeReplay.load(join(import.meta.dirname, "fixtures", "claude", `${name}.jsonl`))

describe("ClaudeAgent.sdkHooks", () => {
  const base = { session_id: sessionId, transcript_path: "/t.jsonl", cwd: "/tmp/x" }
  const call = (hook: HookCallback | undefined, input: Record<string, unknown>, signal = new AbortController().signal) =>
    hook!(input as never, input.tool_use_id as string | undefined, { signal })
  const pre = { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" }

  it("maps beforeTool, afterTool and beforeStop to PreToolUse, PostToolUse(+Failure) and Stop", async () => {
    const seen: Array<unknown> = []
    const hooks = ClaudeAgent.sdkHooks({
      beforeTool: (c) => Effect.sync(() => (seen.push(c), Option.some("before"))),
      afterTool: (c) => Effect.sync(() => (seen.push(c), Option.some(`after:${c.output}`))),
      beforeStop: () => Effect.succeed(Option.some("keep going")),
    })
    expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop"])
    expect(await call(hooks.PreToolUse![0]!.hooks[0], pre)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "before" },
    })
    const post = { ...pre, hook_event_name: "PostToolUse", tool_response: { stdout: "a.txt", stderr: "", interrupted: false } }
    expect(await call(hooks.PostToolUse![0]!.hooks[0], post)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "after:a.txt" },
    })
    const failure = { ...pre, hook_event_name: "PostToolUseFailure", error: "exit 1" }
    expect(await call(hooks.PostToolUseFailure![0]!.hooks[0], failure)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "after:exit 1" },
    })
    expect(await call(hooks.Stop![0]!.hooks[0], { ...base, hook_event_name: "Stop", stop_hook_active: false })).toEqual({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "keep going" },
    })
    expect(seen).toEqual([
      { callId: "toolu_1", name: "Bash", input: { command: "ls" } },
      { callId: "toolu_1", name: "Bash", input: { command: "ls" }, output: "a.txt", isError: false },
      { callId: "toolu_1", name: "Bash", input: { command: "ls" }, output: "exit 1", isError: true },
    ])
  })

  it("adds nothing for None, empty text, failures, defects and aborts", async () => {
    const none = ClaudeAgent.sdkHooks({ beforeTool: () => Effect.succeed(Option.none()) })
    expect(await call(none.PreToolUse![0]!.hooks[0], pre)).toEqual({})
    const empty = ClaudeAgent.sdkHooks({ beforeTool: () => Effect.succeed(Option.some("")) })
    expect(await call(empty.PreToolUse![0]!.hooks[0], pre)).toEqual({})
    const failing = ClaudeAgent.sdkHooks({ beforeTool: () => Effect.fail("nope").pipe(Effect.orDie) })
    expect(await call(failing.PreToolUse![0]!.hooks[0], pre)).toEqual({})
    const throwing = ClaudeAgent.sdkHooks({
      beforeTool: () => {
        throw new Error("sync throw")
      },
    })
    expect(await call(throwing.PreToolUse![0]!.hooks[0], pre)).toEqual({})
    const slow = ClaudeAgent.sdkHooks({ beforeTool: () => Effect.never })
    const abort = new AbortController()
    const pending = call(slow.PreToolUse![0]!.hooks[0], pre, abort.signal)
    abort.abort()
    expect(await pending).toEqual({})
  })

  it("ignores inputs for other events", async () => {
    const hooks = ClaudeAgent.sdkHooks({ beforeTool: () => Effect.succeed(Option.some("x")) })
    expect(await call(hooks.PreToolUse![0]!.hooks[0], { ...base, hook_event_name: "Stop" })).toEqual({})
  })

  it("flattens tool responses for afterTool", () => {
    expect(ClaudeAgent.toolResponseText("plain")).toBe("plain")
    expect(ClaudeAgent.toolResponseText({ stdout: "out", stderr: "err" })).toBe("out\nerr")
    expect(ClaudeAgent.toolResponseText({ content: [{ type: "text", text: "t" }] })).toBe("t")
    expect(ClaudeAgent.toolResponseText({ filePath: "/a" })).toBe('{"filePath":"/a"}')
  })

  it("buildOptions passes hooks and layer env", () => {
    const options = ClaudeAgent.buildOptions(
      { cwd: "/x", hooks: { beforeStop: () => Effect.succeed(Option.none()) }, env: { B: "run" } },
      { env: { A: "layer", B: "layer", PATH: undefined } },
      sessionId,
      { PATH: "/bin" },
    )
    expect(Object.keys(options.hooks!)).toEqual(["Stop"])
    expect(options.env).toEqual({ A: "layer", B: "run", ENABLE_CLAUDEAI_MCP_SERVERS: "false" })
    expect(ClaudeAgent.buildOptions({ cwd: "/x" }, {}, sessionId, {})).not.toHaveProperty("hooks")
  })
})

describe("stall classification", () => {
  const stall = { idleMs: 3200, inTool: true }
  const interrupted = result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" })

  it("a stalled turn that ended after the interrupt is Stalled, not Interrupted", () => {
    const outcome = ClaudeAgent.classifyOutcome(outcomeInput({ result: interrupted, interruptRequested: true, stalled: stall }))
    expect(outcome).toMatchObject({ _tag: "Stalled", idleMs: 3200, inTool: true })
    expect(outcome._tag === "Stalled" && outcome.message).toMatch(/3\.2s while a tool was running; the turn was interrupted/)
  })

  it("a stalled turn whose process we killed is Stalled, not ProcessKilled", () => {
    const outcome = ClaudeAgent.classifyOutcome(
      outcomeInput({ result: null, processError: { message: "killed", signal: "SIGKILL", exitCode: null }, stalled: { idleMs: 20_000, inTool: false } }),
    )
    expect(outcome).toMatchObject({ _tag: "Stalled", idleMs: 20_000, inTool: false })
    expect(outcome._tag === "Stalled" && outcome.message).toMatch(/was killed/)
  })

  it("a turn that succeeded anyway stays Succeeded", () => {
    expect(ClaudeAgent.classifyOutcome(outcomeInput({ stalled: stall }))._tag).toBe("Succeeded")
  })

  it("markStalled applies only to the running turn, and step/stepExit carry it", () => {
    const ctx: ClaudeAgent.StepContext = { sessionId, resumed: false, capUsd: null, nowMs: 0 }
    const init = { type: "system", subtype: "init", session_id: sessionId } as unknown as ClaudeSdk.Frame
    const started = { type: "command_lifecycle", command_uuid: "u1", state: "started" } as unknown as ClaudeSdk.Frame
    let state = ClaudeAgent.step(ctx, ClaudeAgent.initialState, init).state
    state = ClaudeAgent.step(ctx, state, started).state
    expect(ClaudeAgent.markStalled(state, TurnId.make("other"), stall)).toBe(state)
    const marked = ClaudeAgent.markStalled(state, TurnId.make("u1"), stall)
    expect(ClaudeAgent.step(ctx, marked, interrupted).events).toMatchObject([{ _tag: "TurnEnded", outcome: { _tag: "Stalled", inTool: true } }])
    expect(ClaudeAgent.stepExit(ctx, marked, { message: "killed", signal: "SIGKILL", exitCode: null }).events).toMatchObject([
      { _tag: "TurnEnded", outcome: { _tag: "Stalled" } },
    ])
  })
})

describe("ClaudeAgent.accountStatus", () => {
  const checkedAt = DateTime.makeUnsafe(1_800_000_000_000)
  const signedIn = { email: "user@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" as const }
  const window = (utilization: number | null, resets_at: string | null = "2026-10-30T00:20:00.508040+00:00") => ({ utilization, resets_at })
  const snapshot = (rateLimits: Record<string, unknown> | null, account: Record<string, unknown> = signedIn): ClaudeSdk.StatusSnapshot => ({
    account,
    usage: { subscription_type: "max", rate_limits_available: rateLimits !== null, rate_limits: rateLimits } as never,
    usageError: null,
  })
  const decode = (status: AccountStatus) => Schema.encodeUnknownSync(AccountStatus)(status)

  it("maps a recorded status (signed in, room left, extra usage exhausted but not needed)", () => {
    const recorded = fixture("status").flatMap((l) => (l.dir === "status" ? [l.status] : []))[0]!
    const status = ClaudeAgent.accountStatus(recorded, checkedAt)
    decode(status)
    expect(status).toMatchObject({ provider: "claude", usable: true, reason: null, plan: "max" })
    expect(status.windows.map((w) => [w.label, w.window])).toEqual([
      ["five_hour", "five_hour"],
      ["seven_day", "weekly"],
      ["model_scoped:Fable", "other"],
    ])
    expect(status.windows[0]!.usedPercent).toBeGreaterThanOrEqual(0)
    expect(status.windows[0]!.resetsAt).not.toBeNull()
  })

  it("parses ISO reset times with microseconds", () => {
    const [w] = ClaudeAgent.usageWindows({ five_hour: window(65) })
    expect(w).toMatchObject({ window: "five_hour", label: "five_hour", usedPercent: 65 })
    expect(DateTime.toEpochMillis(w!.resetsAt!)).toBe(Date.parse("2026-10-30T00:20:00.508Z"))
  })

  it("unauthenticated, from a recorded signed-out CLI", () => {
    const recorded = fixture("status-unauthenticated").flatMap((l) => (l.dir === "status" ? [l.status] : []))[0]!
    expect(ClaudeAgent.accountStatus(recorded, checkedAt)).toMatchObject({ usable: false, reason: "unauthenticated", windows: [], plan: null })
  })

  it("recognizes API keys, OAuth tokens and third-party providers as signed in", () => {
    expect(ClaudeAgent.signedIn({ tokenSource: "none", apiProvider: "firstParty" })).toBe(false)
    expect(ClaudeAgent.signedIn({})).toBe(false)
    expect(ClaudeAgent.signedIn({ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" })).toBe(true)
    expect(ClaudeAgent.signedIn({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" })).toBe(true)
    expect(ClaudeAgent.signedIn({ apiProvider: "bedrock" })).toBe(true)
  })

  it("usage_limited when an account-wide window is full and extra usage can't take over", () => {
    expect(ClaudeAgent.accountStatus(snapshot({ five_hour: window(100), seven_day: window(40) }), checkedAt)).toMatchObject({
      usable: false,
      reason: "usage_limited",
    })
    const withOverage = { five_hour: window(100), extra_usage: { is_enabled: true, spend_limit_reached: false } }
    expect(ClaudeAgent.accountStatus(snapshot(withOverage), checkedAt).usable).toBe(true)
    const overageSpent = { five_hour: window(100), extra_usage: { is_enabled: true, spend_limit_reached: true } }
    expect(ClaudeAgent.accountStatus(snapshot(overageSpent), checkedAt).reason).toBe("usage_limited")
  })

  it("a full per-model window is reported but doesn't make the account unusable", () => {
    const status = ClaudeAgent.accountStatus(
      snapshot({ five_hour: window(10), seven_day_opus: window(100), model_scoped: [{ display_name: "Fable", ...window(100) }] }),
      checkedAt,
    )
    expect(status.usable).toBe(true)
    expect(status.windows.map((w) => w.label)).toEqual(["five_hour", "seven_day_opus", "model_scoped:Fable"])
  })

  it("spend_limited when extra usage is what meters the account and its limit is reached", () => {
    const status = ClaudeAgent.accountStatus(
      snapshot({ five_hour: null, seven_day: null, extra_usage: { is_enabled: true, spend_limit_reached: true } }),
      checkedAt,
    )
    expect(status).toMatchObject({ usable: false, reason: "spend_limited", windows: [] })
  })

  it("falls back to limits[] when no named window is present", () => {
    expect(
      ClaudeAgent.usageWindows({
        limits: [
          { kind: "session", percent: 5, resets_at: "2026-10-30T00:20:00Z" },
          { kind: "weekly_all", percent: 6, resets_at: null },
          { kind: "weekly_scoped", percent: 7, resets_at: null, scope: { model: { display_name: "Fable" } } },
        ],
      }).map((w) => [w.window, w.label, w.usedPercent]),
    ).toEqual([
      ["five_hour", "session", 5],
      ["weekly", "weekly_all", 6],
      ["other", "model_scoped:Fable", 7],
    ])
  })

  it("without the experimental usage API, still reports sign-in and plan", () => {
    const status = ClaudeAgent.accountStatus({ account: signedIn, usage: null, usageError: "unsupported" }, checkedAt)
    expect(status).toMatchObject({ usable: true, reason: null, windows: [], plan: "Claude Max" })
  })
})

describe("ClaudeAgent.historyEvents", () => {
  const msg = (type: SessionMessage["type"], uuid: string, message: unknown, extra: Record<string, unknown> = {}) =>
    ({ type, uuid, session_id: sessionId, message, parent_tool_use_id: null, parent_agent_id: null, ...extra }) as SessionMessage
  const user = (uuid: string, content: unknown, extra?: Record<string, unknown>) => msg("user", uuid, { role: "user", content }, extra)
  const assistant = (uuid: string, content: unknown, stop_reason: string | null = null) =>
    msg("assistant", uuid, { role: "assistant", content, stop_reason })
  const shape = (events: ReadonlyArray<AgentEvent>) =>
    events.map((e) => {
      switch (e._tag) {
        case "TurnStarted":
          return `TurnStarted:${e.turnId}`
        case "UserMessage":
          return `UserMessage:${e.turnId}:${e.text}`
        case "TurnEnded":
          return `TurnEnded:${e.turnId}:${e.outcome._tag}`
        case "Text":
          return `Text:${e.turnId}:${e.text}`
        case "ToolCall":
          return `ToolCall:${e.turnId}:${e.summary}`
        case "ToolResult":
          return `ToolResult:${e.turnId}:${e.output}`
        case "Compacted":
          return `Compacted:${e.turnId}:${e.trigger}`
        default:
          return e._tag
      }
    })

  it("groups prompts, steers, tools, interrupts and compactions into turns", () => {
    const events = ClaudeAgent.historyEvents([
      user("p1", "run ls"),
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], "tool_use"),
      user("r1", [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }]),
      user("s1", "also say hi", { isQueuedCommand: true }),
      assistant("a2", [{ type: "text", text: "a.txt, hi" }], "end_turn"),
      user("p2", [{ type: "text", text: "sleep" }]),
      assistant("a3", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "sleep 20" } }], "tool_use"),
      user("r2", [{ type: "tool_result", tool_use_id: "t2", content: "interrupted", is_error: true }]),
      user("i2", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      msg("system", "c1", undefined, { subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 1 } }),
      user("sum", "This session is being continued...", { isCompactSummary: true }),
      user("meta", "<local-command-caveat>...</local-command-caveat>", { isMeta: true }),
      user("p3", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
      user("o3", "<local-command-stdout>Compacted </local-command-stdout>"),
      msg("system", "x1", undefined, { subtype: "informational" }),
    ])
    expect(shape(events)).toEqual([
      "TurnStarted:p1",
      "UserMessage:p1:run ls",
      "ToolCall:p1:ls",
      "ToolResult:p1:a.txt",
      "UserMessage:p1:also say hi",
      "Text:p1:a.txt, hi",
      "TurnStarted:p2",
      "UserMessage:p2:sleep",
      "ToolCall:p2:sleep 20",
      "ToolResult:p2:interrupted",
      "TurnEnded:p2:Interrupted",
      "Compacted:null:manual",
      "TurnStarted:p3",
      "UserMessage:p3:/compact",
    ])
    expect(events.find((e) => e._tag === "UserMessage")).toMatchObject({ messageId: "p1", raw: { uuid: "p1" } })
    for (const event of events) Schema.encodeUnknownSync(AgentEvent)(event)
  })

  it("a queued message after the turn ended starts a new turn", () => {
    const events = ClaudeAgent.historyEvents([
      user("p1", "one"),
      assistant("a1", [{ type: "text", text: "one" }], "end_turn"),
      user("p2", "two", { isQueuedCommand: true }),
    ])
    expect(shape(events)).toEqual(["TurnStarted:p1", "UserMessage:p1:one", "Text:p1:one", "TurnStarted:p2", "UserMessage:p2:two"])
  })

  it("maps a recorded transcript with a compaction", () => {
    const line = fixture("history").find((l) => l.dir === "history" && l.history !== null)
    if (line?.dir !== "history" || line.history === null) throw new Error("no history in fixture")
    const tags = ClaudeAgent.historyEvents(line.history.messages).map((e) => e._tag)
    expect(tags).toEqual(["TurnStarted", "UserMessage", "ToolCall", "ToolResult", "Text", "TurnStarted", "UserMessage", "Text", "Compacted", "TurnStarted", "UserMessage"])
  })
})

describe("ClaudeSdk transcript helpers", () => {
  const entries = ClaudeSdk.parseTranscript(
    [
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "u1", compactMetadata: { trigger: "auto", preTokens: 9 } }),
      JSON.stringify({ type: "user", uuid: "u2", parentUuid: "b1" }),
      '{"type":"assistant","uuid":"cut-off',
    ].join("\n"),
  )

  it("parses transcripts, skipping a torn last line", () => {
    expect(entries.map((e) => e.uuid)).toEqual(["u1", "b1", "u2"])
  })

  it("bridges compactions so the SDK reads the whole chain", () => {
    expect(ClaudeSdk.bridgeCompactions(entries)[1]).toMatchObject({ subtype: "effect_agent_compact_boundary", parentUuid: "u1" })
    expect(ClaudeSdk.bridgeCompactions(entries)[2]).toBe(entries[2])
  })

  it("restores system subtypes and compact metadata by uuid", () => {
    const messages = [
      { type: "system", uuid: "b1", session_id: "s", message: undefined, parent_tool_use_id: null, parent_agent_id: null },
      { type: "user", uuid: "u2", session_id: "s", message: {}, parent_tool_use_id: null, parent_agent_id: null },
    ] as Array<SessionMessage>
    const restored = ClaudeSdk.restoreSystemFields(messages, entries)
    expect(restored[0]).toMatchObject({ subtype: "compact_boundary", compact_metadata: { trigger: "auto", preTokens: 9 } })
    expect(restored[1]).toBe(messages[1])
    expect(ClaudeAgent.historyEvents(restored)).toMatchObject([{ _tag: "Compacted", trigger: "auto" }])
  })
})

describe("ClaudeAgent.modelOfLabel", () => {
  it("names the model a per-model window caps", () => {
    expect(ClaudeAgent.modelOfLabel("seven_day_opus")).toEqual(Option.some("opus"))
    expect(ClaudeAgent.modelOfLabel("model_scoped:Fable")).toEqual(Option.some("fable"))
    expect(ClaudeAgent.modelOfLabel("model_scoped:Opus 5")).toEqual(Option.some("opus"))
    expect(ClaudeAgent.modelOfLabel("five_hour")).toEqual(Option.none())
    expect(ClaudeAgent.modelOfLabel("seven_day")).toEqual(Option.none())
  })
})

