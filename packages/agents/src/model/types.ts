/**
 * D-143 (model-providers-ui): the contract between the built-in model agent's loop and a provider client
 * (backend design §2.2). S0 laid the interfaces; W2 added the fields the clients and the loop need (`bounds`,
 * `redact`, `argumentsError`, {@linkcode ModelClientSettings}) and kept every S0 name. The gateway builds one client
 * per configured provider and hands them to `AgentRuntime` through `AgentRuntimeOptions.model`, so this package never
 * imports gateway code.
 */

/** One MCP tool as the provider sees it: its name, description and JSON Schema input, nothing of its scope. */
export interface ModelTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** A tool call the model asked for, with the provider's own id so its result can be matched back. */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
	/**
	 * W2 (backend §2.2): set when the provider's arguments were not a JSON object. The call is kept so its id can be
	 * answered — the loop answers it with an `isError` tool result and never invokes anything — rather than crashing
	 * the task on a malformed turn.
	 */
	readonly argumentsError?: string;
}

/** The outcome of one {@linkcode ToolCall}: the tool's text (capped by the loop) and whether it failed. */
export interface ToolResultMessage {
	readonly id: string;
	readonly text: string;
	readonly isError: boolean;
}

/** The transcript in a wire-neutral shape; each client maps it to its provider's own format. */
export type ModelMessage =
	| { readonly role: 'system'; readonly text: string }
	| { readonly role: 'user'; readonly text: string }
	| { readonly role: 'assistant'; readonly text: string; readonly toolCalls: ToolCall[] }
	| { readonly role: 'tool'; readonly results: ToolResultMessage[] };

/** One complete assistant turn (non-streaming per step, §2.2): the loop acts only on a whole turn. */
export interface ModelTurn {
	readonly text: string;
	readonly toolCalls: ToolCall[];
	readonly stop: 'end' | 'tool_use' | 'length' | 'refusal' | 'other';
	readonly usage: { readonly input: number; readonly output: number };
}

/** The per-provider loop bounds (backend §2.1 `max_steps`, `max_output_tokens`, `token_budget`). */
export interface ModelBounds {
	readonly maxSteps: number;
	readonly maxOutputTokens: number;
	readonly tokenBudget: number;
}

/** A configured provider, ready to dial. The settings (key included) stay inside the client; nothing here reads them. */
export interface ModelProviderClient {
	readonly id: string;
	readonly kind: 'openai' | 'anthropic';
	readonly models: readonly string[];
	readonly defaultModel: string;
	/** W2: the loop's bounds for this provider; absent (a test fake) means the loop's defaults. */
	readonly bounds?: ModelBounds;
	/**
	 * W2 (§3.12, gate F12): strips this provider's key out of text the loop is about to emit — events, artifacts,
	 * history, `tasks.json`. The key never leaves the client: the loop hands text in and gets `[REDACTED]` back. Absent
	 * (a test fake) means nothing to redact.
	 */
	readonly redact?: (text: string) => string;
	/**
	 * D-158: the model ids the provider lists (`GET …/models`), for the control plane's model picker — never the loop's.
	 * Same transport and bounds as `complete`. Absent (a test fake) means the provider cannot list.
	 */
	listModels?(signal: AbortSignal): Promise<string[]>;
	complete(
		input: {
			readonly model: string;
			readonly messages: ModelMessage[];
			readonly tools: ModelTool[];
			readonly maxOutputTokens: number;
		},
		signal: AbortSignal,
	): Promise<ModelTurn>;
}

/**
 * W2: what a client is built from — structurally a subset of the gateway's `ModelProviderSettings`
 * (`packages/gateway/src/model_providers.ts`), so the gateway passes its resolved settings straight through. `apiKey`
 * is the only secret: it goes into one request header and into {@linkcode ModelProviderClient.redact}, nowhere else.
 */
export interface ModelClientSettings {
	readonly id: string;
	/** As the file admitted it, trailing slash stripped; `providerEndpoint` (E-120) resolves each call's URL from it. */
	readonly baseUrl: string;
	readonly models: readonly string[];
	readonly defaultModel: string;
	readonly apiKey: string | null;
	/** Operator headers, already refused the credential names at parse; sent as given, the key header set after them. */
	readonly headers?: Readonly<Record<string, string>>;
	/** §3.12 (gate F16), OpenAI only: which output-token parameter the wire takes; `max_tokens` by default. */
	readonly maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
	readonly maxSteps?: number;
	readonly maxOutputTokens?: number;
	readonly tokenBudget?: number;
}
