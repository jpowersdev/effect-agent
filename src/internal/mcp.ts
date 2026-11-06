/**
 * `RunSettings.mcp`: which MCP tool calls a session may make, decided inside
 * the session's own process.
 *
 * Globs are matched with `effect/Glob` against `server/tool`, so a `*` stays
 * within the server or the tool. Both providers name an MCP tool
 * `mcp__<server>__<tool>`, with every character outside `[A-Za-z0-9_-]`
 * replaced by `_` (a claude.ai connector's server is `claude_ai_<Name>`, as
 * `claude_ai_Slack` or `claude_ai_Google_Calendar`). The server ends at the
 * first `__`, as both providers read it. But a server may itself contain `__`,
 * so a name with another `__` after that one could belong to another server:
 * every reading counts. A call is refused if any reading matches a deny glob,
 * or if any reading matches no allow glob.
 *
 * @internal
 */
import { Glob } from "effect"
import type { RunSettings } from "../Agent.ts"

/**
 * The compiled `RunSettings.mcp`.
 *
 * @internal
 */
export interface Policy {
  readonly allow: ReadonlyArray<Glob.Glob>
  readonly deny: ReadonlyArray<Glob.Glob>
}

/**
 * Compiles `RunSettings.mcp`. Wildcards match names that start with `.`, so a
 * deny glob can't be dodged by one.
 *
 * @internal
 */
export const policy = (mcp: NonNullable<RunSettings["mcp"]>): Policy => ({
  allow: mcp.allow.map((pattern) => Glob.make(pattern, { dot: true })),
  deny: (mcp.deny ?? []).map((pattern) => Glob.make(pattern, { dot: true })),
})

/**
 * Whether a provider-native tool name is an MCP tool's.
 *
 * @internal
 */
export const isMcpTool = (name: string): boolean => name.startsWith("mcp__")

/**
 * Every `server/tool` a provider-native name can be read as, the provider's own
 * reading (the server ends at the first `__`) first; empty if it is no MCP
 * tool's, or a server or tool would have a `/` or be `.` or `..` (which a glob
 * can't match as one segment).
 *
 * @example
 * ```ts skip-type-checking
 * readings("mcp__claude_ai_Slack__slack_send_message") // ["claude_ai_Slack/slack_send_message"]
 * readings("mcp__a__b__c") // ["a/b__c", "a__b/c"]
 * ```
 *
 * @internal
 */
export const readings = (name: string): ReadonlyArray<string> => {
  if (!isMcpTool(name)) return []
  const rest = name.slice("mcp__".length)
  if (rest.includes("/")) return []
  const out: Array<string> = []
  for (let at = rest.indexOf("__"); at >= 0; at = rest.indexOf("__", at + 1)) {
    const server = rest.slice(0, at)
    const tool = rest.slice(at + 2)
    if (server !== "" && tool !== "" && !isDots(server) && !isDots(tool)) out.push(`${server}/${tool}`)
  }
  return out
}

const isDots = (segment: string) => segment === "." || segment === ".."

/**
 * Why `policy` refuses a call to the MCP tool `name`, or null if it allows it.
 *
 * @internal
 */
export const refusal = (policy: Policy, name: string): string | null => {
  const names = readings(name)
  if (names.length === 0) return `${name} can't be read as server/tool, so no mcp.allow pattern matches it`
  for (const reading of names) {
    const denied = policy.deny.find((glob) => Glob.match(glob, reading))
    if (denied !== undefined) return `${reading} matches mcp.deny pattern ${denied.pattern}`
  }
  const missing = names.find((reading) => !policy.allow.some((glob) => Glob.match(glob, reading)))
  return missing === undefined ? null : `${missing} is not in mcp.allow`
}

/**
 * What the model gets for a refused call.
 *
 * @internal
 */
export const refusalMessage = (reason: string): string => `This MCP tool call was refused: ${reason}`
