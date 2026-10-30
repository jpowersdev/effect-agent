/**
 * The host's side of remote hooks: the provider session's hook functions call
 * `call`, which forwards the call to an attached client that registered to
 * answer that hook (`HookRequests`) and waits for its `HookResponse`.
 *
 * - Who answers: of the registered clients that have that hook, the one that
 *   attached most recently (ranked by its first registration, so a client
 *   that only reconnects keeps its place).
 * - No such client: the hook adds nothing, at once.
 * - Timeout: the chosen client's `timeoutMs`, from when the call was made. On
 *   timeout the hook adds nothing (and it is logged); the agent never waits
 *   longer.
 * - A client whose connection drops before answering: its calls wait, and are
 *   delivered again when it (or another answerer) registers, until their
 *   timeout.
 */
import { type Cause, Deferred, Duration, Effect, Exit, Option, Queue, Stream } from "effect"
import { randomUUID } from "node:crypto"
import type { HookCall, HookName, HookRequest, HookStreamItem } from "./protocol.ts"

export interface Answerer {
  readonly clientId: string
  readonly hooks: ReadonlyArray<HookName>
  readonly timeoutMs: number
}

interface Registration {
  readonly clientId: string
  readonly rank: number
  readonly hooks: ReadonlySet<HookName>
  readonly timeoutMs: number
  readonly queue: Queue.Queue<HookRequest, Cause.Done>
}

interface Pending {
  readonly request: HookRequest
  readonly result: Deferred.Deferred<Option.Option<string>>
  assigned: Registration | null
}

export const make = (options: {
  /** Internal, tests only: called before each delivery; true drops it (as a lost connection would). */
  readonly dropDelivery?: () => boolean
} = {}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>()
    const registrations = new Set<Registration>()
    const ranks = new Map<string, number>()
    const pending = new Map<string, Pending>()
    let closed = false

    const best = (hook: HookName): Registration | null => {
      let pick: Registration | null = null
      for (const r of registrations) if (r.hooks.has(hook) && (pick === null || r.rank > pick.rank)) pick = r
      return pick
    }

    const deliver = (p: Pending) => {
      p.assigned = null
      const r = best(p.request.hook)
      if (r === null || options.dropDelivery?.() === true) return
      p.assigned = r
      Queue.offerUnsafe(r.queue, p.request)
    }

    /** Register `answerer`; the stream carries the calls it should run, until the session ends. */
    const register = (answerer: Answerer): Stream.Stream<HookStreamItem> =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (closed) return Stream.empty as Stream.Stream<HookStreamItem>
          const queue = yield* Queue.unbounded<HookRequest, Cause.Done>()
          let rank = ranks.get(answerer.clientId)
          if (rank === undefined) {
            rank = ranks.size + 1
            ranks.set(answerer.clientId, rank)
          }
          const registration: Registration = {
            clientId: answerer.clientId,
            rank,
            hooks: new Set(answerer.hooks),
            timeoutMs: answerer.timeoutMs,
            queue,
          }
          registrations.add(registration)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registrations.delete(registration)
              // Unanswered calls go to whoever answers now, or wait for a registration.
              for (const p of pending.values()) if (p.assigned === registration || p.assigned === null) deliver(p)
            }),
          )
          // Calls waiting since a connection dropped.
          for (const p of pending.values()) if (p.assigned === null) deliver(p)
          return Stream.concat(Stream.succeed<HookStreamItem>({ _tag: "Registered" }), Stream.fromQueue(queue))
        }),
      )

    const call = (hook: HookName, input: HookCall | null): Effect.Effect<Option.Option<string>> =>
      Effect.suspend(() => {
        const answerer = best(hook)
        if (closed || answerer === null) return Effect.succeedNone
        const hookId = randomUUID()
        const p: Pending = { request: { _tag: "HookRequest", hookId, hook, call: input }, result: Deferred.makeUnsafe(), assigned: null }
        pending.set(hookId, p)
        deliver(p)
        return Deferred.await(p.result).pipe(
          Effect.timeoutOption(Duration.millis(answerer.timeoutMs)),
          Effect.flatMap((answer) =>
            Option.isSome(answer)
              ? Effect.succeed(answer.value)
              : Effect.as(
                  Effect.logWarning(`hook ${hook} (${hookId}) timed out after ${answerer.timeoutMs} ms; it adds nothing`),
                  Option.none<string>(),
                ),
          ),
          Effect.ensuring(Effect.sync(() => pending.delete(hookId))),
          // The host's logger, even when the provider's SDK runs the hook outside the host's fibers.
          Effect.provideContext(services),
        )
      })

    /** A client's answer; unknown (late, or repeated) ids are ignored. */
    const respond = (hookId: string, result: string | null) =>
      Effect.sync(() => {
        const p = pending.get(hookId)
        if (p === undefined) return
        Deferred.doneUnsafe(p.result, Exit.succeed(result === null || result === "" ? Option.none() : Option.some(result)))
      })

    /** The session ended: end every registration's stream; waiting calls add nothing. */
    const close = Effect.sync(() => {
      closed = true
      for (const r of registrations) Queue.endUnsafe(r.queue)
      for (const p of pending.values()) Deferred.doneUnsafe(p.result, Exit.succeed(Option.none()))
    })

    return { register, call, respond, close, answerers: () => registrations.size }
  })

export type HookBridge = Effect.Success<ReturnType<typeof make>>
