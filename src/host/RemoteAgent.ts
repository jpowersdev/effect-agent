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
 * and `AgentHosts` (`open` typed as `RemoteSession`, `attach`, `list`).
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
import { Context, Deferred, Duration, Effect, Exit, Layer, Option, Schedule, Schema, Scope, Stream } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { spawn } from "node:child_process"
import { closeSync, openSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Agent, type AgentSession, type RunOptions } from "../Agent.ts"
import { AgentError, SessionNotFound, type TurnFailure } from "../AgentError.ts"
import type { AgentEvent, TurnSucceeded } from "../AgentEvent.ts"
import { type MessageId, SessionId, type TurnId } from "../Domain.ts"
import * as Launcher from "../Launcher.ts"
import { isLive, readManifest } from "./Host.ts"
import {
  defaultDir,
  ensureDir,
  fromRunOptions,
  HostSpec,
  type Manifest,
  manifestPath,
  providerLayer,
  type ProviderSpec,
  ReadyLine,
  socketPath,
} from "./HostSpec.ts"
import { type EventsTrimmed, type HostInfo, HostRpcs, type SeqEvent } from "./protocol.ts"

export const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url))

export interface RemoteAgentOptions extends ProviderSpec {
  /** Where hosts keep their sockets, manifests and logs. Default `HostSpec.defaultDir()`. */
  readonly dir?: string
  /** Events each host keeps for `subscribeFrom`. Default 50 000. */
  readonly maxEvents?: number
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

/** `AgentSession`, plus what reattaching needs. */
export interface RemoteSession extends AgentSession {
  /** The host process's pid. */
  readonly hostPid: number
  readonly socket: string
  /**
   * Every event with `seq >= fromSeq` the host still has, then live ones,
   * until the session ends. Fails with `EventsTrimmed` if `fromSeq` is
   * older than what the host keeps, rather than skipping events silently.
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

export class AgentHosts extends Context.Service<
  AgentHosts,
  {
    /** `Agent.open`, typed as a `RemoteSession`. */
    readonly open: (options: RunOptions) => Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope>
    /** Connect to a running host. `SessionNotFound` when no live host has that session. */
    readonly attach: (sessionId: SessionId) => Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope>
    /** Live hosts in the directory; manifests of dead ones are removed. */
    readonly list: Effect.Effect<ReadonlyArray<Manifest>>
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

      const connect = (target: { readonly sessionId: SessionId; readonly socket: string; readonly pid: number }) =>
        Effect.gen(function* () {
          const connection = yield* Scope.make()
          const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
            Layer.provide(Layer.effect(Socket.Socket, NodeSocket.makeNet({ path: target.socket }))),
            Layer.provide(RpcSerialization.layerNdjson),
          )
          const client = yield* Layer.buildWithScope(protocol, connection).pipe(
            Effect.flatMap((context) =>
              RpcClient.make(HostRpcs, { disableTracing: true }).pipe(Effect.provideContext(context), Scope.provide(connection)),
            ),
          )

          let detached = false
          /** Completed by `detach`: calls and streams still running fail with `AgentError` rather than being interrupted. */
          const detachedSignal = Deferred.makeUnsafe<void>()
          const whenDetached = Effect.andThen(Deferred.await(detachedSignal), Effect.fail(agentError("detached from the session")))
          const call = <A, E>(
            effect: Effect.Effect<A, E>,
          ): Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | AgentError> =>
            Effect.suspend(() =>
              detached
                ? Effect.fail(agentError("detached from the session"))
                : (effect as Effect.Effect<A, unknown>).pipe(
                    Effect.mapError((e) => (e instanceof RpcClientError.RpcClientError ? fromClient(e) : e)),
                    Effect.raceFirst(whenDetached),
                  ),
            ) as Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError> | AgentError>

          const info = call(client.Info())
          const first = yield* info.pipe(
            Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.fail(agentError("host did not answer")) }),
            Effect.exit,
          )
          if (Exit.isFailure(first)) {
            yield* Scope.close(connection, Exit.void)
            return yield* Effect.failCause(first.cause)
          }

          const detach = Effect.suspend(() => {
            if (detached) return Effect.void
            detached = true
            return Deferred.succeed(detachedSignal, undefined).pipe(
              // Let racing calls and streams settle before their connection goes.
              Effect.andThen(Effect.yieldNow),
              Effect.andThen(Scope.close(connection, Exit.void)),
            )
          })

          const stop = Effect.gen(function* () {
            const stopped = yield* call(client.Stop()).pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.exit)
            yield* detach
            if (yield* waitForExit(target.pid, Duration.seconds(10))) return
            // The host didn't stop on request (unreachable, or stuck): ask its signal handler.
            signal(target.pid, "SIGTERM")
            if (yield* waitForExit(target.pid, Duration.seconds(15))) return
            return yield* Exit.isFailure(stopped)
              ? Effect.failCause(stopped.cause)
              : Effect.fail(agentError(`host ${target.pid} did not exit after Stop`))
          })

          const subscribeFrom = (fromSeq: number, live = false): Stream.Stream<SeqEvent, EventsTrimmed | AgentError> =>
            Stream.suspend(() =>
              detached
                ? Stream.fail(agentError("detached from the session"))
                : client.Subscribe({ fromSeq, live }).pipe(
                    Stream.catchIf(
                      (e): e is RpcClientError.RpcClientError => e instanceof RpcClientError.RpcClientError,
                      (e) => Stream.fail(fromClient(e)),
                    ),
                    Stream.interruptWhen(whenDetached),
                  ),
            )

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

          const session: RemoteSession = {
            sessionId: first.value.sessionId,
            provider: first.value.provider,
            location: Option.fromNullishOr(first.value.location),
            pid: info.pipe(Effect.map((i) => Option.fromNullishOr(i.pid)), Effect.orElseSucceed(Option.none)),
            hostPid: target.pid,
            socket: target.socket,
            subscribe,
            events: Stream.unwrap(subscribe),
            send: (input) => call(client.Send({ input })),
            turn: (input) => call(client.Turn({ input })),
            steer: (input) => call(client.Steer({ input })),
            interrupt: call(client.Interrupt()),
            end: call(client.End()),
            subscribeFrom: (fromSeq) => subscribeFrom(fromSeq),
            lastSeq: Effect.map(info, (i) => i.lastSeq),
            info,
            awaitTurn: (turnId) => call(client.AwaitTurn({ turnId })),
            awaitMessage: (messageId) => call(client.AwaitMessage({ messageId })),
            detach,
            stop,
          }

          yield* Effect.addFinalizer(() => (onScopeClose === "stop" && !detached ? Effect.ignore(stop) : detach))
          return session
        })

      // ---- services ----

      const open = (run: RunOptions): Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope> =>
        Effect.gen(function* () {
          if (run.hooks !== undefined) {
            return yield* agentError("hooks can't be used with RemoteAgent: functions can't cross processes")
          }
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
          }
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(HostSpec))(spec).pipe(
            Effect.mapError((e) => agentError(`invalid options: ${e.message}`, e)),
          )
          const wrap = yield* prepareWrap(run.cwd)
          const ready = yield* startHost(wrap(hostCommand), encoded)
          return yield* connect(ready).pipe(
            Effect.tapError(() => Effect.sync(() => signal(ready.pid, "SIGTERM"))),
          )
        })

      const attach = (sessionId: SessionId): Effect.Effect<RemoteSession, SessionNotFound | AgentError, Scope.Scope> =>
        Effect.gen(function* () {
          const manifest = readManifest(manifestPath(dir, sessionId))
          if (manifest === undefined) return yield* notFound(sessionId, "no manifest")
          if (!isLive(manifest)) {
            removeHostFiles(dir, sessionId)
            return yield* notFound(sessionId, `host ${manifest.pid} is gone`)
          }
          return yield* connect(manifest).pipe(
            Effect.catchTag("AgentError", (e) => {
              if (!isAlive(manifest.pid)) removeHostFiles(dir, sessionId)
              return Effect.fail(notFound(sessionId, e.message))
            }),
          )
        })

      const agent = Agent.of({
        provider,
        capabilities: local.capabilities.pipe(Effect.map((c) => ({ ...c, reattach: true, hooks: false }))),
        open,
        status: local.status,
        history: local.history,
      })
      const hosts = AgentHosts.of({ open, attach, list: Effect.sync(() => listHosts(dir)) })
      return Context.make(Agent, agent).pipe(Context.add(AgentHosts, hosts))
    }),
  )

/** Session id helper for ids read from elsewhere (e.g. a database). */
export const sessionId = SessionId.make
