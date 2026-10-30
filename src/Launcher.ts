/**
 * Control over how agent processes start. Optional: without a `Launcher`,
 * commands run as-is. Provide one to wrap each agent process, e.g. in a
 * systemd scope (`examples/SystemdLauncher.ts` in the repository), so that
 * stopping the session also stops whatever its commands left running, under
 * resource limits.
 *
 * When the session's Scope closes, the agent process and everything it
 * started are stopped (see `ProcessTree`). A cgroup launcher is the stronger
 * guarantee: it also catches commands that cleared their environment, and
 * works on platforms without /proc.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, type Scope } from "effect"
import type { AgentError } from "./AgentError.ts"

/**
 * @since 0.1.0
 * @category models
 */
export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * Passed to `Launcher.prepare` for each agent process.
 *
 * @since 0.1.0
 * @category models
 */
export interface LaunchContext {
  readonly provider: string
  readonly cwd: string
}

/**
 * Must be pure: providers may apply it synchronously at spawn time.
 *
 * @since 0.1.0
 * @category models
 */
export type Wrap = (command: Command) => Command

/**
 * @since 0.1.0
 * @category services
 */
export class Launcher extends Context.Service<
  Launcher,
  {
    /**
     * Called once per agent process, before it starts, in the session's
     * Scope (so it can create resources, such as temp files, released when
     * the session ends).
     */
    readonly prepare: (context: LaunchContext) => Effect.Effect<Wrap, AgentError, Scope.Scope>
  }
>()("effect-agent/Launcher") {}

/**
 * A `Launcher` layer from its `prepare` function.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (prepare: Launcher["Service"]["prepare"]): Layer.Layer<Launcher> =>
  Layer.succeed(Launcher, { prepare })

const identity: Wrap = (command) => command

/**
 * The wrap to use: the provided `Launcher`'s, or none.
 *
 * @since 0.1.0
 * @category utils
 */
export const prepare = (context: LaunchContext): Effect.Effect<Wrap, AgentError, Scope.Scope> =>
  Effect.serviceOption(Launcher).pipe(
    Effect.flatMap((launcher) =>
      launcher._tag === "Some" ? launcher.value.prepare(context) : Effect.succeed(identity),
    ),
  )
