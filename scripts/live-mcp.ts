/**
 * `RunOptions.mcp` on Claude Code with the real model, in process and
 * detached, with permissions bypassed as in every session:
 *
 *   node scripts/live-mcp.ts
 *
 * Safe against your own setup: the config dir is a throwaway one whose only MCP
 * server is `test/support/mcpServer.ts` (no `.claude.json`, plugins or
 * settings of yours), claude.ai connectors are off (`ENABLE_CLAUDEAI_MCP_SERVERS`),
 * and before any prompt is sent a preflight asks the CLI which MCP servers it
 * loaded and stops unless that is exactly `fixture`. It signs in with
 * `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` if set, else with the access
 * token in `$CLAUDE_CONFIG_DIR/.credentials.json` (Linux), passed as
 * `CLAUDE_CODE_OAUTH_TOKEN`: the CLI doesn't refresh a token from the
 * environment, so your stored login is never touched. Uses claude-haiku-5-5;
 * a fraction of a cent.
 */
import { query } from "@anthropic-ai/claude-agent-sdk"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type AgentEvent, type RunOptions, SessionId } from "../src/index.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { AgentHosts, DetachedAgent } from "../src/host/index.ts"
import { host } from "../test/support/hostCommand.ts"

const fixture = join(import.meta.dirname, "..", "test", "support", "mcpServer.ts")

class Check extends Error {}
const check = (ok: unknown, message: string) => {
  if (!ok) throw new Check(message)
}

const auth = (): Record<string, string> => {
  if (process.env["ANTHROPIC_API_KEY"]) return { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }
  if (process.env["CLAUDE_CODE_OAUTH_TOKEN"]) return { CLAUDE_CODE_OAUTH_TOKEN: process.env["CLAUDE_CODE_OAUTH_TOKEN"] }
  const file = join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), ".credentials.json")
  const oauth = (JSON.parse(readFileSync(file, "utf8")) as { claudeAiOauth?: { accessToken: string; expiresAt: number } }).claudeAiOauth
  check(oauth !== undefined, `no claudeAiOauth in ${file}; set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN`)
  check(oauth!.expiresAt > Date.now() + 10 * 60_000, "the stored access token expires within 10 minutes; run claude once to refresh it")
  return { CLAUDE_CODE_OAUTH_TOKEN: oauth!.accessToken }
}

const root = mkdtempSync(join(tmpdir(), "ea-live-mcp-"))
const home = join(root, "config")
const cwd = join(root, "work")
const log = join(root, "mcp.log")
mkdirSync(home, { mode: 0o700 })
mkdirSync(cwd)
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { type: "stdio", command: process.execPath, args: [fixture], env: { MCP_FIXTURE_LOG: log } } } }))

const reached = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l !== "") : [])
const reset = () => rmSync(log, { force: true })

const run: RunOptions = {
  cwd,
  model: "claude-haiku-5-5",
  env: {
    HOME: root,
    CLAUDE_CONFIG_DIR: home,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ...auth(),
  },
  disable: { askUser: true },
  // Connectors are off and the preflight checks it; denying them too costs nothing.
  mcp: { allow: ["fixture/read_*"], deny: ["*/*send*", "claude_ai_*/*"] },
  spendCapUsd: 0.25,
}

const prompt = [
  "This is a test of tool permissions. Use only the tools named here.",
  'First call mcp__fixture__read_note. Then call mcp__fixture__send_note with text "hi".',
  "Call each exactly once, even if one fails. Then reply with what each returned, verbatim.",
].join(" ")

/** The MCP servers the CLI loads with `run`'s options, before any prompt; stops unless it's just the fixture. */
const preflight = Effect.promise(async () => {
  const abort = new AbortController()
  const options = ClaudeAgent.buildOptions(run, {}, SessionId.make(randomUUID()))
  const q = query({ prompt: (async function* () { await new Promise(() => {}) })(), options: { ...options, abortController: abort, persistSession: false } })
  try {
    // claude.ai connectors arrive after startup, if at all: give them time to show up.
    await new Promise((r) => setTimeout(r, 5000))
    return (await q.mcpServerStatus()).map((s) => `${s.name} (${s.status})`)
  } finally {
    abort.abort()
  }
}).pipe(
  Effect.tap((servers) => Effect.sync(() => console.log(`preflight: MCP servers loaded: ${servers.join(", ")}`))),
  Effect.flatMap((servers) =>
    servers.length === 1 && servers[0]!.startsWith("fixture ") ? Effect.void : Effect.die(new Check(`expected only the fixture server, got: ${servers.join(", ")}; stopping before any prompt`)),
  ),
)

/** One turn of `prompt`; checks that read_note ran, send_note never reached the server, and the model got the reason. */
const scenario = (name: string, layer: Layer.Layer<Agent | AgentHosts> | Layer.Layer<Agent>) =>
  Effect.gen(function* () {
    reset()
    const events: Array<AgentEvent> = []
    yield* Effect.gen(function* () {
      const session = yield* (yield* Agent).open(run)
      const stream = yield* session.subscribe
      yield* stream.pipe(Stream.runForEach((e) => Effect.sync(() => events.push(e))), Effect.forkScoped)
      yield* session.turn(prompt)
      yield* session.end
    }).pipe(Effect.scoped, Effect.provide(layer))
    const calls = events.flatMap((e) => (e._tag === "ToolCall" ? [e.name] : []))
    const results = events.flatMap((e) => (e._tag === "ToolResult" ? [e.output] : []))
    const text = events.flatMap((e) => (e._tag === "Text" ? [e.text] : [])).join("")
    console.log(`${name}: tool calls ${JSON.stringify(calls)}; reached the server: ${JSON.stringify(reached())}`)
    console.log(`${name}: results ${JSON.stringify(results)}`)
    console.log(`${name}: model said ${JSON.stringify(text.slice(0, 400))}`)
    check(calls.includes("mcp__fixture__send_note"), `${name}: the model never tried send_note, so nothing was tested`)
    check(JSON.stringify(reached()) === JSON.stringify(["read_note"]), `${name}: expected only read_note to reach the server`)
    check(results.some((r) => r.includes("fixture/send_note matches mcp.deny pattern */*send*")), `${name}: the refusal didn't reach the model`)
    console.log(`${name}: ok`)
  })

const program = Effect.gen(function* () {
  yield* preflight
  yield* scenario("local", ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer())))
  yield* scenario("detached", DetachedAgent.layer({ host, provider: "claude", dir: join(root, "hosts") }).pipe(Layer.provide(NodeServices.layer)))
})

Effect.runPromise(program)
  .then(
    () => console.log("all ok"),
    (e) => {
      console.error(e instanceof Check ? `FAILED: ${e.message}` : e)
      process.exitCode = 1
    },
  )
  .finally(() => {
    const leftovers = readdirSync(root)
    rmSync(root, { recursive: true, force: true })
    console.log(`removed ${root} (${leftovers.join(", ")})`)
  })
