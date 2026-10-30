/**
 * Stopping everything an agent started.
 *
 * A process-group kill is not enough: both Claude Code's Bash tool and Codex
 * start each command in a new session with its own process group. So every
 * agent process gets a unique `EFFECT_AGENT_PROCESS` variable, which
 * everything it starts inherits, and a sweep signals every live process
 * carrying it (Linux, via /proc).
 *
 * Elsewhere, or for a command that clears its environment, only the agent's
 * own process group is reached. A cgroup `Launcher` (`systemd-run --scope`)
 * closes that gap.
 *
 * @since 0.1.0
 */
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { Duration, Effect, Schedule } from "effect"

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

/**
 * Send a signal to a process (or, with a negative id, a process group). False when it is gone.
 *
 * @since 0.2.0
 * @category utils
 */
export const signal = (pid: number, sig: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(pid, sig)
    return true
  } catch (e) {
    // EPERM: it exists but isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether a process is running (ours or not).
 *
 * @since 0.2.0
 * @category predicates
 */
export const isAlive = (pid: number): boolean => signal(pid, 0)

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

/** A process's group id (Linux, from /proc); undefined if it is gone or unknown. */
const processGroupOf = (pid: number): number | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1")
    // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parentheses.
    const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])
    return Number.isInteger(pgrp) ? pgrp : undefined
  } catch {
    return undefined
  }
}

/**
 * SIGTERM the process group of `pid` (when given) and every process carrying
 * `marker` (each process gets one SIGTERM), then SIGKILL whatever is left
 * after `grace`. Processes they start while stopping (carrying the marker)
 * are found and stopped too. A no-op once they are all gone.
 *
 * @since 0.1.0
 * @category utils
 */
export const kill = (
  marker: string,
  options: { readonly pid?: number | undefined; readonly grace?: Duration.Input } = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const group = options.pid !== undefined ? -options.pid : undefined
    /** Marked processes found so far; each is sent SIGTERM once, when found. */
    const known = new Set<number>()
    const signalAll = (pids: Iterable<number>, sig: NodeJS.Signals | 0) => {
      let alive = false
      for (const p of pids) alive = signal(p, sig) || alive
      return alive
    }
    /** Sweep /proc for marked processes not seen yet, and SIGTERM them (but not `skip`). Whether any is alive. */
    const terminateNew = (skip: ReadonlySet<number> = new Set()) => {
      const found = markedProcesses(marker).filter((p) => !known.has(p))
      for (const p of found) known.add(p)
      return signalAll(found.filter((p) => !skip.has(p)), "SIGTERM") || found.some(isAlive)
    }
    // Sweep before signalling the group, so the members found now are exactly those the
    // group signal reaches: they aren't signalled twice. Anything found later is.
    const before = markedProcesses(marker)
    const inGroup = new Set(options.pid !== undefined ? before.filter((p) => processGroupOf(p) === options.pid) : [])
    const groupAlive = group !== undefined && signal(group, "SIGTERM")
    if (!terminateNew(inGroup) && !groupAlive) return
    // Until all are gone, sweeping /proc again for any they start (with the marker) while
    // stopping: every fourth check while some are alive (a sweep reads every process's
    // environ), and every time the known ones have gone (the group may live on through one).
    let checks = 0
    const done = yield* Effect.sync(() => {
      const knownAlive = signalAll(known, 0)
      const swept = (!knownAlive || ++checks % 4 === 0) && terminateNew()
      if (knownAlive || swept) return false
      return !(group !== undefined && signal(group, 0))
    }).pipe(
      Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (gone) => gone }),
      Effect.timeoutOption(options.grace ?? Duration.seconds(3)),
    )
    if (done._tag === "Some") return
    for (const p of markedProcesses(marker)) known.add(p)
    if (group !== undefined) signal(group, "SIGKILL")
    signalAll(known, "SIGKILL")
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
