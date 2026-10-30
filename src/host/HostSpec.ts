/**
 * What a host process is started with, and where hosts live on disk.
 *
 * A `HostSpec` is everything needed to rebuild a provider layer and open one
 * session in another process, so it is plain data: provider-layer options
 * that serialize, `RunSettings` (`RunOptions` without hooks), and the host's
 * own settings. Durations are encoded as millis.
 *
 * @since 0.1.0
 */
import { Duration, Layer, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, RunSettings } from "../Agent.ts"
import { AgentError, SessionNotFound } from "../AgentError.ts"
import { DurationInput, EnvOverrides, SessionId } from "../Domain.ts"
import * as ClaudeAgent from "../claude/ClaudeAgent.ts"
import * as ClaudeReplay from "../claude/ClaudeReplay.ts"
import * as ClaudeSdk from "../claude/ClaudeSdk.ts"
import * as CodexAgent from "../codex/CodexAgent.ts"
import * as CodexAppServer from "../codex/CodexAppServer.ts"
import * as CodexReplay from "../codex/CodexReplay.ts"
import type { JsonValue } from "../codex/protocol.ts"

/**
 * A duration: `Duration` input text (`"30 seconds"`) or millis. Encoded as millis.
 *
 * @since 0.1.0
 * @category models
 */
export const DurationSpec = DurationInput
/**
 * @since 0.1.0
 * @category models
 */
export type DurationSpec = typeof DurationSpec.Type

/**
 * Environment overrides; encoded with `null` where `RunOptions.env` has `undefined` (removes the variable).
 *
 * @since 0.1.0
 * @category models
 */
export const EnvSpec = EnvOverrides
/**
 * @since 0.1.0
 * @category models
 */
export type EnvSpec = typeof EnvSpec.Type

/**
 * The serializable part of `ClaudeAgentOptions`.
 *
 * @since 0.1.0
 * @category models
 */
export const ClaudeOptionsSpec = Schema.Struct({
  settingSources: Schema.optionalKey(Schema.Array(Schema.Literals(["user", "project", "local"]))),
  pathToClaudeCodeExecutable: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  checkResume: Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(EnvSpec),
  stallGrace: Schema.optionalKey(DurationSpec),
})
/**
 * @since 0.1.0
 * @category models
 */
export type ClaudeOptionsSpec = typeof ClaudeOptionsSpec.Type

const ModelPrice = Schema.Struct({
  input: Schema.Number,
  cachedInput: Schema.optionalKey(Schema.Number),
  output: Schema.Number,
  reasoning: Schema.optionalKey(Schema.Number),
})

/**
 * `CodexAgentOptions` plus the serializable `CodexAppServer` options.
 *
 * @since 0.1.0
 * @category models
 */
export const CodexOptionsSpec = Schema.Struct({
  pricing: Schema.optionalKey(Schema.Record(Schema.String, ModelPrice)),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  stallGrace: Schema.optionalKey(DurationSpec),
  codexPath: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  forceKillAfter: Schema.optionalKey(DurationSpec),
})
/**
 * @since 0.1.0
 * @category models
 */
export type CodexOptionsSpec = typeof CodexOptionsSpec.Type

/**
 * `RunOptions` without `hooks`: `RunSettings`.
 *
 * @since 0.1.0
 * @category models
 */
export const RunSpec = RunSettings
/**
 * @since 0.1.0
 * @category models
 */
export type RunSpec = RunSettings

/**
 * The provider a host runs a session with.
 *
 * @since 0.1.0
 * @category models
 */
export const Provider = Schema.Literals(["claude", "codex"])
/**
 * @since 0.1.0
 * @category models
 */
export type Provider = typeof Provider.Type

/**
 * Provider-layer settings shared by `RemoteAgent.layer` and the host.
 *
 * @since 0.1.0
 * @category models
 */
export const ProviderSpec = Schema.Struct({
  provider: Provider,
  claude: Schema.optionalKey(ClaudeOptionsSpec),
  codex: Schema.optionalKey(CodexOptionsSpec),
  /**
   * Tests: play back this recording (a fixture path) through the provider's
   * replay transport instead of running the CLI.
   */
  replay: Schema.optionalKey(Schema.String),
  /** Claude replays: `ClaudeReplay.ReplayOptions.knownSessions`. */
  replayKnownSessions: Schema.optionalKey(Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)])),
  /** Tests, Claude replays: append each replayed hook call (`ClaudeReplay.ReplayedHook`) to this file as a JSON line. */
  replayHookLog: Schema.optionalKey(Schema.String),
})
/**
 * @since 0.1.0
 * @category models
 */
export type ProviderSpec = typeof ProviderSpec.Type

/**
 * What a host process is started with: `ProviderSpec`, the session's `RunSpec`, and the host's own settings.
 *
 * @since 0.1.0
 * @category models
 */
export const HostSpec = Schema.Struct({
  ...ProviderSpec.fields,
  run: RunSpec,
  /** Where the socket, manifest and log go. */
  dir: Schema.String,
  /**
   * Events kept in memory for `subscribeFrom` (a ring buffer). With
   * `persistEvents` this is only a cache in front of the events file.
   * Default 50 000.
   */
  maxEvents: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))),
  /** Append every event to `<dir>/<sessionId>.events.jsonl`. Default true. */
  persistEvents: Schema.optionalKey(Schema.Boolean),
  /** How long events files are kept after their host exits (for pruning at startup). Default 24 hours. */
  retainEvents: Schema.optionalKey(DurationSpec),
  /**
   * Internal, tests only: drop every client connection right before replying
   * to the first call of each of these RPCs (after the host has acted on it).
   */
  testDropBeforeReply: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Internal, tests only: serve the `TestInvokeHook` RPC. */
  testInvokeHook: Schema.optionalKey(Schema.Boolean),
  /** End an idle session no client has been attached to for this long. Default 30 minutes. */
  orphanTimeout: Schema.optionalKey(DurationSpec),
  /** How long to keep serving after the session ends, for clients to read the last events. Default 5 seconds. */
  linger: Schema.optionalKey(DurationSpec),
})
/**
 * @since 0.1.0
 * @category models
 */
export type HostSpec = typeof HostSpec.Type

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * `$XDG_RUNTIME_DIR/effect-agent`, or `<tmpdir>/effect-agent-<uid>`.
 *
 * @since 0.1.0
 * @category utils
 */
export const defaultDir = (): string => {
  const runtime = process.env["XDG_RUNTIME_DIR"]
  if (runtime !== undefined && runtime !== "") return join(runtime, "effect-agent")
  return join(tmpdir(), `effect-agent-${process.getuid?.() ?? "user"}`)
}

/**
 * Create `dir` (mode 0700), or make an existing one 0700: it holds sockets and full transcripts.
 *
 * @internal
 */
export const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/**
 * The session's unix socket in `dir`.
 *
 * @since 0.1.0
 * @category utils
 */
export const socketPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.sock`)
/**
 * The session's `Manifest` file in `dir`.
 *
 * @since 0.1.0
 * @category utils
 */
export const manifestPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.json`)
/**
 * The session's host log in `dir`.
 *
 * @since 0.1.0
 * @category utils
 */
export const logPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.log`)
/**
 * The session's events file in `dir`.
 *
 * @since 0.1.0
 * @category utils
 */
export const eventsPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.events.jsonl`)

/**
 * What a running host records in `<dir>/<sessionId>.json`, for `attach` and `list` to find it.
 *
 * @since 0.1.0
 * @category models
 */
export const Manifest = Schema.Struct({
  sessionId: SessionId,
  provider: Provider,
  socket: Schema.String,
  /** The host process's pid. */
  pid: Schema.Number,
  cwd: Schema.String,
  startedAt: Schema.DateTimeUtcFromMillis,
})
/**
 * @since 0.1.0
 * @category models
 */
export type Manifest = typeof Manifest.Type

// ---------------------------------------------------------------------------
// Readiness: one JSON line on the host's stdout
// ---------------------------------------------------------------------------

/**
 * The host opened its session and is serving it on `socket`.
 *
 * @internal
 */
export const Ready = Schema.TaggedStruct("Ready", {
  sessionId: SessionId,
  socket: Schema.String,
  pid: Schema.Number,
})

/**
 * The one line a host writes to stdout: `Ready`, or `Failed` with the error opening the session.
 *
 * @internal
 */
export const ReadyLine = Schema.Union([
  Ready,
  Schema.TaggedStruct("Failed", { error: Schema.Union([SessionNotFound, AgentError]) }),
])
/** @internal */
export type ReadyLine = typeof ReadyLine.Type

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/**
 * A validated `DurationSpec` as a `Duration`.
 *
 * @internal
 */
export const toDuration = (spec: DurationSpec): Duration.Duration => Duration.fromInputUnsafe(spec)

const claudeOptions = (spec: ClaudeOptionsSpec = {}): ClaudeAgent.ClaudeAgentOptions => ({
  ...(spec.settingSources !== undefined && { settingSources: spec.settingSources }),
  ...(spec.pathToClaudeCodeExecutable !== undefined && { pathToClaudeCodeExecutable: spec.pathToClaudeCodeExecutable }),
  ...(spec.model !== undefined && { model: spec.model }),
  ...(spec.checkResume !== undefined && { checkResume: spec.checkResume }),
  ...(spec.env !== undefined && { env: spec.env }),
  ...(spec.stallGrace !== undefined && { stallGrace: toDuration(spec.stallGrace) }),
})

/**
 * The real (or replayed) provider `Agent` layer for a spec, with no
 * `Launcher`. Codex spawns its app-server through the platform's
 * `ChildProcessSpawner` (`NodeServices.layer`, `BunServices.layer`).
 *
 * @internal
 */
export const providerLayer = (spec: ProviderSpec): Layer.Layer<Agent, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const replay = spec.replay
  if (spec.provider === "claude") {
    const sdk =
      replay !== undefined
        ? ClaudeReplay.layerFile(replay, {
            ...(spec.replayKnownSessions !== undefined && { knownSessions: spec.replayKnownSessions }),
            ...(spec.replayHookLog !== undefined && {
              onHook: (call: ClaudeReplay.ReplayedHook) => appendFileSync(spec.replayHookLog!, `${JSON.stringify(call)}\n`),
            }),
          })
        : ClaudeSdk.layer()
    return ClaudeAgent.layer(claudeOptions(spec.claude)).pipe(Layer.provide(sdk))
  }
  const codex = spec.codex ?? {}
  const server =
    replay !== undefined
      ? Layer.suspend(() => CodexReplay.layer(readFileSync(replay, "utf8")))
      : CodexAppServer.layer({
          ...(codex.codexPath !== undefined && { codexPath: codex.codexPath }),
          ...(codex.args !== undefined && { args: codex.args }),
          ...(codex.forceKillAfter !== undefined && { forceKillAfter: toDuration(codex.forceKillAfter) }),
        })
  return CodexAgent.layer({
    ...(codex.pricing !== undefined && { pricing: codex.pricing }),
    // Decoded from the JSON spec, so the values are JSON.
    ...(codex.config !== undefined && { config: codex.config as Readonly<Record<string, JsonValue>> }),
    ...(codex.stallGrace !== undefined && { stallGrace: toDuration(codex.stallGrace) }),
  }).pipe(Layer.provide(server))
}
