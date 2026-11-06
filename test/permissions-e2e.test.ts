/**
 * The permission options on the real `claude` and `codex`, against local
 * stand-ins for the model: free and offline. Claude's `permissionMode:
 * "dontAsk"` runs only what `allowedTools` allows; Codex's `sandbox:
 * "workspace-write"` stops writes outside `cwd`. The defaults (permissions
 * bypassed, no sandbox) are checked too, so a change to them shows up here.
 * Codex tests are skipped where there is no `codex`.
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "../src/Agent.ts"
import { ClaudeAgent, ClaudeSdk } from "../src/claude/index.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import { DetachedAgent } from "../src/host/index.ts"
import { host } from "./support/hostCommand.ts"
import * as MockMessages from "./support/mockMessages.ts"
import * as MockResponses from "./support/mockResponses.ts"
import * as McpHttpServer from "./support/mcpHttpServer.ts"

const hasCodex = spawnSync("codex", ["--version"]).status === 0
const timeout = 60_000

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const dirs = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const cwd = join(root, "work")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  return { root, cwd, home }
}

const turn = (run: Parameters<Agent["Service"]["open"]>[0]) =>
  Effect.gen(function* () {
    const session = yield* (yield* Agent).open(run)
    yield* session.turn("go")
    yield* session.end
  })

describe("claude", () => {
  const world = (optionsFor: (paths: { readonly allowed: string }) => ClaudeAgent.ClaudeAgentOptions) =>
    Effect.gen(function* () {
      const mock = yield* MockMessages.make
      const { root, cwd, home } = dirs("ea-perm-claude-")
      const env = {
        HOME: root,
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: "sk-mock",
        ANTHROPIC_BASE_URL: mock.baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
      }
      const allowed = join(cwd, "allowed.txt")
      const denied = join(cwd, "denied.txt")
      const options = optionsFor({ allowed })
      mock.script.push({ name: "Bash", input: { command: `touch ${denied}` } }, { name: "Bash", input: { command: `touch ${allowed}` } })
      return {
        mock,
        allowed,
        denied,
        run: { cwd, env, model: "claude-haiku-5-5" },
        local: ClaudeAgent.layer(options).pipe(Layer.provide(ClaudeSdk.layer())),
        detached: DetachedAgent.layer({ host, provider: "claude", claude: options, dir: join(root, "hosts"), onScopeClose: "detach" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      }
    })

  it.live(
    "by default permissions are bypassed: every command runs",
    () =>
      Effect.gen(function* () {
        const w = yield* world(() => ({}))
        yield* turn(w.run).pipe(Effect.scoped, Effect.provide(w.local))
        expect([existsSync(w.denied), existsSync(w.allowed)]).toEqual([true, true])
      }).pipe(Effect.scoped),
    timeout,
  )

  for (const where of ["local", "detached"] as const) {
    it.live(
      `dontAsk runs only what allowedTools allows, and denies the rest (${where})`,
      () =>
        Effect.gen(function* () {
          // The world's paths are only known once it's made; the rule names one exact command.
          const w = yield* world((paths) => ({ permissionMode: "dontAsk", allowedTools: [`Bash(touch ${paths.allowed})`] }))
          yield* turn(w.run).pipe(Effect.scoped, Effect.provide(where === "local" ? w.local : w.detached))
          expect([existsSync(w.denied), existsSync(w.allowed)]).toEqual([false, true])
          expect(JSON.stringify(w.mock.requests)).toContain("denied")
        }).pipe(Effect.scoped),
      timeout,
    )
  }
})

describe.skipIf(!hasCodex)("codex", () => {
  const tmpExcluded = { "sandbox_workspace_write.exclude_slash_tmp": true, "sandbox_workspace_write.exclude_tmpdir_env_var": true }
  const world = (options: CodexAgent.CodexAgentOptions) =>
    Effect.gen(function* () {
      const mock = yield* MockResponses.make
      const { root, cwd, home } = dirs("ea-perm-codex-")
      const outside = join(root, "outside.txt")
      const inside = join(cwd, "inside.txt")
      mock.script.push(
        MockResponses.functionCall("exec_command", { cmd: `touch ${outside}` }, { callId: "call_out" }),
        MockResponses.functionCall("exec_command", { cmd: `touch ${inside}` }, { callId: "call_in" }),
      )
      return {
        outside,
        inside,
        run: { cwd, env: { HOME: root, CODEX_HOME: home }, model: "gpt-5.5" },
        local: CodexAgent.layer(options).pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })), Layer.provide(NodeServices.layer)),
        detached: DetachedAgent.layer({
          host,
          provider: "codex",
          codex: {
            args: mock.args,
            ...(options.sandbox !== undefined && { sandbox: options.sandbox }),
            ...(options.config !== undefined && { config: options.config }),
          },
          dir: join(root, "hosts"),
          onScopeClose: "detach",
        }).pipe(Layer.provide(NodeServices.layer)),
      }
    })

  it.live(
    "by default there is no sandbox: a command writes outside cwd",
    () =>
      Effect.gen(function* () {
        const w = yield* world({})
        yield* turn(w.run).pipe(Effect.scoped, Effect.provide(w.local))
        expect([existsSync(w.outside), existsSync(w.inside)]).toEqual([true, true])
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    'in a sandbox with mcpServerTools: "approve", a session\'s own mcpServers can be called',
    () =>
      Effect.gen(function* () {
        const mock = yield* MockResponses.make
        const { root, cwd, home } = dirs("ea-perm-codex-mcp-")
        const task = yield* McpHttpServer.make
        mock.script.push(MockResponses.functionCall("read_note", {}, { namespace: "mcp__task_tools" }))
        yield* turn({
          cwd,
          env: { HOME: root, CODEX_HOME: home },
          model: "gpt-5.5",
          mcpServers: { task_tools: { type: "http", url: task.url, headers: { Authorization: `Bearer ${task.token}` } } },
        }).pipe(
          Effect.scoped,
          Effect.provide(
            CodexAgent.layer({ sandbox: { mode: "workspace-write", mcpServerTools: "approve" } }).pipe(
              Layer.provide(CodexAppServer.layer({ args: mock.args })),
              Layer.provide(NodeServices.layer),
            ),
          ),
        )
        expect(task.reached()).toEqual(["read_note"])
      }).pipe(Effect.scoped),
    timeout,
  )

  for (const where of ["local", "detached"] as const) {
    it.live(
      `a sandbox with mcpServerTools: "refuse" fails open for a session with mcpServers (${where})`,
      () =>
        Effect.gen(function* () {
          const w = yield* world({ sandbox: { mode: "workspace-write", mcpServerTools: "refuse" } })
          const failed = yield* Effect.flip(
            turn({ ...w.run, mcpServers: { task_tools: { type: "stdio", command: "true" } } }).pipe(
              Effect.scoped,
              Effect.provide(where === "local" ? w.local : w.detached),
            ),
          )
          expect(failed.message).toContain('mcpServerTools: "refuse", so it takes no mcpServers')
          expect([existsSync(w.outside), existsSync(w.inside)]).toEqual([false, false])
        }).pipe(Effect.scoped),
      timeout,
    )

    it.live(
      `workspace-write lets a command write in cwd and nowhere else (${where})`,
      () =>
        Effect.gen(function* () {
          // The test's dirs are under the temp dir, which workspace-write also lets commands write to by default.
          const w = yield* world({ sandbox: { mode: "workspace-write", mcpServerTools: "refuse" }, config: tmpExcluded })
          yield* turn(w.run).pipe(Effect.scoped, Effect.provide(where === "local" ? w.local : w.detached))
          expect([existsSync(w.outside), existsSync(w.inside)]).toEqual([false, true])
        }).pipe(Effect.scoped),
      timeout,
    )
  }
})
