/**
 * Where messages went and how turns ended, read off a session's events:
 * `MessageLanded` / `MessageDropped` settle a message, `TurnEnded` a turn.
 * Shared by the providers (for `send` / `turn` / `steer`) and the host (for
 * `AwaitTurn` / `AwaitMessage` after a reattach).
 *
 * Settled messages and turns are remembered (the last `limit` of each), so
 * asking after the fact answers at once. Asking about one that has been
 * forgotten fails rather than waiting for something that already happened:
 * a forgotten id is kept for the life of the tracker (just the id; the
 * outcome, with its final text, is what `limit` bounds).
 *
 * @internal
 */
import { Deferred, Effect, Exit } from "effect"
import { AgentError, SessionClosed } from "../AgentError.ts"
import type { AgentEvent, TurnOutcome } from "../AgentEvent.ts"
import type { TurnId } from "../Domain.ts"

/** @internal */
export interface TurnTracker {
  /** A message was sent: `landing` waits for it. */
  readonly expect: (messageId: string) => void
  /** A message that was never sent after all (sending it failed). */
  readonly forget: (messageId: string) => void
  readonly observe: (event: AgentEvent) => void
  /** The turn a sent message landed in; fails if it was dropped or the session ended first. */
  readonly landing: (messageId: string) => Effect.Effect<TurnId, AgentError | SessionClosed>
  /** How a turn ended; fails if the session ended first. */
  readonly outcome: (turnId: string) => Effect.Effect<TurnOutcome, AgentError | SessionClosed>
  /**
   * The session ended: whoever is still waiting fails, with `error` if given
   * (else `SessionClosed`). Only the first call counts.
   */
  readonly end: (error: AgentError | SessionClosed | null) => void
  readonly running: () => TurnId | null
  /** Nothing is running (after replaying an earlier host's events: that host is gone). */
  readonly clearRunning: () => void
  /** A turn is running, or a sent message hasn't landed yet. */
  readonly busy: () => boolean
  /** The oldest sent message that hasn't landed. */
  readonly oldestUnlanded: () => string | null
}

/** Set `key` in `map`, dropping the oldest entries past `limit` (each passed to `dropped`). */
const remember = <K, V>(map: Map<K, V>, key: K, value: V, limit: number, dropped: (key: K) => void) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value!
    map.delete(oldest)
    dropped(oldest)
  }
}

/** @internal */
export const make = (options: {
  readonly provider: string
  /** Named in the error for a message this tracker never saw sent, e.g. `host`. */
  readonly owner?: string
  readonly limit?: number
}): TurnTracker => {
  const { provider } = options
  const limit = options.limit ?? 10_000
  const error = (message: string) => new AgentError({ message, provider })

  let running: TurnId | null = null
  let ended: { readonly error: AgentError | SessionClosed | null } | null = null
  /** Sent, not landed or dropped yet (in send order). */
  const unlanded = new Set<string>()
  const landedIn = new Map<string, TurnId>()
  const dropped = new Map<string, string>()
  const outcomes = new Map<string, TurnOutcome>()
  /** Settled, then dropped to stay within `limit`. Never dropped: waiting on one would never end. */
  const forgotten = new Set<string>()
  const forget = (id: string) => {
    forgotten.add(id)
  }
  const messageWaiters = new Map<string, Deferred.Deferred<TurnId, AgentError | SessionClosed>>()
  const turnWaiters = new Map<string, Deferred.Deferred<TurnOutcome, AgentError | SessionClosed>>()

  const droppedError = (messageId: string, reason: string) =>
    error(`message ${messageId} was ${reason} before it reached a turn`)
  const tooOld = (what: string, id: string) =>
    error(`${what} ${id} was settled too long ago to look up (the last ${limit} are kept)`)
  const closed = (message: string) => new SessionClosed({ message, provider })
  const neverLanded = (messageId: string) => closed(`the session ended before message ${messageId} reached a turn`)
  const neverEnded = (turnId: string) => closed(`the session ended before turn ${turnId} did`)

  const settleMessage = (messageId: string, exit: Exit.Exit<TurnId, AgentError | SessionClosed>) => {
    unlanded.delete(messageId)
    const waiter = messageWaiters.get(messageId)
    messageWaiters.delete(messageId)
    if (waiter !== undefined) Deferred.doneUnsafe(waiter, exit)
  }

  const observe = (event: AgentEvent) => {
    switch (event._tag) {
      case "TurnStarted":
        running = event.turnId
        // Claude names a turn after the message that started it.
        if (unlanded.has(event.turnId)) {
          remember(landedIn, event.turnId as string, event.turnId, limit, forget)
          settleMessage(event.turnId, Exit.succeed(event.turnId))
        }
        break
      case "MessageLanded":
        remember(landedIn, event.messageId as string, event.turnId, limit, forget)
        settleMessage(event.messageId, Exit.succeed(event.turnId))
        break
      case "MessageDropped":
        remember(dropped, event.messageId as string, event.reason, limit, forget)
        settleMessage(event.messageId, Exit.fail(droppedError(event.messageId, event.reason)))
        break
      case "TurnEnded": {
        if (running === event.turnId) running = null
        remember(outcomes, event.turnId as string, event.outcome, limit, forget)
        const waiter = turnWaiters.get(event.turnId)
        turnWaiters.delete(event.turnId)
        if (waiter !== undefined) Deferred.doneUnsafe(waiter, Exit.succeed(event.outcome))
        break
      }
    }
  }

  const outcome = (turnId: string): Effect.Effect<TurnOutcome, AgentError | SessionClosed> =>
    Effect.suspend(() => {
      const known = outcomes.get(turnId)
      if (known !== undefined) return Effect.succeed(known)
      if (forgotten.has(turnId)) return Effect.fail(tooOld("turn", turnId))
      if (ended !== null) return Effect.fail(ended.error ?? neverEnded(turnId))
      let waiter = turnWaiters.get(turnId)
      if (waiter === undefined) {
        waiter = Deferred.makeUnsafe<TurnOutcome, AgentError | SessionClosed>()
        turnWaiters.set(turnId, waiter)
      }
      return Deferred.await(waiter)
    })

  const landing = (messageId: string): Effect.Effect<TurnId, AgentError | SessionClosed> =>
    Effect.suspend(() => {
      const turnId = landedIn.get(messageId)
      if (turnId !== undefined) return Effect.succeed(turnId)
      const reason = dropped.get(messageId)
      if (reason !== undefined) return Effect.fail(droppedError(messageId, reason))
      if (forgotten.has(messageId)) return Effect.fail(tooOld("message", messageId))
      if (ended !== null) return Effect.fail(ended.error ?? neverLanded(messageId))
      if (!unlanded.has(messageId)) {
        return Effect.fail(error(`message ${messageId} was not sent through this ${options.owner ?? "session"}`))
      }
      let waiter = messageWaiters.get(messageId)
      if (waiter === undefined) {
        waiter = Deferred.makeUnsafe<TurnId, AgentError | SessionClosed>()
        messageWaiters.set(messageId, waiter)
      }
      return Deferred.await(waiter)
    })

  const end = (reason: AgentError | SessionClosed | null) => {
    if (ended !== null) return
    ended = { error: reason }
    running = null
    for (const [turnId, waiter] of turnWaiters) Deferred.doneUnsafe(waiter, Exit.fail(reason ?? neverEnded(turnId)))
    turnWaiters.clear()
    for (const [messageId, waiter] of messageWaiters) Deferred.doneUnsafe(waiter, Exit.fail(reason ?? neverLanded(messageId)))
    messageWaiters.clear()
  }

  return {
    expect: (messageId) => {
      unlanded.add(messageId)
    },
    forget: (messageId) => {
      unlanded.delete(messageId)
    },
    observe,
    landing,
    outcome,
    end,
    running: () => running,
    clearRunning: () => {
      running = null
    },
    busy: () => running !== null || unlanded.size > 0,
    oldestUnlanded: () => unlanded.values().next().value ?? null,
  }
}

