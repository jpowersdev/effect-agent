/**
 * Stopping everything an agent started. A process-group kill is not enough:
 * both Claude Code's Bash tool and Codex start each command in a new session
 * with its own process group. So every agent process gets a unique
 * `EFFECT_AGENT_PROCESS` variable, which everything it starts inherits, and a
 * sweep signals every live process carrying it (Linux, via /proc). Elsewhere,
 * or for a command that clears its environment, only the agent's own process
 * group is reached; a cgroup `Launcher` (`systemd-run --scope`) closes that gap.
 *
 * @since 0.1.0
 */
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { Duration, Effect } from "effect"

/**
 * The environment variable that marks an agent process and everything it starts.
 *
 * @since 0.1.0
 * @category constants
 */
export const markerVariable = "EFFECT_AGENT_PROCESS"

/**
 * A fresh, unique value for `markerVariable`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const newMarker = (): string => randomUUID()

/** Send a signal to a process (or, with a negative id, a process group). False when it is gone. */
const signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(pid, sig)
    return true
  } catch (e) {
    // EPERM: it exists but isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Live processes whose environment carries `EFFECT_AGENT_PROCESS=<marker>` (Linux; elsewhere none).
 *
 * @since 0.1.0
 * @category utils
 */
export const markedProcesses = (marker: string): Array<number> => {
  if (process.platform !== "linux") return []
  const needle = `\0${markerVariable}=${marker}\0`
  const found: Array<number> = []
  let entries: Array<string>
  try {
    entries = readdirSync("/proc")
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      if (`\0${readFileSync(`/proc/${entry}/environ`, "latin1")}`.includes(needle)) found.push(Number(entry))
    } catch {
      // Gone, or not ours.
    }
  }
  return found
}

/**
 * SIGTERM the process group of `pid` (when given) and every process carrying
 * `marker`, then SIGKILL whatever is left after `grace`. A no-op once they are
 * all gone.
 *
 * @since 0.1.0
 * @category utils
 */
export const kill = (
  marker: string,
  options: { readonly pid?: number | undefined; readonly grace?: Duration.Input } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const send = (sig: NodeJS.Signals | 0) => {
      let alive = options.pid !== undefined ? signal(-options.pid, sig) : false
      for (const p of markedProcesses(marker)) alive = signal(p, sig) || alive
      return alive
    }
    if (!send("SIGTERM")) return
    const deadline = Date.now() + Duration.toMillis(Duration.fromInputUnsafe(options.grace ?? Duration.seconds(3)))
    while (Date.now() < deadline) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      if (!send(0)) return
    }
    send("SIGKILL")
  })

/**
 * SIGKILL the process group of `pid` (when given) and every process carrying `marker`, now.
 *
 * @since 0.1.0
 * @category utils
 */
export const killNow = (marker: string, pid?: number): void => {
  if (pid !== undefined) signal(-pid, "SIGKILL")
  for (const p of markedProcesses(marker)) signal(p, "SIGKILL")
}
