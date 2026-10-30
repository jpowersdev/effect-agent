/**
 * Transport for `codex app-server`: one process per connection, speaking
 * newline-delimited JSON-RPC on stdio.
 *
 * ```ts skip-type-checking
 * CodexAppServer.layer().pipe(Layer.provide(NodeServices.layer))
 * ```
 *
 * The process is spawned through `ChildProcessSpawner`, wrapped by the
 * `Launcher` if one is provided (in the caller's context or the layer's),
 * and started in its own process group. Closing the connection's Scope
 * sends SIGTERM to that group and SIGKILLs it after `forceKillAfter`.
 *
 * Codex (0.162.1) runs each command in its own PTY session, so commands are
 * not in that group. They stop because app-server stops them on SIGTERM
 * (verified, including `nohup ... &` children of a running command).
 *
 * If app-server has to be SIGKILLed, a running command's foreground process
 * dies with its PTY, but a `nohup`ed background one survives. Use a
 * `Launcher` that puts the process in a cgroup (`systemd-run --scope`) to
 * catch those too.
 *
 * @since 0.1.0
 */
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AgentError } from "../AgentError.ts"
import * as Recorder from "../internal/recorder.ts"
import * as Launcher from "../Launcher.ts"
import * as ProcessTree from "../ProcessTree.ts"
import * as P from "./protocol.ts"

const provider = "codex"

/**
 * A JSON-RPC error response from app-server.
 *
 * @since 0.1.0
 * @category errors
 */
export class CodexRpcError extends Schema.TaggedError<CodexRpcError>()("CodexRpcError", {
  method: Schema.String,
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown),
}) {}

/**
 * How app-server exited: an exit code, or the signal that killed it.
 *
 * @since 0.1.0
 * @category models
 */
export interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: string | null
}

/**
 * A notification or a server-to-client request, in arrival order.
 *
 * @since 0.1.0
 * @category models
 */
export type Incoming = P.Incoming

/**
 * Options for `CodexAppServer.connect`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ConnectOptions {
  readonly cwd: string
  /** Applied over the host environment; `undefined` removes a variable. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * Answers server-to-client requests. Defaults to `defaultServerRequestHandler`,
   * which declines approvals, answers ask-user requests with no answers and
   * rejects anything else, so app-server never waits on us.
   */
  readonly onServerRequest?: (request: P.ServerRequest) => Effect.Effect<unknown, CodexRpcError>
}

/**
 * An initialized app-server connection, live or replayed. Closed with its Scope.
 *
 * @since 0.1.0
 * @category models
 */
export interface Connection {
  /** app-server's pid; null when replaying. */
  readonly pid: number | null
  readonly initialize: P.InitializeResponse
  readonly request: <M extends P.ClientMethod>(
    method: M,
    params: P.ClientRequests[M]["params"],
  ) => Effect.Effect<P.ClientRequests[M]["result"], CodexRpcError | AgentError>
  /**
   * Notifications and server requests in arrival order. Single consumer:
   * frames are buffered until read, and the stream ends when app-server's
   * stdout closes.
   */
  readonly incoming: Stream.Stream<Incoming>
  /** Waits for app-server to exit. */
  readonly exit: Effect.Effect<ProcessExit>
  /** The exit, if app-server has exited. */
  readonly exited: Effect.Effect<Option.Option<ProcessExit>>
  /** SIGTERM app-server (SIGKILL after the timeout) and wait for it. Idempotent. */
  readonly close: Effect.Effect<void>
  /**
   * Stop a server that stopped responding: SIGTERM its process group, SIGKILL
   * after 2 seconds. (The SIGTERM matters: Codex runs each command in its own
   * PTY session, outside the group, and only app-server's own shutdown
   * reliably stops them; a `nohup`ed background command survives a SIGKILL.)
   */
  readonly kill: Effect.Effect<void>
}

/**
 * Options for `make` and `layer`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** Path to the `codex` binary. Default `codex` (resolved on PATH). */
  readonly codexPath?: string
  /** Extra arguments after `app-server`, e.g. `["-c", "model=\"o4\""]`. */
  readonly args?: ReadonlyArray<string>
  /**
   * Tee every frame to this JSONL file (`{"dir":"out"|"in","msg":...}` per
   * line). A connection truncates the file and records until it closes; one
   * that starts while another is recording isn't recorded (so a `status`
   * call during a session leaves the session's recording alone).
   */
  readonly record?: string
  /** How long to wait after SIGTERM before SIGKILL. Default 10 seconds. */
  readonly forceKillAfter?: Duration.Input
  readonly clientName?: string
  readonly clientVersion?: string
}

/**
 * Starts app-server connections.
 *
 * @since 0.1.0
 * @category services
 */
export class CodexAppServer extends Context.Service<
  CodexAppServer,
  {
    readonly connect: (options: ConnectOptions) => Effect.Effect<Connection, AgentError, Scope.Scope>
    /** The codex version, without starting a session. */
    readonly version: Effect.Effect<string | null, AgentError>
  }
>()("effect-agent/codex/CodexAppServer") {}

/**
 * Notifications we never use; opting out keeps recordings small and free of account metadata.
 *
 * @internal
 */
export const optOutNotificationMethods: ReadonlyArray<P.NotificationMethod> = [
  "turn/moderationMetadata",
  "remoteControl/status/changed",
  "rawResponse/completed",
  "rawResponseItem/completed",
]

/**
 * The `initialize` params: client info and capabilities, opting out of `optOutNotificationMethods`.
 *
 * @internal
 */
export const initializeParams = (options: Pick<Options, "clientName" | "clientVersion"> = {}): P.InitializeParams => ({
  clientInfo: { name: options.clientName ?? "effect_agent", title: null, version: options.clientVersion ?? "0.0.0" },
  capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods },
})

/**
 * `effect_agent/0.162.1 (NixOS ...)` -> `0.162.1`
 *
 * @internal
 */
export const parseUserAgentVersion = (userAgent: string): string | null => /^[^/\s]+\/(\d[^\s]*)/.exec(userAgent)?.[1] ?? null

/**
 * Declines approvals and elicitations, answers ask-user requests with no answers and fails anything else with METHOD_NOT_FOUND.
 *
 * @since 0.1.0
 * @category rpc
 */
export const defaultServerRequestHandler = (request: P.ServerRequest): Effect.Effect<unknown, CodexRpcError> => {
  const M = P.ServerRequestMethods
  switch (request.method) {
    case M.commandApproval:
    case M.fileChangeApproval:
      return Effect.succeed<P.ApprovalDeclined>({ decision: "decline" })
    case M.legacyExecApproval:
    case M.legacyPatchApproval:
      return Effect.succeed<P.LegacyApprovalAborted>({ decision: "abort" })
    case M.requestUserInput:
      return Effect.succeed<P.UserInputAnswers>({ answers: {} })
    case M.mcpElicitation:
      return Effect.succeed<P.ElicitationDeclined>({ action: "decline", content: null, _meta: null })
    default:
      return Effect.fail(
        new CodexRpcError({
          method: request.method,
          code: P.METHOD_NOT_FOUND,
          message: `effect-agent does not handle ${request.method}`,
        }),
      )
  }
}

const agentError = (message: string, cause?: unknown) =>
  new AgentError({ message, provider, ...(cause !== undefined ? { cause } : {}) })

/**
 * The plumbing shared by the live and replay transports: request/response
 * correlation, the incoming queue and the exit signal. `write` sends one
 * frame.
 *
 * @internal
 */
export const makeRpcCore = Effect.fnUntraced(function* (write: (msg: P.Message) => Effect.Effect<void>) {
  let nextId = 1
  const pending = new Map<P.RequestId, { method: string; deferred: Deferred.Deferred<unknown, CodexRpcError | AgentError> }>()
  const incoming = yield* Queue.unbounded<Incoming, Cause.Done>()
  const exitSignal = yield* Deferred.make<ProcessExit>()
  let closedReason: string | null = null

  const failPending = (reason: string) =>
    Effect.suspend(() => {
      closedReason ??= reason
      const all = [...pending.values()]
      pending.clear()
      return Effect.forEach(all, (p) => Deferred.fail(p.deferred, agentError(`${reason} (waiting for ${p.method})`)), {
        discard: true,
      })
    })

  const request = <M extends P.ClientMethod>(
    method: M,
    params: P.ClientRequests[M]["params"],
  ): Effect.Effect<P.ClientRequests[M]["result"], CodexRpcError | AgentError> =>
    Effect.suspend(() => {
      if (closedReason !== null) return Effect.fail(agentError(`${closedReason}; cannot send ${method}`))
      const id = nextId++
      const deferred = Deferred.makeUnsafe<unknown, CodexRpcError | AgentError>()
      pending.set(id, { method, deferred })
      const msg: P.Message = params === undefined ? { id, method } : { id, method, params }
      return write(msg).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))),
      ) as Effect.Effect<P.ClientRequests[M]["result"], CodexRpcError | AgentError>
    })

  /** Route one frame from the server. Returns server requests for the caller to answer. */
  const dispatch = (msg: P.Message): Effect.Effect<Option.Option<P.ServerRequest>> =>
    Effect.suspend(() => {
      if (P.isResponse(msg)) {
        const p = pending.get(msg.id!)
        if (p === undefined) return Effect.succeedNone
        pending.delete(msg.id!)
        const done =
          msg.error !== undefined
            ? Deferred.fail(
                p.deferred,
                new CodexRpcError({
                  method: p.method,
                  code: msg.error.code,
                  message: msg.error.message,
                  ...(msg.error.data !== undefined ? { data: msg.error.data } : {}),
                }),
              )
            : Deferred.succeed(p.deferred, msg.result)
        return Effect.as(done, Option.none())
      }
      if (P.isServerRequest(msg)) return Effect.as(Queue.offer(incoming, msg), Option.some(msg))
      if (P.isNotification(msg)) return Effect.as(Queue.offer(incoming, msg), Option.none())
      return Effect.succeedNone
    })

  return {
    request,
    dispatch,
    failPending,
    incoming,
    incomingStream: Stream.fromQueue(incoming),
    endIncoming: Queue.end(incoming),
    exitSignal,
  }
})

const RpcErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
})

/**
 * One JSON-RPC frame as app-server writes it. `error: null` (which some
 * servers send alongside a result) counts as no error.
 */
const WireMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.NullOr(RpcErrorBody)),
  emittedAtMs: Schema.optionalKey(Schema.Number),
})
const fromWire = ({ error, ...rest }: typeof WireMessage.Type): P.Message =>
  error === null || error === undefined ? rest : { ...rest, error }
const decodeWireLine = Schema.decodeUnknownOption(Schema.fromJsonString(WireMessage))
const decodeWire = Schema.decodeUnknownOption(WireMessage)

/**
 * A line of app-server output as a `Message`; none for anything that isn't a JSON-RPC object.
 *
 * @internal
 */
export const decodeMessage = (line: string): Option.Option<P.Message> => Option.map(decodeWireLine(line), fromWire)

/**
 * An already-parsed frame as a `Message`; none for anything that isn't a JSON-RPC object.
 *
 * @internal
 */
export const decodeMessageValue = (value: unknown): Option.Option<P.Message> => Option.map(decodeWire(value), fromWire)

/** JSON-RPC "internal error": our handler for a server request failed unexpectedly. */
const INTERNAL_ERROR = -32603

/** Builds the env passed to the spawner: `extendEnv` semantics, `undefined` removes. */
const childEnv = (env: Readonly<Record<string, string | undefined>> | undefined) => ({ ...env })

const signalOf = (error: unknown): string | null => {
  const text = `${String(error)} ${String((error as { cause?: unknown })?.cause ?? "")}`
  return /signal:? '?(SIG[A-Z0-9]+)/.exec(text)?.[1] ?? null
}

/**
 * Spawns `codex app-server` through `ChildProcessSpawner`, one process per connection.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const codexPath = options.codexPath ?? "codex"
    const forceKillAfter = options.forceKillAfter ?? Duration.seconds(10)
    // A Launcher provided to the layer applies when the caller doesn't provide its own.
    const prepareWrap = Launcher.prepareWithFallback(yield* Effect.serviceOption(Launcher.Launcher))

    /** Whether a connection is recording; another one that starts meanwhile isn't. */
    let recording = false

    const version = yield* Effect.cached(
      spawner.string(ChildProcess.make(codexPath, ["--version"], { stderr: "ignore" })).pipe(
        Effect.map((out) => /(\d+\.\d+\.\d+\S*)/.exec(out)?.[1] ?? null),
        Effect.mapError((cause) => agentError(`could not run ${codexPath} --version`, cause)),
      ),
    )

    const connect = (connectOptions: ConnectOptions): Effect.Effect<Connection, AgentError, Scope.Scope> =>
      Effect.gen(function* () {
        // A connection that starts while another is recording isn't recorded.
        // Check and claim the recording in one step (another connection may be starting too);
        // only the connection that claimed it records, and gives it up when it closes.
        const recordPath = options.record
        const owns =
          recordPath === undefined
            ? false
            : yield* Effect.acquireRelease(
                Effect.sync(() => {
                  if (recording) return false
                  recording = true
                  return true
                }),
                (claimed) =>
                  Effect.sync(() => {
                    if (claimed) recording = false
                  }),
              )
        const recorder =
          owns && recordPath !== undefined
            ? yield* Recorder.make(recordPath, { truncate: true }).pipe(
                Effect.mapError((cause) => agentError(`cannot write recording ${recordPath}`, cause)),
              )
            : Recorder.none
        const record = (dir: "in" | "out", msg: unknown) => recorder.record({ dir, msg })
        const flush = recorder.flush

        const wrap = yield* prepareWrap({ provider, cwd: connectOptions.cwd })
        // Inherited by app-server and every command it runs (each in its own PTY session,
        // outside our process group), so they can all be found and stopped.
        const marker = ProcessTree.newMarker()
        const command = wrap({ command: codexPath, args: ["app-server", ...(options.args ?? [])] })
        const stdinQueue = yield* Queue.unbounded<string, Cause.Done>()
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(command.command, [...command.args], {
              cwd: connectOptions.cwd,
              // Own process group: kills (scope close, `close`, `kill`) signal the whole group.
              detached: true,
              env: { ...childEnv(connectOptions.env), [ProcessTree.markerVariable]: marker },
              extendEnv: true,
              // Frames are written in order as they are queued; the spawner pipes them in.
              stdin: Stream.fromQueue(stdinQueue).pipe(Stream.encodeText),
              stdout: "pipe",
              stderr: "pipe",
              killSignal: "SIGTERM",
              forceKillAfter,
            }),
          )
          .pipe(Effect.mapError((cause) => agentError(`could not start ${command.command} (codex app-server)`, cause)))
        // Runs before the spawner's own kill (finalizers run in reverse): SIGTERM app-server
        // and everything carrying the marker, SIGKILL leftovers after the grace period.
        const sweep = ProcessTree.kill(marker, { pid: handle.pid, grace: forceKillAfter })
        yield* Effect.addFinalizer(() => sweep)

        const write = (msg: P.Message) =>
          Effect.suspend(() => {
            record("out", msg)
            return Effect.asVoid(Queue.offer(stdinQueue, JSON.stringify(msg) + "\n"))
          })
        const core = yield* makeRpcCore(write)

        // Keep the last stderr lines for error messages; stderr must be drained anyway.
        const stderrTail: Array<string> = []
        yield* Stream.decodeText(handle.stderr).pipe(
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.sync(() => {
              stderrTail.push(line)
              if (stderrTail.length > 20) stderrTail.shift()
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        )

        const onServerRequest = connectOptions.onServerRequest ?? defaultServerRequestHandler
        // Always answer: app-server waits on a server request until it gets one.
        const answer = (req: P.ServerRequest) =>
          Effect.suspend(() => onServerRequest(req)).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => {
                const error = Cause.findErrorOption(cause)
                return write({
                  id: req.id,
                  error: Option.isSome(error)
                    ? { code: error.value.code, message: error.value.message }
                    : { code: INTERNAL_ERROR, message: `effect-agent failed to handle ${req.method}` },
                })
              },
              onSuccess: (result) => write({ id: req.id, result }),
            }),
          )

        const reader = yield* Stream.decodeText(handle.stdout).pipe(
          Stream.splitLines,
          Stream.runForEach((line) =>
            Option.match(decodeMessage(line), {
              // Not JSON-RPC (a blank line, a log line): nothing to route.
              onNone: () => Effect.void,
              onSome: (msg) => {
                record("in", msg)
                return core.dispatch(msg).pipe(
                  Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (req) => Effect.forkScoped(answer(req)) })),
                  Effect.asVoid,
                )
              },
            }),
          ),
          Effect.catchCause((cause) => Effect.logError("codex app-server reader failed", cause)),
          Effect.forkScoped,
        )

        // Exit watcher: let the reader drain what's left, then end everything.
        yield* handle.exitCode.pipe(
          Effect.exit,
          Effect.flatMap((exit) => {
            const info: ProcessExit = Exit.isSuccess(exit)
              ? { exitCode: exit.value, signal: null }
              : { exitCode: null, signal: signalOf(Cause.squash(exit.cause)) }
            const ended = Effect.gen(function* () {
              yield* core.failPending(
                `codex app-server exited (${info.signal ?? `code ${info.exitCode}`})${
                  stderrTail.length > 0 ? `: ${stderrTail.slice(-3).join(" | ")}` : ""
                }`,
              )
              yield* core.endIncoming
              yield* Deferred.succeed(core.exitSignal, info)
            })
            return Effect.gen(function* () {
              // Whatever still carries the marker is an orphan of a dead app-server.
              yield* ProcessTree.kill(marker, { grace: Duration.seconds(2) }).pipe(Effect.forkScoped)
              // Let the reader drain what's left; however it ends, the connection ends with it.
              yield* Fiber.await(reader).pipe(Effect.timeoutOption(Duration.seconds(2)))
            }).pipe(Effect.ensuring(ended))
          }),
          Effect.forkScoped,
        )

        const close = Effect.gen(function* () {
          yield* core.failPending("connection closed")
          yield* Effect.ignore(handle.kill({ killSignal: "SIGTERM", forceKillAfter }))
          yield* sweep
          yield* flush
        })
        const kill = Effect.gen(function* () {
          yield* core.failPending("connection killed")
          yield* Effect.ignore(handle.kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(2) }))
          yield* ProcessTree.kill(marker, { pid: handle.pid, grace: Duration.seconds(2) })
          yield* flush
        })

        const initialize = yield* core.request("initialize", initializeParams(options)).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.mapError((cause) =>
            agentError(
              `codex app-server initialize failed${stderrTail.length > 0 ? `: ${stderrTail.join(" | ")}` : ""}`,
              cause,
            ),
          ),
        )
        yield* write({ method: "initialized" })

        return {
          pid: handle.pid,
          initialize,
          request: core.request,
          incoming: core.incomingStream,
          exit: Deferred.await(core.exitSignal),
          exited: Deferred.isDone(core.exitSignal).pipe(
            Effect.flatMap((done) => (done ? Effect.map(Deferred.await(core.exitSignal), Option.some) : Effect.succeedNone)),
          ),
          close,
          kill,
        } satisfies Connection
      })

    return CodexAppServer.of({ connect, version })
  })

/**
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options = {}): Layer.Layer<CodexAppServer, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(CodexAppServer, make(options))
