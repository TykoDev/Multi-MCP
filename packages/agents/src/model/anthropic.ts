/**
 * D-143 W2 (backend §2.2): the Anthropic Messages client. `POST {base_url}/v1/messages` (`/v1` only when the base
 * URL does not already end in it, E-120: {@linkcode providerEndpoint}) with `x-api-key` and the
 * pinned `anthropic-version`, non-streaming; the system prompt travels as the top-level `system`, tools as
 * `input_schema` definitions, tool calls as `tool_use` blocks and their answers as `tool_result` blocks inside a user
 * message. `max_tokens` is always the parameter (§3.12). The parser refuses an Anthropic provider without a key, so
 * the header is always present in practice; a missing key still produces no header rather than an empty one.
 */
import type { ModelMessage, ModelProviderClient, ModelTool, ModelTurn, ToolCall } from './types.ts';
import { ARGUMENTS_NOT_OBJECT } from './openai.ts';
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

/** The Messages API version this client speaks; a constant, never operator-configurable. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** The system text and the `messages` array as the Messages wire takes them. */
function wire(messages: readonly ModelMessage[]): { system: string; messages: Record<string, unknown>[] } {
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

function wireTools(tools: readonly ModelTool[]): Record<string, unknown>[] {
	return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
}

function stopOf(reason: unknown, calls: number): ModelTurn['stop'] {
	switch (reason) {
		case 'tool_use':
			return 'tool_use';
		case 'end_turn':
		case 'stop_sequence':
			return calls > 0 ? 'tool_use' : 'end';
		case 'max_tokens':
			return 'length';
		case 'refusal':
			return 'refusal';
		default:
			return calls > 0 ? 'tool_use' : 'other';
	}
}

/** A `message` answer → a {@linkcode ModelTurn}; anything without a `content` array is `malformed`. */
export function anthropicTurn(answer: Record<string, unknown>): ModelTurn {
	if (!Array.isArray(answer.content)) throw new ModelProviderError('malformed', false);
	const text: string[] = [];
	const toolCalls: ToolCall[] = [];
	answer.content.forEach((item, index) => {
		const block = plain(item);
		if (block === undefined) return;
		if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
		else if (block.type === 'tool_use') {
			const id = typeof block.id === 'string' && block.id !== '' ? block.id : `toolu_${index}`;
			const name = typeof block.name === 'string' ? block.name : '';
			const input = plain(block.input);
			toolCalls.push(
				input === undefined
					? { id, name, arguments: {}, argumentsError: ARGUMENTS_NOT_OBJECT }
					: { id, name, arguments: input },
			);
		}
	});
	const usage = plain(answer.usage) ?? {};
	return {
		text: text.join(''),
		toolCalls,
		stop: stopOf(answer.stop_reason, toolCalls.length),
		usage: { input: count(usage.input_tokens), output: count(usage.output_tokens) },
	};
}

/** Builds the client for one Anthropic provider. The key lives in the closure's headers and the redactor. */
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
			const { system, messages } = wire(input.messages);
			const body: Record<string, unknown> = {
				model: input.model,
				...(system === '' ? {} : { system }),
				messages,
				...(input.tools.length ? { tools: wireTools(input.tools) } : {}),
				max_tokens: input.maxOutputTokens,
			};
			return anthropicTurn(await providerRequest(url, headers, body, signal, options));
		}, // D-158: the provider's model list, for the control plane's picker; a GET carries no body, so no content-type. Anthropic pages its list at 20 by default; one page of up to 1000 holds every model it serves.
		async listModels(signal): Promise<string[]> {
			const list = providerEndpoint('anthropic', settings.baseUrl, 'models?limit=1000');
			return modelIdsOf(await providerRequest(list, withoutContentType(headers), undefined, signal, options));
		},
	};
}
