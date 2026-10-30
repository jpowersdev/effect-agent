/**
 * The Codex provider: an `Agent` backed by `codex app-server`, its transport,
 * the frame-to-event mapping, and a transport that replays recordings.
 *
 * @since 0.1.0
 */

/**
 * `Agent` backed by `codex app-server`, one process per session.
 *
 * @since 0.1.0
 * @category modules
 */
export * as CodexAgent from "./CodexAgent.ts"

/**
 * Transport for `codex app-server`: newline-delimited JSON-RPC on stdio.
 *
 * @since 0.1.0
 * @category modules
 */
export * as CodexAppServer from "./CodexAppServer.ts"

/**
 * Pure mapping from app-server frames to `AgentEvent`s. Internal: exported
 * for the tests, and left out of the API reference.
 *
 * @since 0.1.0
 * @category modules
 */
export * as CodexEvents from "./CodexEvents.ts"

/**
 * A `CodexAppServer` that replays a recorded session with no process.
 *
 * @since 0.1.0
 * @category modules
 */
export * as CodexReplay from "./CodexReplay.ts"
