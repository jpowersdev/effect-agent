---
title: "Process control"
description: "Wrap agent processes with a Launcher, stop everything they started, and catch stalls."
sidebar:
  order: 5
---

Provide a `Launcher` to wrap every agent process: it gets the command and returns the one to run instead. Provide it as a layer, or per session around `open`.

## Recipe: a systemd scope per session

On Linux with a systemd user manager, [`examples/SystemdLauncher.ts`](https://github.com/jpowersdev/effect-agent/blob/main/examples/SystemdLauncher.ts) runs each agent process in its own transient scope (`systemd-run --user --scope`). Copy it into your app. It gives you three things:
- **Everything stops:** stopping the scope at the end of the session kills everything in the cgroup, including commands that cleared their environment.
- **Limits:** resource limits cover the agent and everything it starts.
- **An answer to "was that an OOM kill?"** A turn that ends `ProcessKilled` doesn't say why it died.

```ts
import * as SystemdLauncher from "./SystemdLauncher.ts"

const result = yield* Effect.gen(function* () {
  const systemd = yield* SystemdLauncher.make({ properties: { MemoryMax: "4G", TasksMax: "512" } })
  const session = yield* agent.open({ cwd }).pipe(Effect.provideService(Launcher.Launcher, systemd.launcher))
  return yield* session.turn(prompt).pipe(
    Effect.catchTag("ProcessKilled", (killed) =>
      // OutOfMemory: an error of your own
      Effect.flatMap(systemd.oomKilled, (oom) => Effect.fail(oom ? new OutOfMemory({ cause: killed }) : killed)),
    ),
  )
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
```

- **OOM policy:** `oomPolicy: "stop"` (systemd's default) stops the whole scope when the kernel OOM killer strikes, so the turn ends `ProcessKilled`. With `"continue"`, usually only the runaway command dies, and the agent sees it fail and carries on. `oomKilled` reports the kill either way.
- **Slices:** each `make` puts its scopes in a slice of their own, which keeps the OOM count after the scope is gone. All of those slices sit under `effect_agent.slice`, so `systemctl --user set-property effect_agent.slice MemoryMax=16G` caps every agent together.
- **Arguments:** the recipe passes `--expand-environment=no`. Without it, `systemd-run` expands `$VAR` in the command line and silently rewrites any argument (such as a prompt) that contains a `$`.
- **Remote sessions:** for `RemoteAgent`, pass `stopOnEnd: false`. The `Launcher` then wraps the host, so the host, the agent and its commands share one scope, and that scope must outlive the caller.
- **Testing:** `test/systemd-launcher.test.ts` checks the recipe against the real user manager, and skips itself where there is none. `node scripts/live-systemd.ts` runs it with Claude Code: a session under limits, and an out-of-memory command under each policy.

Without one, processes are still stopped when the session ends, and as soon as an agent process dies its leftovers are swept. Both Claude Code and Codex start each command in its own session, so a process-group kill alone misses them. Instead, each agent process gets a unique `EFFECT_AGENT_PROCESS` variable, and every live process carrying it is stopped (Linux, via `/proc`). A cgroup launcher is still the stronger guarantee: it also covers commands that clear their environment.

`watchdog: { idle, toolIdle, grace }` ends a quiet turn `Stalled`. Heartbeats count as activity, so a model that is thinking is not idle; `toolIdle` applies while a tool call runs.
