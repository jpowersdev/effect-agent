/**
 * A session's persisted event log, `<dir>/<sessionId>.events.jsonl`: one
 * Schema-encoded `{ seq, event }` per line, in seq order from 0. The host
 * appends each event synchronously before publishing it, so the file is never
 * behind what subscribers have seen. It outlives the host for `retainEvents`
 * (counted from the file's mtime, which the host sets when it exits).
 *
 * When the session ends, the host writes one last line, `{"ended":null}` for a
 * clean end or `{"ended":<encoded AgentError>}`, so a reader of the file ends
 * as a live subscription would: completing, or failing with that error. A
 * file without it (its host was SIGKILLed) is known to be incomplete; reading
 * it completes at its end.
 *
 * A line without its trailing newline (being written, or cut off by a crash)
 * is not part of the log.
 */
import { Data, Effect, Exit, Schema, Stream } from "effect"
import {
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { AgentError } from "../AgentError.ts"
import { SeqEvent } from "./protocol.ts"

export const suffix = ".events.jsonl"

export class EventFileError extends Data.TaggedError("EventFileError")<{ readonly message: string }> {}

const SeqEventJson = Schema.fromJsonString(SeqEvent)
const encodeLine = Schema.encodeSync(SeqEventJson)
const decodeLine = Schema.decodeUnknownExit(SeqEventJson)
/** Lines are encoded with `seq` first, so it can be read without decoding the event. */
const seqPrefix = /^\{"seq":(\d+),/

/** The last line: how the session ended (null: cleanly). */
const Ending = Schema.Struct({ ended: Schema.NullOr(AgentError) })
const EndingJson = Schema.fromJsonString(Ending)
const encodeEnding = Schema.encodeSync(EndingJson)
const decodeEnding = Schema.decodeUnknownExit(EndingJson)
const isEnding = (text: string) => text.startsWith('{"ended":')

/** Every 1 024th seq's byte offset is remembered, so a catch-up seeks instead of scanning from 0. */
const checkpointEvery = 1024

interface Line {
  readonly offset: number
  readonly bytes: number
  readonly text: string
}

/** Complete lines from byte `start` to the current end of the file. */
function* lines(fd: number, start: number): Generator<Line> {
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let pending = Buffer.alloc(0)
  let position = start
  let lineStart = start
  while (true) {
    const n = readSync(fd, chunk, 0, chunk.length, position)
    if (n === 0) return
    position += n
    const data = pending.length > 0 ? Buffer.concat([pending, chunk.subarray(0, n)]) : chunk.subarray(0, n)
    let from = 0
    while (true) {
      const newline = data.indexOf(0x0a, from)
      if (newline < 0) break
      const bytes = newline + 1 - from
      yield { offset: lineStart, bytes, text: data.toString("utf8", from, newline) }
      lineStart += bytes
      from = newline + 1
    }
    pending = Buffer.from(data.subarray(from))
  }
}

/**
 * Entries `from <= seq < until` (`until` undefined: to the end of the file),
 * checked to be contiguous. Yields an `EventFileError` (and stops) on a bad
 * line, a gap, or a file that ends before `until`.
 */
function* entries(
  fd: number,
  from: number,
  until: number | undefined,
  start: number,
  path: string,
): Generator<SeqEvent | EventFileError | AgentError> {
  let expected = from
  for (const line of lines(fd, start)) {
    if (until !== undefined && expected >= until) return
    if (isEnding(line.text)) {
      const ending = decodeEnding(line.text)
      if (Exit.isFailure(ending)) yield new EventFileError({ message: `${path}: unreadable ending at byte ${line.offset}` })
      else if (until !== undefined && expected < until) break
      else if (ending.value.ended !== null) yield ending.value.ended
      return
    }
    const quick = seqPrefix.exec(line.text)
    if (quick !== null && Number(quick[1]) < expected) continue
    const decoded = decodeLine(line.text)
    if (Exit.isFailure(decoded)) {
      yield new EventFileError({ message: `${path}: unreadable line at byte ${line.offset}` })
      return
    }
    const entry = decoded.value
    if (entry.seq < expected) continue
    if (entry.seq !== expected) {
      yield new EventFileError({ message: `${path}: events ${expected} to ${entry.seq - 1} are missing` })
      return
    }
    yield entry
    expected++
  }
  if (until !== undefined && expected < until) {
    yield new EventFileError({ message: `${path}: ends at ${expected}, before ${until}` })
  }
}

/**
 * Read the entries `from <= seq < until` of an events file (see `entries`).
 * Read to its end, it ends as the session did: failing with the session's
 * `AgentError` if it ended with one.
 */
export const read = (
  path: string,
  from: number,
  options: { readonly until?: number; readonly startOffset?: number } = {},
): Stream.Stream<SeqEvent, EventFileError | AgentError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fd = yield* Effect.acquireRelease(
        Effect.try({
          try: () => openSync(path, "r"),
          catch: (e) => new EventFileError({ message: `cannot open ${path}: ${e instanceof Error ? e.message : String(e)}` }),
        }),
        (fd) => Effect.sync(() => closeSync(fd)),
      )
      return Stream.fromIterable(entries(fd, Math.max(0, from), options.until, options.startOffset ?? 0, path)).pipe(
        Stream.mapEffect((item) =>
          item instanceof EventFileError || item instanceof AgentError ? Effect.fail(item) : Effect.succeed(item),
        ),
      )
    }),
  )

export interface Writer {
  readonly path: string
  /** The seq the next appended entry must have (entries already in the file come first). */
  readonly next: number
  /** Append one line; throws if the write fails. */
  readonly append: (entry: SeqEvent) => void
  /** Write the last line: how the session ended. Throws if the write fails. */
  readonly end: (error: AgentError | null) => void
  /** A byte offset at or before `seq`'s line, to start reading from. */
  readonly offsetFor: (seq: number) => number
  /** Stamp the mtime (retention counts from it) and close. Idempotent. */
  readonly close: () => void
}

/**
 * Open (creating, mode 0600) an events file for appending. With `existing`
 * (a resumed session), entries earlier hosts left in it are passed to it in
 * order and numbering continues after them; anything after the last good line
 * is cut off. Without, the file is emptied.
 */
export const openWriter = (path: string, existing: ((entry: SeqEvent) => void) | null): Writer => {
  const fd = openSync(path, "a+", 0o600)
  let closed = false
  try {
    fchmodSync(fd, 0o600)
    const now = new Date()
    // Fresh mtime first, so a concurrent prune doesn't take it for an expired file.
    futimesSync(fd, now, now)
    const checkpoints: Array<number> = []
    let next = 0
    let size = 0
    for (const line of existing !== null ? lines(fd, 0) : []) {
      // The earlier host's ending: the resumed session goes on, so it is cut off.
      if (isEnding(line.text)) break
      const decoded = decodeLine(line.text)
      if (Exit.isFailure(decoded) || decoded.value.seq !== next) break
      if (next % checkpointEvery === 0) checkpoints.push(line.offset)
      existing?.(decoded.value)
      next++
      size = line.offset + line.bytes
    }
    if (fstatSync(fd).size !== size) ftruncateSync(fd, size)
    const write = (text: string) => {
      const line = Buffer.from(`${text}\n`, "utf8")
      let written = 0
      while (written < line.length) written += writeSync(fd, line, written)
      size += line.length
    }
    return {
      path,
      next,
      append: (entry) => {
        if (entry.seq % checkpointEvery === 0) checkpoints[entry.seq / checkpointEvery] = size
        write(encodeLine(entry))
      },
      end: (error) => write(encodeEnding({ ended: error })),
      offsetFor: (seq) => {
        const index = Math.min(Math.floor(seq / checkpointEvery), checkpoints.length - 1)
        return index < 0 ? 0 : (checkpoints[index] ?? 0)
      },
      close: () => {
        if (closed) return
        closed = true
        try {
          const at = new Date()
          futimesSync(fd, at, at)
        } catch {
          // Best effort.
        }
        closeSync(fd)
      },
    }
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

/**
 * Remove events files in `dir` whose session has no live host (`hosted`) and
 * that were last written more than `retainMs` ago.
 */
export const prune = (dir: string, retainMs: number, hosted: (sessionId: string) => boolean): void => {
  let names: Array<string>
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith(suffix)) continue
    const sessionId = name.slice(0, -suffix.length)
    if (hosted(sessionId)) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs >= retainMs) rmSync(path, { force: true })
    } catch {
      // Gone already.
    }
  }
}
