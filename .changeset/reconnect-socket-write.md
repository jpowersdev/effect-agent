---
"@jpowersdev/effect-agent": patch
---

`RemoteAgent`: a call or subscription that writes to its host connection just as it drops now reconnects and resumes, instead of dying with a `SocketError`.
