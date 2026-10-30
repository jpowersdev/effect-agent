/**
 * Sessions that outlive the process that started them. Each session runs in
 * its own host process (`main.ts`), started detached; clients talk to it over
 * a unix socket, and any process can `attach` to it again by session id,
 * catch up on the events it missed, and keep controlling it.
 *
 *   const layer = RemoteAgent.layer({ provider: "claude", onScopeClose: "detach" })
 *
 *   // process A
 *   const session = yield* (yield* Agent).open({ cwd })
 *   yield* session.send("long task")       // A may now exit; the session keeps running
 *
 *   // process B
 *   const session = yield* (yield* AgentHosts).attach(sessionId)
 *   yield* session.subscribeFrom(0).pipe(Stream.runForEach(persist))
 *
 * `RemoteAgent.layer` provides `Agent` (so existing programs work unchanged)
 * and `AgentHosts` (`open` typed as `RemoteSession`, `attach`, `list`,
 * `events`). Hooks stay in the client: the host forwards each hook call to
 * an attached client that has hooks (see `AttachOptions`).
 *
 * Process supervision: hosts are started with `detached: true` and survive
 * their caller, but a service manager may still kill them. A runner under
 * systemd with the default `KillMode=control-group` has every process in its
 * cgroup killed when it restarts, hosts included. Provide a `Launcher` that
 * wraps the host in its own scope (`systemd-run --user --scope ...`, see
 * `Launcher.ts`); it applies to the host command, so the host and the agent
 * CLI it runs live in that scope.
 */
import { NodeSocket } from "@effect/platform-node"
import { Cause, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schedule, Schema, Scope, Stream } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Agent, type AgentSession, type Hooks, type RunOptions } from "../Agent.ts"
import { AgentError, SessionNotFound, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnSucceeded } from "../AgentEvent.ts"
import { type MessageId, SessionId, type TurnId } from "../Domain.ts"
import * as Launcher from "../Launcher.ts"
import * as EventFile from "./EventFile.ts"
import { defaults as hostDefaults, isLive, pruneEvents, readManifest } from "./Host.ts"
import {
  defaultDir,
  ensureDir,
  eventsPath,
  fromRunOptions,
  HostSpec,
  type Manifest,
  manifestPath,
  providerLayer,
  type ProviderSpec,
  ReadyLine,
  socketPath,
} from "./HostSpec.ts"
import { type EventsTrimmed, type HookName, type HookRequest, type HostInfo, HostRpcs, type SeqEvent } from "./protocol.ts"

export const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url))

export interface RemoteAgentOptions extends ProviderSpec {
  /** Where hosts keep their sockets, manifests and logs. Default `HostSpec.defaultDir()`. */
  readonly dir?: string
  /**
   * Events each host keeps in memory for `subscribeFrom`. With `persistEvents`
   * this is a cache in front of the events file. Default 50 000.
   */
  readonly maxEvents?: number
  /**
   * Hosts append every event to `<dir>/<sessionId>.events.jsonl` (mode 0600),
   * so `subscribeFrom` can serve any seq, and `AgentHosts.events` can read a
   * session's log after its host has exited. Default true.
   */
  readonly persistEvents?: boolean
  /**
   * How long an events file is kept after its host exits (from its mtime).
   * Expired files are removed by `list`, `attach`, `events` and host startup.
   * Default 24 hours.
   */
  readonly retainEvents?: Duration.Input
  /**
   * When the connection to a host drops (other than by `detach`/`stop` or the
   * session ending), re-dial it on this schedule: subscriptions resume from
   * the last seq they delivered, and calls in flight are retried (`send`,
   * `steer` and `turn` carry a request id, so the host acts on them once).
   * Calls fail with `AgentError` when the schedule gives up, or at once if the
   * host is gone (manifest removed or pid dead). `false`: fail on the first
   * drop. Default `defaultReconnect`.
   */
  readonly reconnect?: Schedule.Schedule<unknown, AgentError> | false
  /**
   * How long a host waits for a client to answer a hook call before the hook
   * adds nothing. Default 5 seconds. `open`/`attach` can override it per session.
   */
  readonly hookTimeout?: Duration.Input
  /** Internal, tests only (see `HostSpec.testDropBeforeReply`). */
  readonly testDropBeforeReply?: ReadonlyArray<string>
  /** Internal, tests only (see `HostSpec.testInvokeHook`). */
  readonly testInvokeHook?: boolean
  /** A host ends its session after this long idle with no client attached. Default 30 minutes. */
  readonly orphanTimeout?: Duration.Input
  /** How long a host keeps serving after its session ends. Default 5 seconds. */
  readonly linger?: Duration.Input
  /** The command that runs `main.ts`. Default `node <path to main.ts>`. */
  readonly hostCommand?: Launcher.Command
  /** How long `open` waits for the host to report it is ready. Default 60 seconds. */
  readonly readyTimeout?: Duration.Input
  /**
   * What closing the Scope a session was opened (or attached) in does:
   * `"stop"` (default) stops the session, as with a local session; `"detach"`
   * only drops the connection, leaving the session running in its host.
   */
  readonly onScopeClose?: "stop" | "detach"
}

/** Backoff from 100 ms, doubling, capped at 2 s between attempts; gives up after 30 s. */
export const defaultReconnect: Schedule.Schedule<Duration.Duration> = Schedule.max([
  Schedule.min([Schedule.exponential("100 millis", 2), Schedule.spaced("2 seconds")]),
  Schedule.during("30 seconds"),
])

/** Failures that mean "lost the host" (as opposed to the session's own ending). */
const connectionErrors = new WeakSet<AgentError>()
const connectionError = (error: AgentError): AgentError => {
  connectionErrors.add(error)
  return error
}

/** `AgentSession`, plus what reattaching needs. */
export interface RemoteSession extends AgentSession {
  /** The host process's pid. */
  readonly hostPid: number
  readonly socket: string
  /**
   * Every event with `seq >= fromSeq`, then live ones, until the session
   * ends. Survives reconnects with no gap or duplicate. Fails with
   * `EventsTrimmed` rather than skipping events silently if `fromSeq` is older
   * than the host's cache and the events file isn't there to read it from
   * (`persistEvents: false`, or the file is missing or unreadable).
   */
  readonly subscribeFrom: (fromSeq: number) => Stream.Stream<SeqEvent, EventsTrimmed | AgentError>
  /** The last event's sequence number (-1 before any). */
  readonly lastSeq: Effect.Effect<number, AgentError>
  readonly info: Effect.Effect<HostInfo, AgentError>
  /** That turn's ending: at once if it already ended (even before a reattach), otherwise when it does. */
  readonly awaitTurn: (turnId: TurnId) => Effect.Effect<TurnSucceeded, TurnFailure | AgentError>
  /**
   * The ending of the turn a message landed in, by the `MessageId` that `send`
   * returned: persist that, and a runner restarted mid-turn can pick the result
   * up without knowing the turn id. Fails with `AgentError` if the message was
   * dropped, never reached a turn, or wasn't sent through this host.
   */
  readonly awaitMessage: (messageId: MessageId) => Effect.Effect<TurnSucceeded, TurnFailure | AgentError>
  /** Drop the connection and leave the session running. Calls made after it fail with `AgentError`. */
  readonly detach: Effect.Effect<void>
  /** Close the session now (killing its processes) and wait for the host to exit. */
  readonly stop: Effect.Effect<void, AgentError>
}

export interface AttachOptions {
  /**
   * Answer the session's hook calls with these. Only hooks the session was
   * opened with are ever called. Of the attached clients with a hook, the one
   * that attached most recently answers it; a client attached without hooks
   * never does.
   */
  readonly hooks?: Hooks
  /** Override `RemoteAgentOptions.hookTimeout` for the calls this client answers. */
  readonly hookTimeout?: Duration.Input
}

const hookNames = (hooks: Hooks | undefined): Array<HookName> =>
  hooks === undefined ? [] : (["beforeTool", "afterTool", "beforeStop"] as const).filter((k) => hooks[k] !== undefined)

export class AgentHosts extends Context.Service<
  AgentHosts,
  {
    /** `Agent.open`, typed as a `RemoteSession`. */
    /**
     * `Agent.open`, typed as a `RemoteSession`. `options.hooks` stay in this
     * process: the host forwards each hook call to an attached client that
     * has hooks (see `attach`). Refused where the provider has no hooks.
     */
    readonly open: (
      options: RunOptions,
      session?: { readonly hookTimeout?: Duration.Input },
    ) => Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope>
    /** Connect to a running host. `SessionNotFound` when no live host has that session. */
    readonly attach: (
      sessionId: SessionId,
      options?: AttachOptions,
    ) => Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope>
    /** Live hosts in the directory; manifests of dead ones (and expired events files) are removed. */
    readonly list: Effect.Effect<ReadonlyArray<Manifest>>
    /**
     * A session's log, `{ seq, event }` from `fromSeq` (default 0), whether
     * or not its host is still running: from a live host it follows live
     * events until the session ends (as `subscribeFrom`); otherwise it reads
     * the events file to its end and completes. `SessionNotFound` if there is
     * neither a live host nor an events file.
     */
    readonly events: (
      sessionId: SessionId,
      fromSeq?: number,
    ) => Stream.Stream<SeqEvent, SessionNotFound | EventsTrimmed | AgentError>
  }
>()("effect-agent/AgentHosts") {}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

const removeHostFiles = (dir: string, sessionId: string) => {
  rmSync(manifestPath(dir, sessionId), { force: true })
  rmSync(socketPath(dir, sessionId), { force: true })
}

/** Live manifests in `dir`; stale ones (dead pid) are removed with their sockets. */
export const listHosts = (dir: string): Array<Manifest> => {
  let names: Array<string>
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const live: Array<Manifest> = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const manifest = readManifest(join(dir, name))
    if (manifest === undefined) continue
    if (isLive(manifest)) live.push(manifest)
    else removeHostFiles(dir, manifest.sessionId)
  }
  return live
}

const waitForExit = (pid: number, timeout: Duration.Input) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(Duration.fromInputUnsafe(timeout))
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true
      yield* Effect.sleep(Duration.millis(25))
    }
    return !isAlive(pid)
  })

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

export const layer = (options: RemoteAgentOptions): Layer.Layer<Agent | AgentHosts> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const provider = options.provider
      const dir = options.dir ?? defaultDir()
      const onScopeClose = options.onScopeClose ?? "stop"
      const retainEvents = Duration.fromInputUnsafe(options.retainEvents ?? hostDefaults.retainEvents)
      const prune = () => pruneEvents(dir, retainEvents)
      const readyTimeout = options.readyTimeout ?? Duration.seconds(60)
      const hostCommand = options.hostCommand ?? { command: process.execPath, args: [mainPath] }
      const local = Context.get(yield* Layer.build(providerLayer(options)), Agent)
      const layerLauncher = yield* Effect.serviceOption(Launcher.Launcher)

      const agentError = (message: string, cause?: unknown) =>
        new AgentError({ message, provider, ...(cause !== undefined && { cause }) })
      const notFound = (sessionId: SessionId, why: string) =>
        new SessionNotFound({ message: `no live host for session ${sessionId}: ${why}`, sessionId })
      const fromClient = (e: RpcClientError.RpcClientError) => agentError(`host connection: ${e.message}`, e)

      const prepareWrap = (cwd: string) =>
        Effect.flatMap(Effect.serviceOption(Launcher.Launcher), (caller) => {
          const prepare = Launcher.prepare({ provider, cwd })
          return Option.isNone(caller) && Option.isSome(layerLauncher)
            ? Effect.provideService(prepare, Launcher.Launcher, layerLauncher.value)
            : prepare
        })

      // ---- starting a host ----

      const startHost = (command: Launcher.Command, spec: string) =>
        Effect.callback<{ readonly sessionId: SessionId; readonly socket: string; readonly pid: number }, SessionNotFound | AgentError>(
          (resume) => {
            // Output from before the host opens its own log (e.g. a crash at startup).
            let stderr: number
            try {
              ensureDir(dir)
              stderr = openSync(join(dir, "hosts.stderr.log"), "a", 0o600)
            } catch (e) {
              return resume(Effect.fail(agentError(`cannot use host directory ${dir}: ${String(e)}`, e)))
            }
            const child = spawn(command.command, [...command.args], {
              detached: true,
              stdio: ["pipe", "pipe", stderr],
              cwd: dir,
              env: process.env,
            })
            closeSync(stderr)
            let done = false
            let buffer = ""
            const finish = (exit: Exit.Exit<{ sessionId: SessionId; socket: string; pid: number }, SessionNotFound | AgentError>) => {
              if (done) return
              done = true
              clearTimeout(timer)
              child.removeAllListeners("exit")
              child.stdout?.removeAllListeners("data")
              // Let go of the pipes so the host fully outlives us.
              child.stdout?.destroy()
              child.stdin?.destroy()
              child.unref()
              resume(exit)
            }
            const kill = () => {
              if (child.pid !== undefined) signal(-child.pid, "SIGTERM")
            }
            const timer = setTimeout(() => {
              kill()
              finish(Exit.fail(agentError(`host did not become ready within ${Duration.format(Duration.fromInputUnsafe(readyTimeout))}`)))
            }, Duration.toMillis(Duration.fromInputUnsafe(readyTimeout)))
            child.on("error", (e) => finish(Exit.fail(agentError(`cannot start host ${command.command}: ${e.message}`, e))))
            child.on("exit", (code, sig) =>
              finish(
                Exit.fail(
                  agentError(`host exited (${sig ?? `code ${code}`}) before it was ready; see ${join(dir, "hosts.stderr.log")}`),
                ),
              ),
            )
            child.stdin?.on("error", () => {})
            child.stdout?.on("error", () => {})
            child.stdout?.on("data", (chunk: Buffer) => {
              buffer += chunk.toString("utf8")
              const newline = buffer.indexOf("\n")
              if (newline < 0) return
              const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(ReadyLine))(buffer.slice(0, newline))
              if (Exit.isFailure(decoded)) {
                kill()
                return finish(Exit.fail(agentError(`host sent a bad readiness line: ${buffer.slice(0, newline)}`)))
              }
              const line = decoded.value
              if (line._tag === "Failed") {
                const error = line.error._tag === "AgentError" && line.error.provider === "host" ? agentError(line.error.message) : line.error
                return finish(Exit.fail(error))
              }
              finish(Exit.succeed({ sessionId: line.sessionId, socket: line.socket, pid: line.pid }))
            })
            child.stdin?.end(spec)
            return Effect.sync(() => {
              if (done) return
              kill()
              finish(Exit.fail(agentError("interrupted while starting the host")))
            })
          },
        )

      // ---- connecting ----

      /** One socket connection and its RPC client, checked with an `Info` round trip. */
      const dial = (socket: string, onDisconnect: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
            Layer.provide(Layer.effect(Socket.Socket, NodeSocket.makeNet({ path: socket }))),
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(Layer.succeed(RpcClient.ConnectionHooks, { onConnect: Effect.void, onDisconnect })),
          )
          return yield* Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(protocol, scope)
            const client = yield* RpcClient.make(HostRpcs, { disableTracing: true }).pipe(
              Effect.provideContext(context),
              Scope.provide(scope),
            )
            const info = yield* client.Info().pipe(
              Effect.mapError((e) => (e instanceof RpcClientError.RpcClientError ? fromClient(e) : e)),
              Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.fail(agentError("host did not answer")) }),
            )
            return { client, scope, info }
          }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
        })

      const connect = (
        target: { readonly sessionId: SessionId; readonly socket: string; readonly pid: number },
        onClose: "stop" | "detach",
        /** Answer the session's hook calls with these. */
        answering?: { readonly hooks: Hooks; readonly timeout: Duration.Input },
      ) =>
        Effect.gen(function* () {
          const sessionScope = yield* Effect.scope
          type Conn = Effect.Success<ReturnType<typeof dial>>
          type Client = Conn["client"]

          type State =
            | { readonly _tag: "Connected"; readonly conn: Conn }
            | { readonly _tag: "Reconnecting"; readonly next: Deferred.Deferred<Conn, AgentError> }
            | { readonly _tag: "Failed"; readonly error: AgentError }

          let detached = false
          /** A subscription ran to its end, `Info` said so, or `end`/`stop` returned: a drop after that is the host exiting. */
          let sessionEnded = false
          const markEnded = Effect.sync(() => {
            sessionEnded = true
          })
          /** Connections given up on, closed once the next one is up (or when the session's scope closes). */
          const retired = new Set<Conn>()
          /** Completed by `detach`: calls and streams still running fail with `AgentError` rather than being interrupted. */
          const detachedSignal = Deferred.makeUnsafe<void>()
          const detachedError = () => agentError("detached from the session")
          const whenDetached = Effect.andThen(Deferred.await(detachedSignal), Effect.fail(detachedError()))

          const hostGone = (): string | null => {
            const manifest = readManifest(manifestPath(dir, target.sessionId))
            if (manifest === undefined) return `host ${target.pid} is gone (its manifest was removed)`
            if (manifest.pid !== target.pid || !isAlive(target.pid)) return `host ${target.pid} is gone`
            return null
          }
          const lostError = (message: string) => connectionError(agentError(message))

          /** Dial the host; when this connection drops later, `lost` hears of it at once. */
          const dialTracked = Effect.suspend(() => {
            const holder: { conn?: Conn } = {}
            const onDisconnect = Effect.suspend(() => (holder.conn ? lost(holder.conn, "disconnected") : Effect.void))
            return dial(target.socket, onDisconnect).pipe(
              Effect.tap((conn) =>
                Effect.sync(() => {
                  holder.conn = conn
                }),
              ),
            )
          })

          const first = yield* dialTracked
          let state: State = { _tag: "Connected", conn: first }
          if (first.info.ended) sessionEnded = true

          const closeRetired = Effect.suspend(() => {
            const conns = [...retired]
            retired.clear()
            return Effect.forEach(conns, (c) => Scope.close(c.scope, Exit.void), { discard: true })
          })

          /** Re-dial on the schedule; fail at once if the host is clearly gone. */
          const reconnect = (next: Deferred.Deferred<Conn, AgentError>, schedule: Schedule.Schedule<unknown, AgentError>) =>
            Effect.gen(function* () {
              const attempt = Effect.suspend(() => {
                const gone = hostGone()
                return gone !== null ? Effect.fail(lostError(gone)) : dialTracked
              })
              const exit = yield* attempt.pipe(
                Effect.retry({ schedule, while: () => !detached && hostGone() === null }),
                Effect.exit,
              )
              if (Exit.isSuccess(exit)) {
                const conn = exit.value
                if (detached) {
                  yield* Scope.close(conn.scope, Exit.void)
                  return yield* Deferred.fail(next, detachedError())
                }
                state = { _tag: "Connected", conn }
                if (conn.info.ended) sessionEnded = true
                yield* closeRetired
                return yield* Deferred.succeed(next, conn)
              }
              const last = Cause.findErrorOption(exit.cause)
              const gone = hostGone()
              const error = detached
                ? detachedError()
                : gone !== null
                  ? lostError(`lost the connection to the host: ${gone}`)
                  : lostError(
                      `lost the connection to host ${target.pid} and could not reconnect${
                        Option.isSome(last) ? `: ${last.value.message}` : ""
                      }`,
                    )
              state = { _tag: "Failed", error }
              yield* Deferred.fail(next, error)
            })

          /** `conn` dropped (or was found dead): start reconnecting, unless that's already happening. */
          const lost = (conn: Conn, why: string): Effect.Effect<void> =>
            Effect.suspend(() => {
              if (detached || state._tag !== "Connected" || state.conn !== conn) return Effect.void
              retired.add(conn)
              if (options.reconnect === false || sessionEnded) {
                state = { _tag: "Failed", error: lostError(`host connection: ${why}`) }
                return Effect.void
              }
              const next = Deferred.makeUnsafe<Conn, AgentError>()
              state = { _tag: "Reconnecting", next }
              return reconnect(next, options.reconnect ?? defaultReconnect).pipe(Effect.forkIn(sessionScope), Effect.asVoid)
            })

          const current: Effect.Effect<Conn, AgentError> = Effect.suspend(() => {
            if (detached) return Effect.fail(detachedError())
            switch (state._tag) {
              case "Connected":
                return Effect.succeed(state.conn)
              case "Reconnecting":
                return Deferred.await(state.next)
              case "Failed":
                return Effect.fail(state.error)
            }
          })

          /** The connection failed under this call: an RPC client error, or interrupted because `conn` was retired. */
          const droppedUnder = (conn: Conn, cause: Cause.Cause<unknown>): string | null => {
            const error = Cause.findErrorOption(cause)
            if (Option.isSome(error) && error.value instanceof RpcClientError.RpcClientError) return error.value.message
            if (Cause.hasInterruptsOnly(cause) && (retired.has(conn) || state._tag !== "Connected" || state.conn !== conn)) {
              return "connection closed"
            }
            return null
          }

          /** Run a call on the current connection; after a drop, again on the next one. */
          const call = <A, E>(
            make: (client: Client) => Effect.Effect<A, E>,
          ): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | AgentError> =>
            Effect.gen(function* () {
              while (true) {
                const conn = yield* current
                const exit = yield* Effect.exit(make(conn.client))
                if (Exit.isSuccess(exit)) return exit.value
                const why = droppedUnder(conn, exit.cause)
                if (why === null) return yield* Effect.failCause(exit.cause as Cause.Cause<Exclude<E, RpcClientError.RpcClientError>>)
                yield* lost(conn, why)
              }
            }).pipe(Effect.raceFirst(whenDetached))

          const info = call((c) => c.Info()).pipe(Effect.tap((i) => (i.ended ? markEnded : Effect.void)))

          const detach = Effect.suspend(() => {
            if (detached) return Effect.void
            detached = true
            const conns = [...retired, ...(state._tag === "Connected" ? [state.conn] : [])]
            retired.clear()
            return Deferred.succeed(detachedSignal, undefined).pipe(
              // Let racing calls and streams settle before their connection goes.
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(Effect.forEach(conns, (c) => Scope.close(c.scope, Exit.void), { discard: true })),
            )
          })

          const stop = Effect.gen(function* () {
            const stopped = yield* call((c) => c.Stop()).pipe(
              Effect.tap(markEnded),
              Effect.timeoutOption(Duration.seconds(30)),
              Effect.exit,
            )
            yield* detach
            if (yield* waitForExit(target.pid, Duration.seconds(10))) return
            // The host didn't stop on request (unreachable, or stuck): ask its signal handler.
            signal(target.pid, "SIGTERM")
            if (yield* waitForExit(target.pid, Duration.seconds(15))) return
            return yield* Exit.isFailure(stopped)
              ? Effect.failCause(stopped.cause)
              : Effect.fail(agentError(`host ${target.pid} did not exit after Stop`))
          })

          /** A streaming call that survives drops: after one, `make` runs again on the next connection. */
          const follow = <A, E>(
            make: (client: Client) => Stream.Stream<A, E>,
          ): Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError> | AgentError> =>
            Stream.suspend(() => {
              if (detached) return Stream.fail(detachedError())
              const attempt = (): Stream.Stream<A, Exclude<E, RpcClientError.RpcClientError> | AgentError> =>
                Stream.unwrap(
                  Effect.map(current, (conn) =>
                    make(conn.client).pipe(
                      Stream.catchCause((cause) => {
                        const why = droppedUnder(conn, cause)
                        if (why === null) return Stream.failCause(cause as Cause.Cause<Exclude<E, RpcClientError.RpcClientError>>)
                        return Stream.unwrap(Effect.as(lost(conn, why), Stream.suspend(attempt)))
                      }),
                    ),
                  ),
                )
              return attempt()
            }).pipe(Stream.interruptWhen(whenDetached))

          /** `Subscribe`, resumed after a drop from the seq after the last one delivered. */
          const subscribeFrom = (fromSeq: number, live = false): Stream.Stream<SeqEvent, EventsTrimmed | AgentError> =>
            Stream.suspend(() => {
              let next = Math.max(0, Math.floor(fromSeq))
              let delivered = false
              return follow((client) =>
                client.Subscribe({ fromSeq: next, live: live && !delivered }).pipe(
                  Stream.tap((entry) =>
                    Effect.sync(() => {
                      delivered = true
                      if (entry.seq >= next) next = entry.seq + 1
                    }),
                  ),
                  // The host ends the stream when the session ends (not when a consumer stops early).
                  Stream.concat(Stream.unwrap(Effect.as(markEnded, Stream.empty))),
                ),
              ).pipe(
                // The session's own ending error.
                Stream.tapError((e) => (e._tag === "AgentError" && !connectionErrors.has(e) ? markEnded : Effect.void)),
              )
            })

          const toEvents = (stream: Stream.Stream<SeqEvent, EventsTrimmed | AgentError>): Stream.Stream<AgentEvent, AgentError> =>
            stream.pipe(
              Stream.map((entry) => entry.event),
              Stream.mapError((e) => (e._tag === "EventsTrimmed" ? agentError(e.message, e) : e)),
            )

          // Pin "now" to the host's last sequence number, so events after this returns are kept.
          const subscribe = info.pipe(
            Effect.match({
              onFailure: (e) => Stream.fail(e),
              // Like a local session: subscribing after the end gets only the ending.
              onSuccess: (i) => toEvents(subscribeFrom(i.lastSeq + 1, !i.ended)),
            }),
          )

          /**
           * Register to answer hook calls (again after each reconnect, keeping
           * `clientId`), and answer each by running the hook here. Returns once
           * the host has the registration.
           */
          const answerHooks = (hooks: Hooks, timeout: Duration.Duration) =>
            Effect.gen(function* () {
              const names = hookNames(hooks)
              if (names.length === 0) return
              const clientId = randomUUID()
              const timeoutMs = Duration.toMillis(timeout)
              /** Results by hook id: a request delivered again after a reconnect doesn't run twice. */
              const runs = new Map<string, Deferred.Deferred<string | null>>()
              const runHook = (request: HookRequest): Effect.Effect<Option.Option<string>> => {
                const c = request.call
                switch (request.hook) {
                  case "beforeTool":
                    return hooks.beforeTool !== undefined && c !== null
                      ? hooks.beforeTool({ callId: c.callId, name: c.name, input: c.input })
                      : Effect.succeedNone
                  case "afterTool":
                    return hooks.afterTool !== undefined && c !== null
                      ? hooks.afterTool({
                          callId: c.callId,
                          name: c.name,
                          input: c.input,
                          output: c.output ?? "",
                          isError: c.isError ?? false,
                        })
                      : Effect.succeedNone
                  case "beforeStop":
                    return hooks.beforeStop !== undefined ? hooks.beforeStop() : Effect.succeedNone
                }
              }
              const answer = (request: HookRequest) =>
                Effect.gen(function* () {
                  let result = runs.get(request.hookId)
                  if (result === undefined) {
                    result = Deferred.makeUnsafe<string | null>()
                    runs.set(request.hookId, result)
                    if (runs.size > 1_000) runs.delete(runs.keys().next().value!)
                    // As locally: a failure, defect or timeout adds nothing.
                    yield* Effect.suspend(() => runHook(request)).pipe(
                      Effect.timeoutOption(timeout),
                      Effect.map((text) => (Option.isSome(text) && Option.isSome(text.value) && text.value.value !== "" ? text.value.value : null)),
                      Effect.catchCause(() => Effect.succeed(null)),
                      Effect.flatMap((text) => Deferred.succeed(result!, text)),
                      Effect.forkIn(sessionScope),
                    )
                  }
                  const text = yield* Deferred.await(result)
                  yield* call((c) => c.HookResponse({ hookId: request.hookId, result: text })).pipe(Effect.ignore)
                })
              const registered = Deferred.makeUnsafe<void, AgentError>()
              yield* follow((client) => client.HookRequests({ clientId, hooks: names, timeoutMs })).pipe(
                Stream.runForEach((item) =>
                  item._tag === "Registered"
                    ? Deferred.succeed(registered, undefined).pipe(Effect.asVoid)
                    : answer(item).pipe(Effect.forkIn(sessionScope), Effect.asVoid),
                ),
                Effect.onExit((exit) =>
                  Deferred.done(registered, Exit.isSuccess(exit) ? Exit.void : Exit.fail(agentError("could not register to answer hooks"))),
                ),
                Effect.ignore,
                Effect.forkIn(sessionScope),
              )
              yield* Deferred.await(registered).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(10),
                  orElse: () => Effect.fail(agentError("the host did not take the hook registration")),
                }),
              )
            })

          /** One request id per call, repeated by its retries, so the host acts on it once. */
          const once = <A, E>(make: (requestId: string) => Effect.Effect<A, E>) => Effect.suspend(() => make(randomUUID()))
          const session: RemoteSession = {
            sessionId: first.info.sessionId,
            provider: first.info.provider,
            location: Option.fromNullishOr(first.info.location),
            pid: info.pipe(Effect.map((i) => Option.fromNullishOr(i.pid)), Effect.orElseSucceed(Option.none)),
            hostPid: target.pid,
            socket: target.socket,
            subscribe,
            events: Stream.unwrap(subscribe),
            send: (input) => once((requestId) => call((c) => c.Send({ input, requestId }))),
            turn: (input) => once((requestId) => call((c) => c.Turn({ input, requestId }))),
            steer: (input) => once((requestId) => call((c) => c.Steer({ input, requestId }))),
            interrupt: once((requestId) => call((c) => c.Interrupt({ requestId }))),
            end: call((c) => c.End()).pipe(Effect.tap(markEnded)),
            subscribeFrom: (fromSeq) => subscribeFrom(fromSeq),
            lastSeq: Effect.map(info, (i) => i.lastSeq),
            info,
            awaitTurn: (turnId) => call((c) => c.AwaitTurn({ turnId })),
            awaitMessage: (messageId) => call((c) => c.AwaitMessage({ messageId })),
            detach,
            stop,
          }

          yield* Effect.addFinalizer(() => (onClose === "stop" && !detached ? Effect.ignore(stop) : detach))
          if (answering !== undefined) yield* answerHooks(answering.hooks, Duration.fromInputUnsafe(answering.timeout))
          return session
        })

      // ---- services ----

      const hookTimeout = options.hookTimeout ?? Duration.seconds(5)
      /** Hooks are only forwarded where the provider runs them (`capabilities.hooks`). */
      const refuseHooks = (hooks: Hooks | undefined) =>
        Effect.gen(function* () {
          const names = hookNames(hooks)
          if (names.length === 0 || (yield* local.capabilities).hooks) return
          return yield* agentError(`${provider} does not support RunOptions.hooks (${names.join(", ")}): capabilities.hooks is false`)
        })

      const open = (
        run: RunOptions,
        session: { readonly hookTimeout?: Duration.Input } = {},
      ): Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope> =>
        Effect.gen(function* () {
          yield* refuseHooks(run.hooks)
          const names = hookNames(run.hooks)
          if (run.resume !== undefined) {
            const existing = readManifest(manifestPath(dir, run.resume))
            if (existing !== undefined && isLive(existing)) {
              return yield* agentError(`session ${run.resume} is already running in host ${existing.pid}; attach to it instead`)
            }
          }
          const spec: HostSpec = {
            provider,
            ...(options.claude !== undefined && { claude: options.claude }),
            ...(options.codex !== undefined && { codex: options.codex }),
            ...(options.replay !== undefined && { replay: options.replay }),
            ...(options.replayKnownSessions !== undefined && { replayKnownSessions: options.replayKnownSessions }),
            run: fromRunOptions(run),
            dir,
            ...(options.maxEvents !== undefined && { maxEvents: options.maxEvents }),
            ...(options.orphanTimeout !== undefined && { orphanTimeout: Duration.toMillis(Duration.fromInputUnsafe(options.orphanTimeout)) }),
            ...(options.linger !== undefined && { linger: Duration.toMillis(Duration.fromInputUnsafe(options.linger)) }),
            ...(options.persistEvents !== undefined && { persistEvents: options.persistEvents }),
            retainEvents: Duration.toMillis(retainEvents),
            ...(options.testDropBeforeReply !== undefined && { testDropBeforeReply: [...options.testDropBeforeReply] }),
            ...(names.length > 0 && { hooks: Object.fromEntries(names.map((name) => [name, true])) }),
            ...(options.testInvokeHook === true && { testInvokeHook: true }),
          }
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(HostSpec))(spec).pipe(
            Effect.mapError((e) => agentError(`invalid options: ${e.message}`, e)),
          )
          const wrap = yield* prepareWrap(run.cwd)
          const ready = yield* startHost(wrap(hostCommand), encoded)
          const answering = run.hooks !== undefined ? { hooks: run.hooks, timeout: session.hookTimeout ?? hookTimeout } : undefined
          return yield* connect(ready, onScopeClose, answering).pipe(
            Effect.tapError(() => Effect.sync(() => signal(ready.pid, "SIGTERM"))),
          )
        })

      const attach = (
        sessionId: SessionId,
        attachOptions: AttachOptions = {},
      ): Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope> =>
        Effect.gen(function* () {
          yield* refuseHooks(attachOptions.hooks)
          prune()
          const manifest = readManifest(manifestPath(dir, sessionId))
          if (manifest === undefined) return yield* notFound(sessionId, "no manifest")
          if (!isLive(manifest)) {
            removeHostFiles(dir, sessionId)
            return yield* notFound(sessionId, `host ${manifest.pid} is gone`)
          }
          const answering =
            attachOptions.hooks !== undefined
              ? { hooks: attachOptions.hooks, timeout: attachOptions.hookTimeout ?? hookTimeout }
              : undefined
          return yield* connect(manifest, onScopeClose, answering).pipe(
            Effect.catchTag("AgentError", (e) => {
              if (!isAlive(manifest.pid)) removeHostFiles(dir, sessionId)
              return Effect.fail(notFound(sessionId, e.message))
            }),
          )
        })

      const fromFile = (sessionId: SessionId, fromSeq: number): Stream.Stream<SeqEvent, AgentError> =>
        EventFile.read(eventsPath(dir, sessionId), fromSeq).pipe(Stream.mapError((e) => agentError(e.message, e)))

      const events = (sessionId: SessionId, fromSeq = 0): Stream.Stream<SeqEvent, SessionNotFound | EventsTrimmed | AgentError> =>
        Stream.suspend((): Stream.Stream<SeqEvent, SessionNotFound | EventsTrimmed | AgentError> => {
          prune()
          const file = eventsPath(dir, sessionId)
          const manifest = readManifest(manifestPath(dir, sessionId))
          if (manifest === undefined || !isLive(manifest)) {
            if (manifest !== undefined) removeHostFiles(dir, sessionId)
            if (!existsSync(file)) return Stream.fail(notFound(sessionId, "no host and no events file"))
            return fromFile(sessionId, fromSeq)
          }
          // Follow the live host; if it goes away mid-stream, finish from its file.
          let next = Math.max(0, Math.floor(fromSeq))
          const followed = Stream.unwrap(
            connect(manifest, "detach").pipe(
              Effect.map((session) => session.subscribeFrom(next)),
              Effect.catchTag("AgentError", (e) => Effect.fail(connectionError(e))),
            ),
          ).pipe(
            Stream.tap((entry) =>
              Effect.sync(() => {
                if (entry.seq >= next) next = entry.seq + 1
              }),
            ),
            Stream.catchIf(
              (e): e is AgentError => e._tag === "AgentError" && connectionErrors.has(e) && existsSync(file),
              () => Stream.suspend(() => fromFile(sessionId, next)),
            ),
          )
          return followed
        })

      const agent = Agent.of({
        provider,
        // `hooks` as the provider has them: forwarded to the client.
        capabilities: local.capabilities.pipe(Effect.map((c) => ({ ...c, reattach: true }))),
        open: (run) => open(run),
        status: local.status,
        history: local.history,
      })
      const list = Effect.sync(() => {
        const live = listHosts(dir)
        prune()
        return live
      })
      const hosts = AgentHosts.of({ open, attach, list, events })
      return Context.make(Agent, agent).pipe(Context.add(AgentHosts, hosts))
    }),
  )

/** Session id helper for ids read from elsewhere (e.g. a database). */
export const sessionId = SessionId.make
