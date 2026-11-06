/**
 * `RunOptions.mcp` on the real `claude` and `codex`, with permissions bypassed
 * as in every session, against local stand-ins for the model: free and
 * offline. The machine's MCP setup is a throwaway config dir whose only server
 * is `support/mcpServer.ts`, which logs every call that reaches it, so no test
 * can reach a real server or connector. Codex tests are skipped where there is
 * no `codex`; Claude's CLI comes with the SDK.
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, type Scope } from "effect"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const fixture = join(import.meta.dirname, "support", "mcpServer.ts")

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A session on one provider whose machine has one MCP server, `fixture`. */
interface World {
  readonly root: string
  readonly run: (options?: Partial<RunOptions>) => RunOptions
  readonly local: Layer.Layer<Agent>
  readonly detached: Layer.Layer<Agent | AgentHosts>
  /** The model's next reply calls the fixture's `tool`. */
  readonly callMcp: (tool: string, input?: unknown) => void
  /** The model's next reply reads one of the fixture's resources. */
  readonly readResource: () => void
  /** The calls that reached the fixture. */
  readonly reached: () => ReadonlyArray<string>
  /** Everything the model was sent. */
  readonly sent: () => string
}

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), "ea-mcp-"))
  roots.push(root)
  const cwd = join(root, "work")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  const log = join(root, "mcp.log")
  return { root, cwd, home, log, reached: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : []) }
}

const claude: Effect.Effect<
  World & { readonly callTool: (name: string, input: unknown) => void; readonly requests: ReadonlyArray<MockMessages.MessagesRequest> },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const mock = yield* MockMessages.make
  const { root, cwd, home, log, reached } = dirs()
  // The user's MCP servers, as `claude mcp add --scope user` keeps them.
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [fixture], env: { MCP_FIXTURE_LOG: log } } } }))
  const env = {
    HOME: root,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "sk-mock",
    ANTHROPIC_BASE_URL: mock.baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // No account, so no claude.ai connectors either way.
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
  return {
    root,
    run: (options = {}) => ({ cwd, env, model: "claude-haiku-5-5", ...options }),
    local: ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer())),
    detached: DetachedAgent.layer({ host, provider: "claude", dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(Layer.provide(NodeServices.layer)),
    callMcp: (tool, input = {}) => void mock.script.push({ name: `mcp__fixture__${tool}`, input }),
    callTool: (name, input) => void mock.script.push({ name, input }),
    requests: mock.requests,
    readResource: () => void mock.script.push({ name: "ReadMcpResourceTool", input: { server: "fixture", uri: "note://inbox" } }),
    reached,
    sent: () => JSON.stringify(mock.requests),
  }
})

const codexConfig = (log: string) =>
  `[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(fixture)}]\nenv = { MCP_FIXTURE_LOG = ${JSON.stringify(log)} }\n`

const codex = (layerOptions: { readonly codexPath?: string; readonly config?: Record<string, boolean> } = {}): Effect.Effect<World, never, Scope.Scope> =>
  Effect.gen(function* () {
    const mock = yield* MockResponses.make
    const { root, cwd, home, log, reached } = dirs()
    writeFileSync(join(home, "config.toml"), codexConfig(log))
    const env = { HOME: root, CODEX_HOME: home }
    const { codexPath, config } = layerOptions
    return {
      root,
      run: (options = {}) => ({ cwd, env, model: "gpt-5.5", ...options }),
      local: CodexAgent.layer(config !== undefined ? { config } : {}).pipe(
        Layer.provide(CodexAppServer.layer({ args: mock.args, ...(codexPath !== undefined && { codexPath }) })),
        Layer.provide(NodeServices.layer),
      ),
      detached: DetachedAgent.layer({
        host,
        provider: "codex",
        codex: { args: mock.args, ...(codexPath !== undefined && { codexPath }), ...(config !== undefined && { config }) },
        dir: join(root, "hosts"),
        onScopeClose: "detach",
      }).pipe(Layer.provide(NodeServices.layer)),
      // Codex puts a server's tools in a namespace; the hook sees `mcp__fixture__<tool>`.
      callMcp: (tool, input = {}) => void mock.script.push(MockResponses.functionCall(tool, input, { namespace: "mcp__fixture" })),
      readResource: () => void mock.script.push(MockResponses.functionCall("read_mcp_resource", { server: "fixture", uri: "note://inbox" })),
      reached,
      sent: () => JSON.stringify(mock.requests),
    }
  })

const providers = [
  { name: "claude", world: () => claude, skip: false },
  { name: "codex", world: () => codex(), skip: !hasCodex },
] as const

const turn = (options: RunOptions) =>
  Effect.gen(function* () {
    const session = yield* (yield* Agent).open(options)
    yield* session.turn("go")
    yield* session.end
  })

const clerk = { allow: ["fixture/read_*"], deny: ["*/*send*"] }

for (const p of providers) {
  describe.skipIf(p.skip)(p.name, () => {
    it.live(
      "with mcp, an allowed call runs, and a denied one is refused before it reaches the server",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world()
          w.callMcp("read_note")
          w.callMcp("send_note", { text: "hi" })
          yield* turn(w.run({ mcp: clerk })).pipe(Effect.scoped, Effect.provide(w.local))
          expect(w.reached()).toEqual(["read_note"])
          expect(w.sent()).toContain("read_note ran")
          expect(w.sent()).toContain("This MCP tool call was refused: fixture/send_note matches mcp.deny pattern */*send*")
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with allow: [], the servers load but nothing can be called",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world()
          w.callMcp("read_note")
          yield* turn(w.run({ mcp: { allow: [] } })).pipe(Effect.scoped, Effect.provide(w.local))
          expect(w.reached()).toEqual([])
          expect(w.sent()).toContain("This MCP tool call was refused: fixture/read_note is not in mcp.allow")
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with mcp, MCP resources can't be read, whatever allow says",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world()
          w.readResource()
          yield* turn(w.run({ mcp: { allow: ["**"] } })).pipe(Effect.scoped, Effect.provide(w.local))
          expect(w.reached()).toEqual([])
          expect(w.sent()).not.toContain("the inbox")
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "with mcp, the session's own beforeTool still sees MCP calls, and can't let a refused one through",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world()
          const seen: Array<string> = []
          w.callMcp("send_note", { text: "hi" })
          yield* turn(w.run({ mcp: clerk, hooks: { beforeTool: (call) => Effect.sync(() => (seen.push(call.name), Option.some("BEFORE_MARK"))) } })).pipe(
            Effect.scoped,
            Effect.provide(w.local),
          )
          expect(w.reached()).toEqual([])
          expect(seen).toEqual(["mcp__fixture__send_note"])
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      "on a detached session, the host checks the calls, with no client hook",
      () =>
        Effect.gen(function* () {
          const w = yield* p.world()
          yield* Effect.gen(function* () {
            const hosts = yield* AgentHosts
            w.callMcp("read_note")
            w.callMcp("send_note", { text: "hi" })
            const session = yield* hosts.open(w.run({ mcp: clerk }))
            yield* session.turn("go")
            // A client that attaches later doesn't change what the host allows.
            const attached = yield* hosts.attach(session.sessionId)
            w.callMcp("send_note", { text: "again" })
            yield* attached.turn("again")
            yield* attached.end
          }).pipe(Effect.scoped, Effect.provide(w.detached))
          expect(w.reached()).toEqual(["read_note"])
          expect(w.sent()).toContain("This MCP tool call was refused: fixture/send_note matches mcp.deny pattern */*send*")
        }).pipe(Effect.scoped),
      timeout,
    )
  })
}

describe("claude", () => {
  it.live(
    "without mcp, the machine's MCP servers don't load",
    () =>
      Effect.gen(function* () {
        const w = yield* claude
        w.callMcp("read_note")
        yield* turn(w.run()).pipe(Effect.scoped, Effect.provide(w.local))
        expect(w.reached()).toEqual([])
        expect(w.sent()).toContain("No such tool available: mcp__fixture__read_note")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a subagent's MCP calls are checked too",
    () =>
      Effect.gen(function* () {
        const w = yield* claude
        // The main loop starts a subagent and waits for it; the next requests are the subagent's, and it calls the tools.
        const prompt = "SUBAGENT_PROMPT: read and send the note."
        w.callTool("Agent", { description: "notes", prompt, subagent_type: "general-purpose", run_in_background: false })
        w.callMcp("read_note")
        w.callMcp("send_note", { text: "hi" })
        yield* turn(w.run({ mcp: clerk })).pipe(Effect.scoped, Effect.provide(w.local))
        expect(w.reached()).toEqual(["read_note"])
        const subagent = w.requests.filter((r) => JSON.stringify(r.messages[0]).includes("SUBAGENT_PROMPT"))
        expect(subagent.length).toBeGreaterThan(0)
        expect(JSON.stringify(subagent.at(-1))).toContain("This MCP tool call was refused: fixture/send_note matches mcp.deny pattern */*send*")
      }).pipe(Effect.scoped),
    timeout,
  )
})

describe.skipIf(!hasCodex)("codex", () => {
  // A known gap, not a promise: when a Codex release makes `mcp_servers: {}` hold, this fails, and
  // the README's "Where Codex differs" and this test should change with it (see UPGRADING.md).
  it.live(
    "without mcp, the servers in Codex's config.toml still load: no per-session override turns them off",
    () =>
      Effect.gen(function* () {
        const w = yield* codex()
        w.callMcp("read_note")
        yield* turn(w.run()).pipe(Effect.scoped, Effect.provide(w.local))
        expect(w.reached()).toEqual(["read_note"])
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a call from code mode's exec is checked too",
    () =>
      Effect.gen(function* () {
        const mock = yield* MockResponses.make
        const { cwd, home, log, reached } = dirs()
        writeFileSync(join(home, "config.toml"), codexConfig(log))
        mock.script.push({
          type: "custom_tool_call",
          id: "ct1",
          call_id: "call_1",
          name: "exec",
          input: `text(JSON.stringify(await tools.mcp__fixture__read_note({})));\nawait tools.mcp__fixture__send_note({ text: "hi" });`,
        })
        yield* turn({ cwd, env: { HOME: cwd, CODEX_HOME: home }, model: "gpt-5.5", mcp: clerk }).pipe(
          Effect.scoped,
          Effect.provide(
            CodexAgent.layer({ config: { "features.code_mode": true } }).pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })), Layer.provide(NodeServices.layer)),
          ),
        )
        expect(reached()).toEqual(["read_note"])
        expect(JSON.stringify(mock.requests)).toContain("This MCP tool call was refused: fixture/send_note matches mcp.deny pattern */*send*")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "where a policy stops hooks, open fails rather than run MCP calls unchecked, locally and detached",
    () =>
      Effect.gen(function* () {
        const { root } = dirs()
        // Stands in for a managed policy, which needs a system path: Codex never sees our hooks.
        const codexPath = join(root, "codex-with-policy")
        writeFileSync(
          codexPath,
          `#!/bin/sh\nn=$#\nwhile [ "$n" -gt 0 ]; do\n  a=$1; shift; n=$((n-1))\n  if [ "$a" = "-c" ]; then\n    case "$1" in hooks.*|features.hooks=*) shift; n=$((n-1)); continue ;; esac\n  fi\n  set -- "$@" "$a"\ndone\nexec codex "$@"\n`,
        )
        chmodSync(codexPath, 0o755)
        const w = yield* codex({ codexPath })
        w.callMcp("read_note")
        const local = yield* Effect.flip(turn(w.run({ mcp: { allow: ["**"] } })).pipe(Effect.scoped, Effect.provide(w.local)))
        expect(local.message).toContain("cannot install hooks")
        // The host's retry without a client's hooks keeps `mcp`, so it fails too.
        const detached = yield* Effect.flip(turn(w.run({ mcp: { allow: ["**"] } })).pipe(Effect.scoped, Effect.provide(w.detached)))
        expect(detached.message).toContain("cannot install hooks")
        expect(w.reached()).toEqual([])
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "where the layer's config would stop hooks, open fails",
    () =>
      Effect.gen(function* () {
        const w = yield* codex({ config: { "features.hooks": false } })
        const failed = yield* Effect.flip(turn(w.run({ mcp: { allow: ["**"] } })).pipe(Effect.scoped, Effect.provide(w.local)))
        expect(failed.message).toContain("cannot install hooks")
      }).pipe(Effect.scoped),
    timeout,
  )
})
