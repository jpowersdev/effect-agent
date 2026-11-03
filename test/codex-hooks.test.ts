/**
 * The relay between Codex's command hooks and `RunOptions.hooks`: the plan,
 * the answers, and a real relay process talking to a real socket.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option } from "effect"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { Agent, type Hooks } from "../src/Agent.ts"
import { AgentError } from "../src/AgentError.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import * as CodexHooks from "../src/codex/CodexHooks.ts"
import type * as P from "../src/codex/protocol.ts"

const beforeTool: NonNullable<Hooks["beforeTool"]> = () => Effect.succeedNone
const flagsOf = (plan: CodexHooks.Plan | null) => plan!.flags.filter((f) => f !== "-c")
const nodePath = process.execPath

describe("plan", () => {
  it("is null when there's nothing to install", () => {
    expect(CodexHooks.plan(undefined, [])).toBeNull()
    expect(CodexHooks.plan({}, [])).toBeNull()
  })

  it("refused tools need no relay", () => {
    const plan = CodexHooks.plan(undefined, ["apply_patch"], "/bin/node")!
    expect(plan).toMatchObject({ relay: false, hookCount: 1 })
    expect([...plan.commands]).toEqual([CodexHooks.refuseCommand])
    expect(flagsOf(plan)).toEqual([
      `hooks.PreToolUse=[{matcher="^(collaboration)?(apply_patch)$",hooks=[{type="command",command=${JSON.stringify(CodexHooks.refuseCommand)}}]}]`,
    ])
  })

  it("installs one hook per event, on the relay", () => {
    const hooks: Hooks = { beforeTool, afterTool: () => Effect.succeedNone, beforeStop: () => Effect.succeedNone }
    const plan = CodexHooks.plan(hooks, ["x"], "/bin/node")!
    const relay = JSON.stringify(CodexHooks.relayCommand("/bin/node"))
    expect(plan).toMatchObject({ relay: true, hookCount: 4 })
    expect(plan.commands.size).toBe(2)
    const flags = flagsOf(plan)
    expect(flags[0]).toContain(`{matcher="*",hooks=[{type="command",command=${relay}}]}`)
    expect(flags[1]).toBe(`hooks.PostToolUse=[{matcher="*",hooks=[{type="command",command=${relay}}]}]`)
    // Stop has no tool to match.
    expect(flags[2]).toBe(`hooks.Stop=[{hooks=[{type="command",command=${relay}}]}]`)
  })

  it("escapes tool names in the matcher, and allows the namespace", () => {
    const matcher = new RegExp(CodexHooks.refuseMatcher(["spawn_agent", "a.b"]))
    expect(matcher.test("spawn_agent")).toBe(true)
    expect(matcher.test("collaborationspawn_agent")).toBe(true)
    expect(matcher.test("a.b")).toBe(true)
    expect(matcher.test("axb")).toBe(false)
    expect(matcher.test("exec_command")).toBe(false)
  })

  it("quotes the runtime's path for the shell", () => {
    expect(CodexHooks.relayCommand("/o'dd path/node")).toContain(` '/o'\\''dd path/node' -e '`)
  })
})

describe("trust", () => {
  const plan = CodexHooks.plan({ beforeTool }, [], "/bin/node")!
  const command = [...plan.commands][0]!
  const hook = (over: Partial<P.HookMetadata> = {}): P.HookMetadata => ({
    key: "/<session-flags>/config.toml:pre_tool_use:0:0",
    eventName: "preToolUse",
    source: "sessionFlags",
    enabled: true,
    isManaged: false,
    currentHash: "sha256:abc",
    trustStatus: "untrusted",
    command,
    ...over,
  })
  const listed = (...hooks: ReadonlyArray<P.HookMetadata>): P.HooksListResponse => ({ data: [{ hooks }] })

  it("names only its own hooks", () => {
    const own = CodexHooks.ownHooks(plan, listed(hook(), hook({ source: "user", key: "theirs" }), hook({ command: "other", key: "other" })))
    expect(own.map((h) => h.key)).toEqual([hook().key])
    expect(CodexHooks.stateFlags(own)).toEqual(["-c", `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:abc"}}`])
    expect(CodexHooks.stateFlags([])).toEqual([])
    expect(CodexHooks.stateFlags(own, [hook({ key: "user", source: "user" })])).toEqual([
      "-c",
      `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:abc"},"user"={enabled=false}}`,
    ])
  })

  it("won't run when a hook is missing, untrusted or disabled", () => {
    expect(CodexHooks.notRunnable(plan, listed(hook({ trustStatus: "trusted" })))).toBeNull()
    expect(CodexHooks.notRunnable(plan, listed(hook({ trustStatus: "managed" })))).toBeNull()
    expect(CodexHooks.notRunnable(plan, listed())).toMatch(/found 0 of effect-agent's 1 hooks/)
    expect(CodexHooks.notRunnable(plan, listed(hook()))).toMatch(/preToolUse \(untrusted\)/)
    expect(CodexHooks.notRunnable(plan, listed(hook({ trustStatus: "trusted", enabled: false })))).toMatch(/disabled/)
  })
})

describe("failedCallId", () => {
  const item = (fields: object): P.Incoming => ({ method: "item/completed", params: { threadId: "t", turnId: "u", item: { type: "commandExecution", id: "call_1", ...fields } } }) as P.Incoming

  it("finds commands that failed", () => {
    expect(CodexHooks.failedCallId(item({ status: "failed", exitCode: 3 }))).toBe("call_1")
    expect(CodexHooks.failedCallId(item({ status: "failed", exitCode: null }))).toBe("call_1")
    expect(CodexHooks.failedCallId(item({ status: "completed", exitCode: 0 }))).toBeNull()
    expect(CodexHooks.failedCallId({ method: "turn/started", params: {} } as P.Incoming)).toBeNull()
  })
})

describe("answer", () => {
  const line = (call: object) => JSON.stringify(call)
  const pre = line({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "ls" } })
  const never = () => false

  it.effect("beforeTool gets the call, and its text goes back as context", () =>
    Effect.gen(function* () {
      let seen: unknown
      const out = yield* CodexHooks.answer(
        {
          beforeTool: (call) => {
            seen = call
            return Effect.succeed(Option.some("note"))
          },
        },
        pre,
        never,
      )
      expect(seen).toEqual({ callId: "c1", name: "Bash", input: { command: "ls" } })
      expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "note" } })
    }),
  )

  it.effect("afterTool gets the output and whether the command failed", () =>
    Effect.gen(function* () {
      const seen: Array<unknown> = []
      const hooks: Hooks = {
        afterTool: (call) => {
          seen.push(call)
          return Effect.succeedNone
        },
      }
      const post = (id: string, tool_response: unknown) => line({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: id, tool_input: {}, tool_response })
      const failed = new Set(["bad"])
      expect(yield* CodexHooks.answer(hooks, post("bad", "out\n"), (id) => failed.delete(id))).toBe("")
      yield* CodexHooks.answer(hooks, post("good", { json: true }), (id) => failed.delete(id))
      expect(seen).toEqual([
        { callId: "bad", name: "Bash", input: {}, output: "out\n", isError: true },
        { callId: "good", name: "Bash", input: {}, output: `{"json":true}`, isError: false },
      ])
    }),
  )

  it.effect("beforeStop's text continues the turn", () =>
    Effect.gen(function* () {
      const out = yield* CodexHooks.answer({ beforeStop: () => Effect.succeed(Option.some("one more")) }, line({ hook_event_name: "Stop" }), never)
      expect(JSON.parse(out)).toEqual({ decision: "block", reason: "one more" })
    }),
  )

  it.effect("adds nothing when there's no hook, no text, a failure or a defect", () =>
    Effect.gen(function* () {
      const answers = (hooks: Hooks, input = pre) => CodexHooks.answer(hooks, input, never)
      expect(yield* answers({})).toBe("")
      expect(yield* answers({ beforeTool: () => Effect.succeed(Option.some("")) })).toBe("")
      expect(yield* answers({ beforeTool: () => Effect.die("boom") })).toBe("")
      expect(
        yield* answers({
          beforeTool: () => {
            throw new Error("boom")
          },
        }),
      ).toBe("")
      expect(yield* answers({ beforeTool: () => Effect.succeed(Option.some("x")) }, "not json")).toBe("")
      expect(yield* answers({ beforeTool: () => Effect.succeed(Option.some("x")) }, line({ hook_event_name: "SessionStart" }))).toBe("")
    }),
  )
})

const runtimes: ReadonlyArray<readonly [string, string]> = [
  ["node", nodePath],
  ...(spawnSync("bun", ["--version"]).status === 0 ? ([["bun", execFileSync("which", ["bun"]).toString().trim()]] as const) : []),
]

/** Runs the real hook command the way Codex does. */
const relay = (execPath: string, socket: string | undefined, input: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve) => {
        const child = spawn("sh", ["-c", CodexHooks.relayCommand(execPath)], {
          env: { ...process.env, [CodexHooks.socketVariable]: socket },
          stdio: ["pipe", "pipe", "ignore"],
        })
        let stdout = ""
        child.stdout.on("data", (d) => (stdout += d))
        child.on("close", (code) => resolve({ code, stdout }))
        child.stdin.end(input)
      }),
  )

describe("the relay process", () => {
  for (const [name, execPath] of runtimes) {
    it.live(`${name}: carries a call and its answer, multi-line JSON included`, () =>
      Effect.gen(function* () {
        const socket = yield* CodexHooks.serve(
          { beforeTool: (call) => Effect.succeed(Option.some(`saw ${(call.input as { text: string }).text}`)) },
          () => false,
        )
        const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "c1", tool_input: { text: "a\nb's" } }, null, 2)
        const { code, stdout } = yield* relay(execPath, socket, input)
        expect(code).toBe(0)
        expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe("saw a\nb's")
      }).pipe(Effect.scoped),
    )

    it.live(`${name}: prints nothing when the hook adds nothing`, () =>
      Effect.gen(function* () {
        const socket = yield* CodexHooks.serve({ beforeTool }, () => false)
        expect(yield* relay(execPath, socket, `{"hook_event_name":"PreToolUse"}`)).toEqual({ code: 0, stdout: "" })
      }).pipe(Effect.scoped),
    )

    it.live(`${name}: exits 0 with nothing to say when it can't reach the session`, () =>
      Effect.gen(function* () {
        expect(yield* relay(execPath, "/nonexistent/socket", `{"hook_event_name":"Stop"}`)).toEqual({ code: 0, stdout: "" })
        expect(yield* relay(execPath, undefined, `{"hook_event_name":"Stop"}`)).toEqual({ code: 0, stdout: "" })
      }),
    )
  }

  it.live("a relay that goes away interrupts its call", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const socket = yield* CodexHooks.serve(
        {
          beforeTool: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        },
        () => false,
      )
      const child = spawn("sh", ["-c", CodexHooks.relayCommand(nodePath)], {
        env: { ...process.env, [CodexHooks.socketVariable]: socket },
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      })
      child.stdin.end(`{"hook_event_name":"PreToolUse"}`)
      yield* Deferred.await(started)
      process.kill(-child.pid!, "SIGKILL")
      yield* Deferred.await(interrupted)
    }).pipe(Effect.scoped),
  )

  it.live("a socket it can't listen on fails, rather than hanging", () =>
    Effect.gen(function* () {
      const previous = process.env.TMPDIR
      process.env.TMPDIR = `/tmp/${"x".repeat(200)}`
      mkdirSync(process.env.TMPDIR, { recursive: true })
      const error = yield* CodexHooks.serve({ beforeTool }, () => false).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(process.env.TMPDIR!, { recursive: true, force: true })
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
          }),
        ),
        Effect.scoped,
        Effect.flip,
      )
      expect(error).toMatchObject({ _tag: "AgentError", message: expect.stringMatching(/cannot serve hooks/) })
    }),
  )

  it.live("its socket goes away with the scope", () =>
    Effect.gen(function* () {
      const socket = yield* CodexHooks.serve({ beforeTool }, () => false).pipe(Effect.scoped)
      expect(existsSync(socket)).toBe(false)
      expect(yield* relay(nodePath, socket, `{"hook_event_name":"Stop"}`)).toEqual({ code: 0, stdout: "" })
    }),
  )
})

describe("a failed open", () => {
  it.live("stops serving the relay, without waiting for the caller's scope", () =>
    Effect.gen(function* () {
      let socket: string | undefined
      const server = Layer.succeed(
        CodexAppServer.CodexAppServer,
        CodexAppServer.CodexAppServer.of({
          connect: (options) => {
            socket = options.env?.[CodexHooks.socketVariable]
            return Effect.fail(new AgentError({ message: "no app-server", provider: "codex" }))
          },
          version: Effect.succeed(null),
        }),
      )
      const agent = yield* Agent.pipe(Effect.provide(CodexAgent.layer().pipe(Layer.provide(server))))
      const failed = yield* Effect.flip(agent.open({ cwd: "/tmp", hooks: { beforeTool } }))
      expect(failed.message).toBe("no app-server")
      expect(socket).toBeDefined()
      expect(existsSync(socket!)).toBe(false)
    }).pipe(Effect.scoped),
  )
})

describe("stoppedByConfig", () => {
  it("finds what would stop hooks once thread settings apply", () => {
    expect(CodexHooks.stoppedByConfig({ "features.hooks": false })).toBe("features.hooks")
    expect(CodexHooks.stoppedByConfig({ features: { hooks: false } })).toBe("features.hooks")
    expect(CodexHooks.stoppedByConfig({ hooks: {} })).toBe("hooks")
    expect(CodexHooks.stoppedByConfig({ "hooks.PreToolUse": [] })).toBe("hooks.PreToolUse")
  })

  it("leaves everything else alone", () => {
    expect(CodexHooks.stoppedByConfig(undefined)).toBeNull()
    expect(CodexHooks.stoppedByConfig({})).toBeNull()
    expect(CodexHooks.stoppedByConfig({ "features.hooks": true })).toBeNull()
    expect(CodexHooks.stoppedByConfig({ features: { hooks: true, apps: false } })).toBeNull()
    expect(CodexHooks.stoppedByConfig({ hooks_extra: 1, "features.apps": false })).toBeNull()
  })
})
