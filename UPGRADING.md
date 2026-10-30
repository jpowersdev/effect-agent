# Upgrading Claude Code and Codex

effect-agent drives two CLIs, and each release can change something we depend on: protocol methods and fields, message shapes, error classification, steering semantics. This is the routine for taking a new release of either one. It ends with a branch where the pins, `src/codex/protocol.ts`, the fixtures and the tests all agree with the new CLI.

## What is pinned where

| | Pinned by | Recorded in |
| --- | --- | --- |
| Claude Code | the exact `@anthropic-ai/claude-agent-sdk` version in `package.json`. The SDK bundles its own Claude Code binary (`claudeCodeVersion` in the SDK's `package.json`), so a globally installed `claude` doesn't matter. | `test/fixtures/claude/*.jsonl` (`claude_code_version` in `init` frames) |
| Codex | nothing: users bring their own `codex`. The pin is the release that `protocol.ts`, the surface snapshot and the fixtures were made from. | `src/codex/protocol.ts` header, `test/fixtures/codex/protocol-surface.txt` (first line), `test/fixtures/codex/*.jsonl` (`userAgent`) |

## The tools

| Command | What it tells you | Cost |
| --- | --- | --- |
| `node scripts/codex-protocol.ts [--codex PATH] [--update]` | Generates the app-server protocol from a codex binary. **Surface**: a text rendering of the part `protocol.ts` mirrors, diffed against the committed snapshot, so you see what Codex added, removed or changed. **Conformance**: type-checks `protocol.ts` against the generated bindings and exits 1 on any mismatch. | free, offline |
| `node scripts/claude-sdk-diff.ts [--from V] [--to V] [--docs]` | Follows every SDK type effect-agent imports through `sdk.d.ts`, then lists and diffs each reachable declaration that changed between two SDK versions (default: installed vs latest). | free (`npm pack`, nothing runs) |
| `node scripts/live-codex.ts --record`, `node scripts/live-claude.ts --fixtures` | Runs every scenario against the real CLI, asserts behaviour, and rewrites the fixtures. | a few cents |
| `node scripts/fixture-events.ts [--base REF]` | Compares the fixtures in the working tree with those at `REF` (default `HEAD`) as **normalized event sequences** and **frame shapes**, not JSONL. | free |

## The routine

Do it on a branch, one CLI at a time if both moved, starting from a green tree:

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
```

### 1. See what's new

```sh
codex --version;  npm view @openai/codex version
npm view @anthropic-ai/claude-agent-sdk version    # vs package.json
```

Skim the release notes (the Codex releases on GitHub; the SDK's `CHANGELOG.md` in `anthropics/claude-agent-sdk-typescript`). The scripts find shape changes. Release notes are where behaviour changes get announced.

### 2. Codex: protocol

```sh
node scripts/codex-protocol.ts                  # the codex on PATH
node scripts/codex-protocol.ts --codex PATH     # preview a release before installing it
```

To preview a release without installing it, unpack the platform package into a scratch directory, `npm pack @openai/codex@VERSION-linux-x64`, and point `--codex` at `vendor/*/bin/codex`. Running it with `HOME` and `CODEX_HOME` set to an empty directory keeps it off your config.

Read the **surface** diff with the code that consumes each part:

- `CodexErrorInfo`: new kinds land in `CodexEvents.classifyOutcome` as `AgentFailed`. Decide whether a new kind is a throttle (`throttleKinds`), a usage limit, an auth failure, and so on.
- `RateLimitSnapshot`, `RateLimitWindow`, `GetAccountRateLimitsResponse`: limit windows, `UsageLimited` details, `status`.
- `ThreadItem` variants: `toolCallOf` and `toolResultOf`. New tool-like items show up as `Other` until they're mapped.
- `ServerNotification methods`: new notifications map to `Other`. Progress-like ones belong in `heartbeatMethods` so the watchdog sees activity.
- `ServerRequest methods`: `defaultServerRequestHandler` answers each request it knows and rejects the rest, so a new request kind the server waits on needs an answer.
- `TurnStartParams`, `TurnSteerParams`, `TurnInterruptParams` and their docs: steering and interrupt semantics (also `isStaleSteerError`, which matches error text).

**Conformance** must print `protocol.ts holds`. A failure names the type and field: a field we read that codex dropped or retyped, a literal we name that no longer exists, or a field codex now requires that we don't send. Fix `protocol.ts` (and its users) until it holds. Every wire name the codex provider uses lives in `protocol.ts` (`NotificationMethod`, `CodexErrorKind`, the `ThreadItem` tags, the answers to server requests), so the check covers them. A new export there must also be added to `checks` or `local` in the script, or it reports `not checked`.

Then record the new surface as the pin:

```sh
node scripts/codex-protocol.ts --update
```

### 3. Claude: SDK types

```sh
node scripts/claude-sdk-diff.ts --to VERSION    # before bumping
```

Read the changed declarations with the code that consumes them:

- `SDKMessage` members: `ClaudeAgent.frameEvents` and `step`. New members map to `Other`.
- `SDKResultMessage`, `SDKAssistantMessage` (`error`), `SDKRateLimitInfo`: `classifyOutcome`, `turnUsage`, `limitWindows`, `overageAvailable`.
- `Options`, hook types: `buildOptions`, `buildStatusOptions`, `sdkHooks`.
- `SDKControlGetUsageResponse`, `AccountInfo`, `SessionMessage`: `accountStatus`, `historyEvents`.

Then bump. Pin exactly, with no range:

```sh
# package.json: "@anthropic-ai/claude-agent-sdk": "VERSION"
pnpm install
pnpm typecheck
```

Types don't cover everything. The SDK types some fields loosely, and `command_lifecycle` frames aren't in its types at all (they're decoded by `ClaudeSdk.decodeLifecycle`). Steps 4 and 5 cover what the CLI actually sends.

### 4. Re-record the fixtures

```sh
node scripts/live-codex.ts --record && node scripts/make-codex-fixtures.ts
node scripts/live-claude.ts --fixtures
```

A failing scenario is a finding, not a flake to retry past. The scenarios assert behaviour such as steering, interrupts, process cleanup and hooks.

`live-claude.ts --fixtures` writes a fixture for every scenario, including some no test replays (`launcher`, `hook-*` other than `hooks`). Keep only the fixtures git already tracks: `git clean -n test/fixtures` lists the rest.

Hand-built fixtures aren't recorded, so check them against the new shapes (step 5) and update them by hand:

- Codex `usage-limit`, `process-killed`, `stall-killed` are built from fresh recordings by `scripts/make-codex-fixtures.ts`. Its hard-coded error and rate-limit shapes come from the protocol, so update them if the surface diff touched those types.
- Claude `usage-limit.jsonl` is hand-written from a real usage-limit response (no scenario can trigger one).

### 5. Compare old and new recordings

```sh
node scripts/fixture-events.ts
```

For each fixture this prints a diff of its **normalized event sequence** (e.g. `TurnEnded t1 UsageLimited window="weekly" ...`, `Other brand_new_frame`), and for each provider a diff of **frame shapes** (every key path and value type the CLI sent, per frame kind). Ids are numbered by appearance and model-written text is left out, so the event diff reflects how the CLI's frames map, not how the model phrased its reply.

Re-recording with the *same* CLI still shows some noise. A run on 2.1.312 and 0.162.1 showed these kinds:

- Async notifications (`LimitsUpdated`, `Other thread/started`, `Other account/updated`) moving one line relative to our requests.
- The model writing a slightly different command (`sleep 23.5134` instead of `sleep 20`), or emitting `reasoning` items one run and not the next.
- Server-side fields coming and going with account state (`rate_limit_info.utilization`, `overageEnabled`).

Real changes look different: another outcome, a lost `MessageLanded`, a new `Other` kind, a field the mapping reads disappearing from the shapes, or `!! mapping threw` (the live session would die there).

`--print codex/simple` shows one listing, and `--text` includes the assistant text.

### 6. Update version mentions and tests

```sh
git grep -n -e OLD_CODEX_VERSION -e OLD_CLAUDE_CODE_VERSION -- ':!test/fixtures'
```

This finds the tests that expect the recorded version, the `protocol.ts` header, and comments that record behaviour verified on a release ("verified on 0.162.1"). Re-check each such claim with the live scripts before moving it to the new version.

Some tests also assert values that come from the recording account rather than the CLI, such as the usage percentages and reset times in the `status` tests. A fresh recording changes them, so update them to the new fixture's values. Then:

```sh
pnpm typecheck && pnpm test
```

### 7. Stop for judgment calls

Some changes have no mechanical answer. Raise them before committing:

- Steering semantics: when a steer lands, starts a new turn, or is refused. This covers `turn/steer` errors, `command_lifecycle` states, and queue behaviour.
- Error classification: a new error kind or result subtype, or a changed one.
- Interrupt and process-lifetime behaviour.
- New message kinds that deserve their own event rather than `Other`.

### 8. Commit

One commit per CLI, holding the pin, `protocol.ts` and the surface snapshot, the fixtures, and the test and comment updates. Name the versions in the message (`Codex 0.162.1 -> 0.166.0`) and summarize what the reports showed. Add a changeset with it (`pnpm changeset`: patch, or minor if behaviour changed, naming the new versions); a Claude bump changes the CLI users get, so it always needs a release.

## Why `protocol.ts` is hand-picked, not generated

`codex app-server generate-ts --experimental` writes about 890 files (around 800 definitions) per release, and effect-agent uses about 40 of them. We keep the hand-picked subset and check it mechanically, because:

- **The subset is typed for forward compatibility on purpose.** What we read is loose: open enums for item types, error kinds and reasoning effort, and fields we don't use are left out or optional. A newer server then keeps working with an older effect-agent. Generated types are exact, so every release would break the build, or exhaustive switches, over fields we never read.
- **Neither generated artifact is the whole truth.** The TS bindings fold `"badRequest" | string` into `string` (losing the names), and mark serde-defaulted params as required. The JSON Schema leaves out some methods, such as the experimental raw-event notifications. The checker uses each where it is right: TS for structure and method names, the JSON Schema for required fields and enum names.
- **It's a published library.** Vendoring ~890 generated, experimental files would bloat the package, and every release diff would bury the few changes that matter.
- **What hand-picking risks, the checker recovers.** Drift becomes a failing conformance check, additions show up in the surface diff, and an export that isn't checked is reported.

Revisit this if the subset grows to cover most of the protocol, or Codex publishes stable, versioned protocol types.
