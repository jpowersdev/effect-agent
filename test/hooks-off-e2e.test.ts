/**
 * What a session does where the user has turned hooks off, the same on both
 * providers: the real `claude` and `codex` against local stand-ins for the
 * model, free and offline, with throwaway config. The session's hooks and
 * `disable` still work, and the user's hooks stay off. Skipped where there is no
 * `codex`; Claude's CLI comes with the SDK.
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, type Scope } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type RunOptions } from "../src/Agent.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import { AgentHosts, DetachedAgent } from "../src/host/index.ts"
import { host } from "./support/hostCommand.ts"
import * as MockMessages from "./support/mockMessages.ts"
import * as MockResponses from "./support/mockResponses.ts"

const hasCodex = spawnSync("codex", ["--version"]).status === 0
const timeout = 60_000

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A session on one provider, in throwaway directories, with a hook of the user's that shows if it ran. */
interface World {
  readonly cwd: string
  readonly root: string
  readonly userFired: string
  readonly run: (options?: Partial<RunOptions>) => RunOptions
  readonly local: Layer.Layer<Agent>
  readonly detached: Layer.Layer<Agent | AgentHosts>
  /** The model's next reply runs this shell command. */
  readonly callShell: (command: string) => void
  /** The model's next reply writes `path` with a tool that `disable.tools` can name. */
  readonly callWrite: (path: string) => void
  /** The tool name `callWrite` uses. */
  readonly writeTool: string
  /** Everything sent to the model in its last request. */
  readonly lastRequest: () => string
}

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "ea-off-"))
  roots.push(root)
  const cwd = join(root, "work")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  return { root, cwd, home, userFired: join(root, "user-fired") }
}

const claude = (hooksOff: boolean): Effect.Effect<World, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mock = yield* MockMessages.make
    const { root, cwd, home, userFired } = dirs()
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        ...(hooksOff && { disableAllHooks: true }),
        hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `cat > /dev/null; touch ${userFired}` }] }] },
      }),
    )
    const env = {
      HOME: root,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: "sk-mock",
      ANTHROPIC_BASE_URL: mock.baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    }
    return {
      root,
      cwd,
      userFired,
      run: (options = {}) => ({ cwd, env, model: "claude-haiku-5-5", ...options }),
      local: ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer())),
      detached: DetachedAgent.layer({ host, provider: "claude", dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(Layer.provide(NodeServices.layer)),
      callShell: (command) => void mock.script.push({ name: "Bash", input: { command, description: "x" } }),
      callWrite: (path) => void mock.script.push({ name: "Write", input: { file_path: path, content: "x" } }),
      writeTool: "Write",
      lastRequest: () => JSON.stringify(mock.requests.at(-1)),
    }
  })

const codex = (hooksOff: boolean): Effect.Effect<World, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const mock = yield* MockResponses.make
    const { root, cwd, home, userFired } = dirs()
    const env = { HOME: root, CODEX_HOME: home }
    const toml = `${hooksOff ? "[features]\nhooks = false\n\n" : ""}[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(`cat > /dev/null; touch ${userFired}`)}\n`
    writeFileSync(join(home, "config.toml"), toml)
    // Trust it the way `/hooks` would, so that only `hooks = false` can stop it.
    const listed = yield* Effect.scoped(
      Effect.gen(function* () {
        const conn = yield* (yield* CodexAppServer.CodexAppServer).connect({ cwd, env, args: ["-c", "features.hooks=true"] })
        return yield* conn.request("hooks/list", { cwds: [cwd] })
      }),
    ).pipe(Effect.provide(CodexAppServer.layer({ args: mock.args })), Effect.provide(NodeServices.layer))
    const user = listed.data.flatMap((e) => e.hooks)[0]!
    writeFileSync(join(home, "config.toml"), `${toml}\n[hooks.state.${JSON.stringify(user.key)}]\ntrusted_hash = ${JSON.stringify(user.currentHash)}\n`)
    return {
      root,
      cwd,
      userFired,
      run: (options = {}) => ({ cwd, env, model: "gpt-5.5", ...options }),
      local: CodexAgent.layer().pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })), Layer.provide(NodeServices.layer)),
      detached: DetachedAgent.layer({ host, provider: "codex", codex: { args: mock.args }, dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(Layer.provide(NodeServices.layer)),
      callShell: (cmd) => void mock.script.push(MockResponses.functionCall("exec_command", { cmd })),
      callWrite: (path) => void mock.script.push(MockResponses.applyPatch(`*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n`)),
      writeTool: "apply_patch",
      lastRequest: () => JSON.stringify(mock.requests.at(-1)),
    }
  })

const providers = [
  { name: "claude", world: claude, skip: false },
  { name: "codex", world: codex, skip: !hasCodex },
] as const

const turn = (options: RunOptions) =>
  Effect.gen(function* () {
    const session = yield* (yield* Agent).open(options)
    yield* session.turn("go")
    yield* session.end
  })

for (const p of providers) {
  describe.skipIf(p.skip)(p.name, () => {
    it.live(
      "control: with hooks on, the user's hook runs beside the session's",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(false)
          const marker = join(w.cwd, "ran")
          let ours = 0
          w.callShell(`touch ${marker}`)
          yield* turn(w.run({ hooks: { beforeTool: () => Effect.sync(() => (ours++, Option.none())) } })).pipe(Effect.scoped, Effect.provide(w.local))
          expect(existsSync(marker)).toBe(true)
          expect(ours).toBe(1)
          expect(existsSync(w.userFired)).toBe(true)
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, the session's hooks run and add context, and the user's doesn't run",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          const marker = join(w.cwd, "ran")
          const before: Array<string> = []
          const after: Array<string> = []
          w.callShell(`touch ${marker}`)
          yield* turn(
            w.run({
              hooks: {
                beforeTool: (call) => Effect.sync(() => (before.push(call.name), Option.some("BEFORE_MARK"))),
                afterTool: (call) => Effect.sync(() => (after.push(call.name), Option.some("AFTER_MARK"))),
              },
            }),
          ).pipe(Effect.scoped, Effect.provide(w.local))
          expect(existsSync(marker)).toBe(true)
          expect(before).toEqual(["Bash"])
          expect(after).toEqual(["Bash"])
          expect(w.lastRequest()).toContain("BEFORE_MARK")
          expect(w.lastRequest()).toContain("AFTER_MARK")
          expect(existsSync(w.userFired)).toBe(false)
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, beforeStop keeps the turn going",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          let stops = 0
          yield* turn(w.run({ hooks: { beforeStop: () => Effect.sync(() => (++stops === 1 ? Option.some("STOP_MARK") : Option.none())) } })).pipe(
            Effect.scoped,
            Effect.provide(w.local),
          )
          expect(stops).toBe(2)
          expect(w.lastRequest()).toContain("STOP_MARK")
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, disable.tools still stops the tool, and others run",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          const blocked = join(w.cwd, "blocked")
          const other = join(w.cwd, "other")
          w.callWrite(blocked)
          w.callShell(`touch ${other}`)
          yield* turn(w.run({ disable: { tools: [w.writeTool] } })).pipe(Effect.scoped, Effect.provide(w.local))
          expect(existsSync(blocked)).toBe(false)
          expect(existsSync(other)).toBe(true)
          expect(existsSync(w.userFired)).toBe(false)
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, a session with no hooks of its own runs, and the user's doesn't",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          const marker = join(w.cwd, "ran")
          w.callShell(`touch ${marker}`)
          yield* turn(w.run()).pipe(Effect.scoped, Effect.provide(w.local))
          expect(existsSync(marker)).toBe(true)
          expect(existsSync(w.userFired)).toBe(false)
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, a detached session answers hooks from open and from attach, and the user's doesn't run",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          const first = join(w.cwd, "first")
          const second = join(w.cwd, "second")
          const fromOpen: Array<string> = []
          const fromAttach: Array<string> = []
          yield* Effect.gen(function* () {
            const hosts = yield* AgentHosts
            w.callShell(`touch ${first}`)
            const session = yield* hosts.open(w.run({ hooks: { beforeTool: (call) => Effect.sync(() => (fromOpen.push(call.name), Option.none())) } }))
            expect((yield* session.info).capabilities.hooks).toBe(true)
            yield* session.turn("go")
            const attached = yield* hosts.attach(session.sessionId, { hooks: { beforeTool: (call) => Effect.sync(() => (fromAttach.push(call.name), Option.none())) } })
            w.callShell(`touch ${second}`)
            yield* attached.turn("again")
            yield* attached.end
          }).pipe(Effect.scoped, Effect.provide(w.detached))
          expect(existsSync(first) && existsSync(second)).toBe(true)
          expect(fromOpen).toEqual(["Bash"])
          expect(fromAttach).toEqual(["Bash"])
          expect(existsSync(w.userFired)).toBe(false)
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with hooks off, a detached session with no hooks of its own opens, and a client can answer them later",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world(true)
          const marker = join(w.cwd, "ran")
          const seen: Array<string> = []
          yield* Effect.gen(function* () {
            const hosts = yield* AgentHosts
            const session = yield* hosts.open(w.run())
            const attached = yield* hosts.attach(session.sessionId, { hooks: { beforeTool: (call) => Effect.sync(() => (seen.push(call.name), Option.none())) } })
            w.callShell(`touch ${marker}`)
            yield* attached.turn("go")
            yield* attached.end
          }).pipe(Effect.scoped, Effect.provide(w.detached))
          expect(existsSync(marker)).toBe(true)
          expect(seen).toEqual(["Bash"])
          expect(existsSync(w.userFired)).toBe(false)
        }).pipe(Effect.scoped),
      timeout,
    )
  })
}

describe("claude", () => {
  it.live(
    "with hooks off, disable.subagents still takes the tools away",
    () =>
      Effect.gen(function* () {
        const w = yield* claude(true)
        const marker = join(w.cwd, "ran")
        w.callShell(`touch ${marker}`)
        yield* turn(w.run({ disable: { subagents: true } })).pipe(Effect.scoped, Effect.provide(w.local))
        expect(existsSync(marker)).toBe(true)
        const tools = (JSON.parse(w.lastRequest()) as { readonly tools: ReadonlyArray<string> }).tools
        expect(tools).toContain("Bash")
        expect(tools).not.toContain("Agent")
        expect(tools).not.toContain("Task")
      }).pipe(Effect.scoped),
    timeout,
  )
})
