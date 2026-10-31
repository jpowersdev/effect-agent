/**
 * The provider-neutral core: the `Agent` service, its sessions, messages and
 * turns, the event stream, and usage. Providers live in
 * `@jpowersdev/effect-agent/claude` and `@jpowersdev/effect-agent/codex`;
 * sessions that outlive their process in `@jpowersdev/effect-agent/host`.
 *
 * @since 0.1.0
 */

/**
 * The `Agent` service: one provider, and the options for opening a session.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./Agent.ts"

/**
 * A session: one agent process working in one directory.
 *
 * @since 0.3.0
 * @category re-exports
 */
export * from "./AgentSession.ts"

/**
 * A message: input you give a session, and where it went.
 *
 * @since 0.3.0
 * @category re-exports
 */
export * from "./Message.ts"

/**
 * A turn: the agent's work on a message, and how it ended.
 *
 * @since 0.3.0
 * @category re-exports
 */
export * from "./Turn.ts"

/**
 * The normalized event stream.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./AgentEvent.ts"

/**
 * An infrastructure or protocol failure, for anything without a more specific error.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./AgentError.ts"

/**
 * What a turn used: tokens, and what they cost.
 *
 * @since 0.3.0
 * @category re-exports
 */
export * from "./Usage.ts"

/**
 * Usage-limit windows.
 *
 * @since 0.3.0
 * @category re-exports
 */
export * from "./UsageLimit.ts"

/**
 * Control over how agent processes start.
 *
 * @since 0.1.0
 * @category modules
 */
export * as Launcher from "./Launcher.ts"

/**
 * Token prices, for providers that report tokens but not cost (Codex).
 *
 * @since 0.1.0
 * @category modules
 */
export * as Pricing from "./Pricing.ts"

/**
 * Stopping everything an agent started.
 *
 * @since 0.1.0
 * @category modules
 */
export * as ProcessTree from "./ProcessTree.ts"

/**
 * Idle detection shared by the providers.
 *
 * @since 0.1.0
 * @category modules
 */
export * as Watchdog from "./Watchdog.ts"
