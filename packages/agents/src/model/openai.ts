/**
 * D-143 W2 (backend §2.2): the OpenAI-compatible chat-completions client. `POST {base_url}/chat/completions` (a bare
 * origin gets `/v1` first, E-120: {@linkcode providerEndpoint}),
 * non-streaming, tools as `function` definitions with `tool_choice: 'auto'`. Also the wire of every local server
 * the composer's presets name (Ollama, vLLM, llama.cpp), which is why the key may be absent: a keyless local server
 * gets no `authorization` header at all rather than an empty one.
 *
 * `max_tokens_param` (§3.12, gate F16) decides whether the output bound travels as `max_tokens` (the default, every
 * local server) or `max_completion_tokens` (OpenAI's current name). Nothing else about the body is configurable.
 */
import type { ModelMessage, ModelProviderClient, ModelTool, ModelTurn, ToolCall } from './types.ts';
import {
	clientBase,
	count,
	type ModelClientOptions,
	modelIdsOf,
	ModelProviderError,
	plain,
	providerEndpoint,
	providerRequest,
	requestHeaders,
	withoutContentType,
} from './transport.ts';

/** The fixed text a tool call whose arguments were not a JSON object is answered with (never a crash). */
export const ARGUMENTS_NOT_OBJECT = 'Tool arguments were not a JSON object';

/** The `messages` array as the chat-completions wire takes it. */
function wireMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const message of messages) {
		switch (message.role) {
			case 'system':
				out.push({ role: 'system', content: message.text });
				break;
			case 'user':
				out.push({ role: 'user', content: message.text });
				break;
			case 'assistant':
				out.push({
					role: 'assistant',
					content: message.text === '' ? null : message.text,
					...(message.toolCalls.length
						? {
							tool_calls: message.toolCalls.map((call) => ({
								id: call.id,
								type: 'function',
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							})),
						}
						: {}),
				});
				break;
			case 'tool':
				for (const result of message.results) {
					out.push({ role: 'tool', tool_call_id: result.id, content: result.text });
				}
				break;
		}
	}
	return out;
}

function wireTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

/** One `tool_calls[]` entry → a {@linkcode ToolCall}; unparsable arguments are carried as `argumentsError`. */
function toolCall(value: unknown, index: number): ToolCall {
	const entry = plain(value) ?? {};
	const fn = plain(entry.function) ?? {};
	const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : `call_${index}`;
	const name = typeof fn.name === 'string' ? fn.name : '';
	let args: Record<string, unknown> | undefined;
	if (typeof fn.arguments === 'string') {
		try {
			args = plain(JSON.parse(fn.arguments === '' ? '{}' : fn.arguments));
		} catch {
			args = undefined;
		}
	} else args = plain(fn.arguments);
	return args === undefined
		? { id, name, arguments: {}, argumentsError: ARGUMENTS_NOT_OBJECT }
		: { id, name, arguments: args };
}

function stopOf(reason: unknown, calls: number): ModelTurn['stop'] {
	switch (reason) {
		case 'tool_calls':
			return 'tool_use';
		case 'stop':
			// A local server may say `stop` with calls attached; the calls are what the loop must act on.
			return calls > 0 ? 'tool_use' : 'end';
		case 'length':
			return 'length';
		case 'content_filter':
			return 'refusal';
		default:
			return calls > 0 ? 'tool_use' : 'other';
	}
}

/** A `chat.completion` answer → a {@linkcode ModelTurn}; anything without `choices[0].message` is `malformed`. */
export function openAiTurn(answer: Record<string, unknown>): ModelTurn {
	const choice = Array.isArray(answer.choices) ? plain(answer.choices[0]) : undefined;
	const message = choice === undefined ? undefined : plain(choice.message);
	if (message === undefined) throw new ModelProviderError('malformed', false);
	const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(toolCall);
	const usage = plain(answer.usage) ?? {};
	return {
		text: typeof message.content === 'string' ? message.content : '',
		toolCalls,
		stop: stopOf(choice?.finish_reason, toolCalls.length),
		usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) },
	};
}

/** Builds the client for one OpenAI-compatible provider. The key lives in the closure's headers and the redactor. */
export function openAiClient(options: ModelClientOptions): ModelProviderClient {
	const { settings } = options;
	const url = providerEndpoint('openai', settings.baseUrl, 'chat/completions');
	const headers = requestHeaders(
		settings,
		settings.apiKey === null ? {} : { authorization: `Bearer ${settings.apiKey}` },
	);
	const tokenParam = settings.maxTokensParam ?? 'max_tokens';
	return {
		...clientBase(settings),
		kind: 'openai',
		async complete(input, signal): Promise<ModelTurn> {
			const body: Record<string, unknown> = {
				model: input.model,
				messages: wireMessages(input.messages),
				...(input.tools.length ? { tools: wireTools(input.tools), tool_choice: 'auto' } : {}),
				[tokenParam]: input.maxOutputTokens,
				stream: false,
			};
			return openAiTurn(await providerRequest(url, headers, body, signal, options));
		}, // D-158: the provider's model list, for the control plane's picker; a GET carries no body, so no content-type.
		async listModels(signal): Promise<string[]> {
			const list = providerEndpoint('openai', settings.baseUrl, 'models');
			return modelIdsOf(await providerRequest(list, withoutContentType(headers), undefined, signal, options));
		},
	};
}
