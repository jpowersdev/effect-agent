---
"@jpowersdev/effect-agent": minor
---

Rename `RemoteAgent` to `DetachedAgent`. "Remote" read as hosting on another machine; the sessions are local processes detached from the one that opened them, which `onScopeClose: "detach"` already called them. `RemoteAgentOptions` is now `DetachedAgentOptions` and `RemoteSession` is now `DetachedSession`. The behavior is unchanged, and there is no alias for the old names: replace `RemoteAgent` with `DetachedAgent` in imports from `@jpowersdev/effect-agent/host`.
