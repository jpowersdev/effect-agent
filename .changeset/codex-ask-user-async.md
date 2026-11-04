---
"@jpowersdev/effect-agent": minor
---

`disable.askUser` now stops Codex's asynchronous ask-the-user tools, not just `request_user_input`.

On the gpt-6 family, Codex's catalog offers `request_user_input_async`. It returned `{"accepted":true}` and the turn carried on, so the question went nowhere, and it reached `Text` as if the agent had said it. No Codex switch removes it, so a call is now refused, and the session's instructions tell the model not to ask. The model still sees the tool. Its sibling `send_message_to_user_async`, which Codex offers only with a feature on, is switched off and refused too.

This makes `disable.askUser` depend on hooks on Codex, as `disable.subagents` already does:

- The first `open` per layer starts an extra `codex app-server`, about 250 ms here. A refusal runs no process unless the tool is called.
- `open` now fails where a managed policy stops hooks, or where `CodexAgent.layer({ config })` would, for a session that sets `disable.askUser`. That includes a detached session, whose host otherwise opens without hooks. A session that can't accept this has to leave `askUser` unset, and the model may then ask questions that go nowhere.
