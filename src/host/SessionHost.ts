/**
 * The program a session host process runs. The library ships no executable:
 * add a one-line entry to your app, give it your platform's services, and
 * point `RemoteAgent.layer({ host })` at it.
 *
 * ```ts skip-type-checking
 * // host.ts
 * import { NodeRuntime, NodeServices } from "@effect/platform-node"
 * import { Effect } from "effect"
 * import { SessionHost } from "@jpowersdev/effect-agent/host"
 *
 * NodeRuntime.runMain(SessionHost.run.pipe(Effect.provide(NodeServices.layer)))
 * ```
 *
 * (On Bun: `BunRuntime` and `BunServices` from `@effect/platform-bun`.)
 *
 * `run` reads a JSON `HostSpec` from `Stdio.stdin` and writes one readiness
 * line to `Stdio.stdout` (`Ready` or `Failed`). After that, all output goes
 * to `<dir>/<sessionId>.log`, and it serves one session until it ends.
 *
 * It owns the process while it runs (stdio, signals), so run nothing else in
 * that process. Bundling and the runtime are up to the entry, as for any
 * other entry point in your app.
 *
 * @since 0.1.0
 */
import { Cause, Deferred, Effect, Exit, Logger, Schema, Stdio, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { closeSync, openSync, renameSync, writeSync } from "node:fs"
import { join } from "node:path"
import { AgentError } from "../AgentError.ts"
import { run as runHost } from "./Host.ts"
import { ensureDir, HostSpec, logPath, ReadyLine } from "./HostSpec.ts"

/**
 * The host could not start, or its session failed in a way it couldn't recover from.
 *
 * @since 0.1.0
 * @category errors
 */
export class HostFailed extends Schema.TaggedError<HostFailed>()("HostFailed", {
  message: Schema.String,
}) {}

const encodeReady = Schema.encodeSync(Schema.fromJsonString(ReadyLine))
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Reason = "ended" | "stop" | "sigterm" | "orphan"

/**
 * @since 0.1.0
 * @category running
 */
export const run: Effect.Effect<void, HostFailed, Stdio.Stdio | ChildProcessSpawner.ChildProcessSpawner> = Effect.scoped(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
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

    // ---- readiness: exactly one line on stdout, then stdout/stderr go to the log ----
    let readySent = false
    const ready = (line: ReadyLine) =>
      Effect.suspend(() => {
        if (readySent) return Effect.void
        readySent = true
        // The parent may be gone already; then there is nobody to tell.
        return Stream.make(`${encodeReady(line)}\n`).pipe(Stream.run(stdio.stdout()), Effect.ignore)
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            // The parent closes its end once it has the line, so nothing else may
            // reach stdout or stderr: catch stray writes (e.g. from a dependency).
            const toLog = (chunk: unknown) => {
              write(typeof chunk === "string" ? chunk : String(chunk))
              return true
            }
            process.stdout.write = toLog as typeof process.stdout.write
            process.stderr.write = toLog as typeof process.stderr.write
          }),
        ),
      )
    const failed = (message: string) =>
      ready({ _tag: "Failed", error: new AgentError({ message, provider: "host" }) }).pipe(
        Effect.andThen(Effect.sync(() => write(message))),
        Effect.andThen(Effect.fail(new HostFailed({ message }))),
      )

    // ---- process listeners, removed when `run` ends ----
    const listen = (target: NodeJS.EventEmitter, event: string, listener: (...args: Array<any>) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => target.on(event, listener)),
        () => Effect.sync(() => target.off(event, listener)),
      )
    yield* listen(process.stdout, "error", () => {})
    yield* listen(process.stderr, "error", () => {})

    const spec = yield* stdio.stdin.pipe(
      Stream.decodeText,
      Stream.mkString,
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostSpec))),
      Effect.catch((e) => failed(`invalid host spec: ${describe(e)}`)),
    )

    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          ensureDir(spec.dir)
          logFile = join(spec.dir, `host-${process.pid}.log`)
          logFd = openSync(logFile, "a", 0o600)
        },
        catch: (e) => e,
      }),
      () =>
        Effect.sync(() => {
          if (logFd !== null) closeSync(logFd)
          logFd = null
        }),
    ).pipe(Effect.catch((e) => failed(`cannot use host directory ${spec.dir}: ${describe(e)}`)))

    yield* listen(process, "uncaughtException", (e: unknown) =>
      write(`uncaught exception: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
    )
    yield* listen(process, "unhandledRejection", (e: unknown) =>
      write(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
    )

    // SIGTERM/SIGINT end the session cleanly; detached, so there is no terminal to hang up.
    const shutdown = yield* Deferred.make<Reason>()
    const onSignal = (signal: string) => () => {
      write(`received ${signal}`)
      Deferred.doneUnsafe(shutdown, Exit.succeed("sigterm"))
    }
    yield* listen(process, "SIGTERM", onSignal("SIGTERM"))
    yield* listen(process, "SIGINT", onSignal("SIGINT"))
    yield* listen(process, "SIGHUP", () => {})

    const fileLogger = Logger.make((options) => write(Logger.formatSimple.log(options)))

    const code = yield* runHost(
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
      Effect.catchCause((cause) => {
        const pretty = Cause.pretty(cause)
        write(`host failed: ${pretty}`)
        return failed(`host failed: ${pretty.split("\n")[0]}`)
      }),
      Effect.provide(Logger.layer([fileLogger])),
    )

    if (!readySent) return yield* failed("host exited before it was ready")
    if (code !== 0) return yield* Effect.fail(new HostFailed({ message: `host exited with code ${code}` }))
  }),
)
