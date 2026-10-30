---
"@jpowersdev/effect-agent": minor
---

Fixes from a review of the layering, plus one session runtime for both providers.

Fixes:

- A host run under `NodeRuntime.runMain` now closes its session on SIGTERM. Before, the agent process could outlive the host, and the events file got no end line.
- A Codex session no longer hangs when app-server writes a line that isn't a JSON-RPC object, or a response with `error: null`.
- A Codex `status` or `history` call during a recorded session no longer wipes the recording.
- A bug while reading Claude Code frames now ends the session with an error and stops the CLI. Before, it looked like a clean exit and left the CLI running.
- A Claude stall whose interrupt hangs is still killed after the grace period.
- A stalled Codex `turn/start` no longer blocks `send`, `steer` and `interrupt`; every app-server request has a timeout.
- Claude hooks run with the session's context (logger, tracer).
- Long sessions no longer keep every turn's bookkeeping.

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
