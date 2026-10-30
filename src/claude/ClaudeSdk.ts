/**
 * Transport for Claude Code: one `query()` from `@anthropic-ai/claude-agent-sdk`
 * in streaming-input mode, as an Effect service.
 *
 * ```ts skip-type-checking
 * import { ClaudeSdk } from "@jpowersdev/effect-agent/claude"
 * ClaudeSdk.layer({ record: "/tmp/run.jsonl" })
 * ```
 *
 * `open` spawns the CLI, waits for its initialize handshake and returns a
 * `ClaudeQuery`: push user messages, read raw frames, interrupt, end. Closing
 * the Scope closes the query (the SDK ends stdin, then kills the process after
 * a short grace), waits for the frame pump to finish, then kills the process
 * group, so commands the agent left running stop too.
 *
 * The CLI is spawned here (the SDK's `spawnClaudeCodeProcess`), detached into
 * its own process group, with the command wrapped by a `Launcher.Wrap`. Claude
 * Code's Bash tool starts each command in a new session (its own process
 * group), so killing the CLI's group alone would leave `(cmd &)` running; the
 * CLI is also given a unique `EFFECT_AGENT_PROCESS` variable, which every
 * process it starts inherits, and on Linux processes carrying it are killed too.
 *
 * `status` and `history` are the account and transcript reads `ClaudeAgent`
 * needs outside a session.
 *
 * With `record`, every frame (and every status/history answer, and every
 * SDK hook call with what it returned) is appended to a JSONL file that
 * `ClaudeReplay.layer` can play back without a process.
 *
 * @since 0.1.0
 */
import {
  type AccountInfo,
  type HookCallbackMatcher,
  type HookEvent,
  getSessionInfo,
  getSessionMessages,
  query as sdkQuery,
  type Options,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Context, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type * as Launcher from "../Launcher.ts"
import * as ProcessTree from "../ProcessTree.ts"

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * A `command_lifecycle` frame's state.
 *
 * @since 0.1.0
 * @category models
 */
export const LifecycleState = Schema.Literals(["queued", "started", "completed", "cancelled", "discarded", "refused"])
/**
 * @since 0.1.0
 * @category models
 */
export type LifecycleState = typeof LifecycleState.Type

/**
 * `command_lifecycle` frames (capability `msg_lifecycle_v1`). Not part of the
 * SDK's `SDKMessage` union, so they are decoded defensively with `decodeLifecycle`.
 *
 * @since 0.1.0
 * @category models
 */
export interface CommandLifecycle {
  readonly type: "command_lifecycle"
  readonly command_uuid: string
  readonly state: LifecycleState
  readonly uuid?: string
  readonly session_id?: string
}

/**
 * Anything the CLI writes to us.
 *
 * @since 0.1.0
 * @category models
 */
export type Frame = SDKMessage | CommandLifecycle

const isLifecycleState = Schema.is(LifecycleState)

/**
 * A frame as a `CommandLifecycle`, or undefined if it isn't one.
 *
 * @internal
 */
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

/**
 * A failure of an SDK call, the CLI process or a replay.
 *
 * @since 0.1.0
 * @category errors
 */
export class ClaudeSdkError extends Schema.TaggedError<ClaudeSdkError>()("ClaudeSdkError", {
  operation: Schema.String,
  message: Schema.String,
  /** The SDK's own tag, e.g. `process_killed_by_signal`, `process_exited_nonzero`, `error_result`. */
  errorClass: Schema.NullOr(Schema.String),
  signal: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
}) {}

/**
 * Map whatever `operation` threw to a `ClaudeSdkError`; a `ClaudeSdkError` passes through.
 *
 * @internal
 */
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

/**
 * The subset of `Options` written to a recording's `open` line (for id remapping on replay).
 *
 * @since 0.1.0
 * @category models
 */
export interface RecordedOpen {
  readonly sessionId?: string
  readonly resume?: string
  readonly model?: string
}

/**
 * One line of a JSONL recording. `in`/`out`/`ctl interrupt` are the core format;
 * `ctl open`/`ctl end` mark session boundaries and `error` a thrown transport error.
 * `hook` is one call of an SDK hook callback (`Options.hooks`): its event, the
 * input the CLI passed, what the callback returned, and `position`, the number
 * of `in` frames the session had received when the CLI called it. It is
 * written when the callback returns, so it may come after later lines; replay
 * goes by `position`.
 *
 * @since 0.1.0
 * @category models
 */
export type RecordLine =
  | { readonly dir: "out"; readonly frame: SDKUserMessage }
  | { readonly dir: "in"; readonly frame: Frame }
  | { readonly dir: "ctl"; readonly call: "interrupt" | "end" }
  | { readonly dir: "ctl"; readonly call: "open"; readonly options: RecordedOpen }
  | {
      readonly dir: "hook"
      readonly event: HookEvent
      readonly position: number
      readonly input: unknown
      readonly output: unknown
    }
  | { readonly dir: "status"; readonly status: StatusSnapshot }
  | {
      readonly dir: "history"
      readonly sessionId: string
      readonly cwd: string
      readonly history: HistorySnapshot | null
    }
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

/**
 * The recording line for a transport error.
 *
 * @internal
 */
export const errorLine = (e: ClaudeSdkError): RecordLine => ({
  dir: "error",
  error: { operation: e.operation, message: e.message, errorClass: e.errorClass, signal: e.signal, exitCode: e.exitCode },
})

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Claude Code's `~/.claude/projects/<dir>` name for a cwd: every non-alphanumeric becomes `-`; long paths get a hash suffix.
 *
 * @internal
 */
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

/**
 * The transcript file the CLI writes for a session. `configDir` defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`.
 *
 * @internal
 */
export const transcriptPath = (cwd: string, sessionId: string, configDir?: string): string =>
  join(
    (configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC"),
    "projects",
    encodeProjectDir(canonicalCwd(cwd)),
    `${sessionId}.jsonl`,
  )

/**
 * The CLI version bundled with the installed SDK (its `manifest.json`), or null.
 *
 * @internal
 */
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
// Process
// ---------------------------------------------------------------------------

/**
 * How to start the CLI process.
 *
 * @since 0.1.0
 * @category models
 */
export interface Launch {
  /** From `Launcher.prepare`; applied to the SDK's command and args at spawn time. */
  readonly wrap: Launcher.Wrap
}

const noLaunch: Launch = { wrap: (command) => command }

/** The last few KB of the CLI's stderr (the SDK only keeps this for processes it spawns itself). */
const stderrTailBytes = 4096

/**
 * An SDK `spawnClaudeCodeProcess` that wraps the command and starts it in its own process group.
 *
 * @internal
 */
export const makeSpawner = (launch: Launch) => {
  let child: ChildProcess | undefined
  let stderr = ""
  const marker = ProcessTree.newMarker()
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    const command = launch.wrap({ command: options.command, args: options.args })
    // `signal` is the SDK's forwarded abort: it fires only after stdin EOF plus a
    // grace period, so it is safe to hand to spawn (which then SIGTERMs the child).
    child = nodeSpawn(command.command, [...command.args], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      env: { ...options.env, [ProcessTree.markerVariable]: marker },
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-stderrTailBytes)
    })
    // The SDK listens for `error` too; this keeps an unhandled one from crashing us.
    child.on("error", () => {})
    return child as unknown as SpawnedProcess
  }
  return {
    spawn,
    marker,
    pid: (): number | undefined => child?.pid,
    stderr: (): string => stderr.trim(),
    /** Resolves when the process has exited (immediately if it never started). */
    exited: (): Promise<void> =>
      new Promise((resolve) => {
        if (child === undefined || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
          return resolve()
        }
        child.once("exit", () => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// Status and history
// ---------------------------------------------------------------------------

/**
 * What `status` read from an idle CLI.
 *
 * @since 0.1.0
 * @category models
 */
export interface StatusSnapshot {
  readonly account: AccountInfo
  /** The experimental usage API's answer, or null if it failed (see `usageError`). */
  readonly usage: SDKControlGetUsageResponse | null
  readonly usageError: string | null
}

/**
 * A stored session: its metadata (when the SDK found it) and transcript messages (system messages included).
 *
 * @since 0.1.0
 * @category models
 */
export interface HistorySnapshot {
  readonly info: SDKSessionInfo | null
  readonly messages: ReadonlyArray<SessionMessage>
}

const compactBoundary = (entry: Record<string, unknown>) => entry.type === "system" && entry.subtype === "compact_boundary"

/**
 * Transcript entries for `getSessionMessages` to read in full. The SDK starts
 * a transcript at its last compact boundary (as a resume would); here each
 * boundary is disguised as a plain system entry and linked to the message
 * before it (`logicalParentUuid`), so the whole conversation comes back.
 *
 * @internal
 */
export const bridgeCompactions = (entries: ReadonlyArray<SessionStoreEntry>): Array<SessionStoreEntry> =>
  entries.map((entry) =>
    compactBoundary(entry)
      ? {
          ...entry,
          subtype: "effect_agent_compact_boundary",
          parentUuid: entry.parentUuid ?? entry.logicalParentUuid ?? null,
        }
      : entry,
  )

/**
 * `getSessionMessages` drops system entries' fields; put back what mapping
 * needs from the transcript: `subtype`, and a compact boundary's metadata
 * as `compact_metadata` (the stream frame's name for it).
 *
 * @internal
 */
export const restoreSystemFields = (
  messages: ReadonlyArray<SessionMessage>,
  entries: ReadonlyArray<SessionStoreEntry>,
): Array<SessionMessage> => {
  const byUuid = new Map(entries.flatMap((e) => (typeof e.uuid === "string" && e.type === "system" ? [[e.uuid, e]] : [])))
  return messages.map((m) => {
    const entry = m.type === "system" ? byUuid.get(m.uuid) : undefined
    if (entry === undefined) return m
    return {
      ...m,
      ...(typeof entry.subtype === "string" && { subtype: entry.subtype }),
      ...(entry.compactMetadata !== undefined && { compact_metadata: entry.compactMetadata }),
    } as SessionMessage
  })
}

/**
 * Entries of a transcript JSONL file; lines that are not JSON objects with a `type` are skipped.
 *
 * @internal
 */
export const parseTranscript = (text: string): Array<SessionStoreEntry> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return []
    try {
      const entry = JSON.parse(line) as unknown
      return typeof entry === "object" && entry !== null && typeof (entry as { type?: unknown }).type === "string"
        ? [entry as SessionStoreEntry]
        : []
    } catch {
      return [] // a line cut off by a crash mid-write
    }
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * An open query, as returned by `ClaudeSdk.open`.
 *
 * @since 0.1.0
 * @category models
 */
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
  /** The CLI process's pid (the wrapped command's); none without a process (replay). */
  readonly pid: Option.Option<number>
  /** SIGKILL the process group (and marked processes) now. The frame stream then fails as for any process death. */
  readonly kill: Effect.Effect<void>
}

/**
 * A stored session to look for, as taken by `sessionExists` and `history`.
 *
 * @since 0.1.0
 * @category models
 */
export interface SessionLookup {
  readonly sessionId: string
  readonly cwd: string
  /** Where the transcript would be (see `transcriptPath`). */
  readonly transcript: string
}

/**
 * The transport: `layer` spawns the real CLI, `ClaudeReplay.layer` plays back a recording.
 *
 * @since 0.1.0
 * @category services
 */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    /** Spawn a query and wait for the CLI's initialize handshake. */
    readonly open: (options: Options, launch?: Launch) => Effect.Effect<ClaudeQuery, ClaudeSdkError, Scope.Scope>
    /** Whether the CLI has a record of a session (for resume). */
    readonly sessionExists: (lookup: SessionLookup) => Effect.Effect<boolean>
    /** The CLI version, if known without a turn. */
    readonly version: Effect.Effect<string | null>
    /**
     * Account and plan-limit status from an idle CLI (no prompt is sent). The
     * process is gone when this completes.
     */
    readonly status: (options: Options, launch?: Launch) => Effect.Effect<StatusSnapshot, ClaudeSdkError>
    /** A stored session's transcript; null if the CLI has no record of it in `cwd`. */
    readonly history: (lookup: SessionLookup) => Effect.Effect<HistorySnapshot | null, ClaudeSdkError>
  }
>()("effect-agent/claude/ClaudeSdk") {}

/**
 * @since 0.1.0
 * @category models
 */
export interface LayerOptions {
  /** Append every frame to this JSONL file (see `RecordLine`). */
  readonly record?: string
}

/** Add the process's stderr to a process-death error, as the SDK does for processes it spawns. */
const withStderr = (error: ClaudeSdkError, stderr: string): ClaudeSdkError =>
  stderr === "" || error.message.includes("stderr:") || (error.signal === null && error.exitCode === null)
    ? error
    : new ClaudeSdkError({ ...error, message: `${error.message}. stderr: ${stderr.slice(-1000)}` })

/** After the SDK's own close: wait for the process, then clear out its process group. */
const reap = (spawner: ReturnType<typeof makeSpawner>, wait: Duration.Input, grace: Duration.Input) =>
  Effect.promise(() => spawner.exited()).pipe(
    Effect.timeoutOption(wait),
    Effect.andThen(
      Effect.suspend(() => {
        const pid = spawner.pid()
        return pid === undefined ? Effect.void : ProcessTree.kill(spawner.marker, { pid, grace })
      }),
    ),
  )

/** `hooks` with every callback recorded as a `hook` line (at `position()` frames). */
const recordHooks = (
  hooks: NonNullable<Options["hooks"]>,
  record: (line: RecordLine) => void,
  position: () => number,
): NonNullable<Options["hooks"]> =>
  Object.fromEntries(
    Object.entries(hooks).map(([event, matchers]) => [
      event,
      (matchers ?? []).map(
        (matcher): HookCallbackMatcher => ({
          ...matcher,
          hooks: matcher.hooks.map((callback) => async (input, toolUseId, opts) => {
            const at = position()
            const output = await callback(input, toolUseId, opts)
            record({ dir: "hook", event: event as HookEvent, position: at, input, output })
            return output
          }),
        }),
      ),
    ]),
  )

const openQuery = Effect.fnUntraced(function* (
  options: Options,
  launch: Launch,
  record: (line: RecordLine) => void,
  recording: boolean,
) {
  const spawner = makeSpawner(launch)
  /** `in` frames so far: where a hook call happened, for `hook` lines. */
  let frames = 0
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

  /** How the frame stream ended: cleanly, or with the cause the frame reader should fail with. */
  const pumpEnded = (exit: Exit.Exit<void, ClaudeSdkError>): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
        Queue.endUnsafe(output)
        return Effect.void
      }
      const found = Cause.findErrorOption(exit.cause)
      if (Option.isSome(found)) {
        const error = withStderr(found.value, spawner.stderr())
        record(errorLine(error))
        Queue.failCauseUnsafe(output, Cause.fail(error))
      } else {
        // A bug on our side (e.g. the recording can't be written): the reader sees the defect.
        Queue.failCauseUnsafe(output, exit.cause)
      }
      // Either way the frames stop here: whatever still carries the marker is an orphan.
      return ProcessTree.kill(spawner.marker, { pid: spawner.pid(), grace: Duration.seconds(2) })
    })

  // Spawn the CLI and start its pump in one uninterruptible step, so an
  // interrupt can't leave a process with nothing to stop it.
  const { query } = yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const query = yield* Effect.try({
        try: () =>
          sdkQuery({
            prompt: Stream.toAsyncIterable(Stream.fromQueue(input)),
            options: {
              ...options,
              ...(recording && options.hooks !== undefined && { hooks: recordHooks(options.hooks, record, () => frames) }),
              spawnClaudeCodeProcess: spawner.spawn,
            },
          }),
        catch: toSdkError("open"),
      })
      // Pump the SDK generator into a queue so readers can come and go without
      // calling `return()` on the generator (which would end the session).
      const pump = yield* Stream.fromAsyncIterable(query as AsyncIterable<Frame>, toSdkError("frames")).pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            frames++
            record({ dir: "in", frame })
            Queue.offerUnsafe(output, frame)
          }),
        ),
        Effect.onExit(pumpEnded),
        Effect.forkDetach,
      )
      return { query, pump }
    }),
    // Close the query (the SDK ends stdin, then force-kills after a grace
    // period), give the pump time to observe the exit, then kill whatever is
    // left in the process group (commands the agent started in the background).
    ({ query, pump }) =>
      Effect.sync(() => {
        Queue.endUnsafe(input)
        query.close()
      }).pipe(
        Effect.andThen(Fiber.await(pump).pipe(Effect.timeoutOption(Duration.seconds(10)))),
        Effect.andThen(Fiber.interrupt(pump)),
        Effect.andThen(reap(spawner, Duration.seconds(5), Duration.seconds(3))),
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
    pid: Option.fromNullishOr(spawner.pid()),
    kill: Effect.sync(() => {
      const pid = spawner.pid()
      if (pid === undefined) return
      ProcessTree.killNow(spawner.marker, pid)
    }),
  }
  return result
})

/** An input stream that never yields: the CLI starts and initializes, but no turn runs. */
const idleInput = (): AsyncIterable<SDKUserMessage> => ({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }),
})

const statusQuery = (options: Options, launch: Launch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = makeSpawner(launch)
      // Nothing to save, so don't wait out the SDK's grace: close, then clear the group.
      const query = yield* Effect.acquireRelease(
        Effect.try({
          try: () => sdkQuery({ prompt: idleInput(), options: { ...options, spawnClaudeCodeProcess: spawner.spawn } }),
          catch: toSdkError("status"),
        }),
        (query) => Effect.sync(() => query.close()).pipe(Effect.andThen(reap(spawner, Duration.seconds(1), Duration.seconds(1)))),
      )
      yield* Effect.tryPromise({ try: () => query.initializationResult(), catch: toSdkError("initialize") })
      const account = yield* Effect.tryPromise({ try: () => query.accountInfo(), catch: toSdkError("accountInfo") })
      const usage = yield* Effect.tryPromise({
        try: () => query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        catch: toSdkError("usage"),
      }).pipe(Effect.result)
      const snapshot: StatusSnapshot =
        usage._tag === "Success"
          ? { account, usage: usage.success, usageError: null }
          : { account, usage: null, usageError: usage.failure.message }
      return snapshot
    }),
  )

const readHistory = ({ sessionId, cwd, transcript }: SessionLookup) =>
  Effect.tryPromise({
    try: async (): Promise<HistorySnapshot | null> => {
      const info = (await getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined)) ?? null
      const text = existsSync(transcript) ? readFileSync(transcript, "utf8") : null
      if (info === null && text === null) return null
      const plain = () => getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true })
      if (text === null) return { info, messages: await plain() }
      const entries = parseTranscript(text)
      const bridged = bridgeCompactions(entries)
      // `sessionStore` is an alpha SDK option; without it, history starts at the last compaction.
      const store: SessionStore = {
        append: async () => {},
        load: async (key) => (key.subpath === undefined ? bridged : null),
      }
      const messages = await getSessionMessages(sessionId, { dir: cwd, includeSystemMessages: true, sessionStore: store }).catch(plain)
      return { info, messages: restoreSystemFields(messages, entries) }
    },
    catch: toSdkError("history"),
  })

/**
 * `ClaudeSdk` backed by the SDK and a real CLI process.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: LayerOptions = {}): Layer.Layer<ClaudeSdk> =>
  Layer.sync(ClaudeSdk, () => {
    const record = recorder(options.record)
    return ClaudeSdk.of({
      open: (sdkOptions, launch = noLaunch) => openQuery(sdkOptions, launch, record, options.record !== undefined),
      sessionExists: ({ sessionId, cwd, transcript }) =>
        Effect.promise(() => getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined)).pipe(
          Effect.map((info) => info !== undefined || existsSync(transcript)),
        ),
      version: bundledVersion,
      status: (sdkOptions, launch = noLaunch) =>
        statusQuery(sdkOptions, launch).pipe(Effect.tap((status) => Effect.sync(() => record({ dir: "status", status })))),
      history: (lookup) =>
        readHistory(lookup).pipe(
          Effect.tap((history) =>
            Effect.sync(() => record({ dir: "history", sessionId: lookup.sessionId, cwd: lookup.cwd, history })),
          ),
        ),
    })
  })
