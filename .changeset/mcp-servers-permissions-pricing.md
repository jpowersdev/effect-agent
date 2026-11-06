---
"@jpowersdev/effect-agent": minor
---

A session's own MCP servers, per-provider permissions, and Codex prices shipped with the library.

**`RunOptions.mcpServers`** adds MCP servers for one session, as a task's own server with its own token:

```ts
agent.open({
  cwd,
  mcpServers: { task_tools: { type: "http", url, headers: { Authorization: `Bearer ${taskToken}` } } }
})
```

- HTTP (`url`, `headers`) or stdio (`command`, `args`, `env`). Claude gets them as the SDK's `mcpServers`; Codex as the thread's `mcp_servers`.
- Without `mcp` they are the only servers and every tool on them can be called. With `mcp` they load beside the machine's servers, and `mcp.allow` checks their calls too.
- `open` fails for a name the provider would rewrite, so a glob can always match it: outside `[A-Za-z0-9_]` on Codex (`-` included), outside `[A-Za-z0-9_-]` on Claude.
- They travel to a detached session's host with the rest of `RunSettings`.

**Permissions, per provider.**

- `ClaudeAgentOptions.permissionMode`: `"bypassPermissions"` (the default, as before) or `"dontAsk"`, which runs only what a permission rule allows and denies the rest; `ClaudeAgentOptions.allowedTools` takes the rules (`Read`, `Bash(git log:*)`, `mcp__task_tools__progress`).
- `CodexAgentOptions.sandbox`: `"danger-full-access"` (the default, as before), `"workspace-write"` or `"read-only"`. Approvals stay `never`. In a sandbox Codex asks to approve every MCP call, so `mcpServers` approve their own tools (`default_tools_approval_mode = "approve"`, with `mcp.allow` as their check); a server in `config.toml` is callable in a sandbox only if its own config approves its tools.
- Both are in `HostSpec`'s `claude` and `codex` options, so detached sessions take them too.

**Codex prices.** **Breaking:** `CodexAgentOptions.pricing` and `HostSpec`'s `codex.pricing` are gone. Codex costs are estimated from `CodexAgent.CodexPricing`, a `Context.Reference` read when a session opens, which defaults to `CodexAgent.defaultPrices`: OpenAI's standard-tier text-token rates on `CodexAgent.defaultPricesAsOf`, with no `"*"` entry.

```ts
// Before
CodexAgent.layer({ pricing: table })
// After: for a session, or a whole program
Effect.provideService(program, CodexAgent.CodexPricing, table)
// or beside the layer
Layer.merge(CodexAgent.layer(), Layer.succeed(CodexAgent.CodexPricing, table))
```

- Every Codex cost is an estimate (`Cost.source: "estimated"`), and Codex's `capabilities.cost` and `capabilities.spendCap` are now always `"estimated"`, not `"none"` without a table. A turn on a model the table has now reports a cost where it reported `null`.
- A model the table doesn't have is unpriced: its turns report no cost and `spendCapUsd` is refused for it, as before for a model missing from a table you supplied.
- A detached session's client reads `CodexPricing` and sends it to the host.
- `node scripts/codex-pricing.ts` refreshes the table from OpenAI's pricing page (`--check` reports whether it would change); the `Codex prices` workflow runs it weekly and opens a PR when a price changes.

The docs on MCP names are corrected: Codex rewrites `-` to `_` in server and tool names (Claude keeps it), and adds a hash to servers whose rewritten names collide.
