/**
 * Cross-process survival with the real CLIs.
 *
 *   node scripts/live-reattach.ts            # claude, then codex
 *   node scripts/live-reattach.ts codex      # one provider
 *   node scripts/live-reattach.ts hooks      # remote hooks (Claude)
 *
 * For each provider:
 *   1. Process A (a child node process) opens a session with
 *      `onScopeClose: "detach"`, starts a turn that runs `sleep 8 && echo
 *      survived`, prints the session and turn ids once the command is running,
 *      and exits mid-turn.
 *   2. This process (B) attaches by id, catches up with `subscribeFrom(0)`,
 *      then drops its connection mid-turn (the host's internal SIGUSR2 test
 *      trigger) while the command runs; the client reconnects on its own.
 *      `awaitTurn` gets the result (it must contain "survived").
 *   3. B runs a second command turn with `turn()` and drops the connection
 *      again mid-turn: the call still returns that turn's result.
 *   4. B `end`s the session, checks its subscription saw every seq exactly
 *      once across both drops, and that the host's events file (read with
 *      `AgentHosts.events` after the host exited) matches it event for event.
 *   5. It checks the host and agent processes are gone.
 *
 * `hooks`: a remote Claude session whose hooks run in this process. A
 * `beforeTool` adds a secret word the reply must contain; a `beforeStop`
 * that answers once keeps the turn going; and with only a hookless client
 * attached, a hooked turn completes with the hook adding nothing.
 *
 * Runs in /tmp/effect-agent-live/reattach/ (Claude `claude-haiku-5-5`, Codex at
 * effort `low`); each provider costs two short command turns.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Duration, Effect, Fiber, Option, Ref, Stream } from "effect"
import { type RunOptions, SessionId, TurnId } from "../src/index.ts"
import { AgentHosts, HostSpec, RemoteAgent, type SeqEvent } from "../src/host/index.ts"
import { host } from "../test/support/hostCommand.ts"

const root = "/tmp/effect-agent-live/reattach"
const dir = join(root, "hosts")
const self = fileURLToPath(import.meta.url)
type Provider = "claude" | "codex"

const check = (cond: unknown, message: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`)
  console.log(`  ok: ${message}`)
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const options = (provider: Provider): RemoteAgent.RemoteAgentOptions => ({
  provider,
  host,
  dir,
  onScopeClose: "detach",
  ...(provider === "claude" && { claude: { model: "claude-haiku-5-5" } }),
})

const run = (provider: Provider): RunOptions => {
  const cwd = join(root, provider, "work")
  mkdirSync(cwd, { recursive: true })
  return {
    cwd,
    ...(provider === "codex" && { effort: "low" as const }),
    appendSystemPrompt: "Keep every reply under ten words.",
  }
}

const command = (cmd: string) => `Run this exact shell command and wait for it to finish: ${cmd}\nThen reply with only its output.`
const prompt = command("sleep 8 && echo survived")

/** The host's internal test trigger: drop every client connection, keep running. */
const dropConnections = (hostPid: number) => process.kill(hostPid, "SIGUSR2")
const dropsLogged = (sessionId: string) => {
  try {
    return readFileSync(HostSpec.logPath(dir, sessionId), "utf8").split("\n").filter((l) => l.includes("dropping")).length
  } catch {
    return 0
  }
}
const waitFor = (cond: () => boolean, what: string, ms = 60_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (!cond()) {
      if (Date.now() > deadline) return yield* Effect.fail(new Error(`timed out waiting for ${what}`))
      yield* Effect.sleep(Duration.millis(50))
    }
  })

// ---------------------------------------------------------------------------
// Process A: open, start the turn, exit while the command runs
// ---------------------------------------------------------------------------

const processA = (provider: Provider) =>
  Effect.gen(function* () {
    const session = yield* (yield* AgentHosts).open(run(provider))
    const events = yield* session.subscribe
    const messageId = yield* session.send(prompt)
    let turnId: string | null = null
    yield* events.pipe(
      Stream.takeUntil((e) => {
        if (e._tag === "MessageLanded" && e.messageId === messageId) turnId = e.turnId
        return e._tag === "ToolCall" && turnId !== null && e.turnId === turnId
      }),
      Stream.runDrain,
      Effect.timeout(Duration.seconds(90)),
    )
    const agentPid = Option.getOrNull(yield* session.pid)
    console.log(JSON.stringify({ sessionId: session.sessionId, turnId, hostPid: session.hostPid, agentPid }))
    // Gone mid-turn, without even closing the scope.
    process.exit(0)
  }).pipe(Effect.scoped, Effect.provide(RemoteAgent.layer(options(provider))))

// ---------------------------------------------------------------------------
// Process B
// ---------------------------------------------------------------------------

interface Started {
  readonly sessionId: string
  readonly turnId: string
  readonly hostPid: number
  readonly agentPid: number | null
}

const startA = (provider: Provider) =>
  Effect.callback<Started, Error>((resume) => {
    const child = spawn(process.execPath, [self, "--process-a", provider], { stdio: ["ignore", "pipe", "inherit"] })
    let out = ""
    child.stdout.on("data", (d: Buffer) => (out += d.toString()))
    child.on("exit", (code) => {
      const line = out.trim().split("\n").at(-1) ?? ""
      if (code !== 0) return resume(Effect.fail(new Error(`process A exited ${code}: ${out}`)))
      try {
        resume(Effect.succeed(JSON.parse(line) as Started))
      } catch {
        resume(Effect.fail(new Error(`process A printed ${out}`)))
      }
    })
  })

const processB = (provider: Provider) =>
  Effect.gen(function* () {
    console.log(`\n== ${provider} ==`)
    const t0 = Date.now()
    const a = yield* startA(provider)
    console.log(`  process A exited after ${Date.now() - t0} ms: session ${a.sessionId}, turn ${a.turnId}, host ${a.hostPid}, agent ${a.agentPid}`)
    check(isAlive(a.hostPid), "the host outlived process A")
    if (a.agentPid !== null) check(isAlive(a.agentPid), "the agent process is still running")

    const hosts = yield* AgentHosts
    const seen = yield* Effect.gen(function* () {
      const session = yield* hosts.attach(SessionId.make(a.sessionId))
      check(session.hostPid === a.hostPid, "attached to the same host")
      const seqAtAttach = yield* session.lastSeq
      const caughtUp: Array<SeqEvent> = []
      const reader = yield* session.subscribeFrom(0).pipe(
        Stream.runForEach((e) => Effect.sync(() => caughtUp.push(e))),
        Effect.forkScoped,
      )

      // Drop the connection while the command is still running.
      const awaiting = yield* session.awaitTurn(TurnId.make(a.turnId)).pipe(Effect.timeout(Duration.seconds(120)), Effect.forkScoped)
      yield* Effect.sleep(Duration.millis(500))
      const commandRunning = !caughtUp.some((e) => e.event._tag === "ToolResult" && e.event.turnId === a.turnId)
      dropConnections(a.hostPid)
      yield* waitFor(() => dropsLogged(a.sessionId) === 1, "the host to drop the connection")
      check(commandRunning, "dropped the connection while the command was still running")
      const result = yield* Fiber.join(awaiting)
      console.log(`  turn ended after ${Date.now() - t0} ms: ${JSON.stringify(result.finalText)}`)
      check(result.finalText.toLowerCase().includes("survived"), "the turn started by process A finished with its output, across the drop")

      // A `turn()` call spanning a drop.
      const before = caughtUp.length
      const second = yield* session.turn(command("sleep 4 && echo again")).pipe(Effect.timeout(Duration.seconds(120)), Effect.forkScoped)
      yield* waitFor(() => caughtUp.slice(before).some((e) => e.event._tag === "ToolCall"), "the second turn's command")
      dropConnections(a.hostPid)
      yield* waitFor(() => dropsLogged(a.sessionId) === 2, "the host to drop the connection again")
      const next = yield* Fiber.join(second)
      check(next.finalText.toLowerCase().includes("again"), `turn() returned its turn's result across a drop: ${JSON.stringify(next.finalText)}`)

      yield* session.end
      yield* Fiber.join(reader).pipe(Effect.timeout(Duration.seconds(15)))
      const seqs = caughtUp.map((e) => e.seq)
      check(seqs.every((s, i) => s === i), `caught up on ${seqs.length} events, seq 0..${seqs.length - 1}, each once, across both drops`)
      check(
        caughtUp.filter((e) => e.event._tag === "TurnStarted").length === 2 &&
          caughtUp.filter((e) => e.event._tag === "MessageLanded").length === 2,
        "two turns, two landed messages: nothing was sent twice",
      )
      check(caughtUp[0]?.event._tag === "SessionStarted", "the catch-up starts with SessionStarted")
      const tags = caughtUp.map((e) => e.event)
      const toolResult = caughtUp.find((e) => e.event._tag === "ToolResult" && e.event.output.includes("survived"))
      check(toolResult !== undefined, "the catch-up includes the command's result")
      check(
        toolResult !== undefined && toolResult.seq > seqAtAttach,
        `that result (seq ${toolResult?.seq}) came after process A was gone (last seq at attach: ${seqAtAttach})`,
      )
      check(tags.filter((e) => e._tag === "TurnEnded").length === 2, "both turns ended in the log")
      return caughtUp
    }).pipe(Effect.scoped)

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && (isAlive(a.hostPid) || (a.agentPid !== null && isAlive(a.agentPid)))) {
      yield* Effect.sleep(Duration.millis(100))
    }
    check(!isAlive(a.hostPid), "the host process is gone")
    if (a.agentPid !== null) check(!isAlive(a.agentPid), "the agent process is gone")
    check((yield* hosts.list).every((m) => m.sessionId !== a.sessionId), "the host is no longer listed")
    check(
      !existsSync(HostSpec.socketPath(dir, a.sessionId)) && !existsSync(HostSpec.manifestPath(dir, a.sessionId)),
      "its socket and manifest are removed",
    )
    const logged = yield* hosts.events(SessionId.make(a.sessionId)).pipe(Stream.runCollect)
    check(
      JSON.stringify(logged.map((e) => [e.seq, e.event._tag])) === JSON.stringify(seen.map((e) => [e.seq, e.event._tag])),
      `the retained events file has the same ${logged.length} events the subscription saw`,
    )
    rmSync(HostSpec.eventsPath(dir, a.sessionId), { force: true })
    rmSync(HostSpec.logPath(dir, a.sessionId), { force: true })
    console.log(`  ${provider} passed in ${Date.now() - t0} ms`)
  }).pipe(Effect.provide(RemoteAgent.layer(options(provider))))

// ---------------------------------------------------------------------------
// Remote hooks (Claude)
// ---------------------------------------------------------------------------

const secretPrompt =
  "Use the Bash tool once to run `echo hello`. Context added while the tool runs may tell you a secret word. Then reply with just the secret word, or NONE if you were not told one."

const hooksScenario = Effect.gen(function* () {
  console.log("\n== claude: remote hooks ==")
  const t0 = Date.now()
  const hosts = yield* AgentHosts
  const base = run("claude")
  const created: Array<string> = []

  // beforeTool answered from this process.
  yield* Effect.gen(function* () {
    const calls: Array<string> = []
    const session = yield* hosts.open({
      ...base,
      hooks: {
        beforeTool: (call) =>
          Effect.sync(() => {
            calls.push(call.name)
            return Option.some("The secret word is MANGO.")
          }),
      },
    })
    created.push(session.sessionId)
    const done = yield* session.turn(secretPrompt).pipe(Effect.timeout(Duration.seconds(120)))
    console.log(`  beforeTool calls ${calls.join(",")}; reply ${JSON.stringify(done.finalText)}`)
    check(calls.includes("Bash"), "the remote session's beforeTool ran here, for Bash")
    check(/MANGO/.test(done.finalText), "the reply has the secret word the hook added")
    yield* session.stop
  }).pipe(Effect.scoped)

  // beforeStop answering once keeps the turn going.
  yield* Effect.gen(function* () {
    const asked = yield* Ref.make(0)
    const session = yield* hosts.open({
      ...base,
      hooks: {
        beforeStop: () =>
          Ref.getAndUpdate(asked, (n) => n + 1).pipe(
            Effect.map((n) => (n === 0 ? Option.some("Before you finish, reply once more with just the word KIWI.") : Option.none())),
          ),
      },
    })
    created.push(session.sessionId)
    const events = yield* session.subscribe
    const collected = yield* events.pipe(Stream.runCollect, Effect.forkScoped)
    const done = yield* session.turn("Reply with just: hello").pipe(Effect.timeout(Duration.seconds(120)))
    yield* session.end
    const all = yield* Fiber.join(collected)
    const texts = all.flatMap((e) => (e._tag === "Text" ? [e.text] : []))
    console.log(`  beforeStop calls ${yield* Ref.get(asked)}; texts ${JSON.stringify(texts)}; final ${JSON.stringify(done.finalText)}`)
    check((yield* Ref.get(asked)) >= 2, "beforeStop ran again after the turn continued")
    check(texts.some((t) => /KIWI/.test(t)), "the turn acted on the stop hook's text")
    check(all.filter((e) => e._tag === "TurnEnded").length === 1, "all in one turn")
  }).pipe(Effect.scoped)

  // The hooked client detaches; a hookless one runs a turn: the hook adds nothing, without waiting.
  const calls = yield* Ref.make(0)
  const sessionId = yield* Effect.gen(function* () {
    const session = yield* hosts.open(
      { ...base, hooks: { beforeTool: () => Effect.as(Ref.update(calls, (n) => n + 1), Option.some("The secret word is MANGO.")) } },
      { hookTimeout: "30 seconds" },
    )
    created.push(session.sessionId)
    yield* session.detach
    return session.sessionId
  }).pipe(Effect.scoped)
  yield* Effect.gen(function* () {
    const session = yield* hosts.attach(sessionId)
    const t1 = Date.now()
    const done = yield* session.turn(secretPrompt).pipe(Effect.timeout(Duration.seconds(120)))
    const ms = Date.now() - t1
    console.log(`  detached: reply ${JSON.stringify(done.finalText)} in ${ms} ms`)
    check(!/MANGO/.test(done.finalText), "with the hooked client detached, the hook added nothing")
    check((yield* Ref.get(calls)) === 0, "the detached client's hook was never called")
    check(ms < 30_000, "and the turn didn't wait for the 30 s hook timeout")
    yield* session.stop
  }).pipe(Effect.scoped)

  check((yield* hosts.list).length === 0, "no hosts left")
  for (const id of created) {
    rmSync(HostSpec.eventsPath(dir, id), { force: true })
    rmSync(HostSpec.logPath(dir, id), { force: true })
  }
  console.log(`  hooks passed in ${Date.now() - t0} ms`)
}).pipe(Effect.provide(RemoteAgent.layer({ ...options("claude"), onScopeClose: "stop" })))

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args[0] === "--process-a") {
  Effect.runPromise(processA(args[1] as Provider)).catch((e) => {
    console.error("process A failed:", e)
    process.exit(1)
  })
} else {
  mkdirSync(dir, { recursive: true })
  const providers = (args.length > 0 ? args : ["claude", "codex"]) as Array<Provider | "hooks">
  const scenario = (name: Provider | "hooks") => (name === "hooks" ? hooksScenario : processB(name))
  Effect.runPromise(Effect.forEach(providers, scenario, { discard: true })).then(
    () => {
      rmSync(join(dir, "hosts.stderr.log"), { force: true })
      console.log("\nall passed")
    },
    (e) => {
      console.error("\nFAILED:", e)
      // Leave nothing running: stop any host this script started.
      for (const host of RemoteAgent.listHosts(dir)) process.kill(host.pid, "SIGTERM")
      process.exit(1)
    },
  )
}
