/**
 * A JSONL recording of what a transport sent and received. Lines are
 * buffered in the order they are recorded (`record` is synchronous, so the
 * order is exact) and appended by a fiber every 200 ms, on `flush`, and when
 * the recorder's Scope closes. A write that fails is logged; the session
 * goes on.
 *
 * @internal
 */
import { Effect, Schedule, Semaphore } from "effect"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** @internal */
export interface Recorder {
  readonly record: (line: unknown) => void
  /** Append what has been recorded so far. */
  readonly flush: Effect.Effect<void>
}

/** @internal */
export const none: Recorder = { record: () => {}, flush: Effect.void }

/**
 * Record to `path` until the Scope closes. `truncate` empties the file first;
 * otherwise lines are appended to what is there.
 *
 * @internal
 */
export const make = Effect.fnUntraced(function* (
  path: string,
  options: {
    readonly truncate: boolean
    /** Appends `data` to the file. Tests use it to slow a write down. */
    readonly append?: (path: string, data: string) => Promise<void>
  },
) {
  const append = options.append ?? appendFile
  yield* Effect.tryPromise(async () => {
    await mkdir(dirname(path), { recursive: true })
    if (options.truncate) await writeFile(path, "")
  })
  let buffer: Array<string> = []
  // One write at a time, so concurrent flushes can't reorder lines. A write,
  // once its lines are taken from the buffer, finishes before the next one
  // starts, even if its flush is interrupted (as the periodic one is when the
  // Scope closes): the promise would run on regardless.
  const lock = yield* Semaphore.make(1)
  const flush = lock.withPermit(
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (buffer.length === 0) return Effect.void
        const data = buffer.join("")
        buffer = []
        return Effect.tryPromise(() => append(path, data)).pipe(
          Effect.catch((error) => Effect.logError(`cannot write recording ${path}`, error)),
        )
      }),
    ),
  )
  yield* Effect.addFinalizer(() => flush)
  yield* flush.pipe(Effect.repeat(Schedule.spaced("200 millis")), Effect.forkScoped)
  const recorder: Recorder = {
    record: (line) => {
      buffer.push(`${JSON.stringify(line)}\n`)
    },
    flush,
  }
  return recorder
})
