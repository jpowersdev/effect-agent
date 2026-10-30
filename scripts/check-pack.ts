/**
 * Checks the published file list after `pnpm build`:
 *
 *   node scripts/check-pack.ts
 *
 * - `pnpm pack --dry-run` ships package.json, README.md, LICENSE, `src/` and
 *   `dist/`, and nothing else (no tests, fixtures, scripts or examples). It
 *   runs with `--ignore-scripts`, so `prepack` doesn't rebuild what's checked.
 * - Every source module has its `.js` and `.d.ts` in `dist/`.
 * - Every `exports` entry is in the tarball and imports by package name.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly name: string
  readonly exports: Record<string, string>
}
const packed = JSON.parse(execFileSync("pnpm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" })) as {
  readonly files: ReadonlyArray<{ readonly path: string }>
}
const files = new Set(packed.files.map((file) => file.path))
const problems: Array<string> = []

for (const file of files) {
  if (!/^(src|dist)\//.test(file) && !["package.json", "README.md", "LICENSE"].includes(file)) {
    problems.push(`unexpected file in tarball: ${file}`)
  }
}
for (const file of ["package.json", "README.md", "LICENSE"]) {
  if (!files.has(file)) problems.push(`missing from tarball: ${file}`)
}

const sources = [...files].filter((file) => file.startsWith("src/"))
if (sources.length === 0) problems.push("no src/ files in tarball")
for (const source of sources) {
  const base = source.replace(/^src\//, "dist/").replace(/\.ts$/, "")
  for (const built of [`${base}.js`, `${base}.d.ts`]) {
    if (!files.has(built)) problems.push(`missing from tarball: ${built} (for ${source})`)
  }
}

for (const [subpath, target] of Object.entries(pkg.exports)) {
  const file = target.replace(/^\.\//, "")
  if (!files.has(file)) problems.push(`exports["${subpath}"] -> ${target} is not in the tarball`)
  if (file.endsWith(".js")) {
    const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, "")}`
    try {
      await import(specifier)
    } catch (cause) {
      problems.push(`import("${specifier}") failed: ${String(cause)}`)
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`ok: ${files.size} files, ${sources.length} modules, ${Object.keys(pkg.exports).length} exports`)
