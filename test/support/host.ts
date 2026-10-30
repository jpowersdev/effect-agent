// A consumer's host entry point, as the README shows it.
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { SessionHost } from "../../src/host/index.ts"

NodeRuntime.runMain(SessionHost.run.pipe(Effect.provide(NodeServices.layer)))
