// Bundles the session host into one file, the way Effect's bundle tooling does
// (node-resolve + esbuild, ESM out). The library itself ships per-file in dist/,
// like Effect's packages; only the host is bundled, because it is started as its
// own process for every session and module loading dominates its startup.
import commonjs from "@rollup/plugin-commonjs"
import { nodeResolve } from "@rollup/plugin-node-resolve"
import esbuild from "rollup-plugin-esbuild"
import { builtinModules } from "node:module"

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

export default {
  input: "src/host/main.ts",
  output: { file: "dist/host/main.bundle.js", format: "esm", sourcemap: true, inlineDynamicImports: true },
  // The Claude Agent SDK finds its bundled CLI binary through its own package
  // layout, so it stays a normal dependency.
  external: (id) => builtins.has(id) || id === "@anthropic-ai/claude-agent-sdk" || id.startsWith("@anthropic-ai/claude-agent-sdk/"),
  plugins: [
    nodeResolve({ exportConditions: ["node", "import", "default"], preferBuiltins: true }),
    // NodeSocketServer imports `ws` (CommonJS) for its WebSocket support.
    commonjs(),
    esbuild({ target: "node24", format: "esm", sourceMap: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code === "CIRCULAR_DEPENDENCY" && /node_modules/.test(warning.ids?.join() ?? "")) return
    warn(warning)
  },
}
