---
"@jpowersdev/effect-agent": patch
---

`ClaudeAgentOptions.backgroundTasks: false` turns off Claude Code's background tasks (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`): Bash has no `run_in_background` and subagents can't be backgrounded, so a wait such as CI checks blocks in the turn. Use it when each turn is a whole job, where the turn would otherwise end before the background work finishes and the agent would never hear back. The default is unchanged. `HostSpec` takes it too.
