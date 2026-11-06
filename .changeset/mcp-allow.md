---
"@jpowersdev/effect-agent": minor
---

`RunOptions.mcp` lets a session use the MCP servers and claude.ai connectors already set up on the machine, limited by globs:

```ts
agent.open({
  cwd,
  mcp: {
    allow: ["claude_ai_Slack/slack_{read,search}_*", "claude_ai_Notion/notion-{search,fetch}"],
    deny: ["*/*{send,reply,delete,trash}*"]
  }
})
```

Without `mcp`, nothing changes: a session loads no MCP servers, no claude.ai connectors and no ChatGPT apps, as before.

With it, the session loads its provider's own MCP config (on Claude, the account's claude.ai connectors too), and every call to an MCP tool is checked in the session's own process, before it reaches the server: for a detached session, that's its host. A call is refused unless its name matches an `allow` glob and no `deny` glob, and the model gets the reason as the tool's result ("is not in mcp.allow", or "matches mcp.deny pattern …"). The check holds with permissions bypassed, as every session runs, and covers Claude's subagents and Codex's code mode.

- **Names are `server/tool`**: the provider's `mcp__<server>__<tool>`, split at the first `__`, with every character outside `[A-Za-z0-9_-]` already `_`. A claude.ai connector's server is `claude_ai_<Name>`, as `claude_ai_Slack` or `claude_ai_Google_Calendar`. A name with another `__`, which could belong to another server, must pass under every reading.
- **Globs are `effect/Glob`'s**: `*` stays within the server or the tool, and `{a,b}` is either. Matching is case-sensitive.
- **`allow: []`** loads the servers, but nothing can be called.
- **MCP resources are always refused**: Claude's `ReadMcpResourceTool` and its listing tools are removed, and Codex's `read_mcp_resource` and its listing tools are refused. They name the server in their input, so `allow` can't cover them.
- **Built-in tools are unaffected**: `disable.tools` still governs them. The model may still see a refused MCP tool.
- **On Codex** the check is a hook, so `mcp` costs what `disable.askUser` does: the first `open` per layer starts an extra `codex app-server`, and each MCP call starts a short-lived process of your runtime. `open` fails where hooks can't run, and a detached session's host doesn't retry without them. claude.ai connectors are Claude's, and ChatGPT apps stay off.

Codex 0.162.1 still loads the MCP servers in its `config.toml` in a session without `mcp`. It ignores `mcp_servers` in thread config and in `-c` flags, even `enabled = false` there, so the `mcp_servers: {}` that effect-agent has always set never turned them off. This release doesn't change that, and the docs no longer claim otherwise. On Codex, `mcp: { allow: [] }` refuses every MCP call.
