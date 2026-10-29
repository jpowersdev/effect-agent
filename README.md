# effect-agent

Effect-native control of coding-agent CLIs (Claude Code, Codex): live sessions with steering, resumable sessions, one normalized event stream, and typed endings.

> Status: early development. API will change.

```ts
import { Agent } from "effect-agent"
import * as ClaudeAgent from "effect-agent/claude"

const program = Effect.scoped(
  Effect.gen(function* () {
    const agent = yield* Agent
    const session = yield* agent.open({ cwd, model, appendSystemPrompt, spendCapUsd: 5 })
    const result = yield* session.turn("Fix the failing test")  // fails with UsageLimited | AuthFailed | ...
  }),
).pipe(Effect.provide(ClaudeAgent.layer()))
```

- **Claude** uses `@anthropic-ai/claude-agent-sdk` and its bundled Claude Code binary.
- **Codex** speaks the `codex app-server` JSON-RPC protocol directly (one app-server process per session).
