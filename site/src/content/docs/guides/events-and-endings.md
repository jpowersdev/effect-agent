---
title: "Events and endings"
description: "The normalized event stream, and the typed ways a turn ends."
sidebar:
  order: 3
---

## Events

`SessionStarted`, `TurnStarted`, `MessageLanded`, `MessageDropped`, `UserMessage` (history), `Text`, `ToolCall` (with a one-line `summary`), `ToolResult`, `Retrying` (a retry, not an error), `LimitsUpdated`, `Compacted`, `Heartbeat`, `TurnEnded` (outcome, tokens, cost), and `Other`. Every event carries the provider's original frame in `raw`.

## Endings

A turn ends `Succeeded`, or fails with one of these `Schema` tagged errors (also on `TurnEnded.outcome`):

`AgentFailed`, `UsageLimited { window, resetsAt, overageAvailable }`, `Throttled { retriesLeft }`, `AuthFailed`, `SpendCapReached`, `ContextExhausted`, `ProcessKilled { signal, exitCode }`, `Stalled { idleMs, inTool }`, `Interrupted`.

`open` and `history` fail with `SessionNotFound` for an unknown session; infrastructure failures are `AgentError`.
