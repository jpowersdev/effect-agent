/**
 * A unified line diff (longest common subsequence), for the upgrade scripts'
 * reports. Inputs are small (snapshots, declarations, event listings), so the
 * quadratic table is fine.
 */

export interface DiffOptions {
  /** Unchanged lines shown around each change. Default 2. */
  readonly context?: number
  readonly from?: string
  readonly to?: string
  /** Lines that name a section; each hunk header shows the last one before it, like git's function headings. */
  readonly heading?: RegExp
}

type Op = { readonly kind: " " | "-" | "+"; readonly line: string }

const ops = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<Op> => {
  const n = a.length
  const m = b.length
  // lcs[i * (m + 1) + j]: LCS length of a[i..] and b[j..]
  const lcs = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!)
    }
  }
  const out: Array<Op> = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: " ", line: a[i++]! })
      j++
    } else if (j < m && (i === n || lcs[i * (m + 1) + j + 1]! > lcs[(i + 1) * (m + 1) + j]!)) {
      out.push({ kind: "+", line: b[j++]! })
    } else {
      out.push({ kind: "-", line: a[i++]! })
    }
  }
  return out
}

const lines = (text: string): Array<string> => (text === "" ? [] : text.replace(/\n$/, "").split("\n"))

/** The unified diff of two texts; empty when they are equal. */
export const unifiedDiff = (a: string, b: string, options: DiffOptions = {}): string => {
  const context = options.context ?? 2
  const all = ops(lines(a), lines(b))
  if (all.every((o) => o.kind === " ")) return ""
  const out: Array<string> = []
  if (options.from !== undefined || options.to !== undefined) out.push(`--- ${options.from ?? "a"}`, `+++ ${options.to ?? "b"}`)
  // Line numbers (1-based) before each op, in a and b.
  const posA: Array<number> = []
  const posB: Array<number> = []
  let la = 1
  let lb = 1
  for (const o of all) {
    posA.push(la)
    posB.push(lb)
    if (o.kind !== "+") la++
    if (o.kind !== "-") lb++
  }
  let k = 0
  while (k < all.length) {
    if (all[k]!.kind === " ") {
      k++
      continue
    }
    // A hunk: from `context` lines before this change to `context` lines after the last change within reach.
    const start = Math.max(0, k - context)
    let end = k
    while (end < all.length) {
      if (all[end]!.kind !== " ") {
        end++
        continue
      }
      let next = end
      while (next < all.length && all[next]!.kind === " ") next++
      if (next < all.length && next - end <= 2 * context) end = next
      else break
    }
    const stop = Math.min(all.length, end + context)
    const hunk = all.slice(start, stop)
    const countA = hunk.filter((o) => o.kind !== "+").length
    const countB = hunk.filter((o) => o.kind !== "-").length
    let heading = ""
    if (options.heading !== undefined) {
      // The last heading above the hunk's first change (its leading context included).
      for (let h = k - 1; h >= 0; h--) {
        const o = all[h]!
        if (o.kind !== "+" && options.heading.test(o.line)) {
          heading = ` ${o.line}`
          break
        }
      }
    }
    out.push(`@@ -${posA[start]},${countA} +${posB[start]},${countB} @@${heading}`)
    for (const o of hunk) out.push(`${o.kind}${o.line}`)
    k = stop
  }
  return out.join("\n") + "\n"
}
