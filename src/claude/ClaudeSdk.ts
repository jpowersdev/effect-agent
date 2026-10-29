/**
 * Transport for Claude Code: one `query()` from `@anthropic-ai/claude-agent-sdk`
 * in streaming-input mode, as an Effect service.
 *
 *   import * as ClaudeSdk from "effect-agent/claude/ClaudeSdk"
 *   ClaudeSdk.layer({ record: "/tmp/run.jsonl" })
 *
 * `open` spawns the CLI, waits for its initialize handshake and returns a
 * `ClaudeQuery`: push user messages, read raw frames, interrupt, end. Closing
 * the Scope closes the query (the SDK ends stdin, then kills the process after
 * a short grace) and waits for the frame pump to finish.
 *
 * With `record`, every frame is appended to a JSONL file that
 * `ClaudeReplay.layer` can play back without a process.
 */
import {
  getSessionInfo,
  query as sdkQuery,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export const LifecycleState = Schema.Literals(["queued", "started", "completed", "cancelled", "discarded", "refused"])
export type LifecycleState = typeof LifecycleState.Type

/**
 * `command_lifecycle` frames (capability `msg_lifecycle_v1`). Not part of the
 * SDK's `SDKMessage` union, so they are decoded defensively with `decodeLifecycle`.
 */
export interface CommandLifecycle {
  readonly type: "command_lifecycle"
  readonly command_uuid: string
  readonly state: LifecycleState
  readonly uuid?: string
  readonly session_id?: string
}

/** Anything the CLI writes to us. */
export type Frame = SDKMessage | CommandLifecycle

const isLifecycleState = Schema.is(LifecycleState)

export const decodeLifecycle = (frame: unknown): CommandLifecycle | undefined => {
  if (typeof frame !== "object" || frame === null) return undefined
  const f = frame as Record<string, unknown>
  if (f.type !== "command_lifecycle" || typeof f.command_uuid !== "string" || !isLifecycleState(f.state)) {
    return undefined
  }
  return frame as CommandLifecycle
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ClaudeSdkError extends Schema.TaggedError<ClaudeSdkError>()("ClaudeSdkError", {
  operation: Schema.String,
  message: Schema.String,
  /** The SDK's own tag, e.g. `process_killed_by_signal`, `process_exited_nonzero`, `error_result`. */
  errorClass: Schema.NullOr(Schema.String),
  signal: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
}) {}

export const toSdkError =
  (operation: string) =>
  (cause: unknown): ClaudeSdkError => {
    if (cause instanceof ClaudeSdkError) return cause
    const c = (typeof cause === "object" && cause !== null ? cause : {}) as Record<string, unknown>
    return new ClaudeSdkError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      errorClass: typeof c.errorClass === "string" ? c.errorClass : null,
      signal: typeof c.signal === "string" ? c.signal : null,
      exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
    })
  }

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The subset of `Options` written to a recording's `open` line (for id remapping on replay). */
export interface RecordedOpen {
  readonly sessionId?: string
  readonly resume?: string
  readonly model?: string
}

/**
 * One line of a JSONL recording. `in`/`out`/`ctl interrupt` are the core format;
 * `ctl open`/`ctl end` mark session boundaries and `error` a thrown transport error.
 */
export type RecordLine =
  | { readonly dir: "out"; readonly frame: SDKUserMessage }
  | { readonly dir: "in"; readonly frame: Frame }
  | { readonly dir: "ctl"; readonly call: "interrupt" | "end" }
  | { readonly dir: "ctl"; readonly call: "open"; readonly options: RecordedOpen }
  | {
      readonly dir: "error"
      readonly error: {
        readonly operation: string
        readonly message: string
        readonly errorClass: string | null
        readonly signal: string | null
        readonly exitCode: number | null
      }
    }

const recorder = (path: string | undefined) => {
  if (path === undefined) return (_line: RecordLine) => {}
  mkdirSync(dirname(path), { recursive: true })
  return (line: RecordLine) => appendFileSync(path, JSON.stringify(line) + "\n")
}

export const errorLine = (e: ClaudeSdkError): RecordLine => ({
  dir: "error",
  error: { operation: e.operation, message: e.message, errorClass: e.errorClass, signal: e.signal, exitCode: e.exitCode },
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Claude Code's `~/.claude/projects/<dir>` name for a cwd: every non-alphanumeric becomes `-`; long paths get a hash suffix. */
export const encodeProjectDir = (cwd: string): string => {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (encoded.length <= 200) return encoded
  let hash = 0
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

const canonicalCwd = (cwd: string): string => {
  try {
    return realpathSync(cwd)
  } catch {
    return resolve(cwd)
  }
}

/** The transcript file the CLI writes for a session. `configDir` defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export const transcriptPath = (cwd: string, sessionId: string, configDir?: string): string =>
  join(
    (configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC"),
    "projects",
    encodeProjectDir(canonicalCwd(cwd)),
    `${sessionId}.jsonl`,
  )

/** The CLI version bundled with the installed SDK (its `manifest.json`), or null. */
export const bundledVersion: Effect.Effect<string | null> = Effect.sync(() => {
  try {
    const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const manifest = JSON.parse(readFileSync(join(dirname(entry), "manifest.json"), "utf8")) as { version?: unknown }
    return typeof manifest.version === "string" ? manifest.version : null
  } catch {
    return null
  }
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ClaudeQuery {
  /**
   * Raw frames, buffered for the life of the query. Single consumer, but safe
   * to stop and re-read. Ends when the process exits; fails if it dies.
   */
  readonly frames: Stream.Stream<Frame, ClaudeSdkError>
  /** Queue a user message (set `uuid` and `priority` yourself). */
  readonly send: (message: SDKUserMessage) => Effect.Effect<void, ClaudeSdkError>
  readonly interrupt: Effect.Effect<void, ClaudeSdkError>
  /** End the input stream: the CLI finishes queued work and exits. */
  readonly endInput: Effect.Effect<void>
  /** Close the query now; the process is stopped. */
  readonly close: Effect.Effect<void>
}

export interface SessionLookup {
  readonly sessionId: string
  readonly cwd: string
  /** Where the transcript would be (see `transcriptPath`). */
  readonly transcript: string
}

export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    /** Spawn a query and wait for the CLI's initialize handshake. */
    readonly open: (options: Options) => Effect.Effect<ClaudeQuery, ClaudeSdkError, Scope.Scope>
    /** Whether the CLI has a record of a session (for resume). */
    readonly sessionExists: (lookup: SessionLookup) => Effect.Effect<boolean>
    /** The CLI version, if known without a turn. */
    readonly version: Effect.Effect<string | null>
  }
>()("effect-agent/claude/ClaudeSdk") {}

export interface LayerOptions {
  /** Append every frame to this JSONL file (see `RecordLine`). */
  readonly record?: string
}

const openQuery = Effect.fnUntraced(function* (options: Options, record: (line: RecordLine) => void) {
  const input = yield* Queue.unbounded<SDKUserMessage, Cause.Done>()
  const output = yield* Queue.unbounded<Frame, ClaudeSdkError | Cause.Done>()

  record({
    dir: "ctl",
    call: "open",
    options: {
      ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      ...(options.resume !== undefined && { resume: options.resume }),
      ...(options.model !== undefined && { model: options.model }),
    },
  })

  const query = yield* Effect.try({
    try: () => sdkQuery({ prompt: Stream.toAsyncIterable(Stream.fromQueue(input)), options }),
    catch: toSdkError("open"),
  })

  // Pump the SDK generator into a queue so readers can come and go without
  // calling `return()` on the generator (which would end the session).
  const pump = yield* Stream.fromAsyncIterable(query as AsyncIterable<Frame>, toSdkError("frames")).pipe(
    Stream.runForEach((frame) =>
      Effect.sync(() => {
        record({ dir: "in", frame })
        Queue.offerUnsafe(output, frame)
      }),
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
        if (Option.isSome(error)) {
          record(errorLine(error.value))
          Queue.failCauseUnsafe(output, Cause.fail(error.value))
        } else {
          Queue.endUnsafe(output)
        }
      }),
    ),
    Effect.forkDetach,
  )

  // Close the query (the SDK ends stdin, then force-kills after a grace
  // period), then give the pump time to observe the exit.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Queue.endUnsafe(input)
      query.close()
    }).pipe(
      Effect.andThen(Fiber.await(pump).pipe(Effect.timeoutOption(Duration.seconds(10)))),
      Effect.andThen(Fiber.interrupt(pump)),
    ),
  )

  yield* Effect.tryPromise({ try: () => query.initializationResult(), catch: toSdkError("initialize") })

  const result: ClaudeQuery = {
    frames: Stream.fromQueue(output),
    send: (message) =>
      Effect.suspend(() => {
        record({ dir: "out", frame: message })
        return Queue.offer(input, message)
      }).pipe(
        Effect.flatMap((accepted) =>
          accepted
            ? Effect.void
            : Effect.fail(
                new ClaudeSdkError({
                  operation: "send",
                  message: "input has ended",
                  errorClass: null,
                  signal: null,
                  exitCode: null,
                }),
              ),
        ),
      ),
    interrupt: Effect.suspend(() => {
      record({ dir: "ctl", call: "interrupt" })
      return Effect.tryPromise({ try: () => query.interrupt(), catch: toSdkError("interrupt") })
    }).pipe(Effect.asVoid),
    endInput: Effect.sync(() => {
      record({ dir: "ctl", call: "end" })
      Queue.endUnsafe(input)
    }),
    close: Effect.sync(() => {
      Queue.endUnsafe(input)
      query.close()
    }),
  }
  return result
})

export const layer = (options: LayerOptions = {}): Layer.Layer<ClaudeSdk> =>
  Layer.sync(ClaudeSdk, () => {
    const record = recorder(options.record)
    return ClaudeSdk.of({
      open: (sdkOptions) => openQuery(sdkOptions, record),
      sessionExists: ({ sessionId, cwd, transcript }) =>
        Effect.promise(() => getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined)).pipe(
          Effect.map((info) => info !== undefined || existsSync(transcript)),
        ),
      version: bundledVersion,
    })
  })
