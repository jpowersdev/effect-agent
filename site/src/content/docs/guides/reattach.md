---
title: "Reattach"
description: "Keep sessions running across restarts and deploys, then pick them up again."
sidebar:
  order: 6
---

With `RemoteAgent`, each session runs in a host process of its own. Your process can
exit, for a deploy say, and the session keeps going. When it comes back it attaches by
id and reads the events it missed.

## Add a host entry point

The host runs a small entry point from your app. The library ships no executable.

```ts
// host.ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { SessionHost } from "@jpowersdev/effect-agent/host"

NodeRuntime.runMain(SessionHost.run.pipe(Effect.provide(NodeServices.layer)))
```

On Bun, use `BunRuntime` and `BunServices`. If you bundle your app, make `host.ts` a
second entry point, like a worker. A bundled host starts in about 0.1 s, against 0.25 s.

## Run sessions in hosts

`RemoteAgent.layer` provides `Agent`, so the rest of your program doesn't change.
`onScopeClose: "detach"` leaves sessions running when their scope closes.

```ts
import { AgentHosts, RemoteAgent } from "@jpowersdev/effect-agent/host"

const Remote = RemoteAgent.layer({
  provider: "claude",
  claude: { model: "claude-sonnet-5-5" },
  host: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./host.ts", import.meta.url))],
  },
  onScopeClose: "detach", // the default is "stop"
}).pipe(Layer.provide(NodeServices.layer))
```

## Hand a session across a restart

Store the session id, and the message id from `send`, before you exit.

```ts
const session = yield* agent.open({ cwd })
const messageId = yield* session.send("Fix the failing test")

yield* store.save({ sessionId: session.sessionId, messageId })
```

## Pick it up again

`attach` connects to the session's host. `subscribeFrom` replays events from a
sequence number, then follows live ones. `awaitMessage` answers even if the turn ended
while nobody was attached.

```ts
const hosts = yield* AgentHosts
const { sessionId, messageId, lastSeq } = yield* store.load

const session = yield* hosts.attach(sessionId) // SessionNotFound if no host has it

yield* session.subscribeFrom(lastSeq + 1).pipe(
  Stream.runForEach(({ seq, event }) => store.saveEvent(seq, event)),
  Effect.forkScoped,
)

const result = yield* session.awaitMessage(messageId)
```

## Catch up on a session that already ended

The host is gone once its session ends, but its events file stays for `retainEvents`
(24 hours by default). `hosts.events` reads it, or the live host if there still is one.

```ts
yield* hosts.events(sessionId, lastSeq + 1).pipe(
  Stream.runForEach(({ seq, event }) => store.saveEvent(seq, event)),
)
```

The stream completes after a clean end, and fails with the session's `AgentError` after
a failure. For a host that was SIGKILLed, it completes where the file stops.

## List and stop sessions

`list` returns the live hosts. To stop one, attach and call `stop`, which waits for
the host to exit.

```ts
for (const host of yield* hosts.list) {
  yield* Effect.log(host.sessionId, host.cwd, host.startedAt)
}

yield* Effect.scoped(Effect.flatMap(hosts.attach(sessionId), (s) => s.stop))
```

A host also exits on its own when no client has been attached to an idle session for
`orphanTimeout` (30 minutes by default).

## Answer hooks from your process

Hooks stay in your process; the host forwards each call to a client. After a restart,
attach with them again.

```ts
const session = yield* hosts.open({ cwd, hooks: { beforeTool } })

// After a restart
const session = yield* hosts.attach(sessionId, { hooks: { beforeTool } })
```

Any client can answer any hook, whether or not `open` had it. The client that attached
most recently answers. With nobody to answer, or no answer within `hookTimeout`
(5 seconds), the hook adds nothing and the turn carries on.

## Keep hosts out of a supervisor's reach

Hosts outlive the process that started them, but its supervisor may still stop them.
The `Launcher` wraps the host command, so it can move hosts somewhere else.

```ts
const systemd = yield* SystemdLauncher.make({ stopOnEnd: false })

const Remote = RemoteAgent.layer(options).pipe(
  Layer.provide(Layer.succeed(Launcher.Launcher, systemd.launcher)),
)
```

- **systemd**: stopping the runner's unit kills its whole cgroup, hosts included. Run
  them in their own scopes with the [systemd launcher](../process-control/#limit-memory-per-session),
  as above.
- **launchd**: set `AbandonProcessGroup` on the runner's job.
- **Containers**: hosts stop with the container. Run them somewhere that outlives it.

A host killed with SIGKILL can't stop its agent. Under a cgroup launcher, they stop
together.

## Set where the files go and how long they stay

```ts
RemoteAgent.layer({
  provider: "claude",
  host: { command, args },
  dir: "/run/user/1000/effect-agent", // default: $XDG_RUNTIME_DIR/effect-agent
  maxEvents: 50_000, // events kept in memory; older ones are read from the file
  persistEvents: true, // false: no events file, and no catching up past maxEvents
  retainEvents: "24 hours", // how long the events file outlives the host
  orphanTimeout: "30 minutes",
  hookTimeout: "5 seconds",
})
```

Each session has three files in `dir`:

```
<sessionId>.json           the manifest, while the host runs
<sessionId>.log            the host's log
<sessionId>.events.jsonl   every event, one per line
```

## Survive a dropped connection

If the connection to a host drops, the client reconnects and carries on. Subscriptions
resume where they were, and a retried `send`, `turn` or `interrupt` takes effect once.

```ts
RemoteAgent.layer({
  ...options,
  // The default backs off from 100 ms to 2 s, and gives up after 30 s
  reconnect: Schedule.max([Schedule.spaced("1 second"), Schedule.during("1 minute")]),
})
```

With `reconnect: false`, calls fail with `AgentError` at the first drop.

## Try it end to end

```sh
node scripts/live-reattach.ts
```

Process A starts a slow turn and exits in the middle of it. Process B attaches, catches
up, and loses its connection twice. The script checks that both results arrive and the
subscription saw every event once.
