# effect-agent

Effect-native control of coding-agent CLIs (Claude Code, Codex): live sessions with steering, resumable sessions, one normalized event stream, typed endings, and account status.

> Status: early development (Effect 4.1). The API will change.

```ts
import { Effect, Layer, Stream } from "effect"
import { Agent } from "effect-agent"
import { ClaudeAgent, ClaudeSdk } from "effect-agent/claude"

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

## Providers

Each provider is two layers: a transport (`ClaudeSdk`, `CodexAppServer`) and an `Agent` built on it.

| | Claude | Codex |
|---|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` with its bundled Claude Code | `codex app-server` JSON-RPC, one process per session (via `ChildProcessSpawner`) |
| Steer into the running turn | yes (lands at the next tool boundary) | yes (`turn/steer`) |
| Resume, history | yes | yes |
| Cost | reported | estimated from a `pricing` table you supply |
| Spend cap | native (`maxBudgetUsd`) | estimated, enforced by interrupting |
| Usage-limit reset times | yes | yes |
| Hooks | yes | no (`open` fails if hooks are set) |
| `disable.subagents` | yes | **no**: Codex can't turn them off per thread |
| `disable.tools` | any tool | only some tools (others fail `open`) |
| Account `status` | yes (experimental SDK usage API) | yes |

`agent.capabilities` reports the same at runtime, plus the tool's version.

## Sessions

`agent.open(options)` returns an `AgentSession`:

- `send(input)`: start a turn now, or queue it after the running turn.
- `turn(input)`: `send`, then wait for that turn's ending.
- `steer(input)`: deliver into the running turn → `Landed { turnId }`, or `StartedNewTurn` if the turn ended first.
- `interrupt`: stop the running turn (`Interrupted`); the session stays usable.
- `end`: no more input; finish queued work, then exit.
- `subscribe` / `events`: the normalized event stream; every subscription starts with `SessionStarted`.
- `sessionId`, `location` (the transcript file), `pid`.

`RunOptions` covers `cwd`, `env` (`undefined` removes a variable; nesting markers such as `CLAUDECODE` are always removed), `model`, `effort`, `appendSystemPrompt` (added to the default, never replacing it), `disable`, `spendCapUsd`, `resume`, `watchdog` and `hooks`. Permissions are always off, and MCP servers are never inherited (no user servers, claude.ai connectors or ChatGPT apps).

## Events

`SessionStarted`, `TurnStarted`, `MessageLanded`, `MessageDropped`, `UserMessage` (history), `Text`, `ToolCall` (with a one-line `summary`), `ToolResult`, `Retrying` (a retry, not an error), `LimitsUpdated`, `Compacted`, `Heartbeat`, `TurnEnded` (outcome, tokens, cost), and `Other`. Every event carries the provider's original frame in `raw`.

## Endings

A turn ends `Succeeded`, or fails with one of these `Schema` tagged errors (also on `TurnEnded.outcome`):

`AgentFailed`, `UsageLimited { window, resetsAt, overageAvailable }`, `Throttled { retriesLeft }`, `AuthFailed`, `SpendCapReached`, `ContextExhausted`, `ProcessKilled { signal, exitCode }`, `Stalled { idleMs, inTool }`, `Interrupted`.

`open` and `history` fail with `SessionNotFound` for an unknown session; infrastructure failures are `AgentError`.

## Account status

`agent.status` reports `usable`, a `reason` (`unauthenticated`, `usage_limited`, `spend_limited`), limit `windows` (percent used and reset time), and `plan`, without running a turn.

Some windows cap a single model family (Claude's weekly Opus or `model_scoped` caps); those carry `model: Option<string>` (e.g. `Option.some("fable")`, encoded as `null` when absent). A full per-model window doesn't make the account unusable, since other models still run, so check the model you're about to use:

```ts
import { usableFor } from "effect-agent"

if (usableFor(status, persona.model)) dispatch(task)  // false if e.g. the Fable cap is full for a Fable persona
```

## Process control

Provide a `Launcher` to wrap every agent process, e.g. in a systemd scope:

```ts
import { Launcher } from "effect-agent"

Launcher.layer(({ provider }) =>
  Effect.succeed((cmd) => ({
    command: "systemd-run",
    args: ["--user", "--scope", "--quiet", `--unit=agent-${provider}-${crypto.randomUUID()}.scope`, "--", cmd.command, ...cmd.args],
  })),
)
```

Without one, processes are still stopped when the session ends, and as soon as an agent process dies its leftovers are swept. Both Claude Code and Codex start each command in its own session, so a process-group kill alone misses them. Instead, each agent process gets a unique `EFFECT_AGENT_PROCESS` variable, and every live process carrying it is stopped (Linux, via `/proc`). A cgroup launcher is still the stronger guarantee: it also covers commands that clear their environment.

`watchdog: { idle, toolIdle, grace }` ends a quiet turn `Stalled`. Heartbeats count as activity, so a model that is thinking is not idle; `toolIdle` applies while a tool call runs.

## Reattach

`RemoteAgent.layer` runs each session in its own host process, so it survives the process that opened it (e.g. a runner restarting to deploy). Another process can reattach by id, catch up on what it missed, and keep controlling it.

```ts
import { AgentHosts, RemoteAgent } from "effect-agent/host"

const layer = RemoteAgent.layer({ provider: "claude", claude: { model }, onScopeClose: "detach" })

// before the restart: persist the session id and the MessageId
const session = yield* (yield* Agent).open({ cwd })   // Agent works unchanged; capabilities.reattach is true
const messageId = yield* session.send("Fix the failing test")

// after it
const session = yield* (yield* AgentHosts).attach(sessionId)    // SessionNotFound if no live host
yield* session.subscribeFrom(lastPersistedSeq + 1).pipe(Stream.runForEach(persist), Effect.forkScoped)
const result = yield* session.awaitMessage(messageId)         // even if the turn ended while nobody was attached
```

A `RemoteSession` is an `AgentSession` plus `subscribeFrom(seq)` (a stream of `{ seq, event }` from any seq, then live), `lastSeq`, `awaitTurn` / `awaitMessage` (by turn id, or by the `MessageId` that `send` returned), `detach` and `stop`. `subscribe`/`events` are live from now, as for a local session. `onScopeClose` is `"stop"` by default (closing the scope ends the session, as locally); set `"detach"` to leave it running. `AgentHosts.list` lists live hosts. `status` and `history` run locally. Hooks are refused: functions can't cross processes.

Each host serves one session over effect/rpc on a unix socket in `dir` (default `$XDG_RUNTIME_DIR/effect-agent`, kept at mode 0700), next to a manifest `<sessionId>.json`, a log `<sessionId>.log` and the events file `<sessionId>.events.jsonl`. It exits when the session ends (`end`, `stop`, the agent dying, SIGTERM), lingering a few seconds so clients get the last events, and when no client has been attached to an idle session for `orphanTimeout` (default 30 minutes). Stale manifests (dead pid) are removed by `list` and `attach`.

**The event log.** The host appends every `{ seq, event }` to `<sessionId>.events.jsonl` (mode 0600; one Schema-encoded JSON line each, seq 0, 1, 2, ...) before any subscriber sees it. The last `maxEvents` (default 50 000) are also kept in memory as a cache: `subscribeFrom(seq)` older than the cache reads the missing range from the file, then carries on from the cache and live events with no gap or duplicate. `awaitTurn`/`awaitMessage` don't depend on either, so they answer for any turn of the session. `subscribeFrom` fails with `EventsTrimmed` only when `seq` is older than the cache and the file can't serve it: `persistEvents: false`, or the file is missing or unreadable. A resumed session (`resume`) numbers on from the file its earlier host left.

When the host exits, the socket and manifest go, but the events file is kept for `retainEvents` (default 24 hours, counted from when the host exited). `AgentHosts.events(sessionId, fromSeq?)` reads it whether or not the host is still running: from a live host it follows live events until the session ends; otherwise it reads the file to the end and completes. It fails with `SessionNotFound` if there's neither. Expired files are pruned by `list`, `attach`, `events` and host startup.

```ts
// after the runner restarts, even if the session ended meanwhile
yield* (yield* AgentHosts).events(sessionId, lastPersistedSeq + 1).pipe(Stream.runForEach(persist))
```

**Reconnecting.** When the connection to a host drops (other than by `detach`/`stop` or the session ending), the client re-dials it on `reconnect`, by default an exponential backoff from 100 ms, capped at 2 s between attempts, giving up after 30 s (`RemoteAgent.defaultReconnect`). It's transparent: subscriptions resume from the last seq they delivered, and calls in flight are retried. `send`, `steer` and `turn` carry a client-generated request id. The host remembers the last 1 000 results by id and answers a repeat with the original result, so a retried `send` lands once and a retried `turn` waits on the original turn. Calls fail with `AgentError` when the schedule gives up, or at once if the host is gone (manifest removed or pid dead). `reconnect: false` fails on the first drop.

**Process supervisors:** hosts are started detached, so they outlive the process that opened them, but whatever supervises that process may still stop them. The `Launcher` applies to the host command (so the host and the agent it runs share whatever it sets up); use it to place hosts outside the supervisor's reach. For example:

- **systemd:** with the default `KillMode=control-group`, stopping or restarting the runner's unit kills every process in its cgroup, hosts included. Wrap hosts in their own scope with `systemd-run --user --scope ...` (as above).
- **launchd:** a job's process group is killed when it exits unless `AbandonProcessGroup` is set.
- **Containers:** everything in a container stops with it; hosts need to run somewhere that outlives the runner's container.

A host killed with SIGKILL can't stop its agent either (Node has no parent-death signal); a cgroup launcher such as a systemd scope covers that.

`node scripts/live-reattach.ts` checks this end to end with the real CLIs: process A starts a slow turn and exits mid-turn; process B attaches, catches up, and drops its connection mid-turn twice: once while A's turn runs, once during a `turn()` call. Both turns' results still arrive, the subscription sees every event exactly once, and it matches the events file read back with `AgentHosts.events` after the host has exited.

## Testing

Swap the transport for a replay of a recorded session, so the real event mapping runs with no process:

```ts
ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile("session.jsonl")))
CodexAgent.layer().pipe(Layer.provide(CodexReplay.layer(recordingText)))
```

Record with the transports' `record` option. `test/conformance.test.ts` runs the same programs against both providers.

```sh
pnpm typecheck && pnpm test
node scripts/live-claude.ts   # live, against the real CLIs (small cost)
node scripts/live-codex.ts
```

## License

MIT
