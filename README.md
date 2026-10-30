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

A `RemoteSession` is an `AgentSession` plus `subscribeFrom(seq)` (a stream of `{ seq, event }` that fails with `EventsTrimmed` if `seq` is older than the host keeps, `maxEvents`, default 50 000), `lastSeq`, `awaitTurn` / `awaitMessage` (by turn id, or by the `MessageId` that `send` returned), `detach` and `stop`. `subscribe`/`events` are live from now, as for a local session. `onScopeClose` is `"stop"` by default (closing the scope ends the session, as locally); set `"detach"` to leave it running. `AgentHosts.list` lists live hosts. `status` and `history` run locally. Hooks are refused: functions can't cross processes.

Each host serves one session over effect/rpc on a unix socket in `dir` (default `$XDG_RUNTIME_DIR/effect-agent`), next to a manifest `<sessionId>.json` and a log `<sessionId>.log`. It exits when the session ends (`end`, `stop`, the agent dying, SIGTERM), lingering a few seconds so clients get the last events, and when no client has been attached to an idle session for `orphanTimeout` (default 30 minutes). Stale manifests (dead pid) are removed by `list` and `attach`.

**Process supervisors:** hosts are started detached, so they outlive the process that opened them, but whatever supervises that process may still stop them. The `Launcher` applies to the host command (so the host and the agent it runs share whatever it sets up); use it to place hosts outside the supervisor's reach. For example:

- **systemd:** with the default `KillMode=control-group`, stopping or restarting the runner's unit kills every process in its cgroup, hosts included. Wrap hosts in their own scope with `systemd-run --user --scope ...` (as above).
- **launchd:** a job's process group is killed when it exits unless `AbandonProcessGroup` is set.
- **Containers:** everything in a container stops with it; hosts need to run somewhere that outlives the runner's container.

A host killed with SIGKILL can't stop its agent either (Node has no parent-death signal); a cgroup launcher such as a systemd scope covers that.

`node scripts/live-reattach.ts` checks this end to end with the real CLIs: process A starts a slow turn and exits mid-turn; process B attaches, catches up, gets the turn's result, runs another turn and ends the session.

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
