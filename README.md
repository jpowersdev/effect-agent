<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="">
</p>

<h1 align="center">effect-agent</h1>

<p align="center">
  Effect-native control of coding-agent CLIs (Claude Code, Codex): live sessions with steering, resumable sessions, one normalized event stream, typed endings, and account status.
</p>

<p align="center">
  <a href="https://github.com/jpowersdev/effect-agent/actions/workflows/ci.yml"><img src="https://github.com/jpowersdev/effect-agent/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  <a href="https://jpowersdev.github.io/effect-agent/">Documentation</a> ·
  <a href="https://jpowersdev.github.io/effect-agent/api/core/">API reference</a>
</p>

> Status: early development (Effect 4.1). The API will change.

```sh
pnpm add @jpowersdev/effect-agent effect
pnpm add @effect/platform-node   # or @effect/platform-bun; see Platform
```

```ts
import { Agent } from "@jpowersdev/effect-agent"
import { ClaudeAgent, ClaudeSdk } from "@jpowersdev/effect-agent/claude"
import { Effect, Layer, Stream } from "effect"

const program = Effect.scoped(
  Effect.gen(function*() {
    const agent = yield* Agent
    const session = yield* agent.open({ cwd, model, appendSystemPrompt, spendCapUsd: 5 })
    const events = yield* session.subscribe // subscribe before sending so nothing is missed
    yield* events.pipe(
      Stream.runForEach(persist),
      Effect.forkScoped
    )

    const result = yield* session.turn("Fix the failing test")
    //    ^ fails with UsageLimited | AuthFailed | SpendCapReached | Stalled | ...
  })
).pipe(Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))))
```

Closing the scope ends the session and stops the agent process and everything it started.

## Providers

Each provider is two layers: a transport (`ClaudeSdk`, `CodexAppServer`) and an `Agent` built on it.

| | Claude | Codex |
|---|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` with its bundled Claude Code | `codex app-server` JSON-RPC, one process per session (via `ChildProcessSpawner`) |
| Steer into the running turn | ✅ lands at the next tool boundary | ✅ `turn/steer` |
| Resume, history | ✅ | ✅ |
| Cost | ✅ reported | 🟡 estimated: tokens × `CodexAgent.CodexPricing` (this release's prices unless you provide others) |
| Spend cap | ✅ native (`maxBudgetUsd`) | 🟡 estimated, enforced by interrupting |
| Usage-limit reset times | ✅ | ✅ |
| Hooks | ✅ also detached (see Reattach) | ✅ also detached, through Codex's command hooks (see below) |
| `disable.askUser` | ✅ | ✅ refused when called, on models that have an asynchronous ask tool (the model may still see it) |
| `disable.subagents` | ✅ | ✅ refused when called (the model may still see the tools) |
| `disable.tools` | ✅ any tool | ✅ any tool: removed where Codex has a switch, otherwise refused when called |
| `mcp` (the machine's MCP servers, by allow/deny globs) | ✅ servers and claude.ai connectors | ✅ servers in Codex's config, checked by a hook (see below) |
| `mcpServers` (a session's own MCP servers) | ✅ HTTP and stdio | ✅ HTTP and stdio, as thread config; names keep to `[A-Za-z0-9_]` |
| Permissions | `ClaudeAgentOptions.permissionMode`: `bypassPermissions` (default), `dontAsk` with `allowedTools`, or `settings` (the settings files' `defaultMode` decides, as for `claude -p`) | `CodexAgentOptions.sandbox`: none by default, or `{ mode: "workspace-write" \| "read-only", mcpServerTools: "approve" }`; approvals always `never` (see `CodexSandbox`) |
| Background tasks off | `ClaudeAgentOptions.backgroundTasks: false`: Bash has no `run_in_background`, so a wait blocks in the turn | ❌ no option |
| Account `status` | ✅ via the SDK's experimental usage API | ✅ |

✅ supported · 🟡 partly or estimated · ❌ not supported. `agent.capabilities` reports the same at runtime, plus the tool's version.

Where Codex differs:

- **Hooks need one more process.** The first `open` with hooks or refused tools, per layer, starts an extra app-server to read the hooks' hashes, and each hook call starts a short-lived process of your runtime (node or bun). `disable.askUser`, `disable.subagents` and `mcp` always refuse tools, so they count. A refusal runs no process unless the tool is called. `open` fails if Codex won't run the hooks, rather than running without them. A detached session pays this even if it never uses hooks: each host has its own layer, so every `open` starts the extra app-server, and all three hooks are registered, so every tool call starts two of those processes.
- **Refused isn't removed.** The model still sees a tool that is only refused, and gets the refusal as its result. That includes subagent tools on current models, whose catalog entry selects them regardless of Codex's switches, and `request_user_input_async`, which the gpt-6 family's catalog entries add and no switch removes. The session's instructions also tell the model not to use either.
- **Costs are estimates.** Codex reports tokens, not cost, so a Codex `Cost` is always `source: "estimated"`: tokens times the prices in `CodexAgent.CodexPricing`, a `Context.Reference` read when a session opens (a detached session's client sends it to the host). It defaults to `CodexAgent.defaultPrices`, OpenAI's standard-tier text-token rates on `CodexAgent.defaultPricesAsOf`, refreshed by `node scripts/codex-pricing.ts` and the `Codex prices` workflow. Long-context, cache-write, batch and fast-tier rates aren't in it. A model the table doesn't have is unpriced: no cost, and `spendCapUsd` is refused. On a plan that doesn't bill per token (a ChatGPT login) the estimate is a budgeting figure, not a bill. Provide your own with `Effect.provideService(CodexAgent.CodexPricing, table)`, or `Layer.succeed(CodexAgent.CodexPricing, table)` beside the agent layer.
- **Names are rewritten more.** Codex makes every character outside `[A-Za-z0-9_]` in a server or tool name `_`, `-` included, and adds a hash to servers whose rewritten names collide; `mcp` globs must use that form (`my_server/list_files`). `open` refuses an `mcpServers` name Codex would rewrite.
- **Tool names.** Hooks see Codex's names (`Bash`, `apply_patch`, `collaborationspawn_agent`); `disable.tools` takes those or the names in `toolSwitches`.
- **Gaps in Codex's hooks.** It runs none for hosted tools such as web search, or for `write_stdin`, and none after a failed `apply_patch`, so `afterTool` doesn't see those. `isError` is only set for shell commands.
- **MCP servers in `config.toml` load anyway.** Codex 0.162.1 ignores every per-session way to turn off an MCP server configured in `config.toml` (`mcp_servers` in thread config or `-c`, even `enabled = false` there), so a Codex session without `mcp` can still call them. Only `enabled = false` in the file itself stops one. ChatGPT apps are turned off (`features.apps`). With `mcp`, every call to an MCP tool is checked, so `mcp: { allow: [] }` is the way to make a Codex session refuse them all; it needs hooks, like `disable.askUser`.
- **Trust is undocumented.** Codex skips hooks it doesn't trust, and effect-agent marks its own as trusted through the undocumented `hooks.state`. Your own hooks keep the trust they have.
- **Hooks turned off.** As on Claude with `disableAllHooks`, turning hooks off in config stops your own hooks, and managed ones still run; a session's `RunOptions.hooks` and `disable` keep working. That takes two more app-servers per `open`. Claude runs a session's hooks under any policy. Codex can't under a managed policy that stops them (`features.hooks` in `managed_config.toml` or `requirements.toml`, or `allow_managed_hooks_only`), so `open` fails when a session needs them, which any `disable.askUser`, `disable.subagents` or `mcp` does. It also fails if `CodexAgent.layer({ config })` would stop them (`features.hooks = false`, or any `hooks` key), because that applies after hooks are checked.

## Platform

The library imports no platform package; `effect` is a peer dependency. Where Effect has a platform service, the library takes it from context: Codex spawns its app-server through `ChildProcessSpawner`, and a session host reads its spec and reports readiness through `Stdio`. Provide `NodeServices.layer` from `@effect/platform-node`, or `BunServices.layer` from `@effect/platform-bun`. Everything else uses Node's built-in modules, which Bun implements; Effect's own Bun platform is built on the same modules. That covers files, the Claude SDK's process, the leftover-process sweep, and unix sockets through `@effect/platform-node-shared`. The test suite runs hosts on both runtimes.

## Sessions

`agent.open(options)` returns an `AgentSession`:

- `send(input)`: start a turn now, or queue it after the running turn.
- `turn(input)`: `send`, then wait for that turn's ending.
- `steer(input)`: deliver into the running turn → `Landed { turnId }`, or `StartedNewTurn` if the turn ended first.
- `interrupt`: stop the running turn (`Interrupted`); the session stays usable.
- `end`: no more input; finish queued work, then exit.
- `subscribe` / `events`: the normalized event stream; every subscription starts with `SessionStarted`.
- `sessionId`, `location` (the transcript file), `pid`.

`RunOptions` covers `cwd`, `env` (`undefined` removes a variable; nesting markers such as `CLAUDECODE` are always removed, and Codex sessions also drop Claude Code's `CLAUDE_CODE_OAUTH_TOKEN`, since Codex hands its environment to every command it runs), `model`, `effort`, `appendSystemPrompt` (added to the default, never replacing it), `disable`, `mcp`, `mcpServers`, `spendCapUsd`, `resume`, `watchdog` and `hooks`. Permissions are off unless the provider layer says otherwise (`ClaudeAgentOptions.permissionMode`, `CodexAgentOptions.sandbox`). Without `mcp`, a session loads no MCP servers but its own `mcpServers`: none of the user's, no claude.ai connectors, no ChatGPT apps (but see Codex's `config.toml` above). `RunSettings` is `RunOptions` without `hooks` as a Schema, for storing options or sending them to another process (durations encode as millis); `settingsOf` drops the hooks.

### MCP servers and connectors

`mcp` lets a session use the MCP servers and claude.ai connectors already set up on the machine, as far as two lists of globs allow. Every call to an MCP tool is checked in the session's own process (for a detached session, its host), before it reaches the server, and refused unless its name matches an `allow` glob and no `deny` glob. That holds with permissions bypassed, in Claude's subagents and in Codex's code mode.

```ts
agent.open({
  cwd,
  mcp: {
    allow: ["claude_ai_Slack/slack_{read,search}_*", "claude_ai_Gmail/{search_threads,get_thread,get_message}", "claude_ai_Granola/{get,search,list}_*", "claude_ai_Notion/notion-{search,fetch}"],
    deny: ["*/*{send,reply,delete,trash}*"]
  }
})
```

- **Names are `server/tool`**: the provider's `mcp__<server>__<tool>`, split at the first `__`. Claude has already replaced every character outside `[A-Za-z0-9_-]` with `_`, so a claude.ai connector's server is `claude_ai_<Name>` (`claude_ai_Slack`, `claude_ai_Google_Calendar`), and a server from your config keeps its name (`fixture`, `my-server`). Codex replaces `-` too (`my_server`; see "Where Codex differs"). Matching is case-sensitive.
- **Globs are `effect/Glob`'s**: `*` and `?` stay within the server or the tool, `{a,b}` is either, `**` is anything. `*` alone matches nothing, since every name has a `/`.
- **A name that could be another server's** (one with another `__` after the first, because a server or tool name contains `__`) must pass under every reading: `mcp__a__b__c` is checked as both `a/b__c` and `a__b/c`.
- **`allow: []`** loads the servers, but nothing can be called.
- **Refused calls reach the model** as the tool's result, with the reason: `This MCP tool call was refused: claude_ai_Gmail/send_message matches mcp.deny pattern */*{send,reply,delete,trash}*`, or `... is not in mcp.allow`. The model may still see refused tools in its tool list.
- **MCP resources are always refused** (Claude's `ReadMcpResourceTool` and its listing tools, which are removed; Codex's `read_mcp_resource` and its listing tools): they name the server in their input, so `allow` can't cover them.
- **Built-in tools are unaffected**; `disable.tools` governs those.
- **Without `mcp`, nothing changes**: no MCP servers and no claude.ai connectors load, as before.
- **On Codex** the check is a hook, so `mcp` costs what `disable.askUser` does, and `open` fails where hooks can't run (a detached session too: its host doesn't retry without them). ChatGPT apps stay off: `mcp` covers the servers in Codex's config.

#### A session's own servers

`mcpServers` adds MCP servers for one session, by name, as a task's own server with a token for that task. HTTP servers take `headers`; stdio servers a `command`, `args` and `env`.

```ts
agent.open({
  cwd,
  mcpServers: { task_tools: { type: "http", url, headers: { Authorization: `Bearer ${taskToken}` } } }
})
```

Without `mcp` they are the only servers, and every tool on them can be called. With `mcp` they load beside the machine's, and `mcp.allow` checks their calls too. A name must be one the provider keeps as written, so a glob can match it: `open` fails for a character outside `[A-Za-z0-9_]` on Codex, or `[A-Za-z0-9_-]` on Claude.

`test/mcp-e2e.test.ts` checks all of this on the real CLIs, against a local MCP server with harmless tools in a throwaway config.

## Events

`SessionStarted`, `TurnStarted`, `MessageLanded`, `MessageDropped`, `UserMessage` (history), `Text`, `ToolCall` (with a one-line `summary`), `ToolResult`, `Retrying` (a retry, not an error), `LimitsUpdated`, `Compacted`, `Heartbeat`, `TurnEnded` (outcome, tokens, cost), and `Other`. Every event carries the provider's original frame in `raw`.

## Endings

A turn ends `Succeeded`, or fails with one of these `Schema` tagged errors (also on `TurnEnded.outcome`):

`AgentFailed`, `UsageLimited { window, resetsAt, overageAvailable }`, `Throttled { retriesLeft }`, `AuthFailed`, `SpendCapReached`, `ContextExhausted`, `ProcessKilled { signal, exitCode }`, `Stalled { idleMs, inTool }`, `Interrupted`.

`open` and `history` fail with `SessionNotFound` for an unknown session; infrastructure failures are `AgentError`. Once a session has ended (`end`, its Scope closed, or its agent process died), its calls fail with `SessionClosed`; `end` itself succeeds if the session ended cleanly and fails with what ended it otherwise.

## Account status

`agent.status` reports `usable`, a `reason` (`unauthenticated`, `usage_limited`, `spend_limited`), limit `windows` (percent used and reset time), and `plan`, without running a turn.

Some windows cap a single model family (Claude's weekly Opus or `model_scoped` caps); those carry `model: Option<string>` (e.g. `Option.some("fable")`, encoded as `null` when absent). A full per-model window doesn't make the account unusable, since other models still run, so check the model you're about to use:

```ts
import { usableFor } from "@jpowersdev/effect-agent"

// false if e.g. the Fable cap is full for a Fable persona
if (usableFor(status, persona.model)) {
  dispatch(task)
}
```

## Process control

Provide a `Launcher` to wrap every agent process: it gets the command and returns the one to run instead. Provide it as a layer, or per session around `open`.

### Recipe: a systemd scope per session

On Linux with a systemd user manager, [`examples/SystemdLauncher.ts`](examples/SystemdLauncher.ts) runs each agent process in its own transient scope (`systemd-run --user --scope`). Copy it into your app. It gives you three things:
- **Everything stops:** stopping the scope at the end of the session kills everything in the cgroup, including commands that cleared their environment.
- **Limits:** resource limits cover the agent and everything it starts.
- **An answer to "was that an OOM kill?"** A turn that ends `ProcessKilled` doesn't say why it died.

```ts
import * as SystemdLauncher from "./SystemdLauncher.ts"

const result = yield* Effect.gen(function*() {
  const systemd = yield* SystemdLauncher.make({
    properties: {
      MemoryMax: "4G",
      TasksMax: "512"
    }
  })
  const session = yield* agent.open({ cwd }).pipe(Effect.provideService(Launcher.Launcher, systemd.launcher))
  return yield* session.turn(prompt).pipe(
    Effect.catchTag("ProcessKilled", (killed) =>
      // OutOfMemory: an error of your own
      Effect.flatMap(systemd.oomKilled, (oom) =>
        Effect.fail(
          oom ?
            new OutOfMemory({
              cause: killed
            }) :
            killed
        )))
  )
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)
```

- **OOM policy:** `oomPolicy: "stop"` (systemd's default) stops the whole scope when the kernel OOM killer strikes, so the turn ends `ProcessKilled`. With `"continue"`, usually only the runaway command dies, and the agent sees it fail and carries on. `oomKilled` reports the kill either way.
- **Slices:** each `make` puts its scopes in a slice of their own, which keeps the OOM count after the scope is gone. All of those slices sit under `effect_agent.slice`, so `systemctl --user set-property effect_agent.slice MemoryMax=16G` caps every agent together.
- **Arguments:** the recipe passes `--expand-environment=no`. Without it, `systemd-run` expands `$VAR` in the command line and silently rewrites any argument (such as a prompt) that contains a `$`.
- **Detached sessions:** for `DetachedAgent`, pass `stopOnEnd: false`. The `Launcher` then wraps the host, so the host, the agent and its commands share one scope, and that scope must outlive the caller.
- **Testing:** `test/systemd-launcher.test.ts` checks the recipe against the real user manager, and skips itself where there is none. Its out-of-memory cases cause real OOM kills, so they run only with `EFFECT_AGENT_OOM_TESTS=1`. `node scripts/live-systemd.ts` runs it with Claude Code: a session under limits, and an out-of-memory command under each policy.

Without one, processes are still stopped when the session ends, and as soon as an agent process dies its leftovers are swept. Both Claude Code and Codex start each command in its own session, so a process-group kill alone misses them. Instead, each agent process gets a unique `EFFECT_AGENT_PROCESS` variable, and every live process carrying it is stopped (Linux, via `/proc`). A cgroup launcher is still the stronger guarantee: it also covers commands that clear their environment.

`watchdog: { idle, toolIdle, grace }` ends a quiet turn `Stalled`. Heartbeats count as activity, so a model that is thinking is not idle; `toolIdle` applies while a tool call runs.

## Reattach

`DetachedAgent.layer` runs each session in its own host process, so it survives the process that opened it (e.g. a runner restarting to deploy). Another process can reattach by id, catch up on what it missed, and keep controlling it.

The host process runs an entry point in *your* app; the library ships no executable:

```ts
// host.ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { SessionHost } from "@jpowersdev/effect-agent/host"
import { Effect } from "effect"

NodeRuntime.runMain(SessionHost.run.pipe(Effect.provide(NodeServices.layer)))
// Bun: BunRuntime.runMain(SessionHost.run.pipe(Effect.provide(BunServices.layer)))
```

```ts
import { AgentHosts, DetachedAgent } from "@jpowersdev/effect-agent/host"

const layer = DetachedAgent.layer({
  provider: "claude",
  claude: {
    model
  },
  host: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./host.ts", import.meta.url))]
  },
  onScopeClose: "detach"
}).pipe(Layer.provide(NodeServices.layer)) // status and history run locally

// before the restart: persist the session id and the MessageId
const session = yield* (yield* Agent).open({ cwd }) // Agent works unchanged; capabilities.reattach is true
const messageId = yield* session.send("Fix the failing test")

// after it
const session = yield* (yield* AgentHosts).attach(sessionId) // SessionNotFound if no live host
yield* session.subscribeFrom(lastPersistedSeq + 1).pipe(
  Stream.runForEach(persist),
  Effect.forkScoped
)
const result = yield* session.awaitMessage(messageId) // even if the turn ended while nobody was attached
```

`host` is just a command, so the runtime (Node or Bun, for the host and the client independently) and whether you bundle are up to you: if you bundle your app, make `host.ts` a second entry point, as you would a worker. Module loading dominates host startup, so a bundled entry starts noticeably faster (about 0.1 s versus 0.25 s here).

A `DetachedSession` is an `AgentSession` plus `subscribeFrom(seq)` (a stream of `{ seq, event }` from any seq, then live), `lastSeq`, `awaitTurn` / `awaitMessage` (by turn id, or by the `MessageId` that `send` returned; the host keeps the last 10 000 turns' endings in memory and finds older ones in the events file, so with `persistEvents: false` those fail), `detach` and `stop`. `subscribe`/`events` are live from now, as for a local session. `onScopeClose` is `"stop"` by default (closing the scope ends the session, as locally); set `"detach"` to leave it running. `AgentHosts.list` lists live hosts. `status` and `history` run locally.

Each host serves one session over effect/rpc on a unix socket in `dir` (default `$XDG_RUNTIME_DIR/effect-agent`, kept at mode 0700), next to a manifest `<sessionId>.json`, a log `<sessionId>.log` and the events file `<sessionId>.events.jsonl`. It exits when the session ends (`end`, `stop`, the agent dying, SIGTERM), lingering a few seconds so clients get the last events, and when no client has been attached to an idle session for `orphanTimeout` (default 30 minutes). Stale manifests (dead pid) are removed by `list` and `attach`.

**The event log.** The host appends every `{ seq, event }` to `<sessionId>.events.jsonl` (mode 0600; one Schema-encoded JSON line each, seq 0, 1, 2, ...) before any subscriber sees it. The last `maxEvents` (default 50 000) are also kept in memory as a cache: `subscribeFrom(seq)` older than the cache reads the missing range from the file, then carries on from the cache and live events with no gap or duplicate. `awaitTurn`/`awaitMessage` answer from memory for the last 10 000 turns and from the file for older ones, so with `persistEvents: false` an older turn fails with `AgentError`. `subscribeFrom` fails with `EventsTrimmed` only when `seq` is older than the cache and the file can't serve it: `persistEvents: false`, or the file is missing or unreadable. A resumed session (`resume`) numbers on from the file its earlier host left.

When the host exits, the socket and manifest go, but the events file is kept for `retainEvents` (default 24 hours, counted from when the host exited). `AgentHosts.events(sessionId, fromSeq?)` reads it whether or not the host is still running: from a live host it follows live events until the session ends; otherwise it reads the file to its end. Either way it ends as a live subscription would. When the session ends, the host writes a last line recording how (`{"ended":null}`, or the encoded `AgentError`), so `events` completes after a clean end and fails with the session's error otherwise. A file without that line belongs to a host that was SIGKILLed mid-session. It is known to be incomplete (it stops where the host did), and reading it completes at its end. `events` fails with `SessionNotFound` if there's neither a host nor a file. Expired files are pruned by `list`, `attach`, `events` and host startup.

```ts
// after the runner restarts, even if the session ended meanwhile
yield* (yield* AgentHosts).events(sessionId, lastPersistedSeq + 1).pipe(Stream.runForEach(persist))
```

**Hooks.** `RunOptions.hooks` work on detached sessions (`capabilities.hooks` says whether the provider has them). The functions stay in your process. Every detached session registers all three hook kinds, whether or not `open` passed any, and the host forwards each call (Schema-encoded input) to an attached client that has that hook, then adds that client's answer. So any client can supply any hook at any time, through `open` or `attach`:

```ts
const session = yield* (yield* AgentHosts).open({ cwd, hooks: { beforeTool } }, { hookTimeout: "2 seconds" })
// after a restart, answer them again:
const session = yield* (yield* AgentHosts).attach(sessionId, {
  hooks: {
    beforeTool
  }
})
```

- **Hooks stopped by policy.** Where a managed policy stops Codex running them, a session whose `open` passed none, and whose `disable` doesn't need them, opens without them, `session.info` reports `capabilities.hooks: false`, and `attach` with hooks fails.
- **Who answers.** Of the attached clients that have that hook, the one that attached most recently. When it detaches, the one before it answers again. A client attached without hooks never answers.
- **No answer adds nothing.** With no such client attached, the host answers "nothing" at once, in-process. On Claude that makes an unanswered hook cost next to nothing per tool call. On Codex the hook is a command, so it still starts a process and makes a socket round trip to the host: about 20 ms on Node, twice per tool call, whether or not anyone answers. A client that doesn't answer within `hookTimeout` (default 5 seconds; set on the layer, or per session in `open`/`attach`) adds nothing either, and the host logs the timeout, so the agent never waits longer. A hook that fails or defects adds nothing, as locally.
- **Refusals.** A client's `beforeTool` can refuse the call (`refuseTool`), and the host refuses it in the session; `session.info` reports `capabilities.refuseTool`. A host before 0.7.0 doesn't know refusals: it adds the reason as context, and the tool runs.
- **Reconnects.** A call still waiting when its client's connection drops is delivered again once the client reconnects, until its timeout. The client runs each call once.

**Reconnecting.** When the connection to a host drops (other than by `detach`/`stop` or the session ending), the client re-dials it on `reconnect`, by default an exponential backoff from 100 ms, capped at 2 s between attempts, giving up after 30 s (`DetachedAgent.defaultReconnect`). It's transparent: subscriptions resume from the last seq they delivered, and calls in flight are retried. `send`, `steer`, `turn` and `interrupt` carry a client-generated request id. The host remembers the last 1 000 results by id and answers a repeat with the original result, so a retried `send` lands once, a retried `turn` waits on the original turn, and a retried `interrupt` can't hit the turn after it. Calls fail with `ConnectionLost` when the schedule gives up, or at once if the host is gone (manifest removed or pid dead). `reconnect: false` fails on the first drop. After `detach`, calls fail with `SessionClosed`.

**Process supervisors:** hosts are started detached, so they outlive the process that opened them, but whatever supervises that process may still stop them. The `Launcher` applies to the host command (so the host and the agent it runs share whatever it sets up); use it to place hosts outside the supervisor's reach. For example:

- **systemd:** with the default `KillMode=control-group`, stopping or restarting the runner's unit kills every process in its cgroup, hosts included. Wrap hosts in their own scope with the systemd recipe above (`stopOnEnd: false`).
- **launchd:** a job's process group is killed when it exits unless `AbandonProcessGroup` is set.
- **Containers:** everything in a container stops with it; hosts need to run somewhere that outlives the runner's container.

**A SIGKILLed host** (`kill -9`, the OOM killer) can't run any cleanup. Its agent process, and the commands that agent started, may be left running: Node has no parent-death signal, and the host is the only thing that would have stopped them. Stopping them is up to you, since they are your process tree. Either run hosts under a cgroup `Launcher` (a systemd scope, as above), so that stopping the scope stops the host, the agent and its commands together, or have your own supervisor reap them. The host's socket and manifest stay behind until `list` or `attach` notices the dead pid. Its events file has no ending line (see above).

`node scripts/live-reattach.ts` checks this end to end with the real CLIs: process A starts a slow turn and exits mid-turn; process B attaches, catches up, and drops its connection mid-turn twice: once while A's turn runs, once during a `turn()` call. Both turns' results still arrive, the subscription sees every event exactly once, and it matches the events file read back with `AgentHosts.events` after the host has exited.

## Testing

Swap the transport for a replay of a recorded session, so the real event mapping runs with no process:

```ts
ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile("session.jsonl")))
CodexAgent.layer().pipe(Layer.provide(CodexReplay.layer(recordingText)))
```

Record with the transports' `record` option. A Codex connection truncates the file and records until it closes; one that starts while another is recording (a `status` call during a session, say) isn't recorded. A Codex replay runs no commands, so it never calls your hooks; test those by calling them directly, or with a real `codex`. Claude recordings also capture SDK hook calls (the event, the CLI's input, what the hooks returned, and where in the frame stream they came). `ClaudeReplay` calls the session's own hooks at those points and reports what they answered to `onHook`. `test/conformance.test.ts` runs the same programs against both providers.

```sh
pnpm typecheck && pnpm test
node scripts/live-claude.ts   # live, against the real CLIs (small cost)
node scripts/live-codex.ts
```

To take a new Claude Code or Codex release (protocol check, SDK type diff, fixture refresh), follow [UPGRADING.md](UPGRADING.md).

`EFFECT_AGENT_TEST_HOST=bun` runs every session host (in the tests and `scripts/live-reattach.ts`) under Bun instead of Node.

## Building

The package is built like Effect's: `tsc -p tsconfig.build.json` emits one ESM module per source file into `dist/` (with `.d.ts` files and source maps; `.ts` imports are rewritten to `.js`), and Babel adds pure-call annotations so bundlers can tree-shake. Nothing is bundled and nothing runs on import (`sideEffects: false`). The package ships `src/` too, for go-to-source.

```sh
pnpm build   # build:tsc, build:babel
```

## License

MIT
