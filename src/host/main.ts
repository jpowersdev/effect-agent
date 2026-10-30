/**
 * Host process entry point: `node src/host/main.ts`, with a JSON `HostSpec`
 * on stdin. Writes one readiness line to stdout (`Ready` or `Failed`), then
 * never touches stdout again; everything else goes to `<dir>/<sessionId>.log`.
 * Started by `RemoteAgent.open`, detached from its caller.
 */
import { Cause, Deferred, Effect, Exit, Logger, Schema } from "effect"
import { closeSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { join } from "node:path"
import { AgentError } from "../AgentError.ts"
import { run } from "./Host.ts"
import { ensureDir, HostSpec, logPath, ReadyLine } from "./HostSpec.ts"

const encodeReady = Schema.encodeSync(Schema.fromJsonString(ReadyLine))
let readySent = false
const ready = (line: ReadyLine) => {
  if (readySent) return
  readySent = true
  try {
    writeSync(1, `${encodeReady(line)}\n`)
  } catch {
    // The parent went away; nothing to tell.
  }
  // Nothing may write to stdout or stderr after this: the parent closes its ends.
  const toLog = (chunk: unknown) => {
    write(typeof chunk === "string" ? chunk : String(chunk))
    return true
  }
  process.stdout.write = toLog as typeof process.stdout.write
  process.stderr.write = toLog as typeof process.stderr.write
}
process.stdout.on("error", () => {})
process.stderr.on("error", () => {})

// ---- log file: host-<pid>.log until the session id is known ----
let logFd: number | null = null
let logFile: string | null = null
const write = (text: string) => {
  if (logFd === null) return
  try {
    writeSync(logFd, text.endsWith("\n") ? text : `${text}\n`)
  } catch {
    // Disk full or similar; logging is best effort.
  }
}

const fail = (message: string): never => {
  ready({ _tag: "Failed", error: new AgentError({ message, provider: "host" }) })
  write(message)
  process.exit(1)
}

let spec: HostSpec
try {
  spec = Schema.decodeUnknownSync(Schema.fromJsonString(HostSpec))(readFileSync(0, "utf8"))
} catch (e) {
  spec = fail(`invalid host spec: ${e instanceof Error ? e.message : String(e)}`)
}

try {
  ensureDir(spec.dir)
  logFile = join(spec.dir, `host-${process.pid}.log`)
  logFd = openSync(logFile, "a", 0o600)
} catch (e) {
  fail(`cannot use host directory ${spec.dir}: ${e instanceof Error ? e.message : String(e)}`)
}

process.on("uncaughtException", (e) => {
  write(`uncaught exception: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})
process.on("unhandledRejection", (e) => {
  write(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
})

const shutdown = Deferred.makeUnsafe<"ended" | "stop" | "sigterm" | "orphan">()
const onSignal = (signal: string) => () => {
  write(`received ${signal}`)
  Deferred.doneUnsafe(shutdown, Exit.succeed("sigterm"))
}
process.on("SIGTERM", onSignal("SIGTERM"))
process.on("SIGINT", onSignal("SIGINT"))
// Detached, so there is no terminal to hang up; ignore it anyway.
process.on("SIGHUP", () => {})

const fileLogger = Logger.make((options) => write(Logger.formatSimple.log(options)))

const program = run(
  spec,
  {
    ready,
    opened: (sessionId) => {
      const target = logPath(spec.dir, sessionId)
      try {
        if (logFile !== null) renameSync(logFile, target)
        logFile = target
      } catch {
        // Keep writing to host-<pid>.log.
      }
    },
  },
  shutdown,
).pipe(
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      const pretty = Cause.pretty(cause)
      write(`host failed: ${pretty}`)
      fail(`host failed: ${pretty.split("\n")[0]}`)
      return 1
    }),
  ),
  Effect.provide(Logger.layer([fileLogger])),
)

Effect.runPromise(program).then(
  (code) => {
    if (!readySent) fail("host exited before it was ready")
    if (logFd !== null) closeSync(logFd)
    process.exit(code)
  },
  (e) => {
    write(`host crashed: ${String(e)}`)
    process.exit(1)
  },
)
