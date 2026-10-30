/**
 * What a host process is started with, and where hosts live on disk.
 *
 * A `HostSpec` is everything needed to rebuild a provider layer and open one
 * session in another process, so it is plain data: provider-layer options
 * that serialize, `RunOptions` without hooks (durations as strings such as
 * `"30 seconds"` or millis), and the host's own settings.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Duration, Layer, Option, Schema } from "effect"
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Effort, type RunOptions } from "../Agent.ts"
import { AgentError, SessionNotFound } from "../AgentError.ts"
import { SessionId } from "../Domain.ts"
import * as ClaudeAgent from "../claude/ClaudeAgent.ts"
import * as ClaudeReplay from "../claude/ClaudeReplay.ts"
import * as ClaudeSdk from "../claude/ClaudeSdk.ts"
import * as CodexAgent from "../codex/CodexAgent.ts"
import * as CodexAppServer from "../codex/CodexAppServer.ts"
import * as CodexReplay from "../codex/CodexReplay.ts"

/** A duration as `Duration` input text (`"30 seconds"`) or millis. */
export const DurationSpec = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.check(Schema.makeFilter((u: string | number) => Option.isSome(Duration.fromInput(u as Duration.Input)))),
)
export type DurationSpec = typeof DurationSpec.Type

/** `null` removes the variable (as `undefined` does in `RunOptions.env`). */
export const EnvSpec = Schema.Record(Schema.String, Schema.NullOr(Schema.String))
export type EnvSpec = typeof EnvSpec.Type

/** The serializable part of `ClaudeAgentOptions`. */
export const ClaudeOptionsSpec = Schema.Struct({
  settingSources: Schema.optionalKey(Schema.Array(Schema.Literals(["user", "project", "local"]))),
  pathToClaudeCodeExecutable: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  checkResume: Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(EnvSpec),
  stallGrace: Schema.optionalKey(DurationSpec),
})
export type ClaudeOptionsSpec = typeof ClaudeOptionsSpec.Type

const ModelPrice = Schema.Struct({
  input: Schema.Number,
  cachedInput: Schema.optionalKey(Schema.Number),
  output: Schema.Number,
  reasoning: Schema.optionalKey(Schema.Number),
})

/** `CodexAgentOptions` plus the serializable `CodexAppServer` options. */
export const CodexOptionsSpec = Schema.Struct({
  pricing: Schema.optionalKey(Schema.Record(Schema.String, ModelPrice)),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  stallGrace: Schema.optionalKey(DurationSpec),
  codexPath: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  forceKillAfter: Schema.optionalKey(DurationSpec),
})
export type CodexOptionsSpec = typeof CodexOptionsSpec.Type

/** `RunOptions` without `hooks`. */
export const RunSpec = Schema.Struct({
  cwd: Schema.String,
  env: Schema.optionalKey(EnvSpec),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  appendSystemPrompt: Schema.optionalKey(Schema.String),
  disable: Schema.optionalKey(
    Schema.Struct({
      askUser: Schema.optionalKey(Schema.Boolean),
      subagents: Schema.optionalKey(Schema.Boolean),
      tools: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  spendCapUsd: Schema.optionalKey(Schema.Number),
  resume: Schema.optionalKey(SessionId),
  watchdog: Schema.optionalKey(
    Schema.Struct({
      idle: DurationSpec,
      toolIdle: Schema.optionalKey(DurationSpec),
      grace: Schema.optionalKey(DurationSpec),
    }),
  ),
})
export type RunSpec = typeof RunSpec.Type

export const Provider = Schema.Literals(["claude", "codex"])
export type Provider = typeof Provider.Type

/** Provider-layer settings shared by `RemoteAgent.layer` and the host. */
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
export type ProviderSpec = typeof ProviderSpec.Type

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
export type HostSpec = typeof HostSpec.Type

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** `$XDG_RUNTIME_DIR/effect-agent`, or `<tmpdir>/effect-agent-<uid>`. */
export const defaultDir = (): string => {
  const runtime = process.env["XDG_RUNTIME_DIR"]
  if (runtime !== undefined && runtime !== "") return join(runtime, "effect-agent")
  return join(tmpdir(), `effect-agent-${process.getuid?.() ?? "user"}`)
}

/** Create `dir` (mode 0700), or make an existing one 0700: it holds sockets and full transcripts. */
export const ensureDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

export const socketPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.sock`)
export const manifestPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.json`)
export const logPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.log`)
export const eventsPath = (dir: string, sessionId: string) => join(dir, `${sessionId}.events.jsonl`)

export const Manifest = Schema.Struct({
  sessionId: SessionId,
  provider: Provider,
  socket: Schema.String,
  /** The host process's pid. */
  pid: Schema.Number,
  cwd: Schema.String,
  startedAt: Schema.DateTimeUtcFromMillis,
})
export type Manifest = typeof Manifest.Type

// ---------------------------------------------------------------------------
// Readiness: one JSON line on the host's stdout
// ---------------------------------------------------------------------------

export const Ready = Schema.TaggedStruct("Ready", {
  sessionId: SessionId,
  socket: Schema.String,
  pid: Schema.Number,
})

export const ReadyLine = Schema.Union([
  Ready,
  Schema.TaggedStruct("Failed", { error: Schema.Union([SessionNotFound, AgentError]) }),
])
export type ReadyLine = typeof ReadyLine.Type

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

const toEnv = (env: EnvSpec): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v ?? undefined]))

const fromEnv = (env: Readonly<Record<string, string | undefined>>): EnvSpec =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v ?? null]))

const millis = (input: Duration.Input): number => Duration.toMillis(Duration.fromInputUnsafe(input))

/** A validated `DurationSpec` as a `Duration`. */
export const toDuration = (spec: DurationSpec): Duration.Duration => Duration.fromInputUnsafe(spec as Duration.Input)

/** `RunOptions` -> `RunSpec`. `hooks` are dropped (check for them first: functions can't cross processes). */
export const fromRunOptions = (run: RunOptions): RunSpec => {
  return {
    cwd: run.cwd,
    ...(run.env !== undefined && { env: fromEnv(run.env) }),
    ...(run.model !== undefined && { model: run.model }),
    ...(run.effort !== undefined && { effort: run.effort }),
    ...(run.appendSystemPrompt !== undefined && { appendSystemPrompt: run.appendSystemPrompt }),
    ...(run.disable !== undefined && {
      disable: {
        ...(run.disable.askUser !== undefined && { askUser: run.disable.askUser }),
        ...(run.disable.subagents !== undefined && { subagents: run.disable.subagents }),
        ...(run.disable.tools !== undefined && { tools: [...run.disable.tools] }),
      },
    }),
    ...(run.spendCapUsd !== undefined && { spendCapUsd: run.spendCapUsd }),
    ...(run.resume !== undefined && { resume: run.resume }),
    ...(run.watchdog !== undefined && {
      watchdog: {
        idle: millis(run.watchdog.idle),
        ...(run.watchdog.toolIdle !== undefined && { toolIdle: millis(run.watchdog.toolIdle) }),
        ...(run.watchdog.grace !== undefined && { grace: millis(run.watchdog.grace) }),
      },
    }),
  }
}

export const toRunOptions = (run: RunSpec): RunOptions => ({
  cwd: run.cwd,
  ...(run.env !== undefined && { env: toEnv(run.env) }),
  ...(run.model !== undefined && { model: run.model }),
  ...(run.effort !== undefined && { effort: run.effort }),
  ...(run.appendSystemPrompt !== undefined && { appendSystemPrompt: run.appendSystemPrompt }),
  ...(run.disable !== undefined && { disable: run.disable }),
  ...(run.spendCapUsd !== undefined && { spendCapUsd: run.spendCapUsd }),
  ...(run.resume !== undefined && { resume: run.resume }),
  ...(run.watchdog !== undefined && {
    watchdog: {
      idle: toDuration(run.watchdog.idle),
      ...(run.watchdog.toolIdle !== undefined && { toolIdle: toDuration(run.watchdog.toolIdle) }),
      ...(run.watchdog.grace !== undefined && { grace: toDuration(run.watchdog.grace) }),
    },
  }),
})

const claudeOptions = (spec: ClaudeOptionsSpec = {}): ClaudeAgent.ClaudeAgentOptions => ({
  ...(spec.settingSources !== undefined && { settingSources: spec.settingSources }),
  ...(spec.pathToClaudeCodeExecutable !== undefined && { pathToClaudeCodeExecutable: spec.pathToClaudeCodeExecutable }),
  ...(spec.model !== undefined && { model: spec.model }),
  ...(spec.checkResume !== undefined && { checkResume: spec.checkResume }),
  ...(spec.env !== undefined && { env: toEnv(spec.env) }),
  ...(spec.stallGrace !== undefined && { stallGrace: toDuration(spec.stallGrace) }),
})

/** The real (or replayed) provider `Agent` layer for a spec, with no `Launcher`. */
export const providerLayer = (spec: ProviderSpec): Layer.Layer<Agent> => {
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
        }).pipe(Layer.provide(NodeServices.layer))
  return CodexAgent.layer({
    ...(codex.pricing !== undefined && { pricing: codex.pricing }),
    ...(codex.config !== undefined && { config: codex.config }),
    ...(codex.stallGrace !== undefined && { stallGrace: toDuration(codex.stallGrace) }),
  }).pipe(Layer.provide(server))
}
