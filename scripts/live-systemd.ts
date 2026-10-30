/**
 * The systemd recipe (`examples/SystemdLauncher.ts`) with real Claude Code:
 * the agent runs in its own scope, the scope is gone after the session, and a
 * command that runs out of memory is reported as an OOM kill, both with
 * `OOMPolicy=stop` (the turn ends `ProcessKilled`) and `continue` (the agent
 * carries on). Needs a systemd user manager. Small cost (Haiku).
 *
 *   node scripts/live-systemd.ts
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Launcher } from "../src/index.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import * as SystemdLauncher from "../examples/SystemdLauncher.ts"

const model = "claude-haiku-5-5"
const hog =
  'Use the Bash tool to run exactly this command once: python3 -c "bytearray(3 * 1024**3)". Then reply with just DONE, whatever happened.'

const ok = (what: string, cond: boolean) => {
  if (!cond) throw new Error(`FAILED: ${what}`)
  console.log(`  ok: ${what}`)
}
const loadState = (unit: string) =>
  spawnSync("systemctl", ["--user", "show", "--property=LoadState", "--value", unit], { encoding: "utf8" }).stdout.trim()

const scenario = (name: string, options: SystemdLauncher.Options, prompt: string) =>
  Effect.gen(function* () {
    console.log(`\n== ${name} ==`)
    const systemd = yield* SystemdLauncher.make(options)
    const cwd = mkdtempSync(join(tmpdir(), "ea-live-systemd-"))
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open({ cwd, model })
        const [unit] = yield* systemd.units
        const pid = Option.getOrThrow(yield* session.pid)
        ok(`the agent (pid ${pid}) runs in ${unit}`, readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(unit!))
        return yield* session.turn(prompt).pipe(Effect.exit)
      }),
    ).pipe(Effect.provideService(Launcher.Launcher, systemd.launcher))
    const units = yield* systemd.units
    ok("the scope is gone after the session", units.every((unit) => loadState(unit) === "not-found"))
    return { outcome, oomKilled: yield* systemd.oomKilled }
  }).pipe(Effect.scoped)

const program = Effect.gen(function* () {
  const plain = yield* scenario("no limits", {}, "Reply with just: pong")
  ok("the turn succeeded", plain.outcome._tag === "Success")
  ok("no OOM kill", !plain.oomKilled)

  const stop = yield* scenario("MemoryMax=1G, OOMPolicy=stop", { properties: { MemoryMax: "1G", MemorySwapMax: "0" } }, hog)
  const stopFailure = stop.outcome._tag === "Failure" ? stop.outcome.cause : undefined
  console.log(`  turn: ${stop.outcome._tag}${stopFailure !== undefined ? ` (${String(stopFailure).split("\n")[0]})` : ""}`)
  ok("the turn ended ProcessKilled", stopFailure !== undefined && String(stopFailure).includes("ProcessKilled"))
  ok("reported as an OOM kill", stop.oomKilled)

  const cont = yield* scenario(
    "MemoryMax=1G, OOMPolicy=continue",
    { properties: { MemoryMax: "1G", MemorySwapMax: "0" }, oomPolicy: "continue" },
    hog,
  )
  ok("the agent carried on and the turn succeeded", cont.outcome._tag === "Success")
  ok("reported as an OOM kill", cont.oomKilled)
  console.log("\nall passed")
}).pipe(
  Effect.provide(ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer()))),
  Effect.provide(NodeServices.layer),
)

Effect.runPromise(program).catch((e) => {
  console.error(e)
  process.exit(1)
})
