---
"@jpowersdev/effect-agent": minor
---

Split the core into one module per concept, matching the vocabulary on the getting-started page: `AgentSession` (`AgentSession`, `SessionId` and the session errors), `Message` (`MessageId`, `Input`, `SteerOutcome`), `Turn` (`TurnId`, `TurnSucceeded`, the `TurnFailure` errors, `TurnOutcome`), `Usage` (`TokenUsage`, `Cost`) and `UsageLimit` (`LimitWindow`, `LimitWindowStatus`). `Domain` is gone, and `AgentError` now holds only `AgentError`. Everything is still exported flat from `@jpowersdev/effect-agent`, so imports don't change, except that `DurationInput` and `EnvOverrides` are no longer exported: they only carried `RunSettings` and `HostSpec` across a process boundary.
