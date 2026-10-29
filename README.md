# effect-agent

Effect-native control of coding-agent CLIs (Claude Code, Codex): live sessions with steering, resumable sessions, one normalized event stream, and typed endings.

> Status: early development. API will change.

```ts
import { Effect, Layer } from "effect"
import { Agent } from "effect-agent"
import { ClaudeAgent, ClaudeSdk } from "effect-agent/claude"

const program = Effect.scoped(
  Effect.gen(function* () {
    const agent = yield* Agent
    const session = yield* agent.open({ cwd, model, appendSystemPrompt, spendCapUsd: 5 })
    const result = yield* session.turn("Fix the failing test")  // fails with UsageLimited | AuthFailed | ...
  }),
).pipe(Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))))
```

- **Claude** uses `@anthropic-ai/claude-agent-sdk` and its bundled Claude Code binary.
- **Codex** speaks the `codex app-server` JSON-RPC protocol directly (one app-server process per session).
- Tests can swap the transport for a replay of a recorded session (`ClaudeReplay.layer`, `CodexReplay.layer`), so the real event mapping runs without a process.
