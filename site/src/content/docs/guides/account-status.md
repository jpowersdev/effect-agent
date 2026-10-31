---
title: "Account status"
description: "Check sign-in, usage limits and plan before you start work."
sidebar:
  order: 4
---

`agent.status()` reports whether the account can run a turn right now. It doesn't start
a session.

## Check before starting work

```ts
const status = yield* agent.status()

if (!status.usable) {
  // "unauthenticated", "usage_limited" or "spend_limited"
  return yield* Effect.log(`Skipping: ${status.reason}`)
}
```

## Find out when a limit resets

Each limit window has how much is used and when it resets.

```ts
const resets = status.windows
  .filter((window) => (window.usedPercent ?? 0) >= 100)
  .map((window) => window.resetsAt)
// [DateTime.Utc] for a full five-hour window, say
```

## Check a specific model

Some windows cap one model family, such as Fable, and a full one doesn't make the
account unusable: other models still run. `usableFor` checks the model you're about to
use.

```ts
import { usableFor } from "@jpowersdev/effect-agent"

if (usableFor(status, "claude-fable-5-1")) {
  yield* dispatch(task)
}
```

## Check another account

Pass the environment that points the CLI at it.

```ts
yield* agent.status({
  env: {
    CLAUDE_CONFIG_DIR: "/home/me/.claude-work"
  }
})
yield* agent.status({
  env: {
    CODEX_HOME: "/home/me/.codex-work"
  }
})
```
