---
title: "Reattach"
description: "Sessions that outlive the process that opened them."
sidebar:
  order: 6
---

`RemoteAgent.layer` runs each session in its own host process, so it survives the process that opened it (e.g. a runner restarting to deploy). Another process can reattach by id, catch up on what it missed, and keep controlling it.

The host process runs an entry point in *your* app; the library ships no executable:

```ts
// host.ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { SessionHost } from "@jpowersdev/effect-agent/host"

NodeRuntime.runMain(SessionHost.run.pipe(Effect.provide(NodeServices.layer)))
// Bun: BunRuntime.runMain(SessionHost.run.pipe(Effect.provide(BunServices.layer)))
```

```ts
import { AgentHosts, RemoteAgent } from "@jpowersdev/effect-agent/host"

const layer = RemoteAgent.layer({
  provider: "claude",
  claude: { model },
  host: { command: process.execPath, args: [fileURLToPath(new URL("./host.ts", import.meta.url))] },
  onScopeClose: "detach",
}).pipe(Layer.provide(NodeServices.layer))   // status and history run locally

// before the restart: persist the session id and the MessageId
const session = yield* (yield* Agent).open({ cwd })   // Agent works unchanged; capabilities.reattach is true
const messageId = yield* session.send("Fix the failing test")

// after it
const session = yield* (yield* AgentHosts).attach(sessionId)    // SessionNotFound if no live host
yield* session.subscribeFrom(lastPersistedSeq + 1).pipe(Stream.runForEach(persist), Effect.forkScoped)
const result = yield* session.awaitMessage(messageId)         // even if the turn ended while nobody was attached
```

`host` is just a command, so the runtime (Node or Bun, for the host and the client independently) and whether you bundle are up to you: if you bundle your app, make `host.ts` a second entry point, as you would a worker. Module loading dominates host startup, so a bundled entry starts noticeably faster (about 0.1 s versus 0.25 s here).

A `RemoteSession` is an `AgentSession` plus `subscribeFrom(seq)` (a stream of `{ seq, event }` from any seq, then live), `lastSeq`, `awaitTurn` / `awaitMessage` (by turn id, or by the `MessageId` that `send` returned), `detach` and `stop`. `subscribe`/`events` are live from now, as for a local session. `onScopeClose` is `"stop"` by default (closing the scope ends the session, as locally); set `"detach"` to leave it running. `AgentHosts.list` lists live hosts. `status` and `history` run locally.

Each host serves one session over effect/rpc on a unix socket in `dir` (default `$XDG_RUNTIME_DIR/effect-agent`, kept at mode 0700), next to a manifest `<sessionId>.json`, a log `<sessionId>.log` and the events file `<sessionId>.events.jsonl`. It exits when the session ends (`end`, `stop`, the agent dying, SIGTERM), lingering a few seconds so clients get the last events, and when no client has been attached to an idle session for `orphanTimeout` (default 30 minutes). Stale manifests (dead pid) are removed by `list` and `attach`.

**The event log.** The host appends every `{ seq, event }` to `<sessionId>.events.jsonl` (mode 0600; one Schema-encoded JSON line each, seq 0, 1, 2, ...) before any subscriber sees it. The last `maxEvents` (default 50 000) are also kept in memory as a cache: `subscribeFrom(seq)` older than the cache reads the missing range from the file, then carries on from the cache and live events with no gap or duplicate. `awaitTurn`/`awaitMessage` don't depend on either, so they answer for any turn of the session. `subscribeFrom` fails with `EventsTrimmed` only when `seq` is older than the cache and the file can't serve it: `persistEvents: false`, or the file is missing or unreadable. A resumed session (`resume`) numbers on from the file its earlier host left.

When the host exits, the socket and manifest go, but the events file is kept for `retainEvents` (default 24 hours, counted from when the host exited). `AgentHosts.events(sessionId, fromSeq?)` reads it whether or not the host is still running: from a live host it follows live events until the session ends; otherwise it reads the file to its end. Either way it ends as a live subscription would. When the session ends, the host writes a last line recording how (`{"ended":null}`, or the encoded `AgentError`), so `events` completes after a clean end and fails with the session's error otherwise. A file without that line belongs to a host that was SIGKILLed mid-session. It is known to be incomplete (it stops where the host did), and reading it completes at its end. `events` fails with `SessionNotFound` if there's neither a host nor a file. Expired files are pruned by `list`, `attach`, `events` and host startup.

```ts
// after the runner restarts, even if the session ended meanwhile
yield* (yield* AgentHosts).events(sessionId, lastPersistedSeq + 1).pipe(Stream.runForEach(persist))
```

**Hooks.** `RunOptions.hooks` work on remote sessions where the provider has them (Claude; Codex `open` refuses them, as locally, and `capabilities.hooks` says which). The functions stay in your process. Every remote Claude session registers all three hook kinds, whether or not `open` passed any, and the host forwards each call (Schema-encoded input) to an attached client that has that hook, then adds that client's answer. So any client can supply any hook at any time, through `open` or `attach`:

```ts
const session = yield* (yield* AgentHosts).open({ cwd, hooks: { beforeTool } }, { hookTimeout: "2 seconds" })
// after a restart, answer them again:
const session = yield* (yield* AgentHosts).attach(sessionId, { hooks: { beforeTool } })
```

- **Who answers.** Of the attached clients that have that hook, the one that attached most recently. When it detaches, the one before it answers again. A client attached without hooks never answers.
- **No answer adds nothing.** With no such client attached, the host answers "nothing" at once, in-process, with no socket round trip, so an unanswered hook costs next to nothing per tool call. A client that doesn't answer within `hookTimeout` (default 5 seconds; set on the layer, or per session in `open`/`attach`) adds nothing either, and the host logs the timeout, so the agent never waits longer. A hook that fails or defects adds nothing, as locally.
- **Reconnects.** A call still waiting when its client's connection drops is delivered again once the client reconnects, until its timeout. The client runs each call once.

**Reconnecting.** When the connection to a host drops (other than by `detach`/`stop` or the session ending), the client re-dials it on `reconnect`, by default an exponential backoff from 100 ms, capped at 2 s between attempts, giving up after 30 s (`RemoteAgent.defaultReconnect`). It's transparent: subscriptions resume from the last seq they delivered, and calls in flight are retried. `send`, `steer`, `turn` and `interrupt` carry a client-generated request id. The host remembers the last 1 000 results by id and answers a repeat with the original result, so a retried `send` lands once, a retried `turn` waits on the original turn, and a retried `interrupt` can't hit the turn after it. Calls fail with `AgentError` when the schedule gives up, or at once if the host is gone (manifest removed or pid dead). `reconnect: false` fails on the first drop.

**Process supervisors:** hosts are started detached, so they outlive the process that opened them, but whatever supervises that process may still stop them. The `Launcher` applies to the host command (so the host and the agent it runs share whatever it sets up); use it to place hosts outside the supervisor's reach. For example:

- **systemd:** with the default `KillMode=control-group`, stopping or restarting the runner's unit kills every process in its cgroup, hosts included. Wrap hosts in their own scope with the systemd recipe above (`stopOnEnd: false`).
- **launchd:** a job's process group is killed when it exits unless `AbandonProcessGroup` is set.
- **Containers:** everything in a container stops with it; hosts need to run somewhere that outlives the runner's container.

**A SIGKILLed host** (`kill -9`, the OOM killer) can't run any cleanup. Its agent process, and the commands that agent started, may be left running: Node has no parent-death signal, and the host is the only thing that would have stopped them. Stopping them is up to you, since they are your process tree. Either run hosts under a cgroup `Launcher` (a systemd scope, as above), so that stopping the scope stops the host, the agent and its commands together, or have your own supervisor reap them. The host's socket and manifest stay behind until `list` or `attach` notices the dead pid. Its events file has no ending line (see above).

`node scripts/live-reattach.ts` checks this end to end with the real CLIs: process A starts a slow turn and exits mid-turn; process B attaches, catches up, and drops its connection mid-turn twice: once while A's turn runs, once during a `turn()` call. Both turns' results still arrive, the subscription sees every event exactly once, and it matches the events file read back with `AgentHosts.events` after the host has exited.
