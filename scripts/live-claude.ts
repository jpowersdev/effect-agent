/**
 * End-to-end run of the Claude provider against the real SDK and CLI.
 *
 *   node scripts/live-claude.ts              # all scenarios, recordings in /tmp
 *   node scripts/live-claude.ts --fixtures   # also refresh test/fixtures/claude/*.jsonl
 *   node scripts/live-claude.ts steer interrupt
 *
 * Uses claude-haiku-5-5 in /tmp/effect-agent-live/claude/<scenario>; each
 * scenario costs a fraction of a cent (`status*` scenarios run no turn).
 */
import { Cause, Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Agent, type AgentEvent, type AgentSession, Launcher, SessionId } from "../src/index.ts"
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

/** Processes running this repo's bundled CLI (the agent processes we start). */
const sdkProcesses = () => {
  try {
    return execFileSync("pgrep", ["-f", join(import.meta.dirname, "..", "node_modules", "@anthropic-ai")], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((l) => l !== "")
  } catch {
    return []
  }
}

const pgrep = (pattern: string) => {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter((l) => l !== "")
  } catch {
    return []
  }
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const pretty = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded")

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
        // A unique duration, so pgrep only finds this run's command.
        const sleep = `sleep 23.${Math.floor(Math.random() * 9000 + 1000)}`
        const first = yield* session
          .turn(`Use the Bash tool to run \`${sleep} && echo slept\`, then reply with just: slept`)
          .pipe(Effect.exit, Effect.forkScoped)
        yield* waitFor(events, (e) => e._tag === "ToolCall", "ToolCall")
        yield* Effect.sleep("1 second")
        const running = () => {
          try {
            return execFileSync("pgrep", ["-af", sleep.replace(".", "\\.")], { encoding: "utf8" }).trim()
          } catch {
            return ""
          }
        }
        check(running() !== "", "the command is running before the kill")
        const pids = execFileSync("pgrep", ["-f", session.sessionId], { encoding: "utf8" }).trim().split("\n")
        for (const pid of pids) process.kill(Number(pid), "SIGKILL")
        const exit = yield* Fiber.join(first)
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        check(Option.isSome(error) && error.value._tag === "ProcessKilled", `turn: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded"}`)
        const later = yield* session.send("hello?").pipe(Effect.exit)
        check(Exit.isFailure(later), "send after death fails")
        // Swept as soon as the CLI died, while the session's scope is still open.
        yield* Effect.sleep("2500 millis")
        const left = running()
        check(left === "", `the dead CLI's command was swept; still running: ${left}`)
        console.log("  events:", tags(events).join(" "))
      }),
    ),
  },

  launcher: {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const marker = `300.${Math.floor(Math.random() * 9000 + 1000)}`
      let wrapped = 0
      const launcher = Launcher.layer(() =>
        Effect.succeed((cmd) => {
          wrapped++
          return { command: "env", args: ["EA_LAUNCHED=1", cmd.command, ...cmd.args] }
        }),
      )
      const pid = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd: cwdFor("launcher") })
          const pid = yield* session.pid
          check(Option.isSome(pid), "pid reported")
          const cmdline = readFileSync(`/proc/${Option.getOrThrow(pid)}/cmdline`, "utf8")
          check(cmdline.includes("claude"), `pid ${Option.getOrThrow(pid)} is not the CLI: ${cmdline}`)
          const { events } = yield* collect(session)
          yield* session.turn(
            `Use the Bash tool once to run exactly: echo "launched=\${EA_LAUNCHED:-no}"; (sleep ${marker} &); echo started\nThen reply with just: done`,
          )
          const result = events.find((e) => e._tag === "ToolResult")
          check(result?._tag === "ToolResult" && result.output.includes("launched=1"), `wrapped env not seen: ${result?._tag === "ToolResult" ? result.output : "no result"}`)
          const sleepers = pgrep(`sleep ${marker}`)
          check(sleepers.length > 0, "background sleep is running before close")
          const pgid = execFileSync("ps", ["-o", "pgid=", "-p", sleepers[0]!], { encoding: "utf8" }).trim()
          console.log(`  pid ${Option.getOrThrow(pid)}, background sleep pid ${sleepers[0]} in group ${pgid}`)
          return Option.getOrThrow(pid)
        }),
      ).pipe(Effect.provide(launcher))
      check(wrapped === 1, `launcher wrapped ${wrapped} commands`)
      check(pgrep(`sleep ${marker}`).length === 0, "background sleep gone after scope close")
      check(!existsSync(`/proc/${pid}`), "agent process gone after scope close")
    }),
  },

  status: {
    run: Effect.gen(function* () {
      const before = sdkProcesses().length
      const started = Date.now()
      const status = yield* (yield* Agent).status()
      const ms = Date.now() - started
      console.log(`  ${ms}ms usable=${status.usable} reason=${status.reason} plan=${status.plan}`)
      for (const w of status.windows) console.log(`   ${w.label} (${w.window}) ${w.usedPercent}% resets ${w.resetsAt?.toString() ?? "-"}`)
      check(status.provider === "claude" && status.reason !== "unauthenticated", "signed in")
      check(status.windows.some((w) => w.window === "five_hour") && status.windows.some((w) => w.window === "weekly"), "five_hour and weekly windows")
      check(status.plan !== null, "plan")
      check(ms < 5000, `status took ${ms}ms`)
      check(sdkProcesses().length === before, "status process gone")
    }),
  },

  "status-unauthenticated": {
    run: Effect.gen(function* () {
      const before = sdkProcesses().length
      // Another account via StatusOptions.env: an empty config dir, no API key.
      const status = yield* (yield* Agent).status({
        env: {
          CLAUDE_CONFIG_DIR: (mkdirSync(root, { recursive: true }), mkdtempSync(join(root, "empty-config-"))),
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        },
      })
      console.log(`  usable=${status.usable} reason=${status.reason} windows=${status.windows.length}`)
      check(!status.usable && status.reason === "unauthenticated", "unauthenticated")
      check(sdkProcesses().length === before, "status process gone")
    }),
  },

  history: {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const cwd = cwdFor("history")
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd })
          yield* session.turn("Use the Bash tool to run `echo history-marker`, then reply with just: done")
          yield* session.turn("Reply with just: second")
          yield* session.turn("/compact")
          yield* session.end
          return session.sessionId
        }),
      )
      const events = yield* agent.history(id, { cwd })
      console.log("  history:", events.map((e) => e._tag).join(" "))
      const starts = events.filter((e) => e._tag === "TurnStarted")
      check(starts.length >= 2, `turns ${starts.length}`)
      const prompts = events.flatMap((e) => (e._tag === "UserMessage" ? [e.text] : []))
      check(prompts[0]?.includes("history-marker") && prompts[1] === "Reply with just: second", `prompts ${JSON.stringify(prompts)}`)
      check(events.some((e) => e._tag === "ToolCall" && e.summary === "echo history-marker"), "ToolCall with summary")
      check(events.some((e) => e._tag === "ToolResult" && e.output.includes("history-marker")), "ToolResult")
      check(events.some((e) => e._tag === "Text" && /second/i.test(e.text)), "Text")
      check(events.some((e) => e._tag === "Compacted"), "Compacted")
      const missing = failureOf(yield* agent.history(SessionId.make(crypto.randomUUID()), { cwd }).pipe(Effect.exit))
      check(missing?._tag === "SessionNotFound", `missing id: ${missing?._tag}`)
    }),
  },

  "history-steer-interrupt": {
    run: Effect.gen(function* () {
      const agent = yield* Agent
      const cwd = cwdFor("history-steer-interrupt")
      const { id, first, steered, second } = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* agent.open({ cwd })
          const { events } = yield* collect(session)
          const first = yield* session.send(
            "Use the Bash tool twice, one call per message: `sleep 2 && echo one`, then `sleep 2 && echo two`. Then reply in one line.",
          )
          yield* waitFor(events, (e) => e._tag === "ToolCall", "first ToolCall")
          const steer = yield* session.steer("Also end your reply with the word BANANA.")
          check(steer._tag === "Landed", `steer ${steer._tag}`)
          yield* waitFor(events, (e) => e._tag === "TurnEnded", "first turn to end")
          const second = yield* session.send("Use the Bash tool to run `sleep 20 && echo slept`, then reply with just: slept")
          yield* waitFor(events, (e) => e._tag === "ToolCall" && String(e.turnId) === second, "second ToolCall")
          yield* session.interrupt
          yield* waitFor(events, (e) => e._tag === "TurnEnded" && String(e.turnId) === second, "second turn to end")
          // (The CLI exits 1 if input ends right after an interrupted turn, so finish with a short one.)
          yield* session.turn("Reply with just: ok")
          yield* session.end
          return { id: session.sessionId, first, steered: steer.messageId, second }
        }),
      )
      const events = yield* agent.history(id, { cwd })
      console.log("  history:", events.map((e) => (e._tag === "TurnEnded" ? `TurnEnded(${e.outcome._tag})` : e._tag)).join(" "))
      const starts = events.flatMap((e) => (e._tag === "TurnStarted" ? [String(e.turnId)] : []))
      check(starts.length === 3 && starts[0] === first && starts[1] === second, `turn ids ${starts} vs ${first} ${second}`)
      const steerMessage = events.find((e) => e._tag === "UserMessage" && e.messageId === steered)
      check(steerMessage?._tag === "UserMessage" && String(steerMessage.turnId) === first, "steer is in the first turn")
      const ended = events.filter((e) => e._tag === "TurnEnded")
      check(ended.length === 1 && ended[0]?._tag === "TurnEnded" && String(ended[0].turnId) === second && ended[0].outcome._tag === "Interrupted", "second turn ended Interrupted")
    }),
  },

  watchdog: {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({ cwd: cwdFor("watchdog"), watchdog: { idle: "20 seconds", toolIdle: "3 seconds" } })
        const { events } = yield* collect(session)
        const started = Date.now()
        const exit = yield* session.turn("Use the Bash tool (in the foreground, not in the background) to run `sleep 20 && echo done`, then reply with just: done").pipe(Effect.exit)
        const error = failureOf(exit)
        console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s:`, error?._tag === "Stalled" ? error.message : pretty(exit))
        check(error?._tag === "Stalled" && error.inTool && error.idleMs >= 3000, `turn: ${pretty(exit)}`)
        const ended = events.find((e) => e._tag === "TurnEnded")
        check(ended?._tag === "TurnEnded" && ended.outcome._tag === "Stalled", "TurnEnded Stalled")
        const again = yield* session.turn("Reply with just: ok")
        check(/ok/i.test(again.finalText), `follow-up ${again.finalText}`)
        console.log("  events:", tags(events).join(" "))
      }),
    ),
  },

  "hook-before-tool": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const calls: Array<string> = []
        const session = yield* agent.open({
          cwd: cwdFor("hook-before-tool"),
          hooks: {
            beforeTool: (call) =>
              Effect.sync(() => {
                calls.push(call.name)
                return Option.some("The secret word is MANGO.")
              }),
          },
        })
        const done = yield* session.turn(
          "Use the Bash tool once to run `echo hello`. Context added while the tool runs will tell you a secret word. Then reply with just the secret word.",
        )
        console.log(`  hook calls ${calls.join(",")}; reply: ${done.finalText}`)
        check(calls.includes("Bash"), "beforeTool ran for Bash")
        check(/MANGO/.test(done.finalText), `reply ${done.finalText}`)
      }),
    ),
  },

  "hook-before-stop": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const asked = yield* Ref.make(0)
        const session = yield* agent.open({
          cwd: cwdFor("hook-before-stop"),
          hooks: {
            beforeStop: () =>
              Ref.getAndUpdate(asked, (n) => n + 1).pipe(
                Effect.map((n) => (n === 0 ? Option.some("Before you finish, reply once more with just the word KIWI.") : Option.none())),
              ),
          },
        })
        const { events } = yield* collect(session)
        const done = yield* session.turn("Reply with just: hello")
        const texts = events.flatMap((e) => (e._tag === "Text" ? [e.text] : []))
        console.log(`  stop hook calls ${yield* Ref.get(asked)}; texts ${JSON.stringify(texts)}; final ${done.finalText}`)
        check((yield* Ref.get(asked)) >= 2, "beforeStop ran again after continuing")
        check(texts.some((t) => /KIWI/.test(t)), "the turn continued and acted on the stop hook's text")
        check(events.filter((e) => e._tag === "TurnEnded").length === 1, "one turn")
      }),
    ),
  },

  "hook-failing": {
    run: Effect.scoped(
      Effect.gen(function* () {
        const agent = yield* Agent
        const session = yield* agent.open({
          cwd: cwdFor("hook-failing"),
          hooks: {
            beforeTool: () => Effect.die(new Error("hook bug")),
            afterTool: () => Effect.fail("ignored").pipe(Effect.orDie),
            beforeStop: () => Effect.die("boom"),
          },
        })
        // Every hook defects: they add nothing and the turn ends normally.
        const done = yield* session.turn("Use the Bash tool to run `echo ok`, then reply with just: ok")
        check(/ok/i.test(done.finalText), `reply ${done.finalText}`)
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
    .replace(/"email":"[^"]*"/g, '"email":"user@example.com"')
    .replace(/"organization":"[^"]*"/g, '"organization":"Example Org"')

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
