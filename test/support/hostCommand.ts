import { fileURLToPath } from "node:url"

const entry = (name: string) => fileURLToPath(new URL(name, import.meta.url))

/**
 * Starts `test/support/host.ts`, the way a consumer points `DetachedAgent.layer({ host })`
 * at its own entry; with `EFFECT_AGENT_TEST_HOST=bun`, `host-bun.ts` under Bun.
 */
export const host =
  process.env["EFFECT_AGENT_TEST_HOST"] === "bun"
    ? { command: "bun", args: [entry("./host-bun.ts")] }
    : { command: process.execPath, args: [entry("./host.ts")] }
