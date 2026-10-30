/**
 * Remote hooks: the functions stay in the client; the host forwards each hook
 * call to an attached client with hooks. Real host processes over a Claude
 * recording. A recording never fires hooks, so the host's internal
 * `TestInvokeHook` RPC makes calls through the same bridge the provider's
 * hooks use (the live check in scripts/live-reattach.ts covers the CLI firing
 * them).
 */
import { NodeSocket } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Schedule } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks } from "../src/index.ts"
import { AgentHosts, HostProtocol, HostSpec, RemoteAgent } from "../src/host/index.ts"

const dir = mkdtempSync(join(tmpdir(), "ea-hooks-"))
const started = new Set<number>()

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterAll(() => {
  for (const m of RemoteAgent.listHosts(dir)) started.add(m.pid)
  for (const pid of started) if (isAlive(pid)) process.kill(pid, "SIGKILL")
  rmSync(dir, { recursive: true, force: true })
})

const cwd = "/tmp/effect-agent-replay"
const layer = (options: Partial<RemoteAgent.RemoteAgentOptions> = {}) =>
  RemoteAgent.layer({
    provider: "claude",
    replay: join(import.meta.dirname, "fixtures", "claude", "simple-turn.jsonl"),
    dir,
    testInvokeHook: true,
    onScopeClose: "detach",
    ...options,
  })

const bash = { callId: "toolu_1", name: "Bash", input: { command: "ls" } }

/**
 * Ask the host to run a hook as the agent would, from a separate connection.
 * Retried (with the same request id, so it is one call) if a test drops it.
 */
const invoke = (socket: string, hook: HostProtocol.HookName, call: HostProtocol.HookCall | null = null) =>
  Effect.gen(function* () {
    const requestId = randomUUID()
    const t0 = Date.now()
    const protocol = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Layer.provide(Layer.effect(Socket.Socket, NodeSocket.makeNet({ path: socket }))),
      Layer.provide(RpcSerialization.layerNdjson),
    )
    for (let attempt = 0; attempt < 100; attempt++) {
      const exit = yield* RpcClient.make(HostProtocol.HostRpcs, { disableTracing: true }).pipe(
        Effect.flatMap((client) => client.TestInvokeHook({ requestId, hook, call })),
        Effect.scoped,
        Effect.provide(protocol),
        Effect.exit,
      )
      if (Exit.isSuccess(exit)) return { result: exit.value, ms: Date.now() - t0 }
      const error = Cause.findErrorOption(exit.cause)
      if (Option.isNone(error) || !(error.value instanceof RpcClientError.RpcClientError)) return yield* Effect.failCause(exit.cause)
      yield* Effect.sleep(Duration.millis(50))
    }
    return yield* Effect.die(new Error("could not invoke the hook"))
  })

const hostLog = (sessionId: string) => {
  try {
    return readFileSync(HostSpec.logPath(dir, sessionId), "utf8")
  } catch {
    return ""
  }
}

const open = (hooks: Hooks | undefined, session: { readonly hookTimeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const s = yield* (yield* AgentHosts).open({ cwd, ...(hooks !== undefined && { hooks }) }, session)
    started.add(s.hostPid)
    return s
  })

const timeout = 30_000

describe("remote hooks", () => {
  it.live(
    "each hook is answered by the attached client, with its Schema-encoded input",
    () =>
      Effect.gen(function* () {
        const session = yield* open({
          beforeTool: (call) => Effect.succeed(Option.some(`before ${call.name} ${JSON.stringify(call.input)}`)),
          afterTool: (call) => Effect.succeed(Option.some(`after ${call.output} ${call.isError}`)),
          beforeStop: () => Effect.succeedNone,
        })
        expect((yield* invoke(session.socket, "beforeTool", bash)).result).toBe('before Bash {"command":"ls"}')
        expect((yield* invoke(session.socket, "afterTool", { ...bash, output: "a.txt", isError: false })).result).toBe("after a.txt false")
        expect((yield* invoke(session.socket, "beforeStop")).result).toBeNull()
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "with no client with hooks attached, a hook adds nothing at once",
    () =>
      Effect.gen(function* () {
        const hosts = yield* AgentHosts
        const { sessionId, socket } = yield* Effect.scoped(open({ beforeTool: () => Effect.succeed(Option.some("x")) }))
        // Detached: nobody answers.
        const none = yield* invoke(socket, "beforeTool", bash)
        expect(none.result).toBeNull()
        expect(none.ms).toBeLessThan(500)
        // Attached without hooks: still nobody.
        const session = yield* hosts.attach(sessionId)
        const still = yield* invoke(socket, "beforeTool", bash)
        expect(still.result).toBeNull()
        expect(still.ms).toBeLessThan(500)
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "a client slower than hookTimeout adds nothing, after about the timeout, and the host logs it",
    () =>
      Effect.gen(function* () {
        const session = yield* open(
          { beforeTool: () => Effect.as(Effect.sleep(Duration.seconds(5)), Option.some("too late")) },
          { hookTimeout: "400 millis" },
        )
        const slow = yield* invoke(session.socket, "beforeTool", bash)
        expect(slow.result).toBeNull()
        expect(slow.ms).toBeGreaterThanOrEqual(350)
        expect(slow.ms).toBeLessThan(2_000)
        expect(hostLog(session.sessionId)).toMatch(/hook beforeTool .* timed out after 400 ms/)
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "a hook that fails or defects adds nothing, without waiting for the timeout",
    () =>
      Effect.gen(function* () {
        const session = yield* open({
          beforeTool: () => Effect.die(new Error("hook bug")),
          afterTool: () => Effect.fail("nope").pipe(Effect.orDie),
          beforeStop: () =>
            Effect.sync(() => {
              throw new Error("thrown")
            }),
        })
        for (const [hook, call] of [
          ["beforeTool", bash],
          ["afterTool", { ...bash, output: "", isError: true }],
          ["beforeStop", null],
        ] as const) {
          const out = yield* invoke(session.socket, hook, call)
          expect(out.result).toBeNull()
          expect(out.ms).toBeLessThan(2_000) // the timeout is 5 s
        }
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "a hook call is delivered again after the client reconnects, and runs once",
    () =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0)
        const session = yield* open({ beforeTool: () => Effect.as(Ref.update(runs, (n) => n + 1), Option.some("delivered")) })
        // The host drops every connection instead of delivering the first request.
        const out = yield* invoke(session.socket, "beforeTool", bash)
        expect(out.result).toBe("delivered")
        expect(yield* Ref.get(runs)).toBe(1)
        expect(hostLog(session.sessionId)).toMatch(/dropping/)
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer({ testDropBeforeReply: ["HookRequest"] }))),
    timeout,
  )

  it.live(
    "a connection dropped while the client runs a hook: the answer still arrives, and the hook runs once",
    () =>
      Effect.gen(function* () {
        const runs = yield* Ref.make(0)
        const running = yield* Ref.make(false)
        const session = yield* open({
          beforeTool: () =>
            Effect.gen(function* () {
              yield* Ref.update(runs, (n) => n + 1)
              yield* Ref.set(running, true)
              yield* Effect.sleep(Duration.millis(600))
              return Option.some("slow but sure")
            }),
        })
        const pending = yield* invoke(session.socket, "beforeTool", bash).pipe(Effect.forkScoped)
        while (!(yield* Ref.get(running))) yield* Effect.sleep(Duration.millis(10))
        process.kill(session.hostPid, "SIGUSR2")
        const out = yield* Fiber.join(pending)
        expect(out.result).toBe("slow but sure")
        expect(yield* Ref.get(runs)).toBe(1)
        expect(hostLog(session.sessionId)).toMatch(/dropping/)
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "attach(sessionId, { hooks }) takes over; when it detaches the earlier client answers again",
    () =>
      Effect.gen(function* () {
        const hosts = yield* AgentHosts
        const first = yield* open({ beforeTool: () => Effect.succeed(Option.some("A")) })
        expect((yield* invoke(first.socket, "beforeTool", bash)).result).toBe("A")

        const second = yield* hosts.attach(first.sessionId, { hooks: { beforeTool: () => Effect.succeed(Option.some("B")) } })
        expect((yield* invoke(first.socket, "beforeTool", bash)).result).toBe("B")
        // A client attached without hooks never answers.
        const third = yield* hosts.attach(first.sessionId)
        expect((yield* invoke(first.socket, "beforeTool", bash)).result).toBe("B")
        // A client without that hook doesn't answer it either.
        const fourth = yield* hosts.attach(first.sessionId, { hooks: { beforeStop: () => Effect.succeed(Option.some("D")) } })
        expect((yield* invoke(first.socket, "beforeTool", bash)).result).toBe("B")
        expect((yield* invoke(first.socket, "beforeStop")).result).toBe("D")

        yield* second.detach
        expect((yield* invoke(first.socket, "beforeTool", bash)).result).toBe("A")
        yield* third.detach
        yield* fourth.detach
        yield* first.stop
      }).pipe(Effect.scoped, Effect.provide(layer())),
    timeout,
  )

  it.live(
    "TestInvokeHook is refused unless the host was started for tests",
    () =>
      Effect.gen(function* () {
        const session = yield* open({ beforeTool: () => Effect.succeed(Option.some("x")) })
        const exit = yield* invoke(session.socket, "beforeTool", bash).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        yield* session.stop
      }).pipe(Effect.scoped, Effect.provide(layer({ testInvokeHook: false }))),
    timeout,
  )
})

/**
 * The provider -> host -> client chain with no CLI: a host replays a
 * recording with real hook calls (test/fixtures/claude/hooks.jsonl), its
 * Claude session's SDK hooks forward them to this process, and the replay
 * logs what the SDK got back (`replayHookLog`).
 */
describe("remote hooks over a recording with hook calls", () => {
  const prompt = "Use the Bash tool once to run `echo hello`, then reply with the secret word."
  const replayLayer = (hookLog: string, options: Partial<RemoteAgent.RemoteAgentOptions> = {}) =>
    RemoteAgent.layer({
      provider: "claude",
      replay: join(import.meta.dirname, "fixtures", "claude", "hooks.jsonl"),
      replayHookLog: hookLog,
      dir,
      onScopeClose: "detach",
      ...options,
    })
  const answered = (hookLog: string, event: string) =>
    readFileSync(hookLog, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { event: string; outputs: Array<{ hookSpecificOutput?: { additionalContext?: string } }> })
      .filter((h) => h.event === event)
      .map((h) => (h.outputs.length === 0 ? "no hook" : (h.outputs[0]?.hookSpecificOutput?.additionalContext ?? null)))

  it.live(
    "the CLI's hook calls reach the client's functions, and their answers reach the SDK",
    () =>
      Effect.gen(function* () {
        const hookLog = join(dir, "replayed-hooks-1.jsonl")
        const calls: Array<unknown> = []
        let stops = 0
        yield* Effect.gen(function* () {
          const session = yield* open({
            beforeTool: (call) => Effect.sync(() => (calls.push({ before: call }), Option.some("remote: secret"))),
            afterTool: (call) => Effect.sync(() => (calls.push({ after: call.output, isError: call.isError }), Option.some("remote: checked"))),
            beforeStop: () => Effect.sync(() => (calls.push("stop"), stops++ === 0 ? Option.some("remote: keep going") : Option.none())),
          })
          const done = yield* session.turn(prompt)
          expect(done.finalText).toBe("KIWI")
          yield* session.stop
        }).pipe(Effect.scoped, Effect.provide(replayLayer(hookLog)))
        expect(calls).toEqual([
          { before: { callId: expect.stringMatching(/^toolu_/), name: "Bash", input: expect.objectContaining({ command: "echo hello" }) } },
          { after: "hello", isError: false },
          "stop",
          "stop",
        ])
        expect(answered(hookLog, "PreToolUse")).toEqual(["remote: secret"])
        expect(answered(hookLog, "PostToolUse")).toEqual(["remote: checked"])
        expect(answered(hookLog, "Stop")).toEqual(["remote: keep going", null])
      }),
    timeout,
  )

  it.live(
    "a session opened with no hooks gets a beforeTool from a client that attaches later",
    () =>
      Effect.gen(function* () {
        const hookLog = join(dir, "replayed-hooks-2.jsonl")
        const calls: Array<string> = []
        yield* Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const { sessionId } = yield* Effect.scoped(open(undefined))
          const session = yield* hosts.attach(sessionId, {
            hooks: { beforeTool: (call) => Effect.sync(() => (calls.push(call.name), Option.some("late: secret"))) },
          })
          yield* session.turn(prompt)
          yield* session.stop
        }).pipe(Effect.scoped, Effect.provide(replayLayer(hookLog)))
        expect(calls).toEqual(["Bash"])
        expect(answered(hookLog, "PreToolUse")).toEqual(["late: secret"])
        // Every kind is registered on the session; with no client for them, they answer nothing.
        expect(answered(hookLog, "PostToolUse")).toEqual([null])
        expect(answered(hookLog, "Stop")).toEqual([null, null])
      }),
    timeout,
  )
})

