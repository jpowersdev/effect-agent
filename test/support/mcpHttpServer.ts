/**
 * A Streamable HTTP MCP server for tests, standing in for a task's own server
 * (`RunSettings.mcpServers`): the tools of `mcpServer.ts`, answered as JSON,
 * behind a bearer token. A request without the token gets 401; `reached` lists
 * the tool calls that got through.
 */
import { Effect, type Scope } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export interface McpHttpServer {
  readonly url: string
  readonly token: string
  readonly reached: () => ReadonlyArray<string>
  /** Requests refused for a missing or wrong token. */
  readonly unauthorized: () => number
}

const tools = [
  { name: "read_note", description: "Read the note.", inputSchema: { type: "object", properties: {} } },
  { name: "send_note", description: "Send the note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
]

export const make: Effect.Effect<McpHttpServer, never, Scope.Scope> = Effect.gen(function* () {
  const token = `tok-${Math.random().toString(36).slice(2)}`
  const reached: Array<string> = []
  let unauthorized = 0
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      unauthorized++
      res.writeHead(401).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405).end()
      return
    }
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      const msg = JSON.parse(body) as { readonly id?: unknown; readonly method: string; readonly params?: Record<string, unknown> }
      if (msg.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
      }
      switch (msg.method) {
        case "initialize":
          return reply({ protocolVersion: msg.params?.["protocolVersion"] ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "task", version: "1.0.0" } })
        case "tools/list":
          return reply({ tools })
        case "tools/call": {
          const name = String(msg.params?.["name"])
          reached.push(name)
          return reply({ content: [{ type: "text", text: `task ${name} ran` }] })
        }
        default:
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no ${msg.method}` } }))
      }
    })
  })
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void))),
    () => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  )
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, token, reached: () => [...reached], unauthorized: () => unauthorized }
})
