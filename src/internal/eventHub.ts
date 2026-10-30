/**
 * A session's event fan-out. Every subscription starts with the session's
 * `SessionStarted` (once it is known), then gets every event published after
 * it subscribed, then the session's ending: it completes, or fails with the
 * error the session ended with. A subscription made after the end gets only
 * the ending.
 *
 * @internal
 */
import { Effect, PubSub, type Scope, Stream } from "effect"
import type { AgentError } from "../AgentError.ts"
import type { AgentEvent } from "../AgentEvent.ts"

/** The `PubSub`'s final message: how the session ended (null: cleanly). */
class Ending {
  readonly error: AgentError | null
  constructor(error: AgentError | null) {
    this.error = error
  }
}

/** @internal */
export interface EventHub {
  /** Publish an event. A `SessionStarted` is also kept, to start later subscriptions with. */
  readonly publish: (event: AgentEvent) => Effect.Effect<void>
  /** End every subscription, now and later. Only the first call counts. */
  readonly end: (error: AgentError | null) => Effect.Effect<void>
  /** How the hub ended, if it has: `{ error }`. */
  readonly ended: () => { readonly error: AgentError | null } | null
  readonly subscribe: Effect.Effect<Stream.Stream<AgentEvent, AgentError>, never, Scope.Scope>
}

/** @internal */
export const make: Effect.Effect<EventHub> = Effect.gen(function* () {
  const pubsub = yield* PubSub.unbounded<AgentEvent | Ending>()
  let sessionStarted: AgentEvent | null = null
  let ending: Ending | null = null

  const publish = (event: AgentEvent) =>
    Effect.suspend(() => {
      if (event._tag === "SessionStarted" && sessionStarted === null) sessionStarted = event
      return PubSub.publish(pubsub, event)
    }).pipe(Effect.asVoid)

  const end = (error: AgentError | null) =>
    Effect.suspend(() => {
      if (ending !== null) return Effect.void
      ending = new Ending(error)
      return Effect.asVoid(PubSub.end(pubsub, ending))
    })

  const subscribe = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubsub)
    const tail = Stream.suspend(() => (ending?.error ? Stream.fail(ending.error) : Stream.empty))
    if (ending !== null) return tail
    const prefix = sessionStarted
    const live = Stream.fromSubscription(subscription).pipe(
      Stream.takeWhile((item): item is AgentEvent => !(item instanceof Ending)),
      // Published between subscribing and reading `sessionStarted`: already the prefix.
      Stream.filter((event) => event !== prefix),
    )
    return (prefix === null ? live : Stream.concat(Stream.make(prefix), live)).pipe(Stream.concat(tail))
  })

  return { publish, end, ended: () => ending, subscribe }
})
