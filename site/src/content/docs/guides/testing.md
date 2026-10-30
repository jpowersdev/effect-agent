---
title: "Testing"
description: "Replay recorded sessions with no process; run the suite and the live checks."
sidebar:
  order: 7
---

Swap the transport for a replay of a recorded session, so the real event mapping runs with no process:

```ts
ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile("session.jsonl")))
CodexAgent.layer().pipe(Layer.provide(CodexReplay.layer(recordingText)))
```

Record with the transports' `record` option. A Codex connection truncates the file and records until it closes; one that starts while another is recording (a `status` call during a session, say) isn't recorded. Claude recordings also capture SDK hook calls (the event, the CLI's input, what the hooks returned, and where in the frame stream they came). `ClaudeReplay` calls the session's own hooks at those points and reports what they answered to `onHook`. `test/conformance.test.ts` runs the same programs against both providers.

```sh
pnpm typecheck && pnpm test
node scripts/live-claude.ts   # live, against the real CLIs (small cost)
node scripts/live-codex.ts
```

To take a new Claude Code or Codex release (protocol check, SDK type diff, fixture refresh), follow [UPGRADING.md](https://github.com/jpowersdev/effect-agent/blob/main/UPGRADING.md).

`EFFECT_AGENT_TEST_HOST=bun` runs every session host (in the tests and `scripts/live-reattach.ts`) under Bun instead of Node.

## Building

The package is built like Effect's: `tsc -p tsconfig.build.json` emits one ESM module per source file into `dist/` (with `.d.ts` files and source maps; `.ts` imports are rewritten to `.js`), and Babel adds pure-call annotations so bundlers can tree-shake. Nothing is bundled and nothing runs on import (`sideEffects: false`). The package ships `src/` too, for go-to-source.

```sh
pnpm build   # build:tsc, build:babel
```
