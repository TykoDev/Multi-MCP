/**
 * @module
 * The client half of MCP sampling, for the sampling suites. In MCP the client owns the model, so these responders
 * are the real architecture — and they read the prompt: every answer is derived from the real page text the server
 * sent, so a broken observation pipeline fails the tests. When a model is configured (`scripts/model_endpoint.ts`),
 * the same prompts also go to a real one.
 */
import type { SamplingResponder } from './harness.ts';
import { describeEndpoint, type ModelEndpoint, resolveModelEndpoint } from '../../scripts/model_endpoint.ts';

type Reply = Awaited<ReturnType<SamplingResponder>>;

const reply = (model: string, text: string): Reply => ({ model, role: 'assistant', content: { type: 'text', text } });
const promptOf = (request: Parameters<SamplingResponder>[0]): string =>
	(request.params.messages.at(-1)?.content as { text?: string } | undefined)?.text ?? '';

/** Answers extraction questions from the page in the prompt, and says NOT-FOUND loudly otherwise. */
export function extractionResponder(): SamplingResponder {
	return (request) => {
		const prompt = promptOf(request);
		const question = /Question:\s*(.*)$/s.exec(prompt)?.[1]?.trim() ?? '';
		// The serializer emits one line per text node, so the patterns tolerate newlines; table values anchor on ids.
		const answers: Array<[RegExp, RegExp]> = [
			[/revenue/i, /revenue of\s+([\s\S]+?)\s+for the third quarter/i],
			[/chief executive|ceo/i, /chief executive is\s+([A-Z][a-z]+ [A-Z][a-z]+)/],
			[/headquarter|based/i, /id=hq[^>]*>\s*([A-Za-z]+)/],
			[/employee/i, /id=emp[^>]*>\s*([0-9]+)/],
			[/nonce/i, /Run nonce ([0-9a-f]+)/], // proof the responder saw this run's page
		];
		const found = answers.find(([asks, finds]) => asks.test(question) && finds.test(prompt));
		const text = found?.[1].exec(prompt)?.[1]?.trim() ??
			`NOT-FOUND: the page did not answer ${JSON.stringify(question)}`;
		return Promise.resolve(reply('fixture-responder', text));
	};
}

/** A deterministic policy over the live element list: it picks each action from what the page shows now. */
export function agentResponder(): SamplingResponder {
	return (request) => {
		const prompt = promptOf(request);
		const task = /^Task:\s*(.*)$/m.exec(prompt)?.[1]?.trim() ?? '';
		const elements = prompt.split('\n').flatMap((line) => {
			const match = /^\s{2}(\d+): ([a-z0-9-]+)(?: \[([^\]]*)\])?(?: -> (\S+))?\s*$/.exec(line);
			return match === null ? [] : [{ index: Number(match[1]), tag: match[2] ?? '', href: match[4] ?? '' }];
		});
		const page = prompt.slice(prompt.indexOf('Page:'));
		const act = (action: Record<string, unknown>) => Promise.resolve(reply('fixture-agent', JSON.stringify(action)));

		if (/press the button/i.test(task)) {
			const clicked = /clicked-([0-9a-f]+)/.exec(page)?.[0];
			if (clicked !== undefined) return act({ action: 'done', answer: clicked });
			const button = elements.find((element) => element.tag === 'button');
			if (button === undefined) return act({ action: 'done', answer: 'no button on this page' });
			return act({ thought: 'the button is the only control', action: 'click', index: button.index });
		}
		if (/go to the second page/i.test(task)) {
			if (/arrived-at-second/.test(page)) return act({ action: 'done', answer: 'arrived-at-second' });
			const link = elements.find((element) => element.href.includes('/second'));
			return act(
				link === undefined ? { action: 'done', answer: 'no link to the second page' } : {
					action: 'click',
					index: link.index,
				},
			);
		}
		if (/type .* into the field/i.test(task)) {
			const wanted = /type "([^"]+)"/i.exec(task)?.[1] ?? 'hello';
			if (page.includes(wanted)) return act({ action: 'done', answer: wanted });
			const field = elements.find((element) => element.tag === 'input');
			if (field === undefined) return act({ action: 'done', answer: 'no field on this page' });
			return act({ action: 'type', index: field.index, text: wanted, clear: true });
		}
		if (/impossible/i.test(task)) return act({ action: 'click', index: 999 }); // the loop must give up
		return act({ action: 'done', answer: `no policy for ${JSON.stringify(task)}` });
	};
}

/** A responder whose replies are never valid JSON, for the malformed-reply path. */
export function babblingResponder(): SamplingResponder {
	return () => Promise.resolve(reply('fixture-babbler', 'Sure! I would be happy to help with that.'));
}

// --- the real-model leg -----------------------------------------------------------------------------------------

/**
 * Extra completion budget for a model seen to reason: on an OpenAI-compatible endpoint the reasoning comes out of
 * `max_tokens`, and a 64-token budget came back as 64 tokens of reasoning and an empty message.
 */
const REASONING_HEADROOM = 8_192;
const endpoint: ModelEndpoint | null = resolveModelEndpoint();
/** Models observed to reason, learned from their first reply. */
const reasons = new Set<string>();

/** True when an opt-in real-model leg can run here. */
export function hasRealModel(): boolean {
	return endpoint !== null;
}

/** One line naming what the leg runs against — models and host, never the key. */
export function realModelDescription(): string {
	return endpoint === null ? 'none configured' : describeEndpoint(endpoint);
}

/** Every configured model id, in configured order. */
export function realModels(): readonly string[] {
	return endpoint?.models ?? [];
}

/** A responder backed by one configured real model. */
export function realModelResponder(model: string): SamplingResponder {
	if (endpoint === null) throw new Error('no real model is configured; guard with hasRealModel()');
	const config = endpoint;
	const turns = (request: Parameters<SamplingResponder>[0]) =>
		request.params.messages.map((message) => ({
			role: message.role === 'assistant' ? 'assistant' : 'user',
			text: (message.content as { text?: string }).text ?? '',
		}));
	if (config.kind === 'anthropic') {
		return async (request) => {
			const response = await fetch(`${config.baseUrl}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
				body: JSON.stringify({
					model,
					max_tokens: request.params.maxTokens ?? 1024,
					...(request.params.systemPrompt === undefined ? {} : { system: request.params.systemPrompt }),
					messages: turns(request).map(({ role, text }) => ({ role, content: [{ type: 'text', text }] })),
				}),
			});
			if (!response.ok) throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
			const body = await response.json() as { model: string; content: Array<{ type: string; text?: string }> };
			return reply(body.model, body.content.filter((block) => block.type === 'text').map((b) => b.text).join(''));
		};
	}
	return async (request) => {
		const system = request.params.systemPrompt;
		const messages = [
			...(system === undefined ? [] : [{ role: 'system', content: system }]),
			...turns(request).map(({ role, text }) => ({ role, content: text })),
		];
		const asked = request.params.maxTokens ?? 1024;
		let completion = await complete(config, model, messages, asked + (reasons.has(model) ? REASONING_HEADROOM : 0));
		// One retry, only for a model that thought past its allowance: it needs room, which the server cannot know.
		const stretched = asked + REASONING_HEADROOM * 4;
		if (completion.text === '' && completion.truncated) {
			reasons.add(model);
			completion = await complete(config, model, messages, stretched);
		}
		if (completion.text === '') {
			throw new Error(
				`${model} returned no text: ${
					completion.truncated ? `still cut off at ${stretched} tokens` : `finish_reason ${completion.finishReason}`
				}`,
			);
		}
		return reply(completion.model, completion.text);
	};
}

async function complete(
	config: ModelEndpoint,
	model: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): Promise<{ model: string; text: string; truncated: boolean; finishReason: string }> {
	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(config.apiKey === '' ? {} : { authorization: `Bearer ${config.apiKey}` }),
		},
		body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
	});
	if (!response.ok) {
		throw new Error(`${config.netAuthority} ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const body = await response.json() as {
		model?: string;
		choices?: Array<
			{ finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null } }
		>;
	};
	const choice = body.choices?.[0];
	const raw = choice?.message?.content ?? '';
	// Inline thinking is not the answer, and a stray brace in it would be taken as the action.
	const text = raw.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
	if ((choice?.message?.reasoning_content ?? '') !== '' || text !== raw.trim()) reasons.add(model);
	return {
		model: body.model ?? model,
		text,
		truncated: choice?.finish_reason === 'length',
		finishReason: choice?.finish_reason ?? 'missing',
	};
}
