---
title: "Sessions"
description: "Open a session; send, steer, interrupt and end it."
sidebar:
  order: 2
---

`agent.open(options)` returns an `AgentSession`:

- `send(input)`: start a turn now, or queue it after the running turn.
- `turn(input)`: `send`, then wait for that turn's ending.
- `steer(input)`: deliver into the running turn → `Landed { turnId }`, or `StartedNewTurn` if the turn ended first.
- `interrupt`: stop the running turn (`Interrupted`); the session stays usable.
- `end`: no more input; finish queued work, then exit.
- `subscribe` / `events`: the normalized event stream; every subscription starts with `SessionStarted`.
- `sessionId`, `location` (the transcript file), `pid`.

`RunOptions` covers `cwd`, `env` (`undefined` removes a variable; nesting markers such as `CLAUDECODE` are always removed), `model`, `effort`, `appendSystemPrompt` (added to the default, never replacing it), `disable`, `spendCapUsd`, `resume`, `watchdog` and `hooks`. Permissions are always off, and MCP servers are never inherited (no user servers, claude.ai connectors or ChatGPT apps). `RunSettings` is `RunOptions` without `hooks` as a Schema, for storing options or sending them to another process (durations encode as millis); `settingsOf` drops the hooks.
