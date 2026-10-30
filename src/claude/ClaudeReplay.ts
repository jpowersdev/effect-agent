/**
 * `ClaudeSdk` without a process: plays back a JSONL recording made with
 * `ClaudeSdk.layer({ record })`.
 *
 * ```ts skip-type-checking
 * ClaudeAgent.layer().pipe(Layer.provide(ClaudeReplay.layerFile("test/fixtures/claude/simple-turn.jsonl")))
 * ```
 *
 * Each `open` takes the next recorded session (from its `ctl open` line).
 * When the client sends a message or calls a control method, the recorded
 * `in` frames up to the next recorded `out`/`ctl` line are emitted. The
 * client must make the same calls in the same order as the recorded run;
 * otherwise the call fails with a "replay diverged" error.
 *
 * Recorded message uuids are mapped, in order, to the uuids the client sends
 * (and recorded session ids to the client's), so `MessageId`s line up.
 *
 * Recorded `hook` lines (SDK hook calls) are replayed by calling the
 * session's own `Options.hooks` callbacks for that event, with the recorded
 * input, just before the `in` frame at the recorded position. Frames after it
 * wait for the callbacks, as the CLI would.
 *
 * What the callbacks return is passed to `ReplayOptions.onHook`; the model's
 * reply can't change in a replay. Client calls (`send`, `interrupt`,
 * `endInput`) are taken one at a time.
 *
 * `status` and `history` lines are served apart from the session lines:
 * `status` answers with each recorded status in turn (repeating the last),
 * `history` with the line recorded for that session id. Replayed sessions
 * have no process, so `pid` is none and `kill` ends the frames as a SIGKILL
 * would.
 *
 * @since 0.1.0
 */
import type { HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk"
import { Cause, Effect, Layer, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { readFileSync } from "node:fs"
import * as ClaudeSdk from "./ClaudeSdk.ts"

/**
 * A parsed JSONL recording, one `RecordLine` per line.
 *
 * @since 0.1.0
 * @category models
 */
export type Recording = ReadonlyArray<ClaudeSdk.RecordLine>

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const isRecordLine = Schema.is(Schema.Struct({ dir: Schema.Literals(["out", "in", "ctl", "hook", "status", "history", "error"]) }))

/**
 * Parse a JSONL recording; blank lines are skipped. Throws on a line that isn't a `RecordLine`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (text: string): Recording =>
  text.split("\n").flatMap((line, i) => {
    if (line.trim() === "") return []
    const value = Option.getOrUndefined(parseJson(line))
    if (!isRecordLine(value)) throw new Error(`line ${i + 1} of the recording is not a recording line: ${line.slice(0, 200)}`)
    // The SDK frames inside are the SDK's types; only the line's own shape is checked.
    return [value as ClaudeSdk.RecordLine]
  })

/**
 * Read and parse a JSONL recording file.
 *
 * @since 0.1.0
 * @category parsing
 */
export const load = (path: string): Recording => parse(readFileSync(path, "utf8"))

/**
 * @since 0.1.0
 * @category models
 */
export interface ReplayOptions {
  /**
   * Sessions `sessionExists` reports as present, besides those opened
   * earlier in this replay. `"all"` skips the resume precheck entirely.
   */
  readonly knownSessions?: ReadonlyArray<string> | "all"
  /** Reported CLI version; defaults to the first recorded `init` frame's. */
  readonly version?: string | null
  /** Each replayed hook call: the session's callbacks' outputs for the recorded input. */
  readonly onHook?: (call: ReplayedHook) => void
}

/**
 * One replayed hook call, as passed to `ReplayOptions.onHook`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReplayedHook {
  readonly event: HookEvent
  readonly input: unknown
  /** What each of the session's callbacks for that event returned (none: the session has no such hook). */
  readonly outputs: ReadonlyArray<unknown>
  /** What the recorded run's callbacks returned. */
  readonly recorded: unknown
}

const diverged = (operation: string, expected: string, line: ClaudeSdk.RecordLine | undefined) =>
  new ClaudeSdk.ClaudeSdkError({
    operation,
    message: `replay diverged: client called ${expected}, recording has ${
      line === undefined ? "nothing more" : line.dir === "ctl" ? `ctl ${line.call}` : line.dir
    }`,
    errorClass: "replay_diverged",
    signal: null,
    exitCode: null,
  })

const recordedVersion = (recording: Recording): string | null => {
  for (const line of recording) {
    if (line.dir !== "in") continue
    const f = line.frame as { type?: unknown; subtype?: unknown; claude_code_version?: unknown }
    if (f.type === "system" && f.subtype === "init" && typeof f.claude_code_version === "string") {
      return f.claude_code_version
    }
  }
  return null
}

/**
 * `ClaudeSdk` playing back a recording.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (all: Recording, options: ReplayOptions = {}): Layer.Layer<ClaudeSdk.ClaudeSdk> =>
  Layer.sync(ClaudeSdk.ClaudeSdk, () => {
    const statuses = all.flatMap((l) => (l.dir === "status" ? [l.status] : []))
    const histories = all.flatMap((l) => (l.dir === "history" ? [l] : []))
    const recording = all.filter((l) => l.dir !== "status" && l.dir !== "history")
    let statusCursor = 0
    let cursor = 0
    /** Recorded id -> client id (message uuids and session ids). */
    const ids = new Map<string, string>()
    const opened = new Set<string>()
    const recordedSessions = new Set(
      recording.flatMap((l) => (l.dir === "ctl" && l.call === "open" && l.options.sessionId ? [l.options.sessionId] : [])),
    )

    const remap = <A>(value: A): A => {
      if (ids.size === 0) return value
      let text = JSON.stringify(value)
      for (const [recorded, actual] of ids) if (recorded !== actual) text = text.replaceAll(recorded, actual)
      return JSON.parse(text) as A
    }

    const open = (sdkOptions: Parameters<ClaudeSdk.ClaudeSdk["Service"]["open"]>[0]) =>
      Effect.gen(function* () {
        while (cursor < recording.length) {
          const l = recording[cursor]!
          if (l.dir === "ctl" && l.call === "open") break
          cursor++
        }
        const header = recording[cursor]
        if (header === undefined || header.dir !== "ctl" || header.call !== "open") {
          return yield* diverged("open", "open", header)
        }
        cursor++
        if (header.options.sessionId !== undefined && sdkOptions.sessionId !== undefined) {
          ids.set(header.options.sessionId, sdkOptions.sessionId)
        }
        if (header.options.resume !== undefined && sdkOptions.resume !== undefined) {
          ids.set(header.options.resume, sdkOptions.resume)
        }
        if (sdkOptions.sessionId !== undefined) opened.add(sdkOptions.sessionId)

        const output = yield* Queue.unbounded<ClaudeSdk.Frame, ClaudeSdk.ClaudeSdkError | Cause.Done>()
        let ended = false
        const abort = new AbortController()
        const one = yield* Semaphore.make(1)

        // This session's hook calls, by the `in` frame they come before.
        const hooksAt = new Map<number, Array<Extract<ClaudeSdk.RecordLine, { dir: "hook" }>>>()
        for (let i = cursor; i < recording.length; i++) {
          const l = recording[i]!
          if (l.dir === "ctl" && l.call === "open") break
          if (l.dir === "hook") hooksAt.set(l.position, [...(hooksAt.get(l.position) ?? []), l])
        }
        let received = 0

        const callHook = (line: Extract<ClaudeSdk.RecordLine, { dir: "hook" }>) =>
          Effect.promise(async () => {
            const input = remap(line.input) as HookInput
            const toolUseId = (input as { tool_use_id?: string }).tool_use_id
            const outputs: Array<unknown> = []
            for (const matcher of sdkOptions.hooks?.[line.event] ?? []) {
              for (const callback of matcher.hooks) {
                outputs.push(await callback(input, toolUseId, { signal: abort.signal }).catch((e: unknown) => ({ error: String(e) })))
              }
            }
            options.onHook?.({ event: line.event, input, outputs, recorded: line.output })
          })

        /** Hook calls recorded before the `in` frame at `position` (all that are left, with `rest`). */
        const hooksBefore = (position: number, rest = false) =>
          Effect.suspend(() => {
            const due = rest ? [...hooksAt.entries()].filter(([at]) => at >= position).flatMap(([at, ls]) => (hooksAt.delete(at), ls)) : (hooksAt.get(position) ?? [])
            hooksAt.delete(position)
            return Effect.forEach(due, callHook, { discard: true })
          })

        /** Emit `in` frames until the next client action; returns a recorded transport error. */
        const advance = (untilEnd: boolean): Effect.Effect<ClaudeSdk.ClaudeSdkError | undefined> =>
          Effect.gen(function* () {
            while (cursor < recording.length) {
              if (ended) return undefined
              const l = recording[cursor]!
              if (l.dir === "ctl" && l.call === "open") break
              if ((l.dir === "out" || l.dir === "ctl") && !untilEnd) return undefined
              cursor++
              if (l.dir === "in") {
                yield* hooksBefore(received)
                received++
                if (ended) return undefined
                Queue.offerUnsafe(output, remap(l.frame))
              } else if (l.dir === "error") {
                const error = new ClaudeSdk.ClaudeSdkError(remap(l.error))
                ended = true
                Queue.failCauseUnsafe(output, Cause.fail(error))
                return error
              }
            }
            yield* hooksBefore(received, true)
            ended = true
            Queue.endUnsafe(output)
            return undefined
          })

        const expect = (operation: string, matches: (l: ClaudeSdk.RecordLine) => boolean) =>
          Effect.suspend(() => {
            const l = recording[cursor]
            if (ended || l === undefined || !matches(l)) return Effect.fail(diverged(operation, operation, l))
            cursor++
            return Effect.succeed(l)
          })

        const startError = yield* one.withPermit(advance(false))
        if (startError !== undefined) return yield* startError

        const query: ClaudeSdk.ClaudeQuery = {
          frames: Stream.fromQueue(output),
          send: (message) =>
            expect("send", (l) => l.dir === "out").pipe(
              Effect.tap((l) =>
                Effect.sync(() => {
                  const recorded = l.dir === "out" ? l.frame.uuid : undefined
                  if (recorded !== undefined && message.uuid !== undefined) ids.set(recorded, message.uuid)
                }),
              ),
              Effect.andThen(advance(false)),
              Effect.asVoid,
              one.withPermit,
            ),
          interrupt: expect("interrupt", (l) => l.dir === "ctl" && l.call === "interrupt").pipe(
            Effect.andThen(advance(false)),
            Effect.asVoid,
            one.withPermit,
          ),
          endInput: Effect.suspend(() => {
            if (ended) return Effect.void
            const l = recording[cursor]
            if (l !== undefined && l.dir === "ctl" && l.call === "end") cursor++
            return Effect.asVoid(advance(true))
          }).pipe(one.withPermit),
          close: Effect.sync(() => {
            ended = true
            abort.abort()
            Queue.endUnsafe(output)
          }),
          pid: Option.none(),
          kill: Effect.sync(() => {
            if (ended) return
            ended = true
            abort.abort()
            Queue.failCauseUnsafe(
              output,
              Cause.fail(
                new ClaudeSdk.ClaudeSdkError({
                  operation: "frames",
                  message: "Claude Code process terminated by signal SIGKILL",
                  errorClass: "process_killed_by_signal",
                  signal: "SIGKILL",
                  exitCode: null,
                }),
              ),
            )
          }),
        }
        yield* Effect.addFinalizer(() => query.close)
        return query
      })

    return ClaudeSdk.ClaudeSdk.of({
      open,
      sessionExists: ({ sessionId }) =>
        Effect.sync(
          () =>
            options.knownSessions === "all" ||
            opened.has(sessionId) ||
            recordedSessions.has(sessionId) ||
            (options.knownSessions ?? []).includes(sessionId),
        ),
      version: Effect.succeed(options.version !== undefined ? options.version : recordedVersion(recording)),
      status: () =>
        Effect.suspend(() => {
          const status = statuses[Math.min(statusCursor++, statuses.length - 1)]
          return status === undefined ? Effect.fail(diverged("status", "status", recording[cursor])) : Effect.succeed(status)
        }),
      history: ({ sessionId }) =>
        Effect.sync(() => {
          const line = histories.find((l) => l.sessionId === sessionId || ids.get(l.sessionId) === sessionId)
          return line?.history == null ? null : remap(line.history)
        }),
    })
  })

/**
 * `layer` for a recording file, read when the layer is built.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerFile = (path: string, options: ReplayOptions = {}): Layer.Layer<ClaudeSdk.ClaudeSdk> =>
  Layer.suspend(() => layer(load(path), options))
