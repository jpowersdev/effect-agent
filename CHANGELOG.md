# @jpowersdev/effect-agent

## 0.4.0

### Minor Changes

- [#11](https://github.com/jpowersdev/effect-agent/pull/11) [`974dc1c`](https://github.com/jpowersdev/effect-agent/commit/974dc1ce786ad12961d268492369daa6c2702df2) Thanks [@jpowersdev](https://github.com/jpowersdev)! - Codex now has hooks, and enforces `disable`, as Claude does.
  
  - `RunOptions.hooks` work on Codex, locally and on detached sessions, through its command hooks. `capabilities.hooks` is `true`. The first `open` with hooks or refused tools, per layer, starts an extra `codex app-server`, and each hook call starts a short-lived process of your runtime. With `features.hooks` off in Codex's config they still run and the user's hooks stay off, as on Claude with `disableAllHooks`. `open` fails if a managed policy stops them, or if `CodexAgent.layer`'s `config` would (`features.hooks` false, or any `hooks` key); a detached session whose `open` passed no hooks then opens without them, and `attach` with hooks fails.
  - `disable.subagents` is enforced: a call to a multi-agent tool of either generation is refused. Codex's switches are set too, but current models select the tools regardless, so the model may still see them. `capabilities.disable.subagents` is `true`.
  - `disable.tools` takes any tool name. A tool with no switch, such as `apply_patch`, used to fail `open`; it's now refused when called. `capabilities.disable.tools` is `"any"`.
  - `CodexAppServer.connect` takes `args`, added after the layer's.

## 0.3.0

### Minor Changes

- [#9](https://github.com/jpowersdev/effect-agent/pull/9) [`2721a44`](https://github.com/jpowersdev/effect-agent/commit/2721a44e4def13a96de53159d9288e2379484c0d) Thanks [@jpowersdev](https://github.com/jpowersdev)! - Split the core into one module per concept, matching the vocabulary on the getting-started page: `AgentSession` (`AgentSession`, `SessionId` and the session errors), `Message` (`MessageId`, `Input`, `SteerOutcome`), `Turn` (`TurnId`, `TurnSucceeded`, the `TurnFailure` errors, `TurnOutcome`), `Usage` (`TokenUsage`, `Cost`) and `UsageLimit` (`LimitWindow`, `LimitWindowStatus`). `Domain` is gone, and `AgentError` now holds only `AgentError`. Everything is still exported flat from `@jpowersdev/effect-agent`, so imports don't change, except that `DurationInput` and `EnvOverrides` are no longer exported: they only carried `RunSettings` and `HostSpec` across a process boundary.

- [#9](https://github.com/jpowersdev/effect-agent/pull/9) [`6cae7de`](https://github.com/jpowersdev/effect-agent/commit/6cae7de8ca6fad13177653554de8be1eb4e2f7db) Thanks [@jpowersdev](https://github.com/jpowersdev)! - Rename `RemoteAgent` to `DetachedAgent`. "Remote" read as hosting on another machine; the sessions are local processes detached from the one that opened them, which `onScopeClose: "detach"` already called them. `RemoteAgentOptions` is now `DetachedAgentOptions` and `RemoteSession` is now `DetachedSession`. The behavior is unchanged, and there is no alias for the old names: replace `RemoteAgent` with `DetachedAgent` in imports from `@jpowersdev/effect-agent/host`.

## 0.2.0

### Minor Changes

- [#5](https://github.com/jpowersdev/effect-agent/pull/5) [`903a728`](https://github.com/jpowersdev/effect-agent/commit/903a72887779dd79bad39c7678e497bf93d2706c) Thanks [@jpowersdev](https://github.com/jpowersdev)! - Fixes from a review of the layering, plus one session runtime for both providers.
  
  Fixes:
  
  - A host run under `NodeRuntime.runMain` now closes its session on SIGTERM. Before, the agent process could outlive the host, and the events file got no end line.
  - A Codex session no longer hangs when app-server writes a line that isn't a JSON-RPC object, or a response with `error: null`.
  - A Codex `status` or `history` call during a recorded session no longer wipes the recording.
  - A bug while reading Claude Code frames now ends the session with an error and stops the CLI. Before, it looked like a clean exit and left the CLI running.
  - A Claude stall whose interrupt hangs is still killed after the grace period.
  - A stalled Codex `turn/start` no longer blocks `send`, `steer` and `interrupt`; every app-server request has a timeout.
  - Claude hooks run with the session's context (logger, tracer), not under the span of the `open` that started the session.
  - Long sessions no longer keep every turn's bookkeeping. A host still answers `awaitTurn` and `awaitMessage` for any turn, from its events file once a turn is older than the last 10 000 (with `persistEvents: false`, an older one fails at once).
  - The Codex session's shutdown is reliable: app-server dying, the watchdog's kill, an unanswered `turn/start`, closing the scope and concurrent `end` calls no longer leave a caller waiting forever, report a clean end after a failure, or start a turn alongside another.
  - `ProcessTree.kill` stops processes started while it is stopping their parents, and sends each process one SIGTERM.
  - A remote session that ended keeps failing with `SessionClosed` (and `end` keeps succeeding) after its host exits, instead of `ConnectionLost`.
  
  Changes:
  
  - `SessionClosed` and `ConnectionLost` errors. Calls on a session that has ended, or a detached remote handle, fail with `SessionClosed`. A remote client that loses its host fails with `ConnectionLost`. Before, both were `AgentError`. `AgentSession` calls fail with `SessionError` (`AgentError | SessionClosed | ConnectionLost`).
  - `end` behaves the same for both providers: on a session that died, it fails with what ended it. Codex used to succeed.
  - Both providers treat the same environment variables as nesting markers. Codex no longer strips every `CLAUDE_CODE_*` variable, only the markers and Claude Code's login token (`CLAUDE_CODE_OAUTH_TOKEN`), which it would otherwise pass to every command it runs.
  - `RunSettings` is the Schema for `RunOptions` without hooks. `HostSpec.RunSpec`, `DurationSpec` and `EnvSpec` are now that Schema and its parts, and `HostSpec.fromRunOptions`/`toRunOptions` are gone (use `settingsOf`).
  - `Watchdog.supervise`, `Launcher.prepareWithFallback`, `ProcessTree.isAlive` and `ProcessTree.signal` are new.
  - `CodexEvents` and `Host` are no longer exported from the barrels. They were internal and exported only for the tests.
  - `CodexAppServer`'s `record` option no longer needs a `FileSystem` service.
  - A `RemoteAgent` client loads only the provider it uses.
  - Both providers give `status` and requests to app-server 60 seconds to answer (Claude's `status` had 30).
  - `RunSettings` encodes an infinite duration as `"Infinity"`, so it survives JSON.
  - Hosts and clients should run the same version: a host's RPC errors now include `SessionClosed` and `ConnectionLost`, which a 0.1 client can't decode. Stop hosts started by 0.1 before upgrading clients, or let them end.

## 0.1.1

### Patch Changes

- [`bec7019`](https://github.com/jpowersdev/effect-agent/commit/bec70196da80de9658fb5b6867ed60623a659b35) Thanks [@jpowersdev](https://github.com/jpowersdev)! - `RemoteAgent`: a call or subscription that writes to its host connection just as it drops now reconnects and resumes, instead of dying with a `SocketError`.
- Remote hooks: a hook call that times out is always decided, and logged, by the host. The client now stops a hook still running a second after `hookTimeout`, not at the same moment, so a busy host can no longer take the client's "nothing" as its answer and skip logging the timeout.
