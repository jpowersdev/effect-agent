---
"@jpowersdev/effect-agent": minor
---

Codex now has hooks, and enforces `disable`, as Claude does.

- `RunOptions.hooks` work on Codex, locally and on detached sessions, through its command hooks. `capabilities.hooks` is `true`. The first `open` with hooks or refused tools, per layer, starts an extra `codex app-server`, and each hook call starts a short-lived process of your runtime. With `features.hooks` off in Codex's config they still run and the user's hooks stay off, as on Claude with `disableAllHooks`. `open` fails if a managed policy stops them, or if `CodexAgent.layer`'s `config` would (`features.hooks` false, or any `hooks` key); a detached session whose `open` passed no hooks then opens without them, and `attach` with hooks fails.
- `disable.subagents` is enforced: a call to a multi-agent tool of either generation is refused. Codex's switches are set too, but current models select the tools regardless, so the model may still see them. `capabilities.disable.subagents` is `true`.
- `disable.tools` takes any tool name. A tool with no switch, such as `apply_patch`, used to fail `open`; it's now refused when called. `capabilities.disable.tools` is `"any"`.
- `CodexAppServer.connect` takes `args`, added after the layer's.
