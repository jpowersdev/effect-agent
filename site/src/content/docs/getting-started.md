---
title: "Getting started"
description: "Install effect-agent and run a first turn."
---

:::caution
Early development, on Effect 4.1. The API will change.
:::

## Install

```sh
pnpm add @jpowersdev/effect-agent effect
pnpm add @effect/platform-node   # or @effect/platform-bun
```

## A first turn

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@jpowersdev/effect-agent"
import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"

const program = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open({ cwd: process.cwd(), spendCapUsd: 5 })

  // Subscribe before sending, so no event is missed
  const events = yield* session.subscribe
  yield* events.pipe(Stream.runForEach(Effect.logInfo), Effect.forkScoped)

  const result = yield* session.turn("Fix the failing test")
  yield* Effect.log(result.finalText)
})

const Claude = ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))

// Closing the scope ends the session and stops every process it started
program.pipe(Effect.scoped, Effect.provide(Claude), NodeRuntime.runMain)
```

## Platform services

`effect` is a peer dependency, and the library imports no platform package. Two parts
need services from context:

- Codex starts `codex app-server` with `ChildProcessSpawner`.
- A session host talks to its parent over `Stdio`.

Provide your runtime's layer:

```ts
import { NodeServices } from "@effect/platform-node"
// Bun: import { BunServices } from "@effect/platform-bun"

program.pipe(Effect.provide(NodeServices.layer))
```

Everything else uses Node's built-in modules, which Bun implements too. The test suite
runs session hosts on both.

## Next

- [Providers](../guides/providers/): what Claude Code and Codex each support.
- [Sessions](../guides/sessions/): send, steer, interrupt.
- [API reference](../api/core/): every export, generated from the source.
