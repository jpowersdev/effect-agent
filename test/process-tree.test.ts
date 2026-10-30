/**
 * ProcessTree.kill against real processes (Linux: marked processes are found through /proc).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProcessTree } from "../src/index.ts"

/** A marked process that, on SIGTERM, starts a detached child (which inherits the marker) and exits. */
const spawnsOnTerm = (marker: string) => {
  const script = `
    process.on("SIGTERM", () => {
      require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" }).unref()
      setTimeout(() => process.exit(0), 20)
    })
    setInterval(() => {}, 1000)
    process.send?.("ready")
  `
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, [ProcessTree.markerVariable]: marker },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  return Effect.callback<number>((resume) => {
    child.once("message", () => resume(Effect.succeed(child.pid!)))
  })
}

describe.skipIf(process.platform !== "linux")("ProcessTree.kill", () => {
  it.live("stops every marked process, including one started while stopping", () =>
    Effect.gen(function* () {
      const marker = ProcessTree.newMarker()
      const pid = yield* spawnsOnTerm(marker)
      expect(ProcessTree.markedProcesses(marker)).toEqual([pid])
      yield* ProcessTree.kill(marker, { grace: "3 seconds" })
      expect(ProcessTree.isAlive(pid)).toBe(false)
      expect(ProcessTree.markedProcesses(marker)).toEqual([])
    }),
  )

  it.live("sends each process one SIGTERM", () =>
    Effect.gen(function* () {
      const marker = ProcessTree.newMarker()
      const log = join(mkdtempSync(join(tmpdir(), "ea-pt-")), "terms")
      // Counts its SIGTERMs, and takes a moment to exit, as a process cleaning up would.
      const script = `
        process.on("SIGTERM", () => {
          require("node:fs").appendFileSync(${JSON.stringify(log)}, "term\\n")
          setTimeout(() => process.exit(0), 200)
        })
        setInterval(() => {}, 1000)
        process.send?.("ready")
      `
      const child = spawn(process.execPath, ["-e", script], {
        env: { ...process.env, [ProcessTree.markerVariable]: marker },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
      })
      yield* Effect.callback<void>((resume) => {
        child.once("message", () => resume(Effect.void))
      })
      // Its own group too, as the providers pass it: still one SIGTERM.
      yield* ProcessTree.kill(marker, { pid: child.pid!, grace: "3 seconds" })
      expect(readFileSync(log, "utf8")).toBe("term\n")
    }),
  )

  it.live("a process started in the group after its SIGTERM gets one too", () =>
    Effect.gen(function* () {
      const marker = ProcessTree.newMarker()
      const log = join(mkdtempSync(join(tmpdir(), "ea-pt-")), "terms")
      const child = `
        process.on("SIGTERM", () => {
          require("node:fs").appendFileSync(${JSON.stringify(log)}, "child\\n")
          process.exit(0)
        })
        setInterval(() => {}, 1000)
        process.send("ready")
      `
      // A group leader that, on SIGTERM, starts a child in its own group (not detached),
      // and exits once the child is listening for SIGTERM itself (or has already gone:
      // a SIGTERM that arrives while it is still starting stops it before it listens).
      const script = `
        process.on("SIGTERM", () => {
          const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
          c.once("message", () => process.exit(0))
          c.once("exit", (_code, signal) => {
            require("node:fs").appendFileSync(${JSON.stringify(log)}, "exit:" + signal + "\\n")
            process.exit(0)
          })
        })
        setInterval(() => {}, 1000)
        process.send?.("ready")
      `
      const leader = spawn(process.execPath, ["-e", script], {
        env: { ...process.env, [ProcessTree.markerVariable]: marker },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
      })
      yield* Effect.callback<void>((resume) => {
        leader.once("message", () => resume(Effect.void))
      })
      const started = Date.now()
      yield* ProcessTree.kill(marker, { pid: leader.pid!, grace: "3 seconds" })
      // Stopped by a SIGTERM of its own (handled, or before it could be), not SIGKILLed at the end of the grace period.
      expect(readFileSync(log, "utf8")).toMatch(/^(child|exit:SIGTERM)\n/)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(ProcessTree.markedProcesses(marker)).toEqual([])
    }),
  )

  it.live("is a no-op when nothing carries the marker", () =>
    Effect.gen(function* () {
      yield* ProcessTree.kill(ProcessTree.newMarker())
    }),
  )
})
