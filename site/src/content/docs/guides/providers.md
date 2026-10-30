---
title: "Providers"
description: "Claude Code and Codex: their transports and what each supports."
sidebar:
  order: 1
---

Each provider is two layers: a transport (`ClaudeSdk`, `CodexAppServer`) and an `Agent` built on it.

| | Claude | Codex |
|---|---|---|
| Transport | `@anthropic-ai/claude-agent-sdk` with its bundled Claude Code | `codex app-server` JSON-RPC, one process per session (via `ChildProcessSpawner`) |
| Steer into the running turn | ✅ lands at the next tool boundary | ✅ `turn/steer` |
| Resume, history | ✅ | ✅ |
| Cost | ✅ reported | 🟡 estimated from a `pricing` table you supply |
| Spend cap | ✅ native (`maxBudgetUsd`) | 🟡 estimated, enforced by interrupting |
| Usage-limit reset times | ✅ | ✅ |
| Hooks | ✅ also remote (see [Reattach](../reattach/)) | ❌ `open` fails if hooks are set |
| `disable.subagents` | ✅ | ❌ Codex can't turn them off per thread |
| `disable.tools` | ✅ any tool | 🟡 only some tools (others fail `open`) |
| Account `status` | ✅ via the SDK's experimental usage API | ✅ |

✅ supported · 🟡 partly or estimated · ❌ not supported. `agent.capabilities` reports the same at runtime, plus the tool's version.
