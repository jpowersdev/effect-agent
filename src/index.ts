/**
 * The provider-neutral core: the `Agent` service and its sessions, the event
 * stream, how turns end, and the shared value types. Providers live in
 * `@jpowersdev/effect-agent/claude` and `@jpowersdev/effect-agent/codex`;
 * sessions that outlive their process in `@jpowersdev/effect-agent/host`.
 *
 * @since 0.1.0
 */

/**
 * Provider-neutral coding agent: the `Agent` service, sessions and run options.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./Agent.ts"

/**
 * How a turn can end, as Schema-described tagged errors.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./AgentError.ts"

/**
 * The normalized event stream.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./AgentEvent.ts"

/**
 * Shared value types: ids, token usage, cost and usage-limit windows.
 *
 * @since 0.1.0
 * @category re-exports
 */
export * from "./Domain.ts"

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
