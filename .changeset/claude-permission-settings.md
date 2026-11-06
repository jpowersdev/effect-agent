---
"@jpowersdev/effect-agent": minor
---

`ClaudeAgentOptions.permissionMode: "settings"` passes no permission mode, so the settings files decide, as they do for `claude -p`: their `permissions.defaultMode` applies (`acceptEdits`, `bypassPermissions`, ...), and with none, a tool no rule (or `allowedTools`) allows is denied, since nobody is there to ask. Use it to run an agent under a machine's own Claude Code setup. `bypassPermissions` stays the default; `disable`, `mcp` and `beforeTool` refusals hold in every mode. `HostSpec` takes it too.
