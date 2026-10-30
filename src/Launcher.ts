/**
 * Control over how agent processes start. Optional: without a `Launcher`,
 * commands run as-is. Provide one to wrap each agent process, e.g. in a
 * systemd scope so stopping the run also stops whatever its commands left
 * running:
 *
 *   Launcher.layer(({ provider }) =>
 *     Effect.succeed((cmd) => ({
 *       command: "systemd-run",
 *       args: ["--user", "--scope", "--quiet", `--unit=agent-${provider}-${crypto.randomUUID()}.scope`, "--", cmd.command, ...cmd.args],
 *     })),
 *   )
 *
 * When the session's Scope closes, the agent process and everything it
 * started are stopped (see `ProcessTree`). Use a cgroup launcher like the one
 * above for a guarantee: it also catches commands that cleared their
 * environment, and works on platforms without /proc.
 */
import { Context, Effect, Layer, type Scope } from "effect"
import type { AgentError } from "./AgentError.ts"

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export interface LaunchContext {
  readonly provider: string
  readonly cwd: string
}

/** Must be pure: providers may apply it synchronously at spawn time. */
export type Wrap = (command: Command) => Command

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

export const layer = (prepare: Launcher["Service"]["prepare"]): Layer.Layer<Launcher> =>
  Layer.succeed(Launcher, { prepare })

const identity: Wrap = (command) => command

/** The wrap to use: the provided `Launcher`'s, or none. */
export const prepare = (context: LaunchContext): Effect.Effect<Wrap, AgentError, Scope.Scope> =>
  Effect.serviceOption(Launcher).pipe(
    Effect.flatMap((launcher) =>
      launcher._tag === "Some" ? launcher.value.prepare(context) : Effect.succeed(identity),
    ),
  )
