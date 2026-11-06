# @jpowersdev/effect-agent

## 0.7.0

### Minor Changes

- [#18](https://github.com/jpowersdev/effect-agent/pull/18) [`f26f2e7`](https://github.com/jpowersdev/effect-agent/commit/f26f2e773dd45712e91ad6b8036c13f57c678b38) Thanks [@jpowersdev](https://github.com/jpowersdev)! - `Hooks.beforeTool` can refuse a tool call: return `refuseTool(reason)`, and the tool doesn't run, and the model gets the reason as its result.
  
  ```ts
  agent.open({
    cwd,
    hooks: {
      beforeTool: () => Ref.get(paused).pipe(Effect.map((on) => (on ? refuseTool("The board is paused; stop here.") : Option.none())))
    }
  })
  ```
  
  - **It holds with permissions bypassed**, as every session runs, for built-in tools and MCP tools alike: Claude's Bash, Write and the rest, Codex's commands and `apply_patch`. On Claude it is PreToolUse's deny; on Codex, the same deny from the hook relay `beforeTool` already went through, so it costs nothing more.
  - **It fails open**, as hooks do: a hook that fails or times out, or on a detached session has no client to answer it, refuses nothing.
  - **It stops a call before it starts.** A command already running, in the background too, runs on.
  - **Detached sessions** carry the refusal from the client to the host. `capabilities.refuseTool` says whether a session can refuse. A host from a release before 0.7.0 can't: it takes the reason as text to add, and the tool runs.
  - `BeforeToolResult`, `ToolRefusal` and `isToolRefusal` are exported with it. Code whose `beforeTool` returns an `Option` is unchanged.

## 0.6.0

### Minor Changes

- [#16](https://github.com/jpowersdev/effect-agent/pull/16) [`154c259`](https://github.com/jpowersdev/effect-agent/commit/154c25995aa4cccaaa83656a3657fc0d2a40895a) Thanks [@jpowersdev](https://github.com/jpowersdev)! - `RunOptions.mcp` lets a session use the MCP servers and claude.ai connectors already set up on the machine, limited by globs:
  
  ```ts
  agent.open({
    cwd,
    mcp: {
      allow: ["claude_ai_Slack/slack_{read,search}_*", "claude_ai_Notion/notion-{search,fetch}"],
      deny: ["*/*{send,reply,delete,trash}*"]
    }
  })
  ```
  
  Without `mcp`, nothing changes: a session loads no MCP servers, no claude.ai connectors and no ChatGPT apps, as before.
  
  With it, the session loads its provider's own MCP config (on Claude, the account's claude.ai connectors too), and every call to an MCP tool is checked in the session's own process, before it reaches the server: for a detached session, that's its host. A call is refused unless its name matches an `allow` glob and no `deny` glob, and the model gets the reason as the tool's result ("is not in mcp.allow", or "matches mcp.deny pattern …"). The check holds with permissions bypassed, as every session runs, and covers Claude's subagents and Codex's code mode.
  
  - **Names are `server/tool`**: the provider's `mcp__<server>__<tool>`, split at the first `__`, with every character outside `[A-Za-z0-9_-]` already `_`. A claude.ai connector's server is `claude_ai_<Name>`, as `claude_ai_Slack` or `claude_ai_Google_Calendar`. A name with another `__`, which could belong to another server, must pass under every reading.
  - **Globs are `effect/Glob`'s**: `*` stays within the server or the tool, and `{a,b}` is either. Matching is case-sensitive.
  - **`allow: []`** loads the servers, but nothing can be called.
  - **MCP resources are always refused**: Claude's `ReadMcpResourceTool` and its listing tools are removed, and Codex's `read_mcp_resource` and its listing tools are refused. They name the server in their input, so `allow` can't cover them.
  - **Built-in tools are unaffected**: `disable.tools` still governs them. The model may still see a refused MCP tool.
  - **On Codex** the check is a hook, so `mcp` costs what `disable.askUser` does: the first `open` per layer starts an extra `codex app-server`, and each MCP call starts a short-lived process of your runtime. `open` fails where hooks can't run, and a detached session's host doesn't retry without them. claude.ai connectors are Claude's, and ChatGPT apps stay off.
  
  Codex 0.162.1 still loads the MCP servers in its `config.toml` in a session without `mcp`. It ignores `mcp_servers` in thread config and in `-c` flags, even `enabled = false` there, so the `mcp_servers: {}` that effect-agent has always set never turned them off. This release doesn't change that, and the docs no longer claim otherwise. On Codex, `mcp: { allow: [] }` refuses every MCP call.

## 0.5.0

### Minor Changes

- [#14](https://github.com/jpowersdev/effect-agent/pull/14) [`b36da0b`](https://github.com/jpowersdev/effect-agent/commit/b36da0b6f8b9b799646060e1babc11d711212b4b) Thanks [@jpowersdev](https://github.com/jpowersdev)! - `disable.askUser` now stops Codex's asynchronous ask-the-user tools, not just `request_user_input`.
  
  On the gpt-6 family, Codex's catalog offers `request_user_input_async`. It returned `{"accepted":true}` and the turn carried on, so the question went nowhere, and it reached `Text` as if the agent had said it. No Codex switch removes it, so a call is now refused, and the session's instructions tell the model not to ask. The model still sees the tool. Its sibling `send_message_to_user_async`, which Codex offers only with a feature on, is switched off and refused too.
  
  This makes `disable.askUser` depend on hooks on Codex, as `disable.subagents` already does:
  
  - The first `open` per layer starts an extra `codex app-server`, about 250 ms here. A refusal runs no process unless the tool is called.
  - `open` now fails where a managed policy stops hooks, or where `CodexAgent.layer({ config })` would, for a session that sets `disable.askUser`. That includes a detached session, whose host otherwise opens without hooks. A session that can't accept this has to leave `askUser` unset, and the model may then ask questions that go nowhere.

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
