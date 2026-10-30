// The session host entry used by tests and scripts, as a consumer would write one.
import { NodeRuntime } from "@effect/platform-node"
import { SessionHost } from "../../src/host/index.ts"

NodeRuntime.runMain(SessionHost.run)
