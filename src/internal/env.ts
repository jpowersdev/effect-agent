/**
 * The environment an agent process starts with: the host's, minus the
 * variables a parent agent session sets (which would make the child think it
 * is nested), plus `RunOptions.env`.
 *
 * @internal
 */

/**
 * Variables a parent Claude Code or Codex session sets. Credentials such as
 * `CLAUDE_CODE_OAUTH_TOKEN` are not markers: they pass through.
 *
 * @internal
 */
export const nestingMarkers: ReadonlyArray<string> = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
]

const markers: ReadonlySet<string> = new Set(nestingMarkers)

/** @internal */
export const isNestingMarker = (name: string): boolean => markers.has(name)

/** @internal */
export type Env = Readonly<Record<string, string | undefined>>

/**
 * Overrides to apply over `host` (for spawners that extend the host env):
 * each nesting marker `host` has, removed (`undefined`), then `overrides`.
 *
 * @internal
 */
export const overrides = (host: Env, overrides: Env = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {}
  for (const name of Object.keys(host)) if (isNestingMarker(name)) env[name] = undefined
  return { ...env, ...overrides }
}

/**
 * The whole environment (for spawners that replace it): `host` with the
 * nesting markers removed and `overrides` applied (`undefined` removes).
 *
 * @internal
 */
export const resolve = (host: Env, extra: Env = {}): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries({ ...host, ...overrides(host, extra) })) {
    if (value !== undefined) out[name] = value
  }
  return out
}

/**
 * The process environment, where there is one.
 *
 * @internal
 */
export const host = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {}
