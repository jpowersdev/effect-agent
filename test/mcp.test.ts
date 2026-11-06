/**
 * `RunOptions.mcp`: the `server/tool` names, glob matching, and how each
 * provider is configured for it. `mcp-e2e.test.ts` runs it on the real CLIs.
 */
import { describe, expect, it } from "@effect/vitest"
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Option } from "effect"
import { SessionId } from "../src/AgentSession.ts"
import { ClaudeAgent } from "../src/claude/index.ts"
import { CodexAgent } from "../src/codex/index.ts"
import * as CodexHooks from "../src/codex/CodexHooks.ts"
import * as Mcp from "../src/internal/mcp.ts"

const clerk = Mcp.policy({ allow: ["claude_ai_Slack/slack_{read,search}_*", "claude_ai_Gmail/*", "claude_ai_Notion/notion-search"], deny: ["*/*{send,reply,delete,trash}*"] })

describe("readings", () => {
  it("splits at the first __, as both providers do", () => {
    expect(Mcp.readings("mcp__claude_ai_Slack__slack_read_channel")).toEqual(["claude_ai_Slack/slack_read_channel"])
    expect(Mcp.readings("mcp__claude_ai_Google_Calendar__list_events")).toEqual(["claude_ai_Google_Calendar/list_events"])
    expect(Mcp.readings("mcp__claude_ai_Notion__notion-search")).toEqual(["claude_ai_Notion/notion-search"])
    expect(Mcp.readings("mcp__fixture__read_note")).toEqual(["fixture/read_note"])
  })

  it("gives every reading of a name with another __", () => {
    expect(Mcp.readings("mcp__a__b__c")).toEqual(["a/b__c", "a__b/c"])
    // Overlapping: `___` can end the server before or after its first `_`.
    expect(Mcp.readings("mcp__a___b")).toEqual(["a/_b", "a_/b"])
  })

  it("has none for a name that isn't an MCP tool's, or can't be one segment each", () => {
    for (const name of ["Bash", "mcp_x__y", "mcp__", "mcp__server", "mcp__server__", "mcp____tool", "mcp__a/b__c", "mcp__a__b/c", "mcp__..__x", "mcp__s__."]) {
      expect(Mcp.readings(name), name).toEqual([])
    }
  })
})

describe("refusal", () => {
  it("allows a name matching an allow glob and no deny glob", () => {
    for (const name of ["mcp__claude_ai_Slack__slack_read_channel", "mcp__claude_ai_Slack__slack_search_public", "mcp__claude_ai_Gmail__get_thread", "mcp__claude_ai_Notion__notion-search"]) {
      expect(Mcp.refusal(clerk, name), name).toBeNull()
    }
  })

  it("refuses a name in no allow glob", () => {
    expect(Mcp.refusal(clerk, "mcp__claude_ai_Slack__slack_add_reaction")).toBe("claude_ai_Slack/slack_add_reaction is not in mcp.allow")
    expect(Mcp.refusal(clerk, "mcp__claude_ai_Notion__notion-update-page")).toBe("claude_ai_Notion/notion-update-page is not in mcp.allow")
    expect(Mcp.refusal(clerk, "mcp__fixture__read_note")).toBe("fixture/read_note is not in mcp.allow")
  })

  it("refuses an allowed name that a deny glob matches, naming the pattern", () => {
    expect(Mcp.refusal(clerk, "mcp__claude_ai_Gmail__send_message")).toBe("claude_ai_Gmail/send_message matches mcp.deny pattern */*{send,reply,delete,trash}*")
    expect(Mcp.refusal(clerk, "mcp__claude_ai_Gmail__trash_thread")).toBe("claude_ai_Gmail/trash_thread matches mcp.deny pattern */*{send,reply,delete,trash}*")
  })

  it("keeps * within the server or the tool", () => {
    const policy = Mcp.policy({ allow: ["*"] })
    expect(Mcp.refusal(policy, "mcp__fixture__read_note")).toBe("fixture/read_note is not in mcp.allow")
    expect(Mcp.refusal(Mcp.policy({ allow: ["*/*"] }), "mcp__fixture__read_note")).toBeNull()
    expect(Mcp.refusal(Mcp.policy({ allow: ["fix*"] }), "mcp__fixture__read_note")).toBe("fixture/read_note is not in mcp.allow")
  })

  it("is case-sensitive", () => {
    expect(Mcp.refusal(Mcp.policy({ allow: ["claude_ai_slack/*"] }), "mcp__claude_ai_Slack__slack_read_channel")).toBe(
      "claude_ai_Slack/slack_read_channel is not in mcp.allow",
    )
  })

  it("lets a wildcard match names that start with a dot", () => {
    expect(Mcp.refusal(Mcp.policy({ allow: ["s/*"], deny: ["*/*send*"] }), "mcp__s__.send")).toBe("s/.send matches mcp.deny pattern */*send*")
    expect(Mcp.refusal(Mcp.policy({ allow: ["s/*"] }), "mcp__s__.hidden")).toBeNull()
  })

  it("allows nothing with allow: []", () => {
    expect(Mcp.refusal(Mcp.policy({ allow: [] }), "mcp__fixture__read_note")).toBe("fixture/read_note is not in mcp.allow")
  })

  it("must pass under every reading of an ambiguous name", () => {
    // Server `a` with tool `b__send`, or server `a__b` with tool `send`: denied either way.
    expect(Mcp.refusal(Mcp.policy({ allow: ["a/*", "a__b/*"], deny: ["a__b/*"] }), "mcp__a__b__send")).toBe("a__b/send matches mcp.deny pattern a__b/*")
    expect(Mcp.refusal(Mcp.policy({ allow: ["a/*"] }), "mcp__a__b__send")).toBe("a__b/send is not in mcp.allow")
    expect(Mcp.refusal(Mcp.policy({ allow: ["a/*", "a__b/*"] }), "mcp__a__b__send")).toBeNull()
  })

  it("refuses a name it can't read", () => {
    expect(Mcp.refusal(Mcp.policy({ allow: ["**"] }), "mcp__a/b__c")).toBe("mcp__a/b__c can't be read as server/tool, so no mcp.allow pattern matches it")
  })
})

describe("Claude", () => {
  const sessionId = SessionId.make("00000000-0000-4000-8000-000000000001")
  const pre = (tool_name: string) => ({
    session_id: sessionId,
    transcript_path: "/t.jsonl",
    cwd: "/x",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input: {},
    tool_use_id: "toolu_1",
  })
  const call = (hook: HookCallback | undefined, input: Record<string, unknown>) => hook!(input as never, "toolu_1", { signal: new AbortController().signal })

  it("without mcp, loads no MCP servers and no claude.ai connectors", () => {
    const options = ClaudeAgent.buildOptions({ cwd: "/x" }, {}, sessionId, {})
    expect(options).toMatchObject({ strictMcpConfig: true, mcpServers: {}, settings: { disableClaudeAiConnectors: true }, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } })
    expect(options).not.toHaveProperty("hooks")
  })

  it("with mcp, stops forcing them off, and refuses the resource tools", () => {
    const options = ClaudeAgent.buildOptions({ cwd: "/x", mcp: { allow: [] }, disable: { tools: ["WebSearch"] } }, {}, sessionId, { ENABLE_CLAUDEAI_MCP_SERVERS: "true" })
    expect(options).not.toHaveProperty("strictMcpConfig")
    expect(options).not.toHaveProperty("mcpServers")
    expect(options).not.toHaveProperty("settings")
    // Neither forced off nor on: the machine's own setting holds.
    expect(options.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: "true" })
    expect(options.disallowedTools).toEqual([...ClaudeAgent.mcpResourceTools, "WebSearch"])
    expect(Object.keys(options.hooks!)).toEqual(["PreToolUse"])
  })

  it("refuses MCP calls mcp doesn't allow, in a PreToolUse hook", async () => {
    const [hook] = ClaudeAgent.mcpHooks({ allow: ["fixture/read_*"], deny: ["*/*send*"] })[0]!.hooks
    expect(await call(hook, pre("mcp__fixture__read_note"))).toEqual({})
    expect(await call(hook, pre("Bash"))).toEqual({})
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `This MCP tool call was refused: ${reason}` } })
    expect(await call(hook, pre("mcp__fixture__send_note"))).toEqual(deny("fixture/send_note matches mcp.deny pattern */*send*"))
    expect(await call(hook, pre("mcp__fixture__list_notes"))).toEqual(deny("fixture/list_notes is not in mcp.allow"))
    expect(await call(hook, pre("ReadMcpResourceTool"))).toEqual(deny("ReadMcpResourceTool reads MCP resources, which mcp.allow can't allow"))
  })

  it("runs the MCP check beside the session's own beforeTool", async () => {
    const seen: Array<string> = []
    const options = ClaudeAgent.buildOptions(
      { cwd: "/x", mcp: { allow: [] }, hooks: { beforeTool: (c) => Effect.sync(() => (seen.push(c.name), Option.some("ctx"))), beforeStop: () => Effect.succeedNone } },
      {},
      sessionId,
      {},
    )
    expect(Object.keys(options.hooks!).sort()).toEqual(["PreToolUse", "Stop"])
    const [check, before] = options.hooks!.PreToolUse!
    expect(await call(check!.hooks[0], pre("mcp__fixture__read_note"))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await call(before!.hooks[0], pre("mcp__fixture__read_note"))).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "ctx" } })
    expect(seen).toEqual(["mcp__fixture__read_note"])
  })
})

describe("serverNameProblem", () => {
  it("refuses a name the provider would rename, and only then", () => {
    const http = { type: "http" as const, url: "http://x" }
    expect(Mcp.serverNameProblem(undefined, "codex")).toBeNull()
    expect(Mcp.serverNameProblem({ studio_run: http, Task1: http }, "codex")).toBeNull()
    expect(Mcp.serverNameProblem({ "studio-run": http }, "codex")).toContain('Codex would rename the server "studio-run"')
    expect(Mcp.serverNameProblem({ "studio-run": http }, "claude")).toBeNull()
    expect(Mcp.serverNameProblem({ "studio.run": http }, "claude")).toContain('Claude would rename the server "studio.run"')
  })
})

describe("Codex", () => {
  it("without mcp, loads no MCP servers and no ChatGPT apps", () => {
    expect(CodexAgent.threadOverrides({ cwd: "/x" }).config).toMatchObject({ mcp_servers: {}, "features.apps": false })
    expect(CodexAgent.refusedTools({ cwd: "/x" })).toEqual([])
  })

  it("with mcp, loads the configured servers, still no apps, and refuses the resource tools", () => {
    const config = CodexAgent.threadOverrides({ cwd: "/x", mcp: { allow: [] } }).config!
    expect(config).not.toHaveProperty("mcp_servers")
    expect(config["features.apps"]).toBe(false)
    expect(CodexAgent.refusedTools({ cwd: "/x", mcp: { allow: [] } })).toEqual(CodexAgent.mcpResourceTools)
  })

  it("mcpServers become the thread's mcp_servers, with or without mcp", () => {
    const mcpServers = {
      task: { type: "http" as const, url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
      local: { type: "stdio" as const, command: "node", args: ["s.ts"], env: { A: "1" } },
    }
    const expected = {
      task: { url: "http://127.0.0.1:1/mcp", http_headers: { Authorization: "Bearer t" } },
      local: { command: "node", args: ["s.ts"], env: { A: "1" } },
    }
    expect(CodexAgent.threadOverrides({ cwd: "/x", mcpServers }).config!["mcp_servers"]).toEqual(expected)
    expect(CodexAgent.threadOverrides({ cwd: "/x", mcpServers, mcp: { allow: [] } }).config!["mcp_servers"]).toEqual(expected)
    // Approved only where a sandbox says so; without one Codex asks for no approval.
    const approved = CodexAgent.threadOverrides({ cwd: "/x", mcpServers }, {}, { mode: "workspace-write", mcpServerTools: "approve" }).config!["mcp_servers"]
    expect(approved).toEqual({
      task: { ...expected.task, default_tools_approval_mode: "approve" },
      local: { ...expected.local, default_tools_approval_mode: "approve" },
    })
    expect(CodexAgent.threadOverrides({ cwd: "/x", mcpServers }, {}, { mode: "read-only", mcpServerTools: "refuse" }).config!["mcp_servers"]).toEqual(expected)
  })

  it("plans an MCP check on the relay", () => {
    const plan = CodexHooks.plan(undefined, [], true, "/bin/node")!
    expect(plan).toMatchObject({ relay: true, hookCount: 1 })
    expect([...plan.commands]).toEqual([CodexHooks.mcpCommand("/bin/node")])
    expect(plan.flags).toEqual(["-c", `hooks.PreToolUse=[{matcher="^mcp__",hooks=[{type="command",command=${JSON.stringify(CodexHooks.mcpCommand("/bin/node"))}}]}]`])
    // Refusals first, then the check, then the session's beforeTool.
    const both = CodexHooks.plan({ beforeTool: () => Effect.succeedNone }, ["read_mcp_resource"], true, "/bin/node")!
    expect(both).toMatchObject({ relay: true, hookCount: 3 })
    expect(both.flags[1]!.indexOf("^(collaboration)?")).toBeLessThan(both.flags[1]!.indexOf("^mcp__"))
    expect(both.flags[1]!.indexOf("^mcp__")).toBeLessThan(both.flags[1]!.indexOf(`matcher="*"`))
  })

  it("answers an MCP check with allow or the refusal, failing closed", () =>
    Effect.gen(function* () {
      const policy = Mcp.policy({ allow: ["fixture/read_*"], deny: ["*/*send*"] })
      const check = (tool_name: unknown, mcp: Mcp.Policy | null = policy) =>
        CodexHooks.answer({}, `mcp ${JSON.stringify({ hook_event_name: "PreToolUse", tool_name })}`, () => false, mcp ?? undefined)
      expect(yield* check("mcp__fixture__read_note")).toBe("allow")
      expect(yield* check("mcp__fixture__send_note")).toBe("This MCP tool call was refused: fixture/send_note matches mcp.deny pattern */*send*")
      expect(yield* check("mcp__other__read_note")).toBe("This MCP tool call was refused: other/read_note is not in mcp.allow")
      expect(yield* check(undefined)).toBe("This MCP tool call was refused: effect-agent could not check it")
      expect(yield* check("mcp__fixture__read_note", null)).toBe("This MCP tool call was refused: effect-agent could not check it")
      expect(yield* CodexHooks.answer({}, "mcp not json", () => false, policy)).toBe("This MCP tool call was refused: effect-agent could not check it")
      // The session's beforeTool isn't asked for a check.
      const asked: Array<string> = []
      const hooks = { beforeTool: () => Effect.sync(() => (asked.push("x"), Option.some("ctx"))) }
      expect(yield* CodexHooks.answer(hooks, `mcp ${JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__fixture__read_note" })}`, () => false, policy)).toBe("allow")
      expect(asked).toEqual([])
    }).pipe(Effect.runPromise))
})
