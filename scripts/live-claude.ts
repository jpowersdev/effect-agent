/**
 * End-to-end run of the Claude provider against the real SDK and CLI.
 *
 *   node scripts/live-claude.ts              # all scenarios, recordings in /tmp
 *   node scripts/live-claude.ts --fixtures   # also refresh test/fixtures/claude/*.jsonl
 *   node scripts/live-claude.ts steer interrupt
 *
 * Uses claude-haiku-5-5 in /tmp/effect-agent-live/claude/<scenario>; each
 * scenario costs a fraction of a cent.
 */
import { Cause, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Agent, type AgentEvent, type AgentSession, SessionId } from "../src/index.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"

const model = "claude-haiku-5-5"
const root = "/tmp/effect-agent-live/claude"
const recordings = join(root, "recordings")
const fixtures = join(import.meta.dirname, "..", "test", "fixtures", "claude")
const args = process.argv.slice(2)
const updateFixtures = args.includes("--fixtures")
const only = args.filter((a) => !a.startsWith("--"))

class Check extends Error {}
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Check(message)
}

/** Run `session.events` in the background from now on; read with `get`. */
const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const fiber = yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.forkScoped({ startImmediately: true }),
    )
    return { events, fiber }
  })

/** Wait until an event matches (polling the collected list). */
const waitFor = (events: ReadonlyArray<AgentEvent>, f: (e: AgentEvent) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1200; i++) {
      if (events.some(f)) return events.find(f)!
      yield* Effect.sleep("100 millis")
    }
    return yield* Effect.die(new Check(`timed out waiting for ${label}`))
  })

const tags = (events: ReadonlyArray<AgentEvent>) =>
  events.filter((e) => e._tag !== "Other" && e._tag !== "Heartbeat" && e._tag !== "LimitsUpdated").map((e) => e._tag)

const processAlive = (sessionId: string) => {
  try {
    return execFileSync("pgrep", ["-f", sessionId], { encoding: "utf8" }).trim() !== ""
  } catch {
    return false
  }
}

const layerFor = (name: string, options: ClaudeAgent.ClaudeAgentOptions = {}) => {
  const path = join(recordings, `${name}.jsonl`)
  rmSync(path, { force: true })
  return ClaudeAgent.layer({ model, ...options }).pipe(Layer.provide(ClaudeSdk.layer({ record: path })))
}

const cwdFor = (name: string) => {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

type Scenario = Effect.Effect<void, unknown, Agent>

const scenarios: Record<string, { readonly run: Scenario; readonly options?: ClaudeAgent.ClaudeAgentOptions }> = {
  "simple-turn": {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const caps = yield* agent.capabilities
      check(caps.version !== null, "capabilities.version from the bundled manifest")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd: cwdFor("simple-turn") })
          const { events } = yield* collect(session)
          const done = yield* session.turn("Reply with just the word: pong")
          check(/pong/i.test(done.finalText), `finalText was ${done.finalText}`)
          const started = events[0]
          check(started?._tag === "SessionStarted" && started.sessionId === session.sessionId, "SessionStarted id")
          const init = started?.raw as { mcp_servers?: unknown }
          check(Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0, `mcp_servers ${JSON.stringify(init.mcp_servers)}`)
          const ended = events.find((e) => e._tag === "TurnEnded")
          check(ended?._tag === "TurnEnded" && ended.cost?.source === "reported" && ended.usage !== null, "TurnEnded cost/usage")
          check(Option.isSome(session.location), "location")
          yield* session.end
          const path = Option.getOrThrow(session.location)
          check(existsSync(path), `transcript at ${path}`)
          check(!processAlive(session.sessionId), "process gone after end")
          console.log("  events:", tags(events).join(" "))
        }),
      )
    }),
  },

  "bash-tool": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("bash-tool"), disable: { askUser: true, subagents: true } })
        const { events } = yield* collect(session)
        yield* session.turn(
          'Use the Bash tool to run exactly this command: echo "marker:${CLAUDECODE_PARENT_CHECK:-x}:${CLAUDE_CODE_SESSION_ID:-unset}" Then reply with just: done',
        )
        const call = events.find((e) => e._tag === "ToolCall")
        check(call?._tag === "ToolCall" && call.name === "Bash" && call.summary.startsWith("echo"), "Bash ToolCall")
        const result = events.find((e) => e._tag === "ToolResult")
        check(result?._tag === "ToolResult" && !result.isError, "ToolResult")
        // The parent's session id must not leak into the child (the CLI sets its own for tools, or none).
        check(result?._tag === "ToolResult" && !result.output.includes(process.env.CLAUDE_CODE_SESSION_ID ?? "\0"), `host session id leaked: ${result?._tag === "ToolResult" ? result.output : ""}`)
        const init = events.find((e) => e._tag === "SessionStarted")?.raw as { tools?: ReadonlyArray<string> }
        check(!init.tools?.includes("AskUserQuestion") && !init.tools?.includes("Agent"), `disabled tools present: ${init.tools}`)
        console.log("  events:", tags(events).join(" "))
        console.log("  output:", result?._tag === "ToolResult" ? result.output.trim() : "")
      }),
    ),
  },

  steer: {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("steer") })
        const { events } = yield* collect(session)
        const first = yield* session
          .turn(
            "Use the Bash tool three times, one call per message, never in parallel: `sleep 2 && echo one`, then `sleep 2 && echo two`, then `sleep 2 && echo three`. Then summarize in one line.",
          )
          .pipe(Effect.forkScoped)
        yield* waitFor(events, (e) => e._tag === "ToolCall", "first ToolCall")
        const outcome = yield* session.steer("Also end your summary with the word BANANA.")
        console.log("  steer:", outcome._tag)
        check(outcome._tag === "Landed", `steer outcome ${outcome._tag}`)
        const done = yield* Fiber.join(first)
        check(/banana/i.test(done.finalText), `steer not honoured: ${done.finalText}`)
        check(events.some((e) => e._tag === "MessageLanded" && e.messageId === outcome.messageId), "MessageLanded")
        check(events.filter((e) => e._tag === "TurnEnded").length === 1, "one turn")
        console.log("  events:", tags(events).join(" "))
      }),
    ),
  },

  queue: {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("queue") })
        const { events } = yield* collect(session)
        const first = yield* session.send("Use the Bash tool to run `sleep 2 && echo one`, then reply with just: one")
        yield* waitFor(events, (e) => e._tag === "ToolCall", "ToolCall")
        const second = yield* session.send("Reply with just: two")
        yield* waitFor(events, (e) => e._tag === "TurnEnded" && String(e.turnId) === second, "second turn to end")
        const starts = events.filter((e) => e._tag === "TurnStarted").map((e) => (e._tag === "TurnStarted" ? e.turnId : ""))
        check(String(starts[0]) === first && String(starts[1]) === second, `turns ${starts}`)
        yield* session.end
        console.log("  events:", tags(events).join(" "))
      }),
    ),
  },

  "interrupt-then-turn": {
    run: Effect.gen(function* () {
      const id = yield* Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("interrupt-then-turn") })
        const { events } = yield* collect(session)
        const first = yield* session
          .turn("Use the Bash tool to run `sleep 20 && echo slept`, then reply with just: slept")
          .pipe(Effect.exit, Effect.forkScoped)
        yield* waitFor(events, (e) => e._tag === "ToolCall", "ToolCall")
        yield* session.interrupt
        const exit = yield* Fiber.join(first)
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        check(Option.isSome(error) && error.value._tag === "Interrupted", `first turn: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"}`)
        const again = yield* session.turn("Reply with just: ok")
        check(/ok/i.test(again.finalText), `follow-up ${again.finalText}`)
        console.log("  events:", tags(events).join(" "))
        return session.sessionId
      }),
      )
      // Closed by the Scope without `end`: the process must still be gone.
      check(!processAlive(id), "process gone after scope close")
    }),
  },

  "resume-missing": {
    // Skip the precheck so the CLI's own "No conversation found" path is exercised and recorded.
    options: { checkResume: false },
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const id = SessionId.make(crypto.randomUUID())
      const exit = yield* Effect.scoped(agent.open({ cwd: cwdFor("resume-missing"), resume: id })).pipe(Effect.exit)
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      check(Option.isSome(error) && error.value._tag === "SessionNotFound", `open: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"}`)
      check(!processAlive(id), "process gone")
    }),
  },

  "resume-precheck": {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const exit = yield* Effect.scoped(
        agent.open({ cwd: cwdFor("resume-precheck"), resume: SessionId.make(crypto.randomUUID()) }),
      ).pipe(Effect.exit)
      const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
      check(Option.isSome(error) && error.value._tag === "SessionNotFound", "precheck SessionNotFound")
    }),
  },

  resume: {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const cwd = cwdFor("resume")
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd })
          yield* session.turn("Remember the word: walrus. Reply with just: ok")
          yield* session.end
          return session.sessionId
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd, resume: id })
          const { events } = yield* collect(session)
          const done = yield* session.turn("What word did I ask you to remember? Reply with just the word.")
          check(/walrus/i.test(done.finalText), `resumed answer ${done.finalText}`)
          const started = events.find((e) => e._tag === "SessionStarted")
          check(started?._tag === "SessionStarted" && started.resumed, "resumed SessionStarted")
          yield* session.end
        }),
      )
    }),
  },

  "spend-cap": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("spend-cap"), spendCapUsd: 0.0001 })
        const exit = yield* session.turn("Reply with just: hi").pipe(Effect.exit)
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        check(Option.isSome(error) && error.value._tag === "SpendCapReached", `turn: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"}`)
        if (Option.isSome(error) && error.value._tag === "SpendCapReached") {
          console.log(`  cap ${error.value.capUsd} spent ${error.value.spentUsd}`)
        }
      }),
    ),
  },

  "process-killed": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("process-killed") })
        const { events } = yield* collect(session)
        const first = yield* session
          .turn("Use the Bash tool to run `sleep 20 && echo slept`, then reply with just: slept")
          .pipe(Effect.exit, Effect.forkScoped)
        yield* waitFor(events, (e) => e._tag === "ToolCall", "ToolCall")
        const pids = execFileSync("pgrep", ["-f", session.sessionId], { encoding: "utf8" }).trim().split("\n")
        for (const pid of pids) process.kill(Number(pid), "SIGKILL")
        const exit = yield* Fiber.join(first)
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        check(Option.isSome(error) && error.value._tag === "ProcessKilled", `turn: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"}`)
        const later = yield* session.send("hello?").pipe(Effect.exit)
        check(Exit.isFailure(later), "send after death fails")
        console.log("  events:", tags(events).join(" "))
      }),
    ),
  },
}

/** Drop machine-specific lists from init frames so fixtures stay small and portable. */
const scrub = (text: string) =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const line = JSON.parse(l)
      if (line.dir === "in" && line.frame?.type === "system" && line.frame.subtype === "init") {
        for (const k of ["slash_commands", "terminal_slash_commands", "skills", "plugins", "agents", "memory_paths"]) {
          if (k in line.frame) line.frame[k] = []
        }
        delete line.frame.messaging_socket_path
      }
      return JSON.stringify(line)
    })
    .join("\n")
    .concat("\n")
    .replaceAll(process.env.HOME ?? "\0", "/home/user")

const main = async () => {
  mkdirSync(recordings, { recursive: true })
  let failed = 0
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (only.length > 0 && !only.includes(name)) continue
    const started = Date.now()
    process.stdout.write(`${name} ...\n`)
    const exit = await Effect.runPromiseExit(scenario.run.pipe(Effect.provide(layerFor(name, scenario.options))))
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (Exit.isSuccess(exit)) {
      console.log(`  ok (${seconds}s)`)
      const recording = join(recordings, `${name}.jsonl`)
      if (updateFixtures && existsSync(recording)) {
        mkdirSync(fixtures, { recursive: true })
        writeFileSync(join(fixtures, `${name}.jsonl`), scrub(readFileSync(recording, "utf8")))
      }
    } else {
      failed++
      console.log(`  FAILED (${seconds}s)\n${Cause.pretty(exit.cause)}`)
    }
  }
  if (failed > 0) {
    console.log(`${failed} scenario(s) failed`)
    process.exit(1)
  }
  console.log("all scenarios passed")
}

await main()
