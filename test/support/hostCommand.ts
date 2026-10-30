import { fileURLToPath } from "node:url"

/** Starts `test/support/host.ts`, the way a consumer points `RemoteAgent.layer({ host })` at its own entry. */
export const host = { command: process.execPath, args: [fileURLToPath(new URL("./host.ts", import.meta.url))] }
