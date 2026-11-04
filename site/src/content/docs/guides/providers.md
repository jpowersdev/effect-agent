---
title: "Providers"
description: "Run sessions on Claude Code or Codex, and switch between them."
sidebar:
  order: 1
---

Your program asks for `Agent`. Which agent runs is decided by the layer you provide.

## Use Claude Code

The Claude layer runs Claude Code through the Agent SDK, which bundles the CLI. Sessions
use whatever account `claude` is signed in to.

```ts
import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"

const Claude = ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))

program.pipe(Effect.provide(Claude))
```

## Use Codex

Codex sessions each start a `codex app-server` process, so the layer needs your
platform's services. Codex reports tokens but not cost. Give it prices and it estimates
cost, which is also what `spendCapUsd` is checked against.

```ts
import { CodexAgent, CodexAppServer } from "@jpowersdev/effect-agent/codex"

const Codex = CodexAgent.layer({
  // USD per million tokens, by model id. "*" covers the rest.
  pricing: {
    "*": {
      input: 1.25,
      cachedInput: 0.125,
      output: 10
    }
  }
}).pipe(
  Layer.provide(CodexAppServer.layer()),
  Layer.provide(NodeServices.layer)
)
```

## Pick one at startup

Both layers provide the same service, so the choice can come from config.

```ts
const Provider = process.env.AGENT === "codex" ? Codex : Claude

program.pipe(
  Effect.provide(Provider),
  NodeRuntime.runMain
)
```

## Check what the provider can do

The providers don't support the same options. Ask `capabilities` instead of checking the
provider's name.

```ts
const capabilities = yield* agent.capabilities
// { provider: "codex", version: "0.162.1", steer: true, cost: "estimated", ... }

const session = yield* agent.open(
  capabilities.spendCap !== "none" ? { cwd, spendCapUsd: 5 } : { cwd }
)
```

## What each supports

| | Claude | Codex |
|---|---|---|
| Steer into the running turn | ✅ at the next tool boundary | ✅ |
| Resume, history | ✅ | ✅ |
| Cost | ✅ reported | 🟡 estimated from `pricing` |
| Spend cap | ✅ | 🟡 estimated, enforced by interrupting |
| Hooks | ✅ | ✅ |
| `disable.askUser` | ✅ | ✅ refused when called, on models that have an asynchronous ask tool |
| `disable.subagents` | ✅ | ✅ refused when called |
| `disable.tools` | ✅ any tool | ✅ any tool: removed, or refused when called |
| Account `status` | ✅ | ✅ |

## How Codex differs

Codex runs hooks as commands, so a session with hooks or refused tools costs more than
one without, and `disable.askUser` and `disable.subagents` always refuse tools. The first
`open` per layer starts an extra `codex app-server`, and each hook call starts a short-lived
process of your runtime. `open` fails if Codex won't run the hooks, rather than running
without them.

A detached session pays this even if it never uses hooks. Each host has its own layer, so
every `open` starts the extra `codex app-server`. All three hooks are registered so that a
client can answer them later, so every tool call starts two of those processes, about 20 ms
each on Node.

- A tool that's refused rather than removed is still visible to the model, which gets the
  refusal as the tool's result. Subagent tools usually work this way, because current
  models select them regardless of Codex's switches. So does `request_user_input_async`,
  which the gpt-6 family's catalog entries add and no switch removes. The session's
  instructions also tell the model not to use either.
- Hooks see Codex's tool names, such as `Bash` and `apply_patch`.
- Codex runs no hooks for hosted tools like web search, or after a failed `apply_patch`.
  `isError` is only set for shell commands.
- Turning hooks off in config works as on Claude: your own hooks stop, managed ones still
  run, and a session's `hooks` and `disable` keep working. A managed policy that stops
  hooks is different. Claude still runs a session's hooks; on Codex, `open` fails when a
  session needs them, which any `disable.askUser` or `disable.subagents` does. It also
  fails if `CodexAgent.layer({ config })` would stop them.
