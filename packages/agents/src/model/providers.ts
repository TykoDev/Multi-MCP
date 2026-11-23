/**
 * The two provider clients, both non-streaming. The key lives only in each client's closure (its headers and its
 * redactor); a keyless provider gets no credential header at all rather than an empty one.
 */
import {
	clientBase,
	count,
	type ModelClientOptions,
	modelIdsOf,
	type ModelMessage,
	type ModelProviderClient,
	ModelProviderError,
	type ModelTool,
	type ModelTurn,
	plain,
	providerEndpoint,
	providerRequest,
	requestHeaders,
	type ToolCall,
	withoutContentType,
} from './transport.ts';

/** The fixed text a tool call whose arguments were not a JSON object is answered with (never a crash). */
export const ARGUMENTS_NOT_OBJECT = 'Tool arguments were not a JSON object';

/** The Messages API version the Anthropic client speaks; never operator-configurable. */
export const ANTHROPIC_VERSION = '2023-06-01';

function callOf(id: string, name: string, args: Record<string, unknown> | undefined): ToolCall {
	return args === undefined
		? { id, name, arguments: {}, argumentsError: ARGUMENTS_NOT_OBJECT }
		: { id, name, arguments: args };
}

/** A provider's finish reason → the loop's stop; `end` with calls attached is `tool_use` (local servers do this). */
function stopOf(reason: unknown, calls: number, map: Record<string, ModelTurn['stop']>): ModelTurn['stop'] {
	const stop = typeof reason === 'string' && Object.hasOwn(map, reason) ? map[reason] : undefined;
	return calls > 0 && (stop === 'end' || stop === undefined) ? 'tool_use' : stop ?? 'other';
}

// --- OpenAI-compatible chat completions (also Ollama, vLLM, llama.cpp) -------------------------------------------

function openAiMessages(messages: readonly ModelMessage[]): Record<string, unknown>[] {
	return messages.flatMap((message): Record<string, unknown>[] => {
		switch (message.role) {
			case 'system':
			case 'user':
				return [{ role: message.role, content: message.text }];
			case 'assistant':
				return [{
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
				}];
			case 'tool':
				return message.results.map((result) => ({ role: 'tool', tool_call_id: result.id, content: result.text }));
		}
	});
}

/** One `tool_calls[]` entry → a {@linkcode ToolCall}; unparsable arguments are carried as `argumentsError`. */
function openAiCall(value: unknown, index: number): ToolCall {
	const entry = plain(value) ?? {};
	const fn = plain(entry.function) ?? {};
	let args: Record<string, unknown> | undefined;
	if (typeof fn.arguments === 'string') {
		try {
			args = plain(JSON.parse(fn.arguments === '' ? '{}' : fn.arguments));
		} catch {
			args = undefined;
		}
	} else args = plain(fn.arguments);
	return callOf(
		typeof entry.id === 'string' && entry.id !== '' ? entry.id : `call_${index}`,
		typeof fn.name === 'string' ? fn.name : '',
		args,
	);
}

/** A `chat.completion` answer → a {@linkcode ModelTurn}; anything without `choices[0].message` is `malformed`. */
export function openAiTurn(answer: Record<string, unknown>): ModelTurn {
	const choice = Array.isArray(answer.choices) ? plain(answer.choices[0]) : undefined;
	const message = choice === undefined ? undefined : plain(choice.message);
	if (message === undefined) throw new ModelProviderError('malformed', false);
	const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(openAiCall);
	const usage = plain(answer.usage) ?? {};
	return {
		text: typeof message.content === 'string' ? message.content : '',
		toolCalls,
		stop: stopOf(choice?.finish_reason, toolCalls.length, {
			tool_calls: 'tool_use',
			stop: 'end',
			length: 'length',
			content_filter: 'refusal',
		}),
		usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) },
	};
}

/** The client for one OpenAI-compatible provider; `max_tokens_param` picks the output-bound parameter's name. */
export function openAiClient(options: ModelClientOptions): ModelProviderClient {
	const { settings } = options;
	const url = providerEndpoint('openai', settings.baseUrl, 'chat/completions');
	const headers = requestHeaders(
		settings,
		settings.apiKey === null ? {} : { authorization: `Bearer ${settings.apiKey}` },
	);
	return {
		...clientBase(settings),
		kind: 'openai',
		async complete(input, signal): Promise<ModelTurn> {
			const body: Record<string, unknown> = {
				model: input.model,
				messages: openAiMessages(input.messages),
				...(input.tools.length ? { tools: openAiTools(input.tools), tool_choice: 'auto' } : {}),
				[settings.maxTokensParam ?? 'max_tokens']: input.maxOutputTokens,
				stream: false,
			};
			return openAiTurn(await providerRequest(url, headers, body, signal, options));
		},
		async listModels(signal): Promise<string[]> {
			const list = providerEndpoint('openai', settings.baseUrl, 'models');
			return modelIdsOf(await providerRequest(list, withoutContentType(headers), undefined, signal, options));
		},
	};
}

function openAiTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
	}));
}

// --- Anthropic Messages ----------------------------------------------------------------------------------------

/** The system text and the `messages` array; tool results travel as `tool_result` blocks in a user message. */
function anthropicWire(messages: readonly ModelMessage[]): { system: string; messages: Record<string, unknown>[] } {
	const system: string[] = [];
	const out: Record<string, unknown>[] = [];
	for (const message of messages) {
		switch (message.role) {
			case 'system':
				system.push(message.text);
				break;
			case 'user':
				out.push({ role: 'user', content: message.text });
				break;
			case 'assistant': {
				const content: Record<string, unknown>[] = [];
				if (message.text !== '') content.push({ type: 'text', text: message.text });
				for (const call of message.toolCalls) {
					content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
				}
				// The wire refuses an empty assistant turn; one carries nothing the model needs to see again.
				if (content.length) out.push({ role: 'assistant', content });
				break;
			}
			case 'tool':
				out.push({
					role: 'user',
					content: message.results.map((result) => ({
						type: 'tool_result',
						tool_use_id: result.id,
						content: result.text,
						is_error: result.isError,
					})),
				});
				break;
		}
	}
	return { system: system.join('\n\n'), messages: out };
}

/** A `message` answer → a {@linkcode ModelTurn}; anything without a `content` array is `malformed`. */
export function anthropicTurn(answer: Record<string, unknown>): ModelTurn {
	if (!Array.isArray(answer.content)) throw new ModelProviderError('malformed', false);
	const text: string[] = [];
	const toolCalls: ToolCall[] = [];
	answer.content.forEach((item, index) => {
		const block = plain(item);
		if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
		else if (block?.type === 'tool_use') {
			toolCalls.push(callOf(
				typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${index}`,
				typeof block.name === 'string' ? block.name : '',
				plain(block.input),
			));
		}
	});
	const usage = plain(answer.usage) ?? {};
	return {
		text: text.join(''),
		toolCalls,
		stop: stopOf(answer.stop_reason, toolCalls.length, {
			tool_use: 'tool_use',
			end_turn: 'end',
			stop_sequence: 'end',
			max_tokens: 'length',
			refusal: 'refusal',
		}),
		usage: { input: count(usage.input_tokens), output: count(usage.output_tokens) },
	};
}

/** The client for one Anthropic provider (`x-api-key`, pinned `anthropic-version`, `max_tokens`). */
export function anthropicClient(options: ModelClientOptions): ModelProviderClient {
	const { settings } = options;
	const url = providerEndpoint('anthropic', settings.baseUrl, 'messages');
	const headers = requestHeaders(settings, {
		'anthropic-version': ANTHROPIC_VERSION,
		...(settings.apiKey === null ? {} : { 'x-api-key': settings.apiKey }),
	});
	return {
		...clientBase(settings),
		kind: 'anthropic',
		async complete(input, signal): Promise<ModelTurn> {
			const { system, messages } = anthropicWire(input.messages);
			const body: Record<string, unknown> = {
				model: input.model,
				...(system === '' ? {} : { system }),
				messages,
				...(input.tools.length
					? {
						tools: input.tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							input_schema: tool.inputSchema,
						})),
					}
					: {}),
				max_tokens: input.maxOutputTokens,
			};
			return anthropicTurn(await providerRequest(url, headers, body, signal, options));
		},
		// One page of up to 1000 holds every model (the default page is 20).
		async listModels(signal): Promise<string[]> {
			const list = providerEndpoint('anthropic', settings.baseUrl, 'models?limit=1000');
			return modelIdsOf(await providerRequest(list, withoutContentType(headers), undefined, signal, options));
		},
	};
}
