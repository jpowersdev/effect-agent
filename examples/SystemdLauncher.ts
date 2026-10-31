/**
 * A `Launcher` that runs each agent process in its own systemd scope, for
 * Linux machines with a systemd user manager. Copy it into your app; the
 * README's "Process control" section walks through it.
 *
 * What it buys over the library's own cleanup:
 *
 * - Stopping: when the session ends, its scope is stopped, which kills every
 *   process in the cgroup, including commands that cleared their environment
 *   (the `EFFECT_AGENT_PROCESS` sweep can't see those).
 * - Limits: systemd resource-control properties (`MemoryMax`, `TasksMax`,
 *   `CPUQuota`, ...) apply to the agent and everything it starts.
 * - Out-of-memory: a turn that ends `ProcessKilled` doesn't say why;
 *   `oomKilled` says whether the kernel OOM killer struck.
 *
 * Make one per session, in a Scope that outlives the session (e.g. the same
 * one). Its scopes go in a slice of their own, `effect_agent-<id>.slice`,
 * which keeps the OOM count after a scope is gone and is stopped with that
 * Scope. All such slices sit under `effect_agent.slice`, so
 * `systemctl --user set-property effect_agent.slice MemoryMax=16G` caps every
 * agent together.
 *
 * For `RemoteAgent`, the `Launcher` wraps the host process, so the scope
 * holds the host, the agent and its commands. Pass `stopOnEnd: false` there:
 * the session outlives the Scope it was opened in, and its systemd scope ends
 * on its own once the host has exited and nothing else is left in it.
 */
import { Effect, FileSystem, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Launcher } from "../src/index.ts" // in your app: "@jpowersdev/effect-agent"

export interface Options {
  /**
   * Resource-control properties for each agent's scope, e.g.
   * `{ MemoryMax: "4G", TasksMax: "512" }` (see `systemd.resource-control(5)`).
   */
  readonly properties?: Readonly<Record<string, string>>
  /**
   * When the OOM killer kills a process in the scope: `"stop"` (systemd's
   * default) stops the whole scope, agent included, so the turn ends
   * `ProcessKilled`; `"continue"` leaves the rest running, so usually only
   * the runaway command dies and the agent sees it fail.
   */
  readonly oomPolicy?: "stop" | "continue"
  /** Stop the scopes and the slice when their Scopes close. Default true; false for `RemoteAgent` (see above). */
  readonly stopOnEnd?: boolean
}

export interface SystemdLauncher {
  /** Provide this to `open` (or as a layer); every agent process it starts gets its own scope. */
  readonly launcher: Launcher.Launcher["Service"]
  /** The slice holding this launcher's scopes. */
  readonly slice: string
  /** The scope units started so far. */
  readonly units: Effect.Effect<ReadonlyArray<string>>
  /** Whether the OOM killer has killed a process in any of them. */
  readonly oomKilled: Effect.Effect<boolean>
}

export const make = (
  options: Options = {}
): Effect.Effect<
  SystemdLauncher,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const stopOnEnd = options.stopOnEnd ?? true
    const properties = Object.entries({
      ...options.properties,
      ...(options.oomPolicy !== undefined && {
        OOMPolicy: options.oomPolicy
      })
    }).flatMap(([key, value]) => ["--property", `${key}=${value}`])
    // Dashes in a slice name mean nesting, so the id has none.
    const slice = `effect_agent-${crypto.randomUUID().replaceAll("-", "")}.slice`
    const units: Array<string> = []

    const systemctl = (...args: Array<string>) =>
      spawner.string(ChildProcess.make("systemctl", ["--user", ...args])).pipe(
        Effect.map((out) => out.trim()),
        Effect.orElseSucceed(() => "")
      )

    if (stopOnEnd) {
      yield* Effect.addFinalizer(() => systemctl("stop", slice))
    }

    const launcher: Launcher.Launcher["Service"] = {
      prepare: ({ provider }) =>
        Effect.gen(function*() {
          const unit = `effect-agent-${provider}-${crypto.randomUUID()}.scope`
          units.push(unit)
          // Runs after the library has stopped the agent process (finalizers run in reverse).
          if (stopOnEnd) {
            yield* Effect.addFinalizer(() =>
              // A scope that failed (e.g. OOM-killed) stays loaded until reset; the slice keeps the count.
              Effect.andThen(systemctl("stop", unit), systemctl("reset-failed", unit))
            )
          }
          return (command) => ({
            command: "systemd-run",
            args: [
              "--user",
              "--scope",
              "--quiet",
              // systemd-run expands `$VAR` in the command by default, which would mangle arguments (prompts) that contain `$`.
              "--expand-environment=no",
              `--slice=${slice}`,
              `--unit=${unit}`,
              ...properties,
              "--",
              command.command,
              ...command.args
            ]
          })
        })
    }

    return {
      launcher,
      slice,
      units: Effect.sync(() => [...units]),
      // The slice's memory.events counts kills in every scope under it, including ones already gone.
      oomKilled: Effect.gen(function*() {
        const cgroup = yield* systemctl("show", "--property=ControlGroup", "--value", slice)
        if (cgroup === "") {
          return false
        }
        const events = yield* fs.readFileString(`/sys/fs/cgroup${cgroup}/memory.events`).pipe(
          Effect.orElseSucceed(() => "")
        )
        return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0) > 0
      })
    }
  })
