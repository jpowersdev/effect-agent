/**
 * Idle detection shared by the providers. Feed it every event a session
 * emits; it reports a running turn that has gone quiet for too long. Any
 * event counts as activity, including `Heartbeat`, so a model that is
 * thinking is not idle. While a tool call is open the `toolIdle` limit
 * applies instead, since a long build or test run can be silent.
 *
 * @since 0.1.0
 */
import { Clock, Duration, Effect, Option, Queue, Schedule, type Scope, Stream } from "effect"
import type { AgentEvent } from "./AgentEvent.ts"
import type { TurnId } from "./Turn.ts"

/**
 * Idle limits; `toolIdle` defaults to `idle`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly idle: Duration.Input
  readonly toolIdle?: Duration.Input
}

/**
 * A running turn that went quiet: for how long, and whether a tool call was open.
 *
 * @since 0.1.0
 * @category models
 */
export interface Expiry {
  readonly turnId: TurnId
  readonly idleMs: number
  readonly inTool: boolean
}

/**
 * @since 0.1.0
 * @category models
 */
export interface Watchdog {
  readonly observe: (event: AgentEvent) => Effect.Effect<void>
  /** At most one per turn. */
  readonly expirations: Stream.Stream<Expiry>
}

/**
 * Start a watchdog. It checks for idle turns until the Scope closes.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options): Effect.Effect<Watchdog, never, Scope.Scope> =>
  Effect.gen(function* () {
    const idleMs = Duration.toMillis(Duration.fromInputUnsafe(options.idle))
    const toolIdleMs = Duration.toMillis(Duration.fromInputUnsafe(options.toolIdle ?? options.idle))
    const checkMs = Math.max(10, Math.min(1_000, Math.min(idleMs, toolIdleMs) / 4))
    const expired = yield* Queue.unbounded<Expiry>()

    const state = {
      turn: null as TurnId | null,
      fired: false,
      openCalls: new Set<string>(),
      lastMs: yield* Clock.currentTimeMillis,
    }

    const observe = (event: AgentEvent) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          state.lastMs = now
          switch (event._tag) {
            case "TurnStarted":
              state.turn = event.turnId
              state.fired = false
              state.openCalls.clear()
              break
            case "ToolCall":
              state.openCalls.add(event.callId)
              break
            case "ToolResult":
              state.openCalls.delete(event.callId)
              break
            case "TurnEnded":
              state.turn = null
              state.openCalls.clear()
              break
          }
        }),
      )

    const check = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (state.turn === null || state.fired) return Effect.void
      const inTool = state.openCalls.size > 0
      const quietMs = now - state.lastMs
      if (quietMs < (inTool ? toolIdleMs : idleMs)) return Effect.void
      state.fired = true
      return Queue.offer(expired, { turnId: state.turn, idleMs: quietMs, inTool })
    })

    yield* check.pipe(Effect.repeat(Schedule.spaced(Duration.millis(checkMs))), Effect.forkScoped)

    return { observe, expirations: Stream.fromQueue(expired) }
  })

/**
 * How a provider stops a stalled turn, for `supervise`.
 *
 * @since 0.2.0
 * @category models
 */
export interface Supervisor {
  /** How long an interrupted turn has to end before the agent process is killed. */
  readonly grace: Duration.Input
  /** Mark the turn as stalled (so it ends `Stalled`). False if it is no longer running: nothing to do. */
  readonly stall: (expiry: Expiry) => Effect.Effect<boolean>
  readonly interrupt: (expiry: Expiry) => Effect.Effect<unknown, unknown>
  /** Waits for the turn to end (failing counts: the session ended). */
  readonly turnEnded: (turnId: TurnId) => Effect.Effect<unknown, unknown>
  /** Kill the agent process, which ends the turn (and the session). */
  readonly kill: Effect.Effect<void>
}

/**
 * The stall policy every provider follows, until the Scope closes: a turn
 * that goes quiet is interrupted; if it hasn't ended `grace` later, the agent
 * process is killed. The interrupt runs on its own, so one that hangs (the
 * process is wedged) can't hold up the kill.
 *
 * @since 0.2.0
 * @category constructors
 */
export const supervise = (watchdog: Watchdog, supervisor: Supervisor): Effect.Effect<void, never, Scope.Scope> =>
  watchdog.expirations.pipe(
    Stream.runForEach((expiry) =>
      Effect.gen(function* () {
        if (!(yield* supervisor.stall(expiry))) return
        yield* supervisor.interrupt(expiry).pipe(Effect.ignore, Effect.forkScoped)
        const ended = yield* supervisor.turnEnded(expiry.turnId).pipe(Effect.exit, Effect.timeoutOption(supervisor.grace))
        if (Option.isNone(ended)) yield* supervisor.kill
      }),
    ),
    Effect.forkScoped,
    Effect.asVoid,
  )
