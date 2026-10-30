---
title: "Sessions"
description: "Give an agent work, steer it while it runs, and pick it up later."
sidebar:
  order: 2
---

A session is one agent process working in one directory. It stays open until the scope
it was opened in closes, so you can keep giving it work.

## Run a task

`turn` sends a message and waits for the turn it starts to end.

```ts
const agent = yield* Agent
const session = yield* agent.open({ cwd: "/path/to/repo" })

const result = yield* session.turn("Fix the failing test")
yield* Effect.log(result.finalText)
```

If the turn fails, `turn` fails with a typed error. See
[Events and endings](../events-and-endings/).

## Add to a turn while it runs

`steer` delivers a message into the running turn, at its next tool boundary. If that
turn ends first, the message starts a new one.

```ts
yield* session.send("Upgrade the project to Effect 4")

// Later, when the user adds something
const steered = yield* session.steer("Leave the docs folder alone")
// { _tag: "Landed", turnId, messageId } or { _tag: "StartedNewTurn", ... }
```

## Queue the next task

`send` returns once the message is accepted. If a turn is running, the message waits
for it to end.

```ts
yield* session.send("Fix the lint errors")
yield* session.send("Then update the changelog") // runs after the first turn
```

## Stop a turn

`interrupt` ends the running turn with `Interrupted`. The session stays open.

```ts
yield* session.interrupt
yield* session.send("Try a smaller change instead")
```

## Finish

Closing the scope stops the agent right away, along with every process it started.
`end` lets queued messages run first.

```ts
yield* session.end // finish the queue, then exit
```

## Give it standing instructions

`appendSystemPrompt` is added to the provider's default system prompt. It doesn't
replace it.

```ts
agent.open({
  cwd,
  model: "claude-sonnet-5-5",
  effort: "high",
  appendSystemPrompt: "Commit when the tests pass. Never push.",
})
```

## Cap what it spends

The turn that crosses the cap fails with `SpendCapReached`. Codex enforces it from
estimated cost, by interrupting the turn.

```ts
agent.open({ cwd, spendCapUsd: 5 })
```

## Run it unattended

Nobody is there to answer questions, so turn off the ask-the-user tool. You can turn
off subagents and named tools too.

```ts
agent.open({
  cwd,
  disable: { askUser: true, subagents: true, tools: ["WebSearch"] },
})
```

Sessions always run with permission checks off (Claude's `bypassPermissions`) and with
no MCP servers: none of the user's, and no claude.ai connectors or ChatGPT apps.

## Set its environment

`env` is applied over your process's environment. `undefined` removes a variable.

```ts
agent.open({
  cwd,
  env: { GIT_PAGER: "cat", NODE_OPTIONS: undefined },
})
```

Variables that tell an agent it's nested, such as `CLAUDECODE`, are always removed.
Codex sessions also drop Claude Code's login token, `CLAUDE_CODE_OAUTH_TOKEN`: Codex
passes its environment to every command it runs. Set it in `env` to keep it.

## Store the options, or send them elsewhere

`RunSettings` is `RunOptions` without `hooks`, as a `Schema`. Durations encode as
milliseconds and an `undefined` env value as `null`, so the result is plain JSON.

```ts
const json = yield* Schema.encodeEffect(Schema.fromJsonString(RunSettings))(settingsOf(options))
```

## Keep it going until the tests pass

A `beforeStop` hook runs when the agent is about to end its turn. Returning text keeps
the turn going, with that text added to its context.

```ts
agent.open({
  cwd,
  hooks: {
    beforeStop: () =>
      testsPass.pipe(
        Effect.map((ok) => (ok ? Option.none() : Option.some("The tests still fail."))),
      ),
  },
})
```

Hooks run inside the agent's tool loop, so keep them fast. A hook that fails adds
nothing. Claude has hooks; on Codex, `open` fails if any are set.

## Remind it of a rule

`beforeTool` runs before each tool call, and can add a note the model sees with it.

```ts
const beforeTool = (call: ToolHookInput) =>
  Effect.succeed(
    call.name === "Bash" ? Option.some("Use pnpm, not npm.") : Option.none(),
  )
```

## Continue an earlier session

Pass the session id to `resume`. It fails with `SessionNotFound` if the provider has no
record of it.

```ts
yield* store.save(session.sessionId)

// Later, in another process
const session = yield* agent.open({ cwd, resume: yield* store.load })
```

## Read an earlier session

`history` returns a stored session's messages, tool calls and turn endings as events.
It doesn't start an agent.

```ts
const past = yield* agent.history(sessionId, { cwd })
const prompts = past.filter((event) => event._tag === "UserMessage")
```
