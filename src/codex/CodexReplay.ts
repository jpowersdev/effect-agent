/**
 * A `CodexAppServer` that replays a recorded session with no process.
 *
 * ```ts skip-type-checking
 * CodexAgent.layer().pipe(Layer.provide(CodexReplay.layer(jsonlText)))
 * ```
 *
 * A recording is what `CodexAppServer.layer({ record })` writes: one JSON
 * object per line, `{"dir":"out","msg":...}` for client->server frames and
 * `{"dir":"in","msg":...}` for server->client frames. A line
 * `{"dir":"exit","exitCode":null,"signal":"SIGKILL"}` simulates app-server
 * dying at that point.
 *
 * Each client request is matched to the next recorded `out` request with the
 * same method; the recorded `in` frames after it are then delivered, up to
 * the next recorded `out` request. Response ids are rewritten to the client's
 * request ids, and recorded `clientUserMessageId`s to the client's.
 *
 * @since 0.1.0
 */
import { Deferred, Effect, Layer, Option } from "effect"
import { AgentError } from "../AgentError.ts"
import { CodexAppServer, type Connection, makeRpcCore, parseUserAgentVersion, type ProcessExit } from "./CodexAppServer.ts"
import * as P from "./protocol.ts"

/**
 * One line of a recording.
 *
 * @since 0.1.0
 * @category models
 */
export type Frame =
  | { readonly dir: "out" | "in"; readonly msg: P.Message }
  | { readonly dir: "exit"; readonly exitCode: number | null; readonly signal: string | null }

/**
 * Parses JSONL recording text into frames.
 *
 * @since 0.1.0
 * @category testing
 */
export const parseRecording = (jsonl: string): ReadonlyArray<Frame> =>
  jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Frame)

const agentError = (message: string) => new AgentError({ message, provider: "codex" })

const isOutRequest = (f: Frame): f is { dir: "out"; msg: P.Message } =>
  f.dir === "out" && f.msg.method !== undefined && f.msg.id !== undefined

/** Replace every string found in `map` anywhere in a JSON value. */
const rewrite = (value: unknown, map: ReadonlyMap<string, string>): unknown => {
  if (map.size === 0) return value
  if (typeof value === "string") return map.get(value) ?? value
  if (Array.isArray(value)) return value.map((v) => rewrite(v, map))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, map)
    return out
  }
  return value
}

const connect = (frames: ReadonlyArray<Frame>) =>
  Effect.gen(function* () {
    let cursor = 0
    /** recorded request id -> client request id */
    const ids = new Map<P.RequestId, P.RequestId>()
    /** recorded clientUserMessageId -> client's */
    const strings = new Map<string, string>()
    let exited = false

    // Assigned below; `write` needs `core` to deliver responses.
    let deliver: (msg: P.Message) => Effect.Effect<void> = () => Effect.void
    let onExit: (exit: ProcessExit) => Effect.Effect<void> = () => Effect.void

    const write = (msg: P.Message): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (msg.method === undefined || msg.id === undefined) return // notifications and responses to server requests
        if (exited) return
        let i = cursor
        while (i < frames.length && !(isOutRequest(frames[i]!) && (frames[i] as { msg: P.Message }).msg.method === msg.method)) i++
        if (i >= frames.length) {
          return yield* deliver({
            id: msg.id,
            error: { code: -32000, message: `replay: no recorded ${msg.method} request left` },
          })
        }
        const recorded = (frames[i] as { msg: P.Message }).msg
        ids.set(recorded.id!, msg.id)
        const recordedClientId = (recorded.params as { clientUserMessageId?: unknown } | undefined)?.clientUserMessageId
        const clientId = (msg.params as { clientUserMessageId?: unknown } | undefined)?.clientUserMessageId
        if (typeof recordedClientId === "string" && typeof clientId === "string") strings.set(recordedClientId, clientId)
        cursor = i + 1
        while (cursor < frames.length && !isOutRequest(frames[cursor]!)) {
          const frame = frames[cursor++]!
          if (frame.dir === "exit") {
            exited = true
            return yield* onExit({ exitCode: frame.exitCode, signal: frame.signal })
          }
          if (frame.dir !== "in") continue
          const m = rewrite(frame.msg, strings) as P.Message
          if (P.isResponse(m)) {
            const id = ids.get(m.id!)
            if (id !== undefined) yield* deliver({ ...m, id })
          } else {
            yield* deliver(m)
          }
        }
      })

    const core = yield* makeRpcCore(write)
    deliver = (msg) => Effect.asVoid(core.dispatch(msg))
    const finish = (exit: ProcessExit) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(core.exitSignal)) return
        yield* core.failPending(`codex app-server exited (${exit.signal ?? `code ${exit.exitCode}`})`)
        yield* core.endIncoming
        yield* Deferred.succeed(core.exitSignal, exit)
      })
    onExit = finish

    const initialize = yield* core
      .request("initialize", { clientInfo: { name: "effect_agent", title: null, version: "0.0.0" }, capabilities: { experimentalApi: true, requestAttestation: false } })
      .pipe(Effect.mapError((e) => agentError(`replay initialize failed: ${e.message}`)))

    const stop = (signal: string) =>
      Effect.suspend(() => {
        exited = true
        return finish({ exitCode: null, signal })
      })
    const close = stop("SIGTERM")
    yield* Effect.addFinalizer(() => close)

    return {
      pid: null,
      initialize,
      request: core.request,
      incoming: core.incomingStream,
      exit: Deferred.await(core.exitSignal),
      exited: Deferred.isDone(core.exitSignal).pipe(
        Effect.flatMap((done) => (done ? Effect.map(Deferred.await(core.exitSignal), Option.some) : Effect.succeedNone)),
      ),
      close,
      kill: stop("SIGKILL"),
    } satisfies Connection
  })

/**
 * `recording` is JSONL text (as written by `record`) or parsed frames.
 *
 * @since 0.1.0
 * @category testing
 */
export const layer = (recording: string | ReadonlyArray<Frame>): Layer.Layer<CodexAppServer> => {
  const frames = typeof recording === "string" ? parseRecording(recording) : recording
  const init = frames.find(
    (f, i) => f.dir === "in" && P.isResponse(f.msg) && i > 0 && frames.slice(0, i).some((g) => g.dir === "out" && g.msg.method === "initialize"),
  )
  const userAgent = ((init as { msg?: P.Message } | undefined)?.msg?.result as P.InitializeResponse | undefined)?.userAgent
  return Layer.succeed(
    CodexAppServer,
    CodexAppServer.of({
      connect: () => connect(frames),
      version: Effect.succeed(userAgent !== undefined ? parseUserAgentVersion(userAgent) : null),
    }),
  )
}
