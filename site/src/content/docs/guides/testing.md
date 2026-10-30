---
title: "Testing"
description: "Test code that uses effect-agent against recorded sessions, with no agent running."
sidebar:
  order: 7
---

## Record a session

Run your program once against the real CLI, with `record` on the transport.

```ts
const Recording = ClaudeAgent.layer().pipe(
  Layer.provide(ClaudeSdk.layer({ record: "test/fixtures/fix-issue.jsonl" })),
)
```

For Codex, `CodexAppServer.layer({ record })` does the same. Each connection starts the
file afresh, except one that opens while another is recording (a `status` call during
a session, say): that one isn't recorded.

## Replay it in a test

Swap the transport for a replay. The real event mapping runs, but no process starts, so
the test is fast and free.

```ts
import { it } from "@effect/vitest"
import { ClaudeReplay } from "@jpowersdev/effect-agent/claude"

const Replay = ClaudeAgent.layer().pipe(
  Layer.provide(ClaudeReplay.layerFile("test/fixtures/fix-issue.jsonl")),
)

it.effect("replies on the issue", () =>
  Effect.gen(function* () {
    yield* work(issue)
    expect(replies).toHaveLength(1)
  }).pipe(Effect.provide(Replay)),
)
```

For Codex, use `CodexReplay.layer(recordingText)`. The program has to make the calls it
made while recording. If it doesn't, the replay fails with `replay_diverged`.

## Test your hooks

A Claude recording includes each hook call. The replay calls your session's hooks at
the same points, with the inputs the CLI sent, and reports what they returned.

```ts
const answers: Array<ReadonlyArray<unknown>> = []

const Replay = ClaudeAgent.layer().pipe(
  Layer.provide(
    ClaudeReplay.layerFile("test/fixtures/fix-issue.jsonl", {
      onHook: (call) => answers.push(call.outputs),
    }),
  ),
)
```

The model's replies come from the recording, so they don't change with your hooks.

## Work on effect-agent itself

```sh
pnpm typecheck && pnpm test
EFFECT_AGENT_TEST_HOST=bun pnpm test  # session hosts under Bun instead of Node

# Against the real CLIs (costs a little)
node scripts/live-claude.ts
node scripts/live-codex.ts

pnpm build
```

To take a new Claude Code or Codex release, follow
[UPGRADING.md](https://github.com/jpowersdev/effect-agent/blob/main/UPGRADING.md).
