/**
 * End-to-end check of the Codex provider against the real `codex app-server`.
 *
 *   node scripts/live-codex.ts            # run every scenario, assert, report
 *   node scripts/live-codex.ts --record   # also write test/fixtures/codex/*.jsonl
 *   node scripts/live-codex.ts simple env # run only some scenarios
 *
 * Runs in /tmp/effect-agent-live/codex/ with tiny prompts at effort `low`.
 */
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import type { AgentEvent, AgentSession, RunOptions } from "../src/index.ts"
import { Agent, SessionId } from "../src/index.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"

const ROOT = "/tmp/effect-agent-live/codex"
const FIXTURES = new URL("../test/fixtures/codex/", import.meta.url).pathname
const args = process.argv.slice(2)
const recording = args.includes("--record")
const only = args.filter((a) => !a.startsWith("--"))
const cwd = `${ROOT}/work`
mkdirSync(cwd, { recursive: true })
mkdirSync(`${ROOT}/rec`, { recursive: true })

const base: RunOptions = { cwd, effort: "low", appendSystemPrompt: "Keep every reply under ten words." }

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const check = (cond: unknown, message: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`)
}

/** Subscribe to the session's events and wait until the subscription is live. */
const collect = (session: AgentSession) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const ready = yield* Deferred.make<void>()
    yield* session.events.pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e)).pipe(Effect.andThen(Deferred.succeed(ready, undefined)))),
      Effect.ignore,
      Effect.forkScoped,
    )
    yield* Deferred.await(ready)
    return events
  })

const waitFor = <A extends AgentEvent>(events: Array<AgentEvent>, pred: (e: AgentEvent) => e is A, timeout = 180) =>
  Effect.gen(function* () {
    for (let i = 0; i < timeout * 20; i++) {
      const hit = events.find(pred)
      if (hit) return hit
      yield* Effect.sleep(Duration.millis(50))
    }
    return yield* Effect.die(new Error("timed out waiting for event"))
  })

const is =
  <T extends AgentEvent["_tag"]>(tag: T) =>
  (e: AgentEvent): e is Extract<AgentEvent, { _tag: T }> =>
    e._tag === tag

const recPath = (name: string) => `${ROOT}/rec/${name}.jsonl`

const agentLayer = (name: string, options: CodexAgent.CodexAgentOptions = {}) =>
  CodexAgent.layer(options).pipe(
    Layer.provide(CodexAppServer.layer({ record: recPath(name) })),
    Layer.provide(NodeServices.layer),
  )

const pgrep = (pattern: string) => {
  try {
    return execSync(`pgrep -f -- ${JSON.stringify(pattern)}`).toString().trim()
  } catch {
    return ""
  }
}

/** Fixtures must not carry the account's identity. */
const sanitize = (text: string) =>
  text
    .replaceAll(process.env.HOME ?? "/home/nobody", "/home/user")
    .replace(/"accountId":"[^"]*"/g, '"accountId":"acct-redacted"')
    .replace(/"email":"[^"]*"/g, '"email":"user@example.com"')
    .replace(/"installationId":"[^"]*"/g, '"installationId":"redacted"')
    .replace(/"serverName":"[^"]*"/g, '"serverName":"host"')

const saveFixture = (name: string, text = readFileSync(recPath(name), "utf8")) => {
  if (!recording) return
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(`${FIXTURES}${name}.jsonl`, sanitize(text))
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

type Scenario = Effect.Effect<string, unknown, Scope.Scope>

const simple: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const caps = yield* agent.capabilities
  check(caps.version !== null, "capabilities.version")
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  const result = yield* session.turn("Reply with the word pong.")
  check(/pong/i.test(result.finalText), `finalText was ${result.finalText}`)
  const started = events.find(is("SessionStarted"))
  check(started?.version !== null && started?.model !== null, "SessionStarted version/model")
  check(Option.isSome(session.location), "location")
  const ended = yield* waitFor(events, is("TurnEnded"))
  check(ended.usage !== null && ended.usage.inputTokens > 0, "usage on TurnEnded")
  check(events.some(is("MessageLanded")), "MessageLanded")
  const mcp = events.filter((e) => e._tag === "Other" && (e.raw as any)?.method === "mcpServer/startupStatus/updated")
  check(mcp.length === 0, `MCP servers started: ${JSON.stringify(mcp.map((e) => (e.raw as any).params?.name))}`)
  yield* session.end
  saveFixture("simple")
  return `pong in ${result.turnId}; version ${started?.version} model ${started?.model}; ${events.length} events; no MCP startup`
}).pipe(Effect.provide(agentLayer("simple")))

const command: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  const result = yield* session.turn("Run the shell command `echo hello-from-codex` and then reply with the word done.")
  const call = events.find(is("ToolCall"))
  const res = events.find(is("ToolResult"))
  check(call?.name === "shell" && call.summary.includes("echo hello-from-codex"), `ToolCall ${JSON.stringify(call?.summary)}`)
  check(res !== undefined && !res.isError && res.output.includes("hello-from-codex"), `ToolResult ${res?.output}`)
  yield* session.end
  saveFixture("command")
  return `${call?.summary} -> ${res?.output.trim()}; final ${result.finalText}`
}).pipe(Effect.provide(agentLayer("command")))

const env: Scenario = Effect.gen(function* () {
  process.env.EA_PROBE_UNSET = "leaked"
  process.env.CLAUDECODE = "1"
  process.env.CLAUDE_CODE_ENTRYPOINT = "cli"
  const agent = yield* Agent
  const session = yield* agent.open({ ...base, env: { EA_PROBE_KEEP: "kept", EA_PROBE_UNSET: undefined } })
  const events = yield* collect(session)
  yield* session.turn("Run exactly this shell command: env | grep -E '^(EA_PROBE_|CLAUDE)' | sort ; then reply with the word done.")
  const res = events.find(is("ToolResult"))
  check(res !== undefined, "env command ran")
  check(res!.output.includes("EA_PROBE_KEEP=kept"), `EA_PROBE_KEEP missing: ${res!.output}`)
  check(!res!.output.includes("EA_PROBE_UNSET"), `EA_PROBE_UNSET leaked: ${res!.output}`)
  check(!/CLAUDE/.test(res!.output), `CLAUDE* leaked: ${res!.output}`)
  yield* session.end
  return `command env: ${JSON.stringify(res!.output.trim())}`
}).pipe(Effect.provide(agentLayer("env")))

const steerLands: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  yield* session.send(
    "Run these two shell commands one at a time, as two separate tool calls: `sleep 3 && echo one`, then `sleep 3 && echo two`. Then reply with the word done.",
  )
  yield* waitFor(events, is("ToolCall"))
  const outcome = yield* session.steer("Steering note: end your final reply with the word STEERED.")
  check(outcome._tag === "Landed", `steer outcome ${outcome._tag}`)
  const ended = yield* waitFor(events, is("TurnEnded"))
  const landed = events.filter(is("MessageLanded"))
  check(landed.some((e) => e.messageId === outcome.messageId && e.turnId === ended.turnId), "steer MessageLanded in same turn")
  check(ended.outcome._tag === "Succeeded" && /STEERED/i.test(ended.outcome.finalText), `final ${JSON.stringify(ended.outcome)}`)
  yield* session.end
  saveFixture("steer-landed")
  return `${outcome._tag} in ${outcome.turnId}; final ${(ended.outcome as any).finalText}`
}).pipe(Effect.provide(agentLayer("steer-landed")))

/**
 * Stale steer, recorded at the transport level (the agent never steers a turn
 * it knows has ended), then reordered so the steer races the turn's end as it
 * would in the wild: the recorded `turn/steer` and its error are moved before
 * the first turn's `turn/completed`.
 */
const steerStale: Scenario = Effect.gen(function* () {
  const server = yield* CodexAppServer.CodexAppServer
  const conn = yield* server.connect({ cwd })
  const thread = yield* conn.request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: { mcp_servers: {}, "features.apps": false, model_reasoning_effort: "low" },
    ephemeral: false,
  })
  const threadId = thread.thread.id
  const completions = yield* Deferred.make<void>()
  let completed = 0
  yield* conn.incoming.pipe(
    Stream.runForEach((m) =>
      m.method === "turn/completed" && (m.params as any)?.threadId === threadId && ++completed === 1
        ? Deferred.succeed(completions, undefined)
        : Effect.void,
    ),
    Effect.forkScoped,
  )
  const text = (t: string) => [{ type: "text" as const, text: t, text_elements: [] }]
  const a = yield* conn.request("turn/start", { threadId, input: text("Reply with the word pong."), clientUserMessageId: "rec-a" })
  yield* Deferred.await(completions)
  const stale = yield* conn
    .request("turn/steer", { threadId, input: text("Reply with the word again."), expectedTurnId: a.turn.id, clientUserMessageId: "rec-b" })
    .pipe(Effect.flip)
  check(stale._tag === "CodexRpcError" && /no active turn/.test(stale.message), `stale steer error ${stale.message}`)
  const b = yield* conn.request("turn/start", { threadId, input: text("Reply with the word again."), clientUserMessageId: "rec-b" })
  for (let i = 0; i < 1200 && completed < 2; i++) yield* Effect.sleep(Duration.millis(50))
  check(completed >= 2, "second turn completed")
  yield* conn.close
  yield* Effect.sleep(Duration.millis(300))
  // reorder
  const lines = readFileSync(recPath("steer-stale"), "utf8").trim().split("\n")
  const frames = lines.map((l) => JSON.parse(l))
  const steerOut = frames.findIndex((f) => f.dir === "out" && f.msg.method === "turn/steer")
  const steerIn = frames.findIndex((f) => f.dir === "in" && f.msg.id === frames[steerOut].msg.id && f.msg.error)
  const firstDone = frames.findIndex((f) => f.dir === "in" && f.msg.method === "turn/completed")
  const pair = [frames[steerOut], frames[steerIn]]
  const rest = frames.filter((_, i) => i !== steerOut && i !== steerIn)
  const at = rest.indexOf(frames[firstDone])
  rest.splice(at, 0, ...pair)
  saveFixture("steer-stale", rest.map((f) => JSON.stringify(f)).join("\n") + "\n")
  return `stale steer error "${stale.message}"; new turn ${b.turn.id}`
}).pipe(Effect.provide(CodexAppServer.layer({ record: recPath("steer-stale") }).pipe(Layer.provide(NodeServices.layer))))

const interrupt: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  yield* session.send("Run the shell command `sleep 120 && echo effect-agent-late` and then reply ok.")
  yield* waitFor(events, (e): e is Extract<AgentEvent, { _tag: "ToolCall" }> => e._tag === "ToolCall" && e.summary.includes("sleep 120"))
  yield* Effect.sleep(Duration.seconds(1))
  check(pgrep("sleep 120 && echo effect-agent-late") !== "", "command running before interrupt")
  yield* session.interrupt
  const ended = yield* waitFor(events, is("TurnEnded"))
  check(ended.outcome._tag === "Interrupted", `outcome ${ended.outcome._tag}`)
  yield* Effect.sleep(Duration.millis(500))
  const left = pgrep("sleep 120 && echo effect-agent-late")
  check(left === "", `interrupted command still running: ${left}`)
  const next = yield* session.turn("Reply with the word pong.")
  check(/pong/i.test(next.finalText), "follow-up turn works")
  yield* session.end
  saveFixture("interrupt")
  return `Interrupted; command killed; follow-up "${next.finalText}"`
}).pipe(Effect.provide(agentLayer("interrupt")))

const queue: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  const first = yield* session.send("Run the shell command `sleep 2 && echo first` and then reply with the word first.")
  const second = session.turn("Reply with the word second.")
  const result = yield* second
  const ends = events.filter(is("TurnEnded"))
  check(ends.length === 2, `two turns, got ${ends.length}`)
  check(/second/i.test(result.finalText), "second reply")
  const landed = events.filter(is("MessageLanded"))
  check(landed[0]?.messageId === first && landed[1]?.turnId === result.turnId, "landing order")
  yield* session.end
  saveFixture("queue")
  return `queued turn ran after the first: ${ends.map((e) => e.turnId).join(", ")}`
}).pipe(Effect.provide(agentLayer("queue")))

const resumeMissing: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const missing = yield* agent.open({ ...base, resume: SessionId.make("019a0000-0000-7000-8000-000000000000") }).pipe(Effect.flip)
  check(missing._tag === "SessionNotFound", `got ${missing._tag}`)
  // The failed open already closed app-server (and flushed the recording).
  saveFixture("resume-missing")
  const malformed = yield* agent.open({ ...base, resume: SessionId.make("not-a-thread") }).pipe(Effect.flip)
  check(malformed._tag === "SessionNotFound", `malformed got ${malformed._tag}`)
  return `${missing._tag}: ${missing.message}; malformed id -> ${malformed._tag}`
}).pipe(Effect.provide(agentLayer("resume-missing")))

const resume: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const first = yield* Effect.scoped(
    Effect.gen(function* () {
      const s = yield* agent.open(base)
      yield* s.turn("Remember the word walrus. Reply with the word ok.")
      yield* s.end
      return s.sessionId
    }),
  )
  const session = yield* agent.open({ ...base, resume: first })
  const events = yield* collect(session)
  const result = yield* session.turn("What word did I ask you to remember? Reply with just that word.")
  check(events.find(is("SessionStarted"))?.resumed === true, "resumed flag")
  check(/walrus/i.test(result.finalText), `resume lost context: ${result.finalText}`)
  yield* session.end
  return `resumed ${first}: "${result.finalText}"`
}).pipe(Effect.provide(agentLayer("resume")))

const spendCap: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const caps = yield* agent.capabilities
  check(caps.cost === "estimated" && caps.spendCap === "estimated", "estimated capabilities")
  const session = yield* agent.open({ ...base, spendCapUsd: 0.01 })
  const events = yield* collect(session)
  const failure = yield* session
    .turn("Run the shell command `sleep 5 && echo capped`, then run `sleep 5 && echo again`, then reply done.")
    .pipe(Effect.flip)
  check(failure._tag === "SpendCapReached" && failure.estimated, `got ${JSON.stringify(failure)}`)
  const ended = events.find(is("TurnEnded"))
  check(ended?.cost?.source === "estimated" && ended.cost.usd >= 0.01, "TurnEnded cost")
  const next = yield* session.turn("Reply with the word pong.").pipe(Effect.flip)
  check(next._tag === "SpendCapReached", "later turns refused")
  yield* session.end
  saveFixture("spend-cap")
  const f = failure as { spentUsd: number | null; capUsd: number }
  return `SpendCapReached estimated: spent $${f.spentUsd?.toFixed(2)} >= cap $${f.capUsd}`
}).pipe(Effect.provide(agentLayer("spend-cap", { pricing: { "*": { input: 1000, cachedInput: 1000, output: 1000 } } })))

const noPrice: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const error = yield* agent.open({ ...base, spendCapUsd: 1 }).pipe(Effect.flip)
  check(error._tag === "AgentError", `got ${error._tag}`)
  return `open refused: ${error.message}`
}).pipe(Effect.provide(agentLayer("no-price", { pricing: { "some-other-model": { input: 1, output: 1 } } })))

/** SIGTERM app-server from outside mid-turn: the turn ends ProcessKilled and its command is gone. */
const killed: Scenario = Effect.gen(function* () {
  const agent = yield* Agent
  const session = yield* agent.open(base)
  const events = yield* collect(session)
  const turn = yield* session.turn("Run the shell command `sleep 60 && echo effect-agent-killed` and then reply ok.").pipe(Effect.flip, Effect.forkScoped)
  yield* waitFor(events, (e): e is Extract<AgentEvent, { _tag: "ToolCall" }> => e._tag === "ToolCall" && e.summary.includes("sleep 60"))
  yield* Effect.sleep(Duration.seconds(1))
  const pid = execSync(`pgrep -P ${process.pid} -f "codex app-server"`).toString().trim().split("\n")[0]
  check(pid, "found our app-server")
  execSync(`kill -TERM ${pid}`)
  const failure = yield* Fiber.join(turn)
  check(failure._tag === "ProcessKilled", `got ${failure._tag}: ${failure.message}`)
  yield* Effect.sleep(Duration.millis(500))
  check(pgrep("sleep 60 && echo effect-agent-killed") === "", "command survived app-server")
  const after = yield* session.send("hello").pipe(Effect.flip)
  check(after._tag === "AgentError", "later calls fail")
  const f = failure as { signal: string | null; exitCode: number | null }
  return `ProcessKilled signal=${f.signal} exitCode=${f.exitCode}; command gone; later send -> AgentError`
}).pipe(Effect.provide(agentLayer("killed")))

const scenarios: Record<string, Scenario> = {
  simple,
  command,
  env,
  "steer-landed": steerLands,
  "steer-stale": steerStale,
  interrupt,
  queue,
  "resume-missing": resumeMissing,
  resume,
  "spend-cap": spendCap,
  "no-price": noPrice,
  killed,
}

const appServers = () => {
  try {
    return execSync(`pgrep -f -u ${process.getuid?.() ?? 0} -- "codex app-server$"`).toString().trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

const main = Effect.gen(function* () {
  const before = new Set(appServers())
  let failed = 0
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (only.length > 0 && !only.includes(name)) continue
    const t0 = Date.now()
    const exit = yield* Effect.scoped(scenario).pipe(Effect.timeout(Duration.minutes(5)), Effect.exit)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (exit._tag === "Success") console.log(`PASS ${name} (${secs}s): ${exit.value}`)
    else {
      failed++
      console.log(`FAIL ${name} (${secs}s): ${String(exit.cause)}`)
    }
  }
  yield* Effect.sleep(Duration.seconds(1))
  const leaked = appServers().filter((pid) => !before.has(pid))
  console.log(leaked.length === 0 ? "no app-server processes left running" : `LEAKED app-server pids: ${leaked.join(" ")}`)
  if (failed > 0 || leaked.length > 0) process.exitCode = 1
})

Effect.runPromise(main).catch((e) => {
  console.error(e)
  process.exitCode = 1
})
