/**
 * Cross-process survival with the real CLIs.
 *
 *   node scripts/live-reattach.ts            # claude, then codex
 *   node scripts/live-reattach.ts codex      # one provider
 *
 * For each provider:
 *   1. Process A (a child node process) opens a session with
 *      `onScopeClose: "detach"`, starts a turn that runs `sleep 8 && echo
 *      survived`, prints the session and turn ids once the command is running,
 *      and exits mid-turn.
 *   2. This process (B) attaches by id, catches up with `subscribeFrom(0)`,
 *      `awaitTurn`s the result (it must contain "survived"), runs one more
 *      short turn, and `end`s the session.
 *   3. It checks the host and agent processes are gone.
 *
 * Runs in /tmp/effect-agent-live/reattach/ (Claude `claude-haiku-5-5`, Codex at
 * effort `low`); each provider costs one short command turn and one tiny turn.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Duration, Effect, Fiber, Option, Stream } from "effect"
import { type RunOptions, SessionId, TurnId } from "../src/index.ts"
import { AgentHosts, HostSpec, RemoteAgent, type SeqEvent } from "../src/host/index.ts"

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

const prompt = "Run this exact shell command and wait for it to finish: sleep 8 && echo survived\nThen reply with only its output."

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
    yield* Effect.gen(function* () {
      const session = yield* hosts.attach(SessionId.make(a.sessionId))
      check(session.hostPid === a.hostPid, "attached to the same host")
      const seqAtAttach = yield* session.lastSeq
      const caughtUp: Array<SeqEvent> = []
      const reader = yield* session.subscribeFrom(0).pipe(
        Stream.runForEach((e) => Effect.sync(() => caughtUp.push(e))),
        Effect.forkScoped,
      )

      const result = yield* session.awaitTurn(TurnId.make(a.turnId)).pipe(Effect.timeout(Duration.seconds(120)))
      console.log(`  turn ended after ${Date.now() - t0} ms: ${JSON.stringify(result.finalText)}`)
      check(result.finalText.toLowerCase().includes("survived"), "the turn started by process A finished with its output")

      const next = yield* session.turn("Reply with just the word: pong").pipe(Effect.timeout(Duration.seconds(90)))
      check(next.finalText.toLowerCase().includes("pong"), `still controllable: ${JSON.stringify(next.finalText)}`)

      yield* session.end
      yield* Fiber.join(reader).pipe(Effect.timeout(Duration.seconds(15)))
      const seqs = caughtUp.map((e) => e.seq)
      check(seqs.every((s, i) => s === i), `caught up on ${seqs.length} events, seq 0..${seqs.length - 1} with no gaps`)
      check(caughtUp[0]?.event._tag === "SessionStarted", "the catch-up starts with SessionStarted")
      const tags = caughtUp.map((e) => e.event)
      const toolResult = caughtUp.find((e) => e.event._tag === "ToolResult" && e.event.output.includes("survived"))
      check(toolResult !== undefined, "the catch-up includes the command's result")
      check(
        toolResult !== undefined && toolResult.seq > seqAtAttach,
        `that result (seq ${toolResult?.seq}) came after process A was gone (last seq at attach: ${seqAtAttach})`,
      )
      check(tags.filter((e) => e._tag === "TurnEnded").length === 2, "both turns ended in the log")
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
    console.log(`  ${provider} passed in ${Date.now() - t0} ms`)
  }).pipe(Effect.provide(RemoteAgent.layer(options(provider))))

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args[0] === "--process-a") {
  Effect.runPromise(processA(args[1] as Provider)).catch((e) => {
    console.error("process A failed:", e)
    process.exit(1)
  })
} else {
  mkdirSync(dir, { recursive: true })
  const providers = (args.length > 0 ? args : ["claude", "codex"]) as Array<Provider>
  Effect.runPromise(Effect.forEach(providers, processB, { discard: true })).then(
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
