// The same entry point on Bun (`EFFECT_AGENT_TEST_HOST=bun`).
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { SessionHost } from "../../src/host/index.ts"

BunRuntime.runMain(SessionHost.run.pipe(Effect.provide(BunServices.layer)))
