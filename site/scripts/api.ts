// Turns docgen's markdown (site/.docgen, written by `pnpm docgen` at the repo
// root) into Starlight pages under src/content/docs/api, one directory per
// package entry point.
//
// docgen writes for Jekyll (just-the-docs): its own front matter, a table of
// contents, category headings at h1 and source links without the module's
// directory. Each page gets Starlight front matter, loses the table of
// contents (Starlight renders one), has its headings moved down a level and
// its source links fixed.
//
// docgen's pages for the barrels (index.ts) list re-exports by file name, so
// each entry point's overview is written here instead, from its barrel: the
// barrel's module comment, then its modules with their summaries.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const site = join(dirname(fileURLToPath(import.meta.url)), "..")
const input = join(site, ".docgen", "modules")
const output = join(site, "src", "content", "docs", "api")
const repo = "https://github.com/jpowersdev/effect-agent/blob/main"

// src/ directory -> the entry point's directory under api/, and its import path
const entryPoints: Record<string, { readonly dir: string; readonly path: string }> = {
  ".": { dir: "core", path: "@jpowersdev/effect-agent" },
  claude: { dir: "claude", path: "@jpowersdev/effect-agent/claude" },
  codex: { dir: "codex", path: "@jpowersdev/effect-agent/codex" },
  host: { dir: "host", path: "@jpowersdev/effect-agent/host" },
}
// Modules exported under another name
const titles: Record<string, string> = { "host/protocol": "HostProtocol" }

if (!existsSync(input)) {
  console.error(`${relative(process.cwd(), input)} is missing: run \`pnpm docgen\` at the repository root first.`)
  process.exit(1)
}

const files = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts.md") ? [join(dir, entry.name)] : [],
  )

const yamlString = (s: string) => JSON.stringify(s)

const frontMatter = (fields: { title: string; description?: string; order?: number }) =>
  [
    "---",
    `title: ${yamlString(fields.title)}`,
    ...(fields.description === undefined ? [] : [`description: ${yamlString(fields.description)}`]),
    ...(fields.order === undefined ? [] : ["sidebar:", `  order: ${fields.order}`]),
    "editUrl: false",
    "---",
  ].join("\n")

const firstSentence = (paragraph: string) => paragraph.replace(/\s+/g, " ").split(/(?<=\.) /)[0]!

interface Page {
  readonly title: string
  readonly summary: string | undefined
  readonly markdown: string
}

const convert = (file: string, module: string): Page => {
  const text = readFileSync(file, "utf8")
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "")
  const title = titles[module] ?? basename(module)

  const lines = body.split("\n")
  const out: Array<string> = []
  let fenced = false
  let skippingToc = false
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced
    if (fenced || /^(```|~~~)/.test(line)) {
      out.push(line)
      continue
    }
    if (line === "## Exports Grouped by Category") {
      skippingToc = true
      continue
    }
    if (skippingToc) {
      if (line.startsWith("# ")) skippingToc = false
      else continue
    }
    if (/^## \S+\.ts overview$/.test(line) || line === "---") continue
    // A category: capitalized, as a section title
    if (line.startsWith("# ")) {
      out.push(`## ${line[2]!.toUpperCase()}${line.slice(3)}`)
      continue
    }
    if (/^#{2,5} /.test(line)) {
      out.push(`#${line}`)
      continue
    }
    out.push(
      // docgen links src/<basename>; the module may be in a subdirectory
      line.replace(/\[Source\]\(https:\/\/github\.com\/[^)]*?\/src\/[^/#)]+\.ts(#L\d+)?\)/g, (_m, anchor = "") =>
        `[Source](${repo}/src/${module}.ts${anchor})`,
      ),
    )
  }

  const content = out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
  const first = content.split("\n\n")[0]!
  const summary = /^[#`]|^Since /.test(first) ? undefined : firstSentence(first)
  return { title, summary, markdown: `${frontMatter({ title, ...(summary && { description: summary }) })}\n\n${content}\n` }
}

// The barrel's module comment, as markdown
const barrelComment = (source: string): string => {
  const block = source.match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? ""
  return block
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .filter((line) => !line.startsWith("@"))
    .join("\n")
    .trim()
}

const overview = (dir: string, pages: ReadonlyMap<string, Page>): string => {
  const { path } = entryPoints[dir]!
  const source = readFileSync(join(site, "..", "src", dir, "index.ts"), "utf8")
  const intro = barrelComment(source)
  const modules = Array.from(source.matchAll(/^export \* (?:as (\w+) )?from "\.\/(\w+)\.ts"/gm), ([, namespace, file]) => {
    const module = dir === "." ? file! : `${dir}/${file}`
    const page = pages.get(module)
    return { name: page?.title ?? namespace ?? file!, namespace, module, page }
  })
  const flat = modules.filter((m) => m.namespace === undefined).map((m) => `\`${m.name}\``)
  const namespaces = modules.flatMap((m) => (m.namespace === undefined ? [] : [m.namespace]))
  const items = modules.map(({ name, module, page }) =>
    page === undefined
      ? `- \`${name}\`: internal, exported for the tests; not documented here.`
      : `- [${name}](./${basename(module).toLowerCase()}/): ${page.summary ?? ""}`,
  )
  return [
    frontMatter({ title: "Overview", description: firstSentence(intro.split("\n\n")[0]!), order: 0 }),
    "",
    intro,
    "",
    flat.length === 0
      ? "Each module is a namespace:"
      : `The exports of ${flat.join(", ").replace(/, ([^,]*)$/, " and $1")} are the entry point's own; the other modules are namespaces:`,
    "",
    "```ts",
    `import { ${namespaces.join(", ")} } from "${path}"`,
    "```",
    "",
    "## Modules",
    "",
    ...items,
    "",
  ].join("\n")
}

rmSync(output, { recursive: true, force: true })
const pages = new Map<string, Page>()
for (const file of files(input)) {
  const module = relative(input, file).replace(/\.ts\.md$/, "")
  if (basename(module) === "index") continue
  const entryPoint = entryPoints[dirname(module)]
  if (entryPoint === undefined) throw new Error(`No entry point for src/${dirname(module)}`)
  const page = convert(file, module)
  const target = join(output, entryPoint.dir, `${basename(module)}.md`)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, page.markdown)
  pages.set(module, page)
}
for (const [dir, entryPoint] of Object.entries(entryPoints)) {
  writeFileSync(join(output, entryPoint.dir, "index.md"), overview(dir, pages))
}
console.log(`Wrote ${pages.size} API pages and ${Object.keys(entryPoints).length} overviews to ${relative(process.cwd(), output)}`)
