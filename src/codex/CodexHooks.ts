/**
 * `RunOptions.hooks` and refused tools on Codex, built on its command hooks.
 *
 * Codex runs a command for each hook, with the call as JSON on stdin, so the
 * functions in `RunOptions.hooks` are reached through a relay: a one-line
 * script, run by this process's own runtime (node or bun), that sends the call
 * over a unix socket and prints the answer. The socket's path reaches it in an
 * environment variable, so the command is the same for every session.
 *
 * A tool that can't be removed is refused by a hook that needs no relay: a
 * shell command that exits 2, matched by tool name. The model still sees the
 * tool, and gets the refusal as its result.
 *
 * Hooks can't be set per thread, so they are `-c` flags on app-server. Codex
 * skips hooks it doesn't trust: `hooks.state` records a hook's hash as trusted
 * (undocumented; `--dangerously-bypass-hook-trust` isn't accepted by
 * app-server, and would trust a repository's hooks too). Only hooks from these
 * flags are named, so hooks in the user's config keep whatever trust they have.
 * Where `features.hooks` is off, Codex lists none of these hooks. As on Claude,
 * whose `disableAllHooks` stops hooks from settings but not a session's own, they
 * run anyway and the user's stay off: hooks go on for this process, and
 * `hooks.state` disables every hook but these and managed ones. A managed policy
 * that stops these from running can't be overridden, unlike on Claude: `open`
 * fails, and a detached session that didn't ask for hooks opens without them.
 * The agent's commands inherit the variable and could call the socket; they
 * run with full access anyway, as the same user.
 * All of this was verified on 0.162.1 by `test/codex-hooks-e2e.test.ts`.
 *
 * Not covered, because Codex runs no hooks for them: hosted tools such as web
 * search (which has its own switch), and `write_stdin` (likewise). A failed
 * `apply_patch` runs no `PostToolUse`, so `afterTool` doesn't see it.
 *
 * @internal
 */
import { Context, Effect, Fiber, Option, Schema, type Scope, Tracer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks } from "../Agent.ts"
import { AgentError } from "../AgentError.ts"
import * as P from "./protocol.ts"

/**
 * Where the relay finds its session's socket.
 *
 * @internal
 */
export const socketVariable = "EFFECT_AGENT_CODEX_HOOKS"

/**
 * Sends stdin to the socket and prints the answer. Always exits 0: a hook that
 * can't reach the session adds nothing, like one that fails. No single quotes
 * (see `relayCommand`), and raw newlines can only be JSON whitespace, so one
 * line is one call.
 */
const relayScript = [
  `process.on("uncaughtException",()=>process.exit(0));`,
  `const c=require("node:net").connect(process.env.${socketVariable});`,
  `let i="",o="";`,
  `c.setEncoding("utf8");`,
  `c.on("data",(d)=>{o+=d});`,
  `c.on("error",()=>{});`,
  `c.on("close",()=>{process.stdout.write(o)});`,
  `process.stdin.setEncoding("utf8");`,
  `process.stdin.on("data",(d)=>{i+=d});`,
  `process.stdin.on("end",()=>{c.write(i.replace(/\\n/g," ")+"\\n")});`,
].join("")

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * The hook command that relays to the session.
 *
 * @internal
 */
export const relayCommand = (execPath: string = process.execPath): string =>
  // In an Electron app or a compiled Bun binary, `execPath` is the app; these make it the runtime, for this command only.
  `ELECTRON_RUN_AS_NODE=1 BUN_BE_BUN=1 ${shellQuote(execPath)} -e ${shellQuote(relayScript)}`

/**
 * The hook command that refuses a tool call.
 *
 * @internal
 */
export const refuseCommand = `echo 'This tool is disabled for this session.' >&2; exit 2`

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Matches the tools by the name a hook sees. Tools in Codex's `collaboration`
 * namespace (multi-agent v2) arrive with the namespace as a prefix.
 *
 * @internal
 */
export const refuseMatcher = (tools: ReadonlyArray<string>): string =>
  `^(collaboration)?(${tools.map(escapeRegex).join("|")})$`

/**
 * The app-server flags for a session's hooks.
 *
 * @internal
 */
export interface Plan {
  readonly flags: ReadonlyArray<string>
  /** How many hooks the flags define, each running one of `commands`. */
  readonly hookCount: number
  readonly commands: ReadonlySet<string>
  /** Whether the session must serve the relay. */
  readonly relay: boolean
}

const toml = (s: string) => JSON.stringify(s)

/**
 * What in `CodexAgent.layer`'s `config` would stop hooks; null if nothing would.
 * That config applies when the thread starts, after hooks are verified, and
 * nothing can check them afterwards. A `hooks` key there stops these ones even
 * if it's empty (verified on 0.162.1).
 *
 * @internal
 */
export const stoppedByConfig = (config: Readonly<Record<string, P.JsonValue>> | undefined): string | null => {
  if (config === undefined) return null
  const features = config["features"]
  const nested = typeof features === "object" && features !== null ? (features as Readonly<Record<string, P.JsonValue>>) : {}
  if (config["features.hooks"] === false || nested["hooks"] === false) return "features.hooks"
  return Object.keys(config).find((key) => key === "hooks" || key.startsWith("hooks.")) ?? null
}

const group = (matcher: string | null, command: string) =>
  `{${matcher !== null ? `matcher=${toml(matcher)},` : ""}hooks=[{type="command",command=${toml(command)}}]}`

/**
 * The flags for `hooks` and the tools to refuse; null if there's nothing to install.
 *
 * @internal
 */
export const plan = (hooks: Hooks | undefined, refused: ReadonlyArray<string>, execPath?: string): Plan | null => {
  const command = relayCommand(execPath)
  const refuse = refused.length > 0 ? [group(refuseMatcher(refused), refuseCommand)] : []
  const before = hooks?.beforeTool !== undefined ? [group("*", command)] : []
  const after = hooks?.afterTool !== undefined ? [group("*", command)] : []
  const stop = hooks?.beforeStop !== undefined ? [group(null, command)] : []
  const relayed = before.length + after.length + stop.length
  if (relayed + refuse.length === 0) return null
  const flag = (event: string, groups: ReadonlyArray<string>) => (groups.length > 0 ? ["-c", `hooks.${event}=[${groups.join(",")}]`] : [])
  return {
    flags: [...flag("PreToolUse", [...refuse, ...before]), ...flag("PostToolUse", after), ...flag("Stop", stop)],
    hookCount: relayed + refuse.length,
    commands: new Set([...(refuse.length > 0 ? [refuseCommand] : []), ...(relayed > 0 ? [command] : [])]),
    relay: relayed > 0,
  }
}

/**
 * The hooks in a `hooks/list` answer that came from the plan's flags.
 *
 * @internal
 */
export const ownHooks = (plan: Plan, listed: P.HooksListResponse): ReadonlyArray<P.HookMetadata> =>
  listed.data.flatMap((entry) => entry.hooks).filter((h) => h.source === "sessionFlags" && h.command !== undefined && plan.commands.has(h.command))

/**
 * The hooks in a `hooks/list` answer that stay off when hooks are off in config:
 * all but the plan's and managed ones, which run regardless, as on Claude.
 *
 * @internal
 */
export const otherHooks = (plan: Plan, listed: P.HooksListResponse): ReadonlyArray<P.HookMetadata> => {
  const own = new Set(ownHooks(plan, listed).map((h) => h.key))
  return listed.data.flatMap((entry) => entry.hooks).filter((h) => !own.has(h.key) && !h.isManaged)
}

/**
 * Turns hooks on for one process, where config has them off.
 *
 * @internal
 */
export const hooksOn: ReadonlyArray<string> = ["-c", "features.hooks=true"]

/**
 * The flags that mark these hooks as trusted, and disable `others`.
 *
 * @internal
 */
export const stateFlags = (own: ReadonlyArray<P.HookMetadata>, others: ReadonlyArray<P.HookMetadata> = []): ReadonlyArray<string> =>
  own.length + others.length === 0
    ? []
    : ["-c", `hooks.state={${[...own.map((h) => `${toml(h.key)}={trusted_hash=${toml(h.currentHash)}}`), ...others.map((h) => `${toml(h.key)}={enabled=false}`)].join(",")}}`]

/**
 * Why Codex wouldn't run the plan's hooks; null if it will. A session whose
 * hooks are skipped would silently run tools it was told to refuse.
 *
 * @internal
 */
export const notRunnable = (plan: Plan, listed: P.HooksListResponse): string | null => {
  const own = ownHooks(plan, listed)
  if (own.length !== plan.hookCount) return `Codex found ${own.length} of effect-agent's ${plan.hookCount} hooks (is a managed policy turning hooks off, or restricting them to managed ones?)`
  const stopped = own.filter((h) => !h.enabled || (h.trustStatus !== "trusted" && h.trustStatus !== "managed"))
  return stopped.length === 0 ? null : `Codex won't run ${stopped.map((h) => `${h.eventName} (${h.enabled ? h.trustStatus : "disabled"})`).join(", ")}`
}

/**
 * The call id of a command that just failed. `PostToolUse` carries no exit
 * code, so `afterTool`'s `isError` comes from this: app-server reports the
 * command's end, with the same id, before it starts the hook.
 *
 * @internal
 */
export const failedCallId = (msg: P.Incoming): string | null => {
  if (msg.method !== "item/completed") return null
  const { item } = msg.params as P.ItemNotification
  return P.isItem(item, "commandExecution") && (item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0)) ? item.id : null
}

const HookCall = Schema.Struct({
  hook_event_name: Schema.String,
  tool_name: Schema.optionalKey(Schema.String),
  tool_use_id: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Unknown),
  tool_response: Schema.optionalKey(Schema.Unknown),
})
const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(HookCall))

const toolResponseText = (response: unknown): string => {
  if (typeof response === "string") return response
  return response === undefined ? "" : JSON.stringify(response)
}

const addContext = (hookEventName: string, additionalContext: string) => ({ hookSpecificOutput: { hookEventName, additionalContext } })

const none = Effect.succeed(Option.none<string>())

/**
 * The JSON to print for one hook call, or "" to add nothing. A hook that
 * fails or defects adds nothing. `consumeFailed` says whether the call's
 * command failed.
 *
 * @internal
 */
export const answer = (hooks: Hooks, line: string, consumeFailed: (callId: string) => boolean): Effect.Effect<string> =>
  Effect.suspend(() => {
    const decoded = decodeCall(line)
    if (Option.isNone(decoded)) return Effect.succeed("")
    const call = decoded.value
    const tool = { callId: call.tool_use_id ?? "", name: call.tool_name ?? "", input: call.tool_input }
    const respond = (hook: Effect.Effect<Option.Option<string>>, output: (text: string) => unknown) =>
      Effect.map(hook, (text) => (Option.isSome(text) && text.value !== "" ? JSON.stringify(output(text.value)) : ""))
    switch (call.hook_event_name) {
      case "PreToolUse":
        return respond(hooks.beforeTool?.(tool) ?? none, (text) => addContext("PreToolUse", text))
      case "PostToolUse":
        return respond(
          hooks.afterTool?.({ ...tool, output: toolResponseText(call.tool_response), isError: consumeFailed(tool.callId) }) ?? none,
          (text) => addContext("PostToolUse", text),
        )
      case "Stop":
        // Not a rejection: Codex continues the turn with `reason` as a prompt.
        return respond(hooks.beforeStop?.() ?? none, (reason) => ({ decision: "block", reason }))
      default:
        return Effect.succeed("")
    }
  }).pipe(Effect.catchCause(() => Effect.succeed("")))

/**
 * Serves the relay for the session's scope, and returns the socket's path. A
 * relay that goes away (Codex stopped the hook) interrupts its call, as the
 * abort signal does on Claude.
 *
 * @internal
 */
export const serve = (hooks: Hooks, consumeFailed: (callId: string) => boolean): Effect.Effect<string, AgentError, Scope.Scope> =>
  Effect.gen(function* () {
    const run = Effect.runForkWith(Context.omit(Tracer.ParentSpan)(yield* Effect.context<never>()))
    return yield* Effect.acquireRelease(
      Effect.callback<{ readonly path: string; readonly stop: () => void }, AgentError>((resume) => {
        const dir = mkdtempSync(join(tmpdir(), "ea-hooks-"))
        const path = join(dir, "s")
        const sockets = new Set<Socket>()
        const server = createServer((socket) => {
          sockets.add(socket)
          let input = ""
          let fiber: Fiber.Fiber<void> | null = null
          socket.setEncoding("utf8")
          socket.on("error", () => {})
          socket.on("close", () => {
            sockets.delete(socket)
            if (fiber !== null) run(Fiber.interrupt(fiber))
          })
          socket.on("data", (data: string) => {
            input += data
            const end = input.indexOf("\n")
            if (end < 0 || fiber !== null) return
            fiber = run(Effect.map(answer(hooks, input.slice(0, end), consumeFailed), (output) => void socket.end(output)))
          })
        })
        const stop = () => {
          server.close()
          for (const socket of sockets) socket.destroy()
          rmSync(dir, { recursive: true, force: true })
        }
        server.once("error", (cause) => {
          stop()
          resume(Effect.fail(new AgentError({ message: `cannot serve hooks on ${path}`, provider: "codex", cause })))
        })
        server.listen(path, () => resume(Effect.succeed({ path, stop })))
      }),
      ({ stop }) => Effect.sync(stop),
    ).pipe(Effect.map(({ path }) => path))
  })
