/**
 * `ClaudeAgentOptions.backgroundTasks` on the real `claude`, against a local
 * stand-in for the model: free and offline. The model asks for a command in
 * the background: by default it goes there, and with `backgroundTasks: false`
 * Bash has no `run_in_background`, so the call is refused.
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "../src/Agent.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { DetachedAgent } from "../src/host/index.ts"
import { host } from "./support/hostCommand.ts"
import * as MockMessages from "./support/mockMessages.ts"

const timeout = 60_000

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** What the CLI answered the model's background `sleep 1` with. */
const answer = (options: ClaudeAgent.ClaudeAgentOptions, where: "local" | "detached") =>
  Effect.gen(function* () {
    const mock = yield* MockMessages.make
    const root = mkdtempSync(join(tmpdir(), "ea-bg-claude-"))
    roots.push(root)
    const cwd = join(root, "work")
    const home = join(root, "home")
    mkdirSync(cwd)
    mkdirSync(home)
    mock.script.push({ name: "Bash", input: { command: "sleep 1", run_in_background: true } })
    const layer =
      where === "local"
        ? ClaudeAgent.layer(options).pipe(Layer.provide(ClaudeSdk.layer()))
        : DetachedAgent.layer({ host, provider: "claude", claude: options, dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(
            Layer.provide(NodeServices.layer),
          )
    yield* Effect.gen(function* () {
      const session = yield* (yield* Agent).open({
        cwd,
        env: {
          HOME: root,
          CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: "sk-mock",
          ANTHROPIC_BASE_URL: mock.baseUrl,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        },
        model: "claude-haiku-5-5",
      })
      yield* session.turn("go")
      yield* session.end
    }).pipe(Effect.scoped, Effect.provide(layer))
    return JSON.stringify(mock.requests.at(-1)?.messages)
  }).pipe(Effect.scoped)

describe("claude backgroundTasks", () => {
  it.live(
    "by default a command can run in the background",
    () =>
      Effect.gen(function* () {
        expect(yield* answer({}, "local")).toContain("Command running in background")
      }),
    timeout,
  )

  for (const where of ["local", "detached"] as const) {
    it.live(
      `false takes run_in_background off Bash (${where})`,
      () =>
        Effect.gen(function* () {
          const sent = yield* answer({ backgroundTasks: false }, where)
          expect(sent).toContain("unexpected parameter `run_in_background`")
          expect(sent).not.toContain("Command running in background")
        }),
      timeout,
    )
  }
})
