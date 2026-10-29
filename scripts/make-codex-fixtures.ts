/**
 * Builds the hand-constructed Codex fixtures from recorded ones:
 *
 * - usage-limit.jsonl: simple.jsonl with the turn failing `usageLimitExceeded`
 *   (shapes from the 0.162.1 protocol: `error` notification, `turn/completed`
 *   with `turn.error.codexErrorInfo`), followed by the `account/rateLimits/read`
 *   the agent makes to find the reset time.
 * - process-killed.jsonl: command.jsonl cut off after the command starts,
 *   then app-server dies by SIGKILL.
 *
 *   node scripts/make-codex-fixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs"

const dir = new URL("../test/fixtures/codex/", import.meta.url).pathname
const read = (name: string) =>
  readFileSync(`${dir}${name}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
const write = (name: string, frames: Array<unknown>) =>
  writeFileSync(`${dir}${name}.jsonl`, frames.map((f) => JSON.stringify(f)).join("\n") + "\n")

// ---- usage-limit ----
{
  const frames = read("simple")
  const i = frames.findIndex((f) => f.dir === "in" && f.msg.method === "turn/completed")
  const completed = frames[i].msg
  const { threadId, turn } = completed.params
  const resetsAt = 1793803680 // unix seconds
  const message =
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 3rd, 2026 5:28 PM."
  const error = { message, codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null }
  const failed = {
    ...completed,
    params: { threadId, turn: { ...turn, items: [], status: "failed", error } },
  }
  const errorNotification = {
    method: "error",
    params: { error, willRetry: false, threadId, turnId: turn.id },
    emittedAtMs: completed.emittedAtMs - 1,
  }
  const window = { usedPercent: 100, windowDurationMins: 10080, resetsAt }
  const snapshot = {
    limitId: "codex",
    limitName: null,
    normalModelSlug: null,
    primary: window,
    secondary: { usedPercent: 41, windowDurationMins: 300, resetsAt: resetsAt - 3 * 86400 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  }
  const lastId = Math.max(...frames.filter((f) => f.dir === "out" && typeof f.msg.id === "number").map((f) => f.msg.id))
  const readId = lastId + 1
  const out = [
    // Drop the successful answer: a usage-limited turn produces no agent message.
    ...frames.slice(0, i).filter((f) => !(f.dir === "in" && f.msg.params?.item?.type === "agentMessage")),
    { dir: "in", msg: errorNotification },
    { dir: "in", msg: failed },
    { dir: "out", msg: { id: readId, method: "account/rateLimits/read" } },
    {
      dir: "in",
      msg: {
        id: readId,
        result: {
          ordinaryUsageAllowed: false,
          rateLimits: snapshot,
          rateLimitsByLimitId: { codex: snapshot },
          rateLimitResetCredits: null,
          accountId: "acct-redacted",
          rateLimitUpsell: null,
        },
      },
    },
  ]
  write("usage-limit", out)
}

// ---- process-killed ----
{
  const frames = read("command")
  const i = frames.findIndex((f) => f.dir === "in" && f.msg.method === "item/started" && f.msg.params.item.type === "commandExecution")
  write("process-killed", [...frames.slice(0, i + 1), { dir: "exit", exitCode: null, signal: "SIGKILL" }])
}

console.log("wrote usage-limit.jsonl, process-killed.jsonl")
