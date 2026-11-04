/**
 * Hooks and `disable` on a real `codex app-server`, talking to a local stand-in
 * for the model: free and offline, with a throwaway `CODEX_HOME`. Skipped where
 * there is no `codex`. This is what shows that a Codex release still honors what
 * `CodexHooks` depends on (see UPGRADING.md).
 */
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, type Scope, Stream } from "effect"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type RunOptions } from "../src/Agent.ts"
import type { AgentSession } from "../src/AgentSession.ts"
import { CodexAgent, CodexAppServer } from "../src/codex/index.ts"
import type * as P from "../src/codex/protocol.ts"
import { AgentHosts, DetachedAgent } from "../src/host/index.ts"
import { host } from "./support/hostCommand.ts"
import * as Mock from "./support/mockResponses.ts"

const hasCodex = spawnSync("codex", ["--version"]).status === 0
const timeout = 60_000

interface Sandbox {
  readonly root: string
  readonly cwd: string
  readonly home: string
  readonly marker: string
  readonly run: (options?: Partial<RunOptions>) => RunOptions
}

const roots: Array<string> = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const sandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), "ea-e2e-"))
  roots.push(root)
  const cwd = join(root, "work")
  const home = join(root, "home")
  mkdirSync(cwd)
  mkdirSync(home)
  return {
    root,
    cwd,
    home,
    marker: join(cwd, "ran.txt"),
    run: (options = {}) => ({ cwd, env: { HOME: root, CODEX_HOME: home }, model: "gpt-5.1-codex", ...options }),
  }
}

/** Runs `program` with an `Agent` on a real app-server talking to `mock`. */
const withAgent = <A, E>(mock: Mock.MockResponses, program: Effect.Effect<A, E, Agent | Scope.Scope>, args: ReadonlyArray<string> = []) =>
  program.pipe(
    Effect.scoped,
    Effect.provide(CodexAgent.layer().pipe(Layer.provide(CodexAppServer.layer({ args: [...mock.args, ...args] })))),
    Effect.provide(NodeServices.layer),
  )

const inputOf = (mock: Mock.MockResponses) => JSON.stringify(mock.requests.at(-1)!.input)

const agentTools = (mock: Mock.MockResponses) => mock.requests.at(-1)!.tools.filter((t) => /agent|followup_task|send_message/.test(t))

const execCommand = (cmd: string, callId?: string) => Mock.functionCall("exec_command", { cmd }, callId !== undefined ? { callId } : {})

/** Stands in for a managed policy, which needs a system path: Codex never sees our hooks. */
const codexWithPolicy = (box: Sandbox): string => {
  const path = join(box.root, "codex-with-policy")
  writeFileSync(
    path,
    `#!/bin/sh\nn=$#\nwhile [ "$n" -gt 0 ]; do\n  a=$1; shift; n=$((n-1))\n  if [ "$a" = "-c" ]; then\n    case "$1" in hooks.*|features.hooks=*) shift; n=$((n-1)); continue ;; esac\n  fi\n  set -- "$@" "$a"\ndone\nexec codex "$@"\n`,
  )
  chmodSync(path, 0o755)
  return path
}

/** Puts a hook in the user's config, trusted the way `/hooks` would, and returns the file that shows it ran. */
const userHook = (box: Sandbox, mock: Mock.MockResponses, config = "") =>
  Effect.gen(function* () {
    const fired = join(box.root, "user-fired")
    const command = `cat > /dev/null; touch ${fired}`
    const toml = `${config}[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\n`
    writeFileSync(join(box.home, "config.toml"), toml)
    // Read its hash from a server that lists it, whatever `config` says.
    const listed = yield* Effect.scoped(
      Effect.gen(function* () {
        const conn = yield* (yield* CodexAppServer.CodexAppServer).connect({ cwd: box.cwd, env: { HOME: box.root, CODEX_HOME: box.home }, args: ["-c", "features.hooks=true"] })
        return yield* conn.request("hooks/list", { cwds: [box.cwd] })
      }),
    ).pipe(Effect.provide(CodexAppServer.layer({ args: mock.args })), Effect.provide(NodeServices.layer))
    const user = listed.data.flatMap((e) => e.hooks)[0]!
    writeFileSync(join(box.home, "config.toml"), `${toml}\n[hooks.state.${JSON.stringify(user.key)}]\ntrusted_hash = ${JSON.stringify(user.currentHash)}\n`)
    return fired
  })

describe.skipIf(!hasCodex)("hooks on a real app-server", () => {
  it.live(
    "beforeTool and afterTool see the call, and add context the model receives",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const before: Array<unknown> = []
        const after: Array<unknown> = []
        mock.script.push(execCommand("echo hi", "call_ok"))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(
              box.run({
                hooks: {
                  beforeTool: (call) => {
                    before.push(call)
                    return Effect.succeed(Option.some("BEFORE_MARK"))
                  },
                  afterTool: (call) => {
                    after.push(call)
                    return Effect.succeed(Option.some("AFTER_MARK"))
                  },
                },
              }),
            )
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(before).toEqual([{ callId: "call_ok", name: "Bash", input: { command: "echo hi" } }])
        expect(after).toMatchObject([{ callId: "call_ok", name: "Bash", isError: false, output: expect.stringContaining("hi") }])
        expect(inputOf(mock)).toContain("BEFORE_MARK")
        expect(inputOf(mock)).toContain("AFTER_MARK")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "afterTool's isError follows the command's exit code",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const after: Array<{ readonly callId: string; readonly isError: boolean }> = []
        mock.script.push(execCommand("exit 3", "call_bad"), execCommand("true", "call_good"))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(
              box.run({
                hooks: {
                  afterTool: (call) => {
                    after.push(call)
                    return Effect.succeedNone
                  },
                },
              }),
            )
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(after.map(({ callId, isError }) => ({ callId, isError }))).toEqual([
          { callId: "call_bad", isError: true },
          { callId: "call_good", isError: false },
        ])
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "beforeStop's text keeps the turn going, and the turn still ends normally",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        let stops = 0
        const result = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(
              box.run({
                hooks: {
                  beforeStop: () =>
                    Effect.sync(() => {
                      stops++
                      return stops === 1 ? Option.some("STOP_MARK") : Option.none()
                    }),
                },
              }),
            )
            const ended = yield* session.turn("go")
            yield* session.end
            return ended
          }),
        )
        expect(stops).toBe(2)
        expect(mock.requests.length).toBe(2)
        expect(inputOf(mock)).toContain("STOP_MARK")
        expect(result).toMatchObject({ finalText: "done" })
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a hook that fails adds nothing, and the turn carries on",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(execCommand(`echo x > ${box.marker}`))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ hooks: { beforeTool: () => Effect.die("boom") } }))
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a user's own trusted hook still runs beside ours",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const userFired = yield* userHook(box, mock)
        let ours = 0
        mock.script.push(execCommand("true"))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(
              box.run({
                hooks: {
                  beforeTool: () =>
                    Effect.sync(() => {
                      ours++
                      return Option.none()
                    }),
                },
              }),
            )
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(ours).toBe(1)
        expect(existsSync(userFired)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "with hooks off, the user's hooks stay off wherever they came from: config.toml, hooks.json, or a trusted project",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        for (const [off, expected] of [[false, true], [true, false]] as const) {
          const box = sandbox()
          const fired = (name: string) => join(box.root, `fired-${name}`)
          const command = (name: string) => `cat > /dev/null; touch ${fired(name)}`
          const toml = (name: string) => `[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command(name))}\n`
          const base = `${off ? "[features]\nhooks = false\n\n" : ""}[projects.${JSON.stringify(box.cwd)}]\ntrust_level = "trusted"\n\n${toml("toml")}`
          writeFileSync(join(box.home, "config.toml"), base)
          writeFileSync(join(box.home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command("json") }] }] } }))
          mkdirSync(join(box.cwd, ".codex"))
          writeFileSync(join(box.cwd, ".codex", "config.toml"), toml("project"))
          // Trust them all the way `/hooks` would, so that only `hooks = false` can stop them.
          const listed = yield* Effect.scoped(
            Effect.gen(function* () {
              const conn = yield* (yield* CodexAppServer.CodexAppServer).connect({ cwd: box.cwd, env: { HOME: box.root, CODEX_HOME: box.home }, args: ["-c", "features.hooks=true"] })
              return yield* conn.request("hooks/list", { cwds: [box.cwd] })
            }),
          ).pipe(Effect.provide(CodexAppServer.layer({ args: mock.args })), Effect.provide(NodeServices.layer))
          const hooks = listed.data.flatMap((e) => e.hooks)
          expect(hooks.map((h) => h.source).sort()).toEqual(["project", "user", "user"])
          writeFileSync(join(box.home, "config.toml"), `${base}\n${hooks.map((h) => `[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`).join("")}`)
          let ours = 0
          mock.script.push(execCommand("true"))
          yield* withAgent(
            mock,
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open(box.run({ hooks: { beforeTool: () => Effect.sync(() => (ours++, Option.none())) } }))
              yield* session.turn("go")
              yield* session.end
            }),
          )
          expect(ours).toBe(1)
          for (const name of ["toml", "json", "project"]) expect(existsSync(fired(name)), `${name}, off: ${off}`).toBe(expected)
        }
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "one layer follows the config: hooks turned off, a hook added while off, and hooks turned back on",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const fired = (name: string) => join(box.root, `fired-${name}`)
        const toml = (name: string) => `[[hooks.PreToolUse]]\nmatcher = "*"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(`cat > /dev/null; touch ${fired(name)}`)}\n`
        const off = "[features]\nhooks = false\n\n"
        // Trusts every hook in `config` the way `/hooks` would.
        const write = (config: string) =>
          Effect.gen(function* () {
            writeFileSync(join(box.home, "config.toml"), config)
            const listed = yield* Effect.scoped(
              Effect.gen(function* () {
                const conn = yield* (yield* CodexAppServer.CodexAppServer).connect({ cwd: box.cwd, env: { HOME: box.root, CODEX_HOME: box.home }, args: ["-c", "features.hooks=true"] })
                return yield* conn.request("hooks/list", { cwds: [box.cwd] })
              }),
            ).pipe(Effect.provide(CodexAppServer.layer({ args: mock.args })), Effect.provide(NodeServices.layer))
            writeFileSync(join(box.home, "config.toml"), `${config}\n${listed.data.flatMap((e) => e.hooks).map((h) => `[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`).join("")}`)
          })
        yield* Effect.gen(function* () {
          const agent = yield* Agent
          let ours = 0
          const session = () =>
            Effect.gen(function* () {
              mock.script.push(execCommand("true"))
              const session = yield* agent.open(box.run({ hooks: { beforeTool: () => Effect.sync(() => (ours++, Option.none())) } }))
              yield* session.turn("go")
              yield* session.end
            })
          // On, so the layer keeps the flags.
          yield* write(toml("a"))
          yield* session()
          expect(existsSync(fired("a"))).toBe(true)
          rmSync(fired("a"))
          // Off: the kept flags find nothing, and the user's stay off.
          yield* write(`${off}${toml("a")}`)
          yield* session()
          expect(existsSync(fired("a"))).toBe(false)
          // A hook added while off.
          yield* write(`${off}${toml("a")}\n${toml("b")}`)
          yield* session()
          expect(existsSync(fired("a")) || existsSync(fired("b"))).toBe(false)
          // Back on: nothing is left disabled.
          yield* write(`${toml("a")}\n${toml("b")}`)
          yield* session()
          expect(existsSync(fired("a")) && existsSync(fired("b"))).toBe(true)
          expect(ours).toBe(4)
        }).pipe(Effect.scoped, Effect.provide(CodexAgent.layer().pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })))), Effect.provide(NodeServices.layer))
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "with hooks off, a subagent call on a resumed thread is still refused",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const threadId = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run())
            yield* session.turn("go")
            yield* session.end
            return session.sessionId
          }),
        )
        writeFileSync(join(box.home, "config.toml"), "[features]\nhooks = false\n")
        mock.script.push(Mock.functionCall("spawn_agent", { message: "x", task_name: "t" }, { namespace: "multi_agent_v1" }))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ resume: threadId, disable: { subagents: true } }))
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(inputOf(mock)).toContain("disabled for this session")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "disabling the user's hooks lasts only for the session: other sessions, the config and later sessions don't see it",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const env = { HOME: box.root, CODEX_HOME: box.home }
        const off = "[features]\nhooks = false\n\n"
        const userFired = yield* userHook(box, mock, off)
        const configFile = join(box.home, "config.toml")
        const config = readFileSync(configFile, "utf8")
        const listUser = Effect.scoped(
          Effect.gen(function* () {
            const conn = yield* (yield* CodexAppServer.CodexAppServer).connect({ cwd: box.cwd, env, args: ["-c", "features.hooks=true"] })
            return (yield* conn.request("hooks/list", { cwds: [box.cwd] })).data.flatMap((e) => e.hooks)
          }),
        ).pipe(Effect.provide(CodexAppServer.layer({ args: mock.args })), Effect.provide(NodeServices.layer), Effect.orDie)
        const plainTurn = (options: Partial<RunOptions> = {}) =>
          withAgent(
            mock,
            Effect.gen(function* () {
              mock.script.push(execCommand("true"))
              const session = yield* (yield* Agent).open(box.run(options))
              yield* session.turn("go")
              yield* session.end
            }),
          )

        const seenDuring: Array<ReadonlyArray<{ readonly enabled: boolean; readonly trustStatus: string }>> = []
        mock.script.push(execCommand("true"))
        const threadId = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(
              box.run({
                hooks: {
                  beforeTool: () =>
                    Effect.map(listUser, (hooks) => {
                      seenDuring.push(hooks)
                      return Option.none()
                    }),
                },
              }),
            )
            yield* session.turn("go")
            yield* session.end
            return session.sessionId
          }),
        )
        expect(existsSync(userFired)).toBe(false)
        expect(seenDuring).toMatchObject([[{ enabled: true, trustStatus: "trusted" }]])
        expect(readFileSync(configFile, "utf8")).toBe(config)
        expect(yield* listUser).toMatchObject([{ enabled: true, trustStatus: "trusted" }])

        // Nothing in the Codex home carries what the flags said.
        for (const file of readdirSync(box.home, { recursive: true, withFileTypes: true })) {
          if (!file.isFile() || file.name === "config.toml") continue
          const text = readFileSync(join(file.parentPath, file.name)).toString("latin1")
          for (const ours of ["enabled=false", "hooks.state", "trusted_hash", "features.hooks"]) expect(text.includes(ours), `${file.name}: ${ours}`).toBe(false)
        }

        // The user turns hooks on: their hook runs in new threads, and in ours.
        writeFileSync(configFile, config.replace(off, ""))
        yield* plainTurn()
        expect(existsSync(userFired)).toBe(true)
        rmSync(userFired)
        yield* plainTurn({ resume: threadId })
        expect(existsSync(userFired)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "the layer can turn hooks on itself, which runs the user's too",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const userFired = yield* userHook(box, mock, "[features]\nhooks = false\n\n")
        let ours = 0
        mock.script.push(execCommand("true"))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ hooks: { beforeTool: () => Effect.sync(() => (ours++, Option.none())) } }))
            yield* session.turn("go")
            yield* session.end
          }),
          ["-c", "features.hooks=true"],
        )
        expect(ours).toBe(1)
        expect(existsSync(userFired)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a recording holds only the session's connection, not the one that found the hashes",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const recording = join(box.root, "rec.jsonl")
        const hooks = { beforeStop: () => Effect.succeedNone }
        const lines = yield* Effect.gen(function* () {
          const agent = yield* Agent
          const counts: Array<number> = []
          for (const _ of [1, 2]) {
            const session = yield* agent.open(box.run({ hooks }))
            yield* session.turn("go")
            yield* session.end
            counts.push(readFileSync(recording, "utf8").split("\n").filter((l) => l.includes(`"hooks/list"`) && l.includes(`"dir":"out"`)).length)
          }
          return counts
        }).pipe(
          Effect.scoped,
          Effect.provide(CodexAgent.layer().pipe(Layer.provide(CodexAppServer.layer({ args: mock.args, record: recording })))),
          Effect.provide(NodeServices.layer),
        )
        expect(lines).toEqual([1, 1])
      }).pipe(Effect.scoped),
    timeout,
  )
})

describe.skipIf(!hasCodex)("hooks on a detached session", () => {
  it.live(
    "the host's Codex session calls the hook in the client",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const before: Array<string> = []
        mock.script.push(execCommand("true", "call_hosted"))
        yield* Effect.gen(function* () {
          const session = yield* (yield* Agent).open(
            box.run({
              hooks: {
                beforeTool: (call) =>
                  Effect.sync(() => {
                    before.push(call.callId)
                    return Option.some("HOSTED_MARK")
                  }),
              },
            }),
          )
          yield* session.turn("go")
          yield* session.end
        }).pipe(
          Effect.scoped,
          Effect.provide(DetachedAgent.layer({ host, provider: "codex", codex: { args: mock.args }, dir: join(box.root, "hosts") })),
          Effect.provide(NodeServices.layer),
        )
        expect(before).toEqual(["call_hosted"])
        expect(inputOf(mock)).toContain("HOSTED_MARK")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "with config that would stop hooks, the same: only a session that didn't ask for them opens",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(execCommand(`echo x > ${box.marker}`))
        yield* Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const hooks = { beforeTool: () => Effect.succeedNone }
          for (const needs of [{ hooks }, { disable: { tools: ["apply_patch"] } }, { disable: { askUser: true } }]) {
            const failed = yield* Effect.flip(hosts.open(box.run(needs)))
            expect(failed.message).toContain("cannot install hooks")
          }
          const session = yield* hosts.open(box.run())
          expect((yield* session.info).capabilities.hooks).toBe(false)
          yield* session.turn("go")
          yield* session.end
        }).pipe(
          Effect.scoped,
          Effect.provide(DetachedAgent.layer({ host, provider: "codex", codex: { args: mock.args, config: { "features.hooks": false } }, dir: join(box.root, "hosts"), onScopeClose: "detach" })),
          Effect.provide(NodeServices.layer),
        )
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "where a policy stops hooks, only a session that didn't ask for them opens, and attaching with hooks fails without harming it",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const codexPath = codexWithPolicy(box)
        mock.script.push(execCommand(`echo x > ${box.marker}`))
        yield* Effect.gen(function* () {
          const hosts = yield* AgentHosts
          const hooks = { beforeTool: () => Effect.succeedNone }
          // The host retries these without the hooks a client might want, and their own `disable` fails that too.
          for (const needs of [{ hooks }, { disable: { subagents: true } }, { disable: { askUser: true } }]) {
            const failed = yield* Effect.flip(hosts.open(box.run(needs)))
            expect(failed.message).toContain("cannot install hooks")
            expect(failed.message).toContain("managed policy")
          }
          const session = yield* hosts.open(box.run())
          expect((yield* session.info).capabilities.hooks).toBe(false)
          const refused = yield* Effect.scoped(hosts.attach(session.sessionId, { hooks })).pipe(Effect.flip)
          expect(refused._tag).toBe("AgentError")
          expect(refused.message).toContain("runs no hooks")
          yield* session.turn("go")
          yield* session.end
        }).pipe(
          Effect.scoped,
          Effect.provide(DetachedAgent.layer({ host, provider: "codex", codex: { codexPath, args: mock.args }, dir: join(box.root, "hosts"), onScopeClose: "detach" })),
          Effect.provide(NodeServices.layer),
        )
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )
})

describe.skipIf(!hasCodex)("disable on a real app-server", () => {
  const turnIn = (box: Sandbox) =>
    Effect.gen(function* () {
      const session = yield* (yield* Agent).open(box.run({ model: "gpt-5.5" }))
      yield* session.turn("go")
      yield* session.end
    })

  const patchFor = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\n`

  it.live(
    "a tool with no switch is refused when called, and others still run",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const other = join(box.cwd, "other.txt")
        mock.script.push(Mock.applyPatch(patchFor(box.marker)), execCommand(`echo x > ${other}`))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ model: "gpt-5.5", disable: { tools: ["apply_patch"] } }))
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(existsSync(box.marker)).toBe(false)
        expect(existsSync(other)).toBe(true)
        expect(JSON.stringify(mock.requests[1]!.input)).toContain("disabled for this session")
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "the layer's config can't undo a refusal: open fails if it would stop hooks once the thread starts",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const layerWith = (config: Readonly<Record<string, P.JsonValue>>) =>
          CodexAgent.layer({ config }).pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })), Layer.provide(NodeServices.layer))
        for (const config of [{ "features.hooks": false }, { features: { hooks: false } }, { "hooks.PreToolUse": [] }, { hooks: { PreToolUse: [] } }]) {
          const box = sandbox()
          mock.script.push(Mock.applyPatch(patchFor(box.marker)))
          const failed = yield* Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ model: "gpt-5.5", disable: { tools: ["apply_patch"] } }))
            yield* session.turn("go")
          }).pipe(Effect.scoped, Effect.provide(layerWith(config)), Effect.flip)
          mock.script.length = 0
          expect(failed.message, JSON.stringify(config)).toContain("cannot install hooks")
          expect(existsSync(box.marker), JSON.stringify(config)).toBe(false)
        }
        // A session that needs no hooks is none of its business.
        const box = sandbox()
        mock.script.push(execCommand(`echo x > ${box.marker}`))
        yield* turnIn(box).pipe(Effect.scoped, Effect.provide(layerWith({ "features.hooks": false })))
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "config files can't undo a refusal either",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const ownKey = `"/<session-flags>/config.toml:pre_tool_use:0:0"`
        for (const project of ["[features]\nhooks = false\n", "[hooks]\nPreToolUse = []\n", `[hooks.state.${ownKey}]\nenabled = false\n`]) {
          const box = sandbox()
          writeFileSync(join(box.home, "config.toml"), `[projects.${JSON.stringify(box.cwd)}]\ntrust_level = "trusted"\n`)
          mkdirSync(join(box.cwd, ".codex"))
          writeFileSync(join(box.cwd, ".codex", "config.toml"), project)
          mock.script.push(Mock.applyPatch(patchFor(box.marker)))
          yield* withAgent(
            mock,
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open(box.run({ model: "gpt-5.5", disable: { tools: ["apply_patch"] } }))
              yield* session.turn("go")
              yield* session.end
            }),
          )
          expect(existsSync(box.marker), project).toBe(false)
        }
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "without the hook the same patch applies (the control for the test above)",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(Mock.applyPatch(patchFor(box.marker)))
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ model: "gpt-5.5" }))
            yield* session.turn("go")
            yield* session.end
          }),
        )
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    // Only without a model catalog, as here. A real model's entry can select v2 regardless, which `live-codex.ts disabled` covers.
    "the switches remove subagent tools from a new thread, whichever generation the user's config turned on",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        for (const config of ["", "[features]\nmulti_agent_v2 = true\n"]) {
          const box = sandbox()
          writeFileSync(join(box.home, "config.toml"), config)
          yield* withAgent(
            mock,
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open(box.run({ disable: { subagents: true } }))
              yield* session.turn("go")
              yield* session.end
            }),
          )
          expect(agentTools(mock)).toEqual([])
        }
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a resumed thread keeps its subagent tools, but calling one is refused",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        for (const [generation, namespace, flags] of [
          ["v1", "multi_agent_v1", []],
          ["v2", "collaboration", ["-c", "features.multi_agent_v2=true"]],
        ] as const) {
          const box = sandbox()
          const threadId = yield* withAgent(
            mock,
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open(box.run())
              yield* session.turn("go")
              yield* session.end
              return session.sessionId
            }),
            flags,
          )
          expect(agentTools(mock).length, generation).toBeGreaterThan(0)
          mock.script.push(Mock.functionCall("spawn_agent", { message: "x", task_name: "t" }, { namespace }))
          yield* withAgent(
            mock,
            Effect.gen(function* () {
              const session = yield* (yield* Agent).open(box.run({ resume: threadId, disable: { subagents: true } }))
              yield* session.turn("go")
              yield* session.end
            }),
            flags,
          )
          expect(agentTools(mock).length, `${generation}: the switches don't reach a resumed thread`).toBeGreaterThan(0)
          expect(inputOf(mock), generation).toContain("disabled for this session")
        }
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "every switch in toolSwitches takes effect on a resumed thread too",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const threadId = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run())
            yield* session.turn("go")
            yield* session.end
            return session.sessionId
          }),
        )
        expect(mock.requests.at(-1)!.tools).toContain("web_search")
        yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* (yield* Agent).open(box.run({ resume: threadId, disable: { tools: ["web_search", "goals", "shell", "view_image"] } }))
            yield* session.turn("go")
            yield* session.end
          }),
        )
        const tools = mock.requests.at(-1)!.tools
        for (const gone of ["web_search", "get_goal", "exec_command", "write_stdin", "view_image"]) expect(tools).not.toContain(gone)
      }).pipe(Effect.scoped),
    timeout,
  )
})

describe.skipIf(!hasCodex)("disable.askUser on a real app-server", () => {
  const question = "Which colour?"
  const ask = Mock.functionCall("request_user_input_async", { questions: [{ title: question, options: ["red", "blue"] }] }, { namespace: "functions" })
  const tell = Mock.functionCall("send_message_to_user_async", { message: question }, { namespace: "functions" })
  const askTool = "functions/request_user_input_async"
  const tellTool = "functions/send_message_to_user_async"
  const tellOn = ["-c", "features.send_message_to_user_async=true"]

  /** The flags for a model whose catalog entry selects these tools, as the gpt-6 family's do with `send_user_message_async`. */
  const catalog = (box: Sandbox, tools: ReadonlyArray<string> = ["send_user_message_async"]) => {
    const path = join(box.root, "catalog.json")
    writeFileSync(
      path,
      JSON.stringify({
        models: [
          {
            slug: "asks",
            display_name: "asks",
            supported_reasoning_levels: [],
            shell_type: "default",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            support_verbosity: false,
            truncation_policy: { mode: "bytes", limit: 10000 },
            base_instructions: "You are a test.",
            use_responses_lite: true,
            experimental_supported_tools: tools,
          },
        ],
      }),
    )
    return ["-c", `model_catalog_json=${JSON.stringify(path)}`]
  }

  /** One turn, and the text the session reported as the agent's. */
  const turnIn = (session: AgentSession) =>
    Effect.gen(function* () {
      const text: Array<string> = []
      const events = yield* session.subscribe
      yield* events.pipe(
        Stream.runForEach((e) => Effect.sync(() => (e._tag === "Text" ? void text.push(e.text) : undefined))),
        Effect.ignore,
        Effect.forkScoped,
      )
      yield* session.turn("go")
      yield* session.end
      return text
    })

  const opened = (options: Partial<RunOptions>, box: Sandbox) =>
    Effect.gen(function* () {
      return yield* (yield* Agent).open(box.run({ model: "asks", ...options }))
    })

  it.live(
    "control: without it the call is accepted, and the question reaches Text as if the agent had said it",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(ask)
        const text = yield* withAgent(mock, Effect.flatMap(opened({}, box), turnIn), catalog(box))
        expect(mock.requests[0]!.tools).toContain(askTool)
        expect(Mock.toolOutputs(mock)).toEqual([`{"accepted":true}`])
        expect(text.join("\n")).toContain(question)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "the model still sees the tool, but a call is refused, the question goes nowhere, and other tools run",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(ask, execCommand(`echo x > ${box.marker}`))
        const text = yield* withAgent(mock, Effect.flatMap(opened({ disable: { askUser: true } }, box), turnIn), catalog(box))
        expect(mock.requests[0]!.tools).toContain(askTool)
        expect(inputOf(mock)).toContain("Do not ask the user")
        const outputs = Mock.toolOutputs(mock)
        expect(outputs[0]).toContain("disabled for this session")
        expect(outputs.join()).not.toContain("accepted")
        expect(text.join("\n")).not.toContain(question)
        expect(existsSync(box.marker)).toBe(true)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a resumed thread that was started without it refuses the call too",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const flags = catalog(box)
        const threadId = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* opened({}, box)
            yield* turnIn(session)
            return session.sessionId
          }),
          flags,
        )
        mock.script.push(ask)
        const text = yield* withAgent(mock, Effect.flatMap(opened({ resume: threadId, disable: { askUser: true } }, box), turnIn), flags)
        expect(Mock.toolOutputs(mock).join()).toContain("disabled for this session")
        expect(text.join("\n")).not.toContain(question)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a detached session refuses the call too",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        mock.script.push(ask)
        const text = yield* Effect.flatMap(opened({ disable: { askUser: true } }, box), turnIn).pipe(
          Effect.scoped,
          Effect.provide(DetachedAgent.layer({ host, provider: "codex", codex: { args: [...mock.args, ...catalog(box)] }, dir: join(box.root, "hosts") })),
          Effect.provide(NodeServices.layer),
        )
        expect(mock.requests[0]!.tools).toContain(askTool)
        expect(Mock.toolOutputs(mock).join()).toContain("disabled for this session")
        expect(text.join("\n")).not.toContain(question)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "a client's hook sees the attempt, and the refusal holds",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const seen: Array<string> = []
        mock.script.push(ask)
        yield* Effect.flatMap(
          opened({ disable: { askUser: true }, hooks: { beforeTool: (call) => Effect.sync(() => (seen.push(call.name), Option.none())) } }, box),
          turnIn,
        ).pipe(
          Effect.scoped,
          Effect.provide(DetachedAgent.layer({ host, provider: "codex", codex: { args: [...mock.args, ...catalog(box)] }, dir: join(box.root, "hosts") })),
          Effect.provide(NodeServices.layer),
        )
        expect(Mock.toolOutputs(mock).join()).toContain("disabled for this session")
        expect(seen).toEqual(["request_user_input_async"])
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "the sibling tool: its switch takes it away, new or resumed, and a catalog that selects it anyway is refused",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        // Control: the user's config turns it on, and it does what the other one does.
        mock.script.push(tell)
        const threadId = yield* withAgent(
          mock,
          Effect.gen(function* () {
            const session = yield* opened({}, box)
            const text = yield* turnIn(session)
            expect(text.join("\n")).toContain(question)
            return session.sessionId
          }),
          [...catalog(box), ...tellOn],
        )
        expect(mock.requests.at(-1)!.tools).toContain(tellTool)
        expect(Mock.toolOutputs(mock)).toEqual([`{"accepted":true}`])

        yield* withAgent(mock, Effect.flatMap(opened({ disable: { askUser: true } }, box), turnIn), [...catalog(box), ...tellOn])
        expect(mock.requests.at(-1)!.tools).not.toContain(tellTool)

        mock.script.push(tell)
        const resumed = yield* withAgent(mock, Effect.flatMap(opened({ resume: threadId, disable: { askUser: true } }, box), turnIn), [...catalog(box), ...tellOn])
        expect(mock.requests.at(-1)!.tools).not.toContain(tellTool)
        // The thread's history holds the control's answer; this is the newest.
        expect(Mock.toolOutputs(mock).at(-1)).toContain("unsupported call")
        expect(resumed.join("\n")).not.toContain(question)

        const other = sandbox()
        mock.script.push(tell)
        const text = yield* withAgent(mock, Effect.flatMap(opened({ disable: { askUser: true } }, other), turnIn), catalog(other, ["send_message_to_user_async"]))
        expect(mock.requests.at(-1)!.tools).toContain(tellTool)
        expect(Mock.toolOutputs(mock).join()).toContain("disabled for this session")
        expect(text.join("\n")).not.toContain(question)
      }).pipe(Effect.scoped),
    timeout,
  )

  it.live(
    "where a policy or the layer's config stops hooks, open fails: nothing would stop the tool",
    () =>
      Effect.gen(function* () {
        const mock = yield* Mock.make
        const box = sandbox()
        const failedWith = (layer: Layer.Layer<Agent>) =>
          opened({ disable: { askUser: true } }, box).pipe(Effect.scoped, Effect.provide(layer), Effect.flip)
        const policy = yield* failedWith(
          CodexAgent.layer().pipe(Layer.provide(CodexAppServer.layer({ codexPath: codexWithPolicy(box), args: mock.args })), Layer.provide(NodeServices.layer)),
        )
        expect(policy.message).toContain("cannot install hooks")
        expect(policy.message).toContain("managed policy")
        const config = yield* failedWith(
          CodexAgent.layer({ config: { "features.hooks": false } }).pipe(Layer.provide(CodexAppServer.layer({ args: mock.args })), Layer.provide(NodeServices.layer)),
        )
        expect(config.message).toContain("cannot install hooks")
        expect(mock.requests).toEqual([])
      }).pipe(Effect.scoped),
    timeout,
  )
})
