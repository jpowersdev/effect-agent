---
title: "Process control"
description: "Clean up after agents, limit their resources, and catch stuck turns."
sidebar:
  order: 5
---

## Clean up after a session

There's nothing to call. When a session's scope closes, its agent and every process the
agent started are stopped. If an agent dies, its leftovers are stopped right away.

```ts
yield* Effect.scoped(
  Effect.gen(function* () {
    const session = yield* agent.open({ cwd })
    yield* session.turn("Start the dev server and check the home page")
  }),
)
// The dev server is gone too
```

This works on Linux only, since it reads `/proc`. A command that clears its environment
escapes it; the [systemd scope](#limit-memory-per-session) below catches those too.

## Run agents at a lower priority

A `Launcher` gets each agent's command and returns the one to run instead.

```ts
import { Launcher } from "@jpowersdev/effect-agent"

const Nice = Launcher.layer(() =>
  Effect.succeed(({ command, args }) => ({
    command: "nice",
    args: ["-n", "10", command, ...args],
  })),
)

program.pipe(Effect.provide(Nice))
```

To wrap a single session, provide the launcher around `open`:

```ts
agent.open({ cwd }).pipe(Effect.provideService(Launcher.Launcher, launcher))
```

## Limit memory per session

On Linux with a systemd user manager,
[`examples/SystemdLauncher.ts`](https://github.com/jpowersdev/effect-agent/blob/main/examples/SystemdLauncher.ts)
runs each agent in its own transient scope. Copy it into your app; it isn't part of the
package.

```ts
import * as SystemdLauncher from "./SystemdLauncher.ts"

const systemd = yield* SystemdLauncher.make({
  // See systemd.resource-control(5)
  properties: { MemoryMax: "4G", TasksMax: "512" },
})

const session = yield* agent
  .open({ cwd })
  .pipe(Effect.provideService(Launcher.Launcher, systemd.launcher))
```

The limits cover the agent and everything it starts. When the session ends, everything
in the scope is stopped, including commands that cleared their environment.

## Tell an out-of-memory kill apart

A turn whose agent was killed fails with `ProcessKilled`. `oomKilled` says whether it
was the OOM killer.

```ts
yield* session.turn(prompt).pipe(
  Effect.catchTag("ProcessKilled", (killed) =>
    Effect.flatMap(systemd.oomKilled, (oom) =>
      // OutOfMemory is your own error
      Effect.fail(oom ? new OutOfMemory({ cause: killed }) : killed),
    ),
  ),
)
```

## Let only the runaway command die

By default an OOM kill stops the whole scope, so the turn ends `ProcessKilled`. With
`oomPolicy: "continue"`, usually only the command that ran out dies, and the agent sees
it fail and carries on.

```ts
SystemdLauncher.make({ properties: { MemoryMax: "4G" }, oomPolicy: "continue" })
```

## Limit all agents together

Every scope sits under `effect_agent.slice`, so one command caps them all:

```sh
systemctl --user set-property effect_agent.slice MemoryMax=16G
```

`node scripts/live-systemd.ts` runs the recipe with Claude Code: a session under limits,
and an out-of-memory command under each policy.

## Catch a stuck turn

A turn with no events for `idle` is interrupted and fails with `Stalled`. While a tool
call runs, the limit is `toolIdle`. `Heartbeat` events count, so a model that's thinking
isn't idle.

```ts
agent.open({
  cwd,
  watchdog: { idle: "5 minutes", toolIdle: "30 minutes" },
})
```

If the turn still hasn't ended 10 seconds later (`grace`), the agent is killed, which
ends the session.
