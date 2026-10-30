---
title: "Getting started"
description: "Install effect-agent, run a first turn, and provide platform services."
---

> Status: early development (Effect 4.1). The API will change.

```sh
pnpm add @jpowersdev/effect-agent effect
pnpm add @effect/platform-node   # or @effect/platform-bun; see Platform below
```

```ts
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@jpowersdev/effect-agent"
import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"

const program = Effect.scoped(
  Effect.gen(function* () {
    const agent = yield* Agent
    const session = yield* agent.open({ cwd, model, appendSystemPrompt, spendCapUsd: 5 })
    const events = yield* session.subscribe // subscribe before sending so nothing is missed
    yield* events.pipe(Stream.runForEach(persist), Effect.forkScoped)

    const result = yield* session.turn("Fix the failing test")
    //    ^ fails with UsageLimited | AuthFailed | SpendCapReached | Stalled | ...
  }),
).pipe(Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))))
```

Closing the scope ends the session and stops the agent process and everything it started.



## Platform

The library imports no platform package; `effect` is a peer dependency. Where Effect has a platform service, the library takes it from context: Codex spawns its app-server through `ChildProcessSpawner`, and a session host reads its spec and reports readiness through `Stdio`. Provide `NodeServices.layer` from `@effect/platform-node`, or `BunServices.layer` from `@effect/platform-bun`. Everything else uses Node's built-in modules, which Bun implements; Effect's own Bun platform is built on the same modules. That covers files, the Claude SDK's process, the leftover-process sweep, and unix sockets through `@effect/platform-node-shared`. The test suite runs hosts on both runtimes.

## Next

- [Providers](../guides/providers/): what each provider supports.
- [Sessions](../guides/sessions/): sending, steering and interrupting.
- [API reference](../api/core/agent/): every export, generated from the source.
