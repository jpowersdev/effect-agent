---
"@jpowersdev/effect-agent": minor
---

`Hooks.beforeTool` can refuse a tool call: return `refuseTool(reason)`, and the tool doesn't run, and the model gets the reason as its result.

```ts
agent.open({
  cwd,
  hooks: {
    beforeTool: () => Ref.get(paused).pipe(Effect.map((on) => (on ? refuseTool("The board is paused; stop here.") : Option.none())))
  }
})
```

- **It holds with permissions bypassed**, as every session runs, for built-in tools and MCP tools alike: Claude's Bash, Write and the rest, Codex's commands and `apply_patch`. On Claude it is PreToolUse's deny; on Codex, the same deny from the hook relay `beforeTool` already went through, so it costs nothing more.
- **It fails open**, as hooks do: a hook that fails or times out, or on a detached session has no client to answer it, refuses nothing.
- **It stops a call before it starts.** A command already running, in the background too, runs on.
- **Detached sessions** carry the refusal from the client to the host. `capabilities.refuseTool` says whether a session can refuse. A host from a release before 0.7.0 can't: it takes the reason as text to add, and the tool runs.
- `BeforeToolResult`, `ToolRefusal` and `isToolRefusal` are exported with it. Code whose `beforeTool` returns an `Option` is unchanged.
