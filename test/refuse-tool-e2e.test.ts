/**
 * `beforeTool`'s refusal (`refuseTool`) on the real `claude`, with permissions
 * bypassed as in every session, against a local stand-in for the model: free
 * and offline. Codex's is in `codex-hooks-e2e.test.ts`. A refused Bash or
 * Write must not run, in the session's own process and on a detached session,
 * and the model must get the reason.
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type Hooks, refuseTool } from "../src/Agent.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { DetachedAgent } from "../src/host/index.ts"
import { host } from "./support/hostCommand.ts"
import * as MockMessages from "./support/mockMessages.ts"

const timeout = 60_000

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const world = Effect.gen(function* () {
  const mock = yield* MockMessages.make
  const root = mkdtempSync(join(tmpdir(), "ea-refuse-"))
  roots.push(root)
  const cwd = join(root, "work")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  const env = {
    HOME: root,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "sk-mock",
    ANTHROPIC_BASE_URL: mock.baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
  }
  return {
    mock,
    cwd,
    local: ClaudeAgent.layer().pipe(Layer.provide(ClaudeSdk.layer())),
    detached: DetachedAgent.layer({ host, provider: "claude", dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(Layer.provide(NodeServices.layer)),
    turn: (hooks: Hooks) =>
      Effect.gen(function* () {
        const session = yield* (yield* Agent).open({ cwd, env, model: "claude-haiku-5-5", hooks })
        yield* session.turn("go")
        yield* session.end
      }),
  }
})

/** Refuses every call but the one whose command is `allowed`. */
const pausing = (seen: Array<string>, allowed: string): Hooks => ({
  beforeTool: (call) =>
    Effect.sync(() => {
      seen.push(call.name)
      return JSON.stringify(call.input).includes(allowed) ? Option.none() : refuseTool("PAUSED_MARK: the board is paused")
    }),
})

describe("claude", () => {
  for (const where of ["local", "detached"] as const) {
    it.live(
      `a refused Bash or Write doesn't run, and the model gets the reason (${where})`,
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const ran = join(w.cwd, "ran.txt")
          const written = join(w.cwd, "written.txt")
          const allowed = join(w.cwd, "allowed.txt")
          w.mock.script.push(
            { name: "Bash", input: { command: `echo x > ${ran}` } },
            { name: "Write", input: { file_path: written, content: "x" } },
            { name: "Bash", input: { command: `echo x > ${allowed}` } },
          )
          const seen: Array<string> = []
          yield* w.turn(pausing(seen, "allowed.txt")).pipe(Effect.scoped, Effect.provide(w[where]))
          expect(seen).toEqual(["Bash", "Write", "Bash"])
          expect(existsSync(ran)).toBe(false)
          expect(existsSync(written)).toBe(false)
          expect(existsSync(allowed)).toBe(true)
          expect(JSON.stringify(w.mock.requests).match(/PAUSED_MARK/g)?.length).toBeGreaterThanOrEqual(2)
        }).pipe(Effect.scoped),
      timeout,
    )
  }
})
