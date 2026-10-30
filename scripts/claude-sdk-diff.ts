/**
 * What changed in the Claude Agent SDK's types that effect-agent uses,
 * between two SDK versions.
 *
 *   node scripts/claude-sdk-diff.ts                  # installed SDK -> latest on npm
 *   node scripts/claude-sdk-diff.ts --to 0.3.314     # installed SDK -> a version
 *   node scripts/claude-sdk-diff.ts --from 0.3.310 --to 0.3.312
 *   node scripts/claude-sdk-diff.ts --docs           # also show doc-comment-only changes
 *
 * The roots are the names effect-agent imports from the SDK (in src/, test/
 * and scripts/). From each root it follows every type the declaration
 * mentions through `sdk.d.ts`, so a change three hops down from `SDKMessage`
 * or `Options` shows up, and reports each reachable declaration that was
 * added, removed or changed, with a diff and the path that reaches it. A
 * root missing from the new version exits 1.
 *
 * Packages are fetched with `npm pack` into a temp dir and only read: no
 * install, no scripts, no binary.
 *
 * Types are half the story: the CLI's runtime frames can change without a
 * type change. Re-record the fixtures and compare them with
 * scripts/fixture-events.ts (see UPGRADING.md).
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { unifiedDiff } from "./lib/lineDiff.ts"

const pkg = "@anthropic-ai/claude-agent-sdk"
const repo = join(import.meta.dirname, "..")

const args = process.argv.slice(2)
const optionValue = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const showDocs = args.includes("--docs")

const run = (file: string, argv: ReadonlyArray<string>, cwd?: string) =>
  execFileSync(file, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(cwd !== undefined && { cwd }) })

interface Release {
  readonly version: string
  readonly claudeCodeVersion: string | null
  readonly dts: string
}

const readRelease = (dir: string): Release => {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; claudeCodeVersion?: string }
  return { version: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion ?? null, dts: readFileSync(join(dir, "sdk.d.ts"), "utf8") }
}

const work = mkdtempSync(join(tmpdir(), "claude-sdk-diff-"))

/** `npm pack` one version and unpack it in its own directory. */
const fetchRelease = (spec: string): Release => {
  const version = run("npm", ["view", `${pkg}@${spec}`, "version"]).trim().split("\n").at(-1)!.replace(/^.*'(.*)'$/, "$1")
  const dir = join(work, version)
  mkdirSync(join(dir, "extract"), { recursive: true })
  const tarball = run("npm", ["pack", `${pkg}@${version}`, "--pack-destination", dir, "--silent"]).trim().split("\n").at(-1)!
  run("tar", ["-xzf", join(dir, tarball), "-C", join(dir, "extract")])
  return readRelease(join(dir, "extract", "package"))
}

const installed = (): Release => readRelease(dirname(fileURLToPath(import.meta.resolve(pkg))))

// ---------------------------------------------------------------------------
// Roots: what effect-agent imports
// ---------------------------------------------------------------------------

const sourceFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sourceFiles(path)
    return path.endsWith(".ts") ? [path] : []
  })

const roots = (): Map<string, Array<string>> => {
  const out = new Map<string, Array<string>>()
  const escaped = pkg.replace(/[/]/g, "\\/")
  const staticImport = new RegExp(`import(?: type)? \\{([^{}]*)\\} from "${escaped}"`, "g")
  const dynamicImport = new RegExp(`\\{([^{}]*)\\} = await import\\("${escaped}"\\)`, "g")
  for (const file of ["src", "test", "scripts"].flatMap((d) => sourceFiles(join(repo, d)))) {
    const text = readFileSync(file, "utf8")
    for (const m of [...text.matchAll(staticImport), ...text.matchAll(dynamicImport)]) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()
        if (name === "") continue
        out.set(name, [...(out.get(name) ?? []), file.slice(repo.length + 1)])
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

const declStart = /^(?:export )?(?:declare )?(?:abstract )?(?:type|interface|function|const|let|var|class|namespace|enum) (\w+)/

/**
 * Top-level declarations of a bundled .d.ts: each starts at column 0 (with
 * the doc comment just above it), and overloads of a name are joined.
 */
const declarations = (dts: string): Map<string, string> => {
  const out = new Map<string, string>()
  let doc: Array<string> = []
  let current: { name: string; lines: Array<string> } | null = null
  const flush = () => {
    if (current === null) return
    const text = current.lines.join("\n").trimEnd()
    out.set(current.name, out.has(current.name) ? `${out.get(current.name)}\n${text}` : text)
    current = null
  }
  let inDoc = false
  for (const line of dts.split("\n")) {
    if (!inDoc && line.startsWith("/**")) {
      flush()
      inDoc = !line.includes("*/")
      doc = [line]
      continue
    }
    if (inDoc) {
      doc.push(line)
      if (line.includes("*/")) inDoc = false
      continue
    }
    const start = declStart.exec(line)
    if (start !== null) {
      flush()
      current = { name: start[1]!, lines: [...doc, line] }
      doc = []
    } else if (/^\S/.test(line) && !line.startsWith("}")) {
      flush() // imports, `export { ... }`
      doc = []
    } else if (current !== null) {
      current.lines.push(line)
    }
  }
  flush()
  return out
}

const stripDocs = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n")

/** Every declaration reachable from the roots, with the root-first path that reaches it. */
const reachable = (decls: Map<string, string>, from: Iterable<string>): Map<string, Array<string>> => {
  const paths = new Map<string, Array<string>>()
  const queue: Array<string> = []
  for (const r of from) {
    if (decls.has(r) && !paths.has(r)) {
      paths.set(r, [r])
      queue.push(r)
    }
  }
  while (queue.length > 0) {
    const name = queue.shift()!
    for (const [id] of stripDocs(decls.get(name)!).matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      if (id !== name && decls.has(id) && !paths.has(id)) {
        paths.set(id, [...paths.get(name)!, id])
        queue.push(id)
      }
    }
  }
  return paths
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const before = optionValue("--from") !== undefined ? fetchRelease(optionValue("--from")!) : installed()
const after = fetchRelease(optionValue("--to") ?? "latest")

const imported = roots()
const oldDecls = declarations(before.dts)
const newDecls = declarations(after.dts)
const oldReach = reachable(oldDecls, imported.keys())
const newReach = reachable(newDecls, imported.keys())

const via = (path: ReadonlyArray<string>) => (path.length === 1 ? "(imported)" : `via ${path.slice(0, -1).join(" > ")}`)
const names = [...new Set([...oldReach.keys(), ...newReach.keys()])].sort()
const removed = names.filter((n) => !newDecls.has(n))
const added = names.filter((n) => !oldDecls.has(n))
const both = names.filter((n) => oldDecls.has(n) && newDecls.has(n))
const changed = both.filter((n) => stripDocs(oldDecls.get(n)!) !== stripDocs(newDecls.get(n)!))
const docsOnly = both.filter((n) => !changed.includes(n) && oldDecls.get(n) !== newDecls.get(n))
const missingRoots = [...imported.keys()].filter((r) => oldDecls.has(r) && !newDecls.has(r))
const pathOf = (n: string) => newReach.get(n) ?? oldReach.get(n)!

console.log(
  `${pkg} ${before.version} -> ${after.version} (Claude Code ${before.claudeCodeVersion ?? "?"} -> ${after.claudeCodeVersion ?? "?"})`,
)
console.log(`imported names: ${imported.size}; reachable declarations: ${oldReach.size} -> ${newReach.size}`)
const unknownRoots = [...imported.keys()].filter((r) => !oldDecls.has(r) && !newDecls.has(r))
if (unknownRoots.length > 0) console.log(`not found in sdk.d.ts (re-exports?): ${unknownRoots.join(", ")}`)
console.log(missingRoots.length === 0 ? "no imported name was removed" : `REMOVED, imported by effect-agent: ${missingRoots.map((r) => `${r} (${imported.get(r)!.join(", ")})`).join("; ")}`)

const list = (title: string, items: ReadonlyArray<string>) => {
  console.log(`\n${title}: ${items.length === 0 ? "none" : ""}`)
  for (const n of items) console.log(`  ${n.padEnd(40)} ${via(pathOf(n))}`)
}
list("changed", changed)
list("added", added)
list("removed", removed)
list(`doc comments only${showDocs ? "" : " (--docs to show)"}`, docsOnly)

for (const n of [...changed, ...(showDocs ? docsOnly : [])]) {
  console.log(`\n== ${n} (${via(pathOf(n))}) ==`)
  const strip = !docsOnly.includes(n) && !showDocs
  const a = strip ? stripDocs(oldDecls.get(n)!) : oldDecls.get(n)!
  const b = strip ? stripDocs(newDecls.get(n)!) : newDecls.get(n)!
  process.stdout.write(unifiedDiff(a, b, { context: 3 }))
}
for (const n of added) console.log(`\n== ${n} (added, ${via(pathOf(n))}) ==\n${stripDocs(newDecls.get(n)!)}`)

rmSync(work, { recursive: true, force: true })
if (missingRoots.length > 0) process.exitCode = 1
