---
title: "Account status"
description: "Check usage limits and plan without running a turn."
sidebar:
  order: 4
---

`agent.status` reports `usable`, a `reason` (`unauthenticated`, `usage_limited`, `spend_limited`), limit `windows` (percent used and reset time), and `plan`, without running a turn.

Some windows cap a single model family (Claude's weekly Opus or `model_scoped` caps); those carry `model: Option<string>` (e.g. `Option.some("fable")`, encoded as `null` when absent). A full per-model window doesn't make the account unusable, since other models still run, so check the model you're about to use:

```ts
import { usableFor } from "@jpowersdev/effect-agent"

if (usableFor(status, persona.model)) dispatch(task)  // false if e.g. the Fable cap is full for a Fable persona
```
