/**
 * The provider `Agent` layer for a `ProviderSpec`, imported when it is
 * built: a process that runs Codex sessions doesn't load the Claude SDK, and
 * the other way round.
 *
 * @internal
 */
import { Effect, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { appendFileSync, readFileSync } from "node:fs"
import type { Agent } from "../Agent.ts"
import type { ClaudeAgentOptions } from "../claude/ClaudeAgent.ts"
import type { ReplayedHook } from "../claude/ClaudeReplay.ts"
import type { JsonValue } from "../codex/protocol.ts"
import { type ClaudeOptionsSpec, type ProviderSpec, toDuration } from "./HostSpec.ts"

const claudeOptions = (spec: ClaudeOptionsSpec = {}): ClaudeAgentOptions => ({
  ...(spec.settingSources !== undefined && { settingSources: spec.settingSources }),
  ...(spec.pathToClaudeCodeExecutable !== undefined && { pathToClaudeCodeExecutable: spec.pathToClaudeCodeExecutable }),
  ...(spec.model !== undefined && { model: spec.model }),
  ...(spec.checkResume !== undefined && { checkResume: spec.checkResume }),
  ...(spec.env !== undefined && { env: spec.env }),
  ...(spec.stallGrace !== undefined && { stallGrace: toDuration(spec.stallGrace) }),
})

const claude = (spec: ProviderSpec) =>
  Effect.promise(async () => {
    const [ClaudeAgent, ClaudeReplay, ClaudeSdk] = await Promise.all([
      import("../claude/ClaudeAgent.ts"),
      import("../claude/ClaudeReplay.ts"),
      import("../claude/ClaudeSdk.ts"),
    ])
    const replay = spec.replay
    const sdk =
      replay !== undefined
        ? ClaudeReplay.layerFile(replay, {
            ...(spec.replayKnownSessions !== undefined && { knownSessions: spec.replayKnownSessions }),
            ...(spec.replayHookLog !== undefined && {
              onHook: (call: ReplayedHook) => appendFileSync(spec.replayHookLog!, `${JSON.stringify(call)}\n`),
            }),
          })
        : ClaudeSdk.layer()
    return ClaudeAgent.layer(claudeOptions(spec.claude)).pipe(Layer.provide(sdk))
  })

const codex = (spec: ProviderSpec) =>
  Effect.promise(async () => {
    const [CodexAgent, CodexAppServer, CodexReplay] = await Promise.all([
      import("../codex/CodexAgent.ts"),
      import("../codex/CodexAppServer.ts"),
      import("../codex/CodexReplay.ts"),
    ])
    const options = spec.codex ?? {}
    const replay = spec.replay
    const server =
      replay !== undefined
        ? Layer.suspend(() => CodexReplay.layer(readFileSync(replay, "utf8")))
        : CodexAppServer.layer({
            ...(options.codexPath !== undefined && { codexPath: options.codexPath }),
            ...(options.args !== undefined && { args: options.args }),
            ...(options.forceKillAfter !== undefined && { forceKillAfter: toDuration(options.forceKillAfter) }),
          })
    return CodexAgent.layer({
      ...(options.pricing !== undefined && { pricing: options.pricing }),
      // Decoded from the JSON spec, so the values are JSON.
      ...(options.config !== undefined && { config: options.config as Readonly<Record<string, JsonValue>> }),
      ...(options.stallGrace !== undefined && { stallGrace: toDuration(options.stallGrace) }),
    }).pipe(Layer.provide(server))
  })

/**
 * The real (or replayed) provider `Agent` layer for a spec, with no
 * `Launcher`. Codex spawns its app-server through the platform's
 * `ChildProcessSpawner` (`NodeServices.layer`, `BunServices.layer`).
 *
 * @internal
 */
export const providerLayer = (spec: ProviderSpec): Layer.Layer<Agent, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.unwrap(spec.provider === "claude" ? claude(spec) : codex(spec))
