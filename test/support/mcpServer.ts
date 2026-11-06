/**
 * A stdio MCP server with harmless tools, standing in for the machine's own
 * MCP setup so that no test can reach a real one. Each call to a tool or a
 * resource appends its name to the file in `MCP_FIXTURE_LOG`, so a test can
 * tell a refused call (never reached the server) from one that ran.
 *
 *   node test/support/mcpServer.ts
 */
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const log = (what: string) => {
  const path = process.env["MCP_FIXTURE_LOG"]
  if (path !== undefined) appendFileSync(path, `${what}\n`)
}

const tools = [
  { name: "read_note", description: "Read the note.", inputSchema: { type: "object", properties: {} } },
  { name: "send_note", description: "Send the note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
]

const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line) as { readonly id?: unknown; readonly method: string; readonly params?: Record<string, unknown> }
  if (msg.id === undefined) return
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.["protocolVersion"] ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      })
    case "tools/list":
      return reply(msg.id, { tools })
    case "tools/call": {
      const name = String(msg.params?.["name"])
      log(name)
      return reply(msg.id, { content: [{ type: "text", text: `${name} ran` }] })
    }
    case "resources/list":
      return reply(msg.id, { resources: [{ uri: "note://inbox", name: "inbox", mimeType: "text/plain" }] })
    case "resources/templates/list":
      return reply(msg.id, { resourceTemplates: [] })
    case "resources/read":
      log("resources/read")
      return reply(msg.id, { contents: [{ uri: "note://inbox", mimeType: "text/plain", text: "the inbox" }] })
    default:
      return process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })}\n`)
  }
})
