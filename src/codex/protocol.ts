/**
 * Minimal hand-written subset of the `codex app-server` JSON-RPC protocol:
 * only the methods, notifications and fields effect-agent uses.
 *
 * Derived from codex-cli 0.162.1 via
 * `codex app-server generate-ts --experimental` (the `v2/` types). Shapes
 * the server sends are typed loosely (optional/unknown where we don't
 * depend on a field) so newer servers keep working.
 *
 * Every wire name the codex provider uses (methods, error kinds, item types,
 * statuses) is written here, so `scripts/codex-protocol.ts` can check this
 * file against a codex release (see UPGRADING.md).
 *
 * Wire format: newline-delimited JSON-RPC 2.0 without the `jsonrpc` field.
 */

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

export type RequestId = string | number

export interface RpcErrorBody {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** Any frame on the wire. */
export interface Message {
  readonly id?: RequestId
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: RpcErrorBody
  readonly emittedAtMs?: number
}

export interface Notification {
  readonly method: string
  readonly params?: unknown
  readonly emittedAtMs?: number
}

export interface ServerRequest {
  readonly id: RequestId
  readonly method: string
  readonly params?: unknown
}

/** A notification or a server-to-client request, in arrival order. */
export type Incoming = Notification | ServerRequest

export const isResponse = (m: Message): boolean => m.id !== undefined && m.method === undefined
export const isServerRequest = (m: Message): m is ServerRequest => m.id !== undefined && m.method !== undefined
export const isNotification = (m: Message): m is Notification => m.id === undefined && m.method !== undefined

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | (string & {})
export type AskForApproval = "untrusted" | "on-request" | "never"

export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export interface TextInput {
  readonly type: "text"
  readonly text: string
  /** Always empty: effect-agent sends plain text. */
  readonly text_elements: ReadonlyArray<never>
}
export type UserInput = TextInput

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress"

/** Open enum: a string tag, or a single-key object such as `{ responseStreamDisconnected: {...} }`. */
export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "rateLimitExceeded"
  | "serverOverloaded"
  | "unauthorized"
  | "internalServerError"
  | "badRequest"
  | "other"
  | (string & {})
  | { readonly [key: string]: unknown }

/** The `codexErrorInfo` kinds effect-agent names: a string tag, or the key of an object variant. */
export type CodexErrorKind =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "rateLimitExceeded"
  | "serverOverloaded"
  | "unauthorized"
  | "internalServerError"
  | "badRequest"
  | "other"
  | "responseStreamDisconnected"
  | "responseTooManyFailedAttempts"

export interface TurnError {
  readonly message: string
  readonly codexErrorInfo: CodexErrorInfo | null
  readonly additionalDetails: string | null
}

export type TurnItemsView = "notLoaded" | "summary" | "full"

export interface Turn {
  readonly id: string
  readonly items: ReadonlyArray<ThreadItem>
  /** How much of `items` is loaded (stored turns from `thread/turns/list`). */
  readonly itemsView?: TurnItemsView
  readonly status: TurnStatus
  readonly error: TurnError | null
  readonly startedAt?: number | null
  readonly completedAt?: number | null
  readonly durationMs?: number | null
}

export interface Thread {
  readonly id: string
  readonly path: string | null
  readonly model?: string | null
  readonly ephemeral?: boolean
  readonly cliVersion?: string
  readonly cwd?: string
}

export type MessagePhase = "commentary" | "partial_answer" | "final_answer"

export interface CommandAction {
  readonly type: string
  readonly command: string
}

export type ThreadItem =
  | { readonly type: "userMessage"; readonly id: string; readonly clientId: string | null; readonly content: ReadonlyArray<unknown> }
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string; readonly phase: MessagePhase | null }
  | { readonly type: "reasoning"; readonly id: string }
  | {
      readonly type: "commandExecution"
      readonly id: string
      readonly command: string
      readonly cwd: string
      readonly processId: string | null
      readonly status: "inProgress" | "completed" | "failed" | "declined"
      readonly commandActions: ReadonlyArray<CommandAction>
      readonly aggregatedOutput: string | null
      readonly exitCode: number | null
    }
  | {
      readonly type: "fileChange"
      readonly id: string
      readonly changes: ReadonlyArray<{ readonly path: string; readonly kind: unknown; readonly diff: string }>
      readonly status: "inProgress" | "completed" | "failed" | "declined"
    }
  | {
      readonly type: "mcpToolCall"
      readonly id: string
      readonly server: string
      readonly tool: string
      readonly status: "inProgress" | "completed" | "failed"
      readonly arguments: unknown
      readonly result: { readonly content: ReadonlyArray<unknown>; readonly structuredContent: unknown } | null
      readonly error: { readonly message: string } | null
    }
  | {
      readonly type: "dynamicToolCall"
      readonly id: string
      readonly namespace: string | null
      readonly tool: string
      readonly arguments: unknown
      readonly status: "inProgress" | "completed" | "failed"
      readonly contentItems: ReadonlyArray<{ readonly type: string; readonly text?: string }> | null
      readonly success: boolean | null
    }
  | {
      readonly type: "webSearch"
      readonly id: string
      readonly query: string
      readonly action: unknown
      readonly results: ReadonlyArray<unknown> | null
    }
  | {
      readonly type: "collabAgentToolCall"
      readonly id: string
      readonly tool: string
      readonly status: string
      readonly prompt: string | null
    }
  | { readonly type: "contextCompaction"; readonly id: string }
  | { readonly type: string & {}; readonly id: string; readonly [key: string]: unknown }

/** A `ThreadItem` of a type named above (the open variant keeps `item.type === ...` from narrowing). */
export const isItem = <T extends ThreadItem["type"]>(item: ThreadItem, type: T): item is Extract<ThreadItem, { readonly type: T }> =>
  item.type === type

export interface TokenUsageBreakdown {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteInputTokens?: number
  /** Includes `reasoningOutputTokens`. */
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  readonly total: TokenUsageBreakdown
  readonly last: TokenUsageBreakdown
  readonly modelContextWindow: number | null
}

export interface RateLimitWindow {
  /** 0 to 100. */
  readonly usedPercent: number
  readonly windowDurationMins: number | null
  /** Unix seconds. */
  readonly resetsAt: number | null
}

export interface CreditsSnapshot {
  readonly hasCredits: boolean
  readonly unlimited: boolean
  readonly balance: string | null
}

export interface RateLimitSnapshot {
  readonly limitId: string | null
  readonly limitName?: string | null
  readonly primary: RateLimitWindow | null
  readonly secondary: RateLimitWindow | null
  readonly credits: CreditsSnapshot | null
  /** Backend spend control (workspace budget) exhausted. Null/absent: unknown. */
  readonly spendControlReached?: boolean | null
  readonly planType?: string | null
  /** e.g. `rate_limit_reached`, `workspace_member_usage_limit_reached`. */
  readonly rateLimitReachedType: string | null
}

// ---------------------------------------------------------------------------
// Client -> server requests
// ---------------------------------------------------------------------------

export interface InitializeParams {
  readonly clientInfo: { readonly name: string; readonly title: string | null; readonly version: string }
  readonly capabilities: {
    readonly experimentalApi: boolean
    readonly requestAttestation: boolean
    readonly optOutNotificationMethods?: ReadonlyArray<string>
  }
}

export interface InitializeResponse {
  /** e.g. `effect_agent/0.162.1 (NixOS 26.11.0; x86_64) unknown (effect_agent; 0.0.0)` */
  readonly userAgent: string
  readonly codexHome?: string
  readonly platformFamily?: string
  readonly platformOs?: string
}

/** Params shared by `thread/start` and `thread/resume`. */
export interface ThreadOverrides {
  readonly cwd?: string
  readonly model?: string
  readonly approvalPolicy?: AskForApproval
  readonly sandbox?: SandboxMode
  /** Dotted config.toml keys, e.g. `"features.apps": false`. */
  readonly config?: Readonly<Record<string, JsonValue>>
  /** Appended to the built-in instructions (never use `baseInstructions`, which replaces them). */
  readonly developerInstructions?: string
}

export interface ThreadStartParams extends ThreadOverrides {
  readonly ephemeral?: boolean
}

export interface ThreadResumeParams extends ThreadOverrides {
  readonly threadId: string
  readonly excludeTurns?: boolean
}

export interface ThreadStartResponse {
  readonly thread: Thread
  readonly model: string
  readonly reasoningEffort?: ReasoningEffort | null
  readonly cwd?: string
}
export type ThreadResumeResponse = ThreadStartResponse

export interface TurnStartParams {
  readonly threadId: string
  readonly input: ReadonlyArray<UserInput>
  /** Echoed back as `clientId` on the `userMessage` item. */
  readonly clientUserMessageId?: string
  readonly effort?: ReasoningEffort
}
export interface TurnStartResponse {
  readonly turn: Turn
}

export interface TurnSteerParams {
  readonly threadId: string
  readonly input: ReadonlyArray<UserInput>
  readonly expectedTurnId: string
  readonly clientUserMessageId?: string
}
export interface TurnSteerResponse {
  readonly turnId: string
}

export interface TurnInterruptParams {
  readonly threadId: string
  readonly turnId: string
}

export interface GetAccountRateLimitsResponse {
  /** Null means unavailable. */
  readonly ordinaryUsageAllowed: boolean | null
  readonly rateLimits: RateLimitSnapshot
  readonly rateLimitsByLimitId?: Readonly<Partial<Record<string, RateLimitSnapshot>>> | null
}

export type Account =
  | { readonly type: "apiKey" }
  | { readonly type: "chatgpt"; readonly email: string | null; readonly planType: string }
  | { readonly type: "amazonBedrock"; readonly usesCodexManagedCredentials: boolean }
  | { readonly type: string & {}; readonly planType?: string | null }

export interface GetAccountResponse {
  /** Null when not signed in. */
  readonly account: Account | null
  /** Whether the configured model provider needs an OpenAI sign-in at all. */
  readonly requiresOpenaiAuth: boolean
}

export type SortDirection = "asc" | "desc"

export interface ThreadTurnsListParams {
  readonly threadId: string
  readonly cursor?: string | null
  readonly limit?: number | null
  /** Default `desc`. */
  readonly sortDirection?: SortDirection | null
  /** Default `summary`. */
  readonly itemsView?: TurnItemsView | null
}
export interface ThreadTurnsListResponse {
  readonly data: ReadonlyArray<Turn>
  readonly nextCursor: string | null
}

export interface BackgroundTerminal {
  readonly itemId: string
  readonly processId: string
  readonly command: string
  readonly osPid?: number | null
}
export interface BackgroundTerminalsListResponse {
  readonly data: ReadonlyArray<BackgroundTerminal>
  readonly nextCursor: string | null
}

export interface ClientRequests {
  readonly initialize: { readonly params: InitializeParams; readonly result: InitializeResponse }
  readonly "thread/start": { readonly params: ThreadStartParams; readonly result: ThreadStartResponse }
  readonly "thread/resume": { readonly params: ThreadResumeParams; readonly result: ThreadResumeResponse }
  readonly "thread/unsubscribe": { readonly params: { readonly threadId: string }; readonly result: unknown }
  readonly "turn/start": { readonly params: TurnStartParams; readonly result: TurnStartResponse }
  readonly "turn/steer": { readonly params: TurnSteerParams; readonly result: TurnSteerResponse }
  readonly "turn/interrupt": { readonly params: TurnInterruptParams; readonly result: unknown }
  readonly "account/rateLimits/read": { readonly params: undefined; readonly result: GetAccountRateLimitsResponse }
  readonly "account/read": { readonly params: { readonly refreshToken?: boolean }; readonly result: GetAccountResponse }
  /**
   * Stored turns of a thread, loaded or not (reads the rollout; no
   * `thread/resume` needed). Unknown ids fail `thread not loaded: <id>`.
   */
  readonly "thread/turns/list": { readonly params: ThreadTurnsListParams; readonly result: ThreadTurnsListResponse }
  /** EXPERIMENTAL. */
  readonly "thread/backgroundTerminals/list": {
    readonly params: { readonly threadId: string; readonly cursor?: string | null }
    readonly result: BackgroundTerminalsListResponse
  }
  /** EXPERIMENTAL. Kills the terminal's process (verified on 0.162.1). */
  readonly "thread/backgroundTerminals/terminate": {
    readonly params: { readonly threadId: string; readonly processId: string }
    readonly result: { readonly terminated: boolean }
  }
}
export type ClientMethod = keyof ClientRequests

// ---------------------------------------------------------------------------
// Server -> client notifications (params)
// ---------------------------------------------------------------------------

/**
 * The notifications effect-agent names: read, throttled into heartbeats, or
 * opted out of. Every other notification maps to an `Other` event.
 */
export type NotificationMethod =
  | "turn/started"
  | "turn/completed"
  | "item/started"
  | "item/completed"
  | "thread/tokenUsage/updated"
  | "account/rateLimits/updated"
  | "error"
  // heartbeats
  | "item/agentMessage/delta"
  | "item/reasoning/textDelta"
  | "item/reasoning/summaryTextDelta"
  | "item/reasoning/summaryPartAdded"
  | "item/commandExecution/outputDelta"
  | "item/fileChange/outputDelta"
  | "item/plan/delta"
  | "item/mcpToolCall/progress"
  | "turn/plan/updated"
  | "turn/diff/updated"
  // opted out of
  | "turn/moderationMetadata"
  | "remoteControl/status/changed"
  | "rawResponse/completed"
  | "rawResponseItem/completed"

export interface TurnNotification {
  readonly threadId: string
  readonly turn: Turn
}
export interface ItemNotification {
  readonly threadId: string
  readonly turnId: string
  readonly item: ThreadItem
}
export interface TokenUsageNotification {
  readonly threadId: string
  readonly turnId: string
  readonly tokenUsage: ThreadTokenUsage
}
export interface ErrorNotification {
  readonly threadId: string
  readonly turnId: string
  readonly error: TurnError
  readonly willRetry: boolean
}
export interface RateLimitsUpdatedNotification {
  readonly rateLimits: RateLimitSnapshot
}

// ---------------------------------------------------------------------------
// Server -> client requests we answer
// ---------------------------------------------------------------------------

export const ServerRequestMethods = {
  commandApproval: "item/commandExecution/requestApproval",
  fileChangeApproval: "item/fileChange/requestApproval",
  permissionsApproval: "item/permissions/requestApproval",
  legacyExecApproval: "execCommandApproval",
  legacyPatchApproval: "applyPatchApproval",
  requestUserInput: "item/tool/requestUserInput",
  mcpElicitation: "mcpServer/elicitation/request",
} as const

/** Answer to `commandApproval` and `fileChangeApproval`. */
export interface ApprovalDeclined {
  readonly decision: "decline"
}
/** Answer to `legacyExecApproval` and `legacyPatchApproval`. */
export interface LegacyApprovalAborted {
  readonly decision: "abort"
}
/** Answer to `requestUserInput`: no answers. */
export interface UserInputAnswers {
  readonly answers: Readonly<Record<string, never>>
}
/** Answer to `mcpElicitation`. */
export interface ElicitationDeclined {
  readonly action: "decline"
  readonly content: null
  readonly _meta: null
}

/** JSON-RPC "method not found". */
export const METHOD_NOT_FOUND = -32601
/** What app-server uses for invalid requests (unknown thread, stale steer, ...). */
export const INVALID_REQUEST = -32600
