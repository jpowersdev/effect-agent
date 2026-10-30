/**
 * The Claude Code provider: an `Agent` backed by
 * `@anthropic-ai/claude-agent-sdk`, its transport, and a transport that
 * replays recordings.
 *
 * @since 0.1.0
 */

/**
 * `Agent` backed by Claude Code.
 *
 * @since 0.1.0
 * @category modules
 */
export * as ClaudeAgent from "./ClaudeAgent.ts"

/**
 * `ClaudeSdk` without a process: plays back a JSONL recording.
 *
 * @since 0.1.0
 * @category modules
 */
export * as ClaudeReplay from "./ClaudeReplay.ts"

/**
 * Transport for Claude Code: one SDK `query()` as an Effect service.
 *
 * @since 0.1.0
 * @category modules
 */
export * as ClaudeSdk from "./ClaudeSdk.ts"
