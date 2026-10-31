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
// { provider: "codex", version: "0.162.1", steer: true, hooks: false, ... }

const session = yield* agent.open(
  capabilities.hooks ? { cwd, hooks: { beforeTool } } : { cwd }
)
```

## What each supports

| | Claude | Codex |
|---|---|---|
| Steer into the running turn | ✅ at the next tool boundary | ✅ |
| Resume, history | ✅ | ✅ |
| Cost | ✅ reported | 🟡 estimated from `pricing` |
| Spend cap | ✅ | 🟡 estimated, enforced by interrupting |
| Hooks | ✅ | ❌ `open` fails if hooks are set |
| `disable.subagents` | ✅ | 🟡 asked for in the instructions, not enforced |
| `disable.tools` | ✅ any tool | 🟡 some tools; others fail `open` |
| Account `status` | ✅ | ✅ |
