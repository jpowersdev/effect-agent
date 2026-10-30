/**
 * The README's systemd recipe (`examples/SystemdLauncher.ts`), against the
 * real user manager. Skipped where there is none (e.g. CI containers).
 *
 * The out-of-memory cases need `EFFECT_AGENT_OOM_TESTS=1`: their kernel OOM
 * kills are real, and desktops such as KDE Plasma alert on every one.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as SystemdLauncher from "../examples/SystemdLauncher.ts"

const hasUserManager =
  process.platform === "linux" &&
  spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], { stdio: "ignore" }).status === 0
const oomTests = process.env.EFFECT_AGENT_OOM_TESTS === "1"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const loadState = (unit: string) =>
  spawnSync("systemctl", ["--user", "show", "--property=LoadState", "--value", unit], { encoding: "utf8" }).stdout.trim()

/** Start `command` the way a provider does: through the launcher's wrap, in a session scope. */
const runWrapped = (systemd: SystemdLauncher.SystemdLauncher, scope: Scope.Scope, command: string, args: Array<string>) =>
  Effect.gen(function* () {
    const wrap = yield* systemd.launcher.prepare({ provider: "test", cwd: tmpdir() }).pipe(Scope.provide(scope))
    const wrapped = wrap({ command, args })
    const done = spawnSync(wrapped.command, [...wrapped.args], { encoding: "utf8" })
    return { status: done.status, signal: done.signal, stdout: done.stdout }
  })

const activeState = (unit: string) =>
  spawnSync("systemctl", ["--user", "show", "--property=ActiveState", "--value", unit], { encoding: "utf8" }).stdout.trim()

/** `make` in an outer Scope, as for a session; `body` gets the launcher and a session Scope. */
const withLauncher = <A, E, R>(
  options: SystemdLauncher.Options,
  body: (systemd: SystemdLauncher.SystemdLauncher, session: Scope.Scope) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const outer = yield* Scope.make()
    const systemd = yield* SystemdLauncher.make(options).pipe(Scope.provide(outer))
    const session = yield* Scope.make()
    yield* body(systemd, session).pipe(Effect.ensuring(Scope.close(session, Exit.void)))
    const oomKilledAfterSession = yield* systemd.oomKilled
    yield* Scope.close(outer, Exit.void)
    expect(activeState(systemd.slice)).not.toBe("active")
    return { systemd, oomKilledAfterSession }
  }).pipe(Effect.provide(NodeServices.layer))

describe.skipIf(!hasUserManager)("SystemdLauncher example", () => {
  it.live("stops what the agent left behind, even with a cleared environment", () =>
    Effect.gen(function* () {
      const pidFile = join(mkdtempSync(join(tmpdir(), "ea-systemd-")), "pid")
      let leftover = 0
      const { systemd, oomKilledAfterSession } = yield* withLauncher({}, (systemd, session) =>
        Effect.gen(function* () {
          yield* runWrapped(systemd, session, "sh", ["-c", `env -i setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}`])
          leftover = Number(readFileSync(pidFile, "utf8"))
          const [unit] = yield* systemd.units
          expect(alive(leftover)).toBe(true)
          expect(readFileSync(`/proc/${leftover}/cgroup`, "utf8")).toContain(`${systemd.slice}/${unit}`)
        }),
      )
      expect(alive(leftover)).toBe(false)
      expect(loadState((yield* systemd.units)[0]!)).toBe("not-found")
      expect(oomKilledAfterSession).toBe(false)
    }),
  )

  for (const oomPolicy of ["stop", "continue"] as const) {
    it.live.skipIf(!oomTests)(`reports an out-of-memory kill (OOMPolicy=${oomPolicy}), after the session ends too`, () =>
      Effect.gen(function* () {
        const { systemd, oomKilledAfterSession } = yield* withLauncher(
          { properties: { MemoryMax: "50M", MemorySwapMax: "0" }, oomPolicy },
          (systemd, session) =>
            Effect.gen(function* () {
              const done = yield* runWrapped(systemd, session, "python3", ["-c", "bytearray(400 * 1024 * 1024)"])
              expect(done.signal).toBe("SIGKILL")
              expect(yield* systemd.oomKilled).toBe(true)
            }),
        )
        expect(oomKilledAfterSession).toBe(true)
        // Failed (OOM-killed) scopes are reset, not left behind.
        expect(loadState((yield* systemd.units)[0]!)).toBe("not-found")
      }),
    )
  }

  it.live("passes arguments through literally", () =>
    withLauncher({}, (systemd, session) =>
      Effect.gen(function* () {
        const done = yield* runWrapped(systemd, session, "printf", ["%s", "$HOME ${X} $$ %n"])
        expect(done.stdout).toBe("$HOME ${X} $$ %n")
      }),
    ),
  )

  it.live("an ordinary kill is not an out-of-memory kill", () =>
    Effect.gen(function* () {
      const { oomKilledAfterSession } = yield* withLauncher({ properties: { MemoryMax: "50M" } }, (systemd, session) =>
        Effect.gen(function* () {
          const done = yield* runWrapped(systemd, session, "sh", ["-c", "kill -9 $$"])
          expect(done.signal).toBe("SIGKILL")
        }),
      )
      expect(oomKilledAfterSession).toBe(false)
    }),
  )
})
