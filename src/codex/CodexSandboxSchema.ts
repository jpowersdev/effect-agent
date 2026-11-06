/**
 * `CodexAgent.CodexSandbox`, kept apart from `CodexAgent` so `HostSpec` can
 * decode it without loading the Codex provider.
 *
 * @internal
 */
import { Schema } from "effect"

/** @internal */
export const CodexSandbox = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("danger-full-access") }),
  Schema.Struct({
    mode: Schema.Literals(["workspace-write", "read-only"]),
    mcpServerTools: Schema.Literals(["approve", "refuse"]),
  }),
])
