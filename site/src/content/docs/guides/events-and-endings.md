---
title: "Events and endings"
description: "Follow a turn as it runs, store what happened, and handle the ways it fails."
sidebar:
  order: 3
---

Both providers emit the same events, and a turn ends either with its result or with one
of a fixed set of errors.

## Show progress

Subscribe before you send, so the stream has every event of the turn. `summary` is a
one-line description of a tool call, such as the shell command.

```ts
const events = yield* session.subscribe

yield* events.pipe(
  Stream.runForEach((event) => {
    switch (event._tag) {
      case "Text":
        return Effect.log(event.text)
      case "ToolCall":
        return Effect.log(`$ ${event.summary}`)
      case "TurnEnded":
        return Effect.log(event.outcome._tag, event.cost)
      default:
        return Effect.void
    }
  }),
  Effect.forkScoped
)

yield* session.send("Run the tests")
```

`session.events` is the same stream, but it subscribes when it starts running. Every
event is listed in the [API reference](../../api/core/agentevent/).

## Store a transcript

Events are `Schema` values, so they encode to JSON and decode back. Each keeps the
provider's original frame in `raw`.

```ts
const encode = Schema.encodeEffect(Schema.fromJsonString(AgentEvent))

yield* events.pipe(
  Stream.mapEffect((event) => encode(event)),
  Stream.runForEach((line) => appendLine("transcript.jsonl", line)),
  Effect.forkScoped
)
```

## Retry after a usage limit

`UsageLimited` says which window ran out and when it resets.

```ts
yield* session.turn(task.prompt).pipe(
  Effect.catchTag("UsageLimited", (e) =>
    queue.retry(task, {
      after: e.resetsAt
    }))
)
```

To check before starting instead, see [Account status](../account-status/).

## Nudge a stalled turn

With a [watchdog](../process-control/#catch-a-stuck-turn), a turn that goes quiet for
too long fails with `Stalled`. The session is still open.

```ts
yield* session.turn(prompt).pipe(
  Effect.catchTag("Stalled", () => session.turn("You seem stuck. Where are you?"))
)
```

## Stop at a budget

```ts
yield* session.turn(prompt).pipe(
  Effect.catchTag("SpendCapReached", (e) => Effect.log(`Stopped at $${e.spentUsd} of $${e.capUsd}`))
)
```

## Record how turns ended

`TurnEnded.outcome` is the same value `turn` succeeds or fails with. The errors are
`Schema` tagged errors, so an outcome can be stored and decoded later.

```ts
const outcomes = events.pipe(
  Stream.filter((event) => event._tag === "TurnEnded"),
  Stream.map((ended) => ({
    turnId: ended.turnId,
    outcome: ended.outcome
  }))
)
```

## Every ending

| Error | Fields | |
|---|---|---|
| `AgentFailed` | `kind` | API error, failed tool loop, max turns |
| `UsageLimited` | `window`, `resetsAt`, `overageAvailable` | A subscription limit |
| `Throttled` | `retriesLeft` | The provider stopped retrying |
| `AuthFailed` | | |
| `SpendCapReached` | `capUsd`, `spentUsd`, `estimated` | |
| `ContextExhausted` | | |
| `ProcessKilled` | `signal`, `exitCode` | The process died mid-turn |
| `Stalled` | `idleMs`, `inTool` | The watchdog stopped it |
| `Interrupted` | | `session.interrupt` |

Outside of turns, `open` and `history` fail with `SessionNotFound` for an unknown
session. Infrastructure failures, such as a process that won't start, are `AgentError`.

Once a session has ended (`end`, its scope closed, or its agent process died), its calls
fail with `SessionClosed`. `end` itself succeeds if the session ended cleanly, and fails
with what ended it otherwise.
