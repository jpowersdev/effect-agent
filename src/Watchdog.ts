/**
 * Idle detection shared by the providers. Feed it every event a session
 * emits; it reports a running turn that has gone quiet for too long. Any
 * event counts as activity, including `Heartbeat`, so a model that is
 * thinking is not idle. While a tool call is open the `toolIdle` limit
 * applies instead, since a long build or test run can be silent.
 */
import { Clock, Duration, Effect, Queue, type Scope, Stream } from "effect"
import type { AgentEvent } from "./AgentEvent.ts"
import type { TurnId } from "./Domain.ts"

export interface Options {
  readonly idle: Duration.Input
  readonly toolIdle?: Duration.Input
}

export interface Expiry {
  readonly turnId: TurnId
  readonly idleMs: number
  readonly inTool: boolean
}

export interface Watchdog {
  readonly observe: (event: AgentEvent) => Effect.Effect<void>
  /** At most one per turn. */
  readonly expirations: Stream.Stream<Expiry>
}

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

    yield* Effect.sleep(Duration.millis(checkMs)).pipe(Effect.andThen(check), Effect.forever, Effect.forkScoped)

    return { observe, expirations: Stream.fromQueue(expired) }
  })
