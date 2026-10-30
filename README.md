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
