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

  it.live("is a no-op when nothing carries the marker", () =>
    Effect.gen(function* () {
      yield* ProcessTree.kill(ProcessTree.newMarker())
    }),
  )
})
