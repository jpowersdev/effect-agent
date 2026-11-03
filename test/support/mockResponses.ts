/**
 * A local stand-in for the Responses API, for driving a real `codex app-server`
 * with no account and no tokens. Each request takes the next scripted item
 * (then a plain "done" message) and is kept, so a test can read the tools the
 * model was offered and the input it was sent.
 */
import { Effect, Scope } from "effect"
import { createServer } from "node:http"

/** A tool call or message, as the API streams it. */
export type ResponseItem = Readonly<Record<string, unknown>>

export const functionCall = (name: string, args: unknown, options: { readonly callId?: string; readonly namespace?: string } = {}): ResponseItem => ({
  type: "function_call",
  id: "fc1",
  call_id: options.callId ?? "call_1",
  name,
  ...(options.namespace !== undefined && { namespace: options.namespace }),
  arguments: JSON.stringify(args),
})

export const applyPatch = (input: string): ResponseItem => ({ type: "custom_tool_call", id: "ct1", call_id: "call_1", name: "apply_patch", input })

interface Tool {
  readonly name?: string
  readonly type?: string
  readonly tools?: ReadonlyArray<Tool>
}

const toolNames = (tool: Tool): ReadonlyArray<string> =>
  tool.tools !== undefined ? tool.tools.map((t) => `${tool.name}/${t.name}`) : [tool.name ?? tool.type ?? "?"]

export interface ModelRequest {
  /** `namespace/name` for a tool in a namespace. */
  readonly tools: ReadonlyArray<string>
  readonly input: ReadonlyArray<Record<string, unknown>>
}

export interface MockResponses {
  readonly requests: Array<ModelRequest>
  /** Items for the next requests. */
  readonly script: Array<ResponseItem>
  /** `-c` flags that point app-server at this server. */
  readonly args: ReadonlyArray<string>
}

const sse = (events: ReadonlyArray<{ readonly type: string }>) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }

/** The tool outputs sent to the model so far. */
export const toolOutputs = (mock: MockResponses): ReadonlyArray<string> =>
  mock.requests
    .at(-1)!
    .input.filter((item) => typeof item.type === "string" && item.type.endsWith("call_output"))
    .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output)))

export const make: Effect.Effect<MockResponses, never, Scope.Scope> = Effect.acquireRelease(
  Effect.callback<{ readonly mock: MockResponses; readonly close: () => void }>((resume) => {
    const requests: Array<ModelRequest> = []
    const script: Array<ResponseItem> = []
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (d) => (body += d))
      req.on("end", () => {
        if (!req.url?.includes("/responses")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(`{"models":[]}`)
          return
        }
        const parsed = JSON.parse(body) as { tools?: ReadonlyArray<Tool>; input?: ModelRequest["input"] }
        requests.push({ tools: (parsed.tools ?? []).flatMap(toolNames), input: parsed.input ?? [] })
        const id = `r${requests.length}`
        const item = script.shift() ?? { type: "message", role: "assistant", id: `m${requests.length}`, content: [{ type: "output_text", text: "done" }] }
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.end(
          sse([
            { type: "response.created", response: { id } } as { type: string },
            { type: "response.output_item.done", item } as { type: string },
            { type: "response.completed", response: { id, usage } } as { type: string },
          ]),
        )
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { readonly port: number }
      const args = [
        "-c",
        `model_provider="mock"`,
        "-c",
        `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
      ]
      resume(Effect.succeed({ mock: { requests, script, args }, close: () => void server.close() }))
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ mock }) => mock))
