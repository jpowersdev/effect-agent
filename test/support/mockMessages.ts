/**
 * A local stand-in for the Messages API, for driving the real Claude CLI with
 * no account and no tokens. Each main-loop request takes the next scripted tool
 * call (then a plain "done") and is kept, so a test can read the tools the model
 * was offered and the messages it was sent. The CLI's helper requests get a
 * minimal answer.
 */
import { Effect, Scope } from "effect"
import { createServer, type ServerResponse } from "node:http"

export interface ToolCall {
  readonly name: string
  readonly input: unknown
}

export interface MessagesRequest {
  readonly tools: ReadonlyArray<string>
  readonly messages: ReadonlyArray<unknown>
}

export interface MockMessages {
  readonly requests: Array<MessagesRequest>
  /** Tool calls for the next requests. */
  readonly script: Array<ToolCall>
  readonly baseUrl: string
}

const stream = (res: ServerResponse, call: ToolCall | undefined, n: number) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send("message_start", {
    message: { id: `msg_${n}`, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  if (call !== undefined) {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name: call.name, input: {} } })
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } })
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } })
  }
  send("content_block_stop", { index: 0 })
  send("message_delta", { delta: { stop_reason: call !== undefined ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
  send("message_stop", {})
  res.end()
}

export const make: Effect.Effect<MockMessages, never, Scope.Scope> = Effect.acquireRelease(
  Effect.callback<{ readonly mock: MockMessages; readonly close: () => void }>((resume) => {
    const requests: Array<MessagesRequest> = []
    const script: Array<ToolCall> = []
    const json = (res: ServerResponse, value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(value))
    }
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        if (!req.url?.includes("/v1/messages") || req.url.includes("count_tokens")) return json(res, { input_tokens: 1 })
        const parsed = JSON.parse(body) as { stream?: boolean; model: string; tools?: ReadonlyArray<{ readonly name: string }>; messages?: ReadonlyArray<unknown> }
        const tools = (parsed.tools ?? []).map((t) => t.name)
        if (parsed.stream !== true || !tools.includes("Read")) {
          if (parsed.stream === true) return stream(res, undefined, 0)
          return json(res, { id: "m", type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
        }
        requests.push({ tools, messages: parsed.messages ?? [] })
        stream(res, script.shift(), requests.length)
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { readonly port: number }
      resume(Effect.succeed({ mock: { requests, script, baseUrl: `http://127.0.0.1:${port}` }, close: () => {
        server.close()
        server.closeAllConnections()
      } }))
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ mock }) => mock))
