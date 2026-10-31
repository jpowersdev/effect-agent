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
import { Agent } from "@jpowersdev/effect-agent"
import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"
import { Effect, Layer, Stream } from "effect"

const program = Effect.gen(function*() {
  const agent = yield* Agent
  const session = yield* agent.open({ cwd: process.cwd(), spendCapUsd: 5 })

  // Subscribe before sending, so no event is missed
  const events = yield* session.subscribe
  yield* events.pipe(
    Stream.runForEach(Effect.logInfo),
    Effect.forkScoped
  )

  const result = yield* session.turn("Fix the failing test")
  yield* Effect.log(result.finalText)
})

const Claude = ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))

// Closing the scope ends the session and stops every process it started
program.pipe(
  Effect.scoped,
  Effect.provide(Claude),
  NodeRuntime.runMain
)
```

## Vocabulary

| Noun        | What it is                                                                             | Verbs                                                      |
| ----------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Agent**   | One provider (Claude Code or Codex), as a service. Its layer picks which.              | `open` a session, `status`, `history`, `capabilities`      |
| **Session** | One agent process working in one directory. It stays open until its scope closes.      | `send`, `turn`, `steer`, `interrupt`, `end`, `subscribe`   |
| **Message** | Input you give a session, with a `MessageId`.                                          | lands in a turn, or is dropped                             |
| **Turn**    | The agent's work on a message, from `TurnStarted` to `TurnEnded`.                      | starts, ends with an outcome                               |
| **Outcome** | How a turn ended: `Succeeded` with its `finalText`, or a failure such as `Stalled`.    | `turn` succeeds with it, or fails with it as a typed error |
| **Event**   | Something that happened in a session: text, a tool call and its result, a turn ending. | stream them with `subscribe` or `events`                   |
| **Host**    | A process of its own for a session, so the session outlives yours.                     | `AgentHosts` can `open`, `attach`, `list`, `events`        |

In the example above, `agent.open` starts a session, `session.turn` sends a message and
waits for its turn to end, and `subscribe` streams the session's events.
[Sessions](../guides/sessions/) covers the session verbs, and
[Reattach](../guides/reattach/) covers hosts.

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
