/**
 * @module
 * The client half of MCP sampling, for the R1/R2 suites.
 *
 * In MCP the *client* owns the model, so a test client that answers
 * `sampling/createMessage` is not a stand-in for the real architecture — it is
 * the real architecture. What would make such a test worthless is a responder
 * that ignores its input and returns a canned string: then the assertion proves
 * only that the string survived the round trip.
 *
 * So the responders here **read the prompt**. The prompt is built from a real
 * page rendered out of a real Chromium, and every answer below is derived from
 * that text — the extraction responder finds the figure in the page, and the
 * agent responder picks its element index out of the live element list. If the
 * browser stops producing real page content, these responders stop being able
 * to answer, and the tests fail.
 *
 * The second leg is a real model: when one is configured — a local
 * OpenAI-compatible endpoint or an Anthropic key — the same tests run again
 * against it over the same prompts. See `scripts/model_endpoint.ts`.
 */
import type { SamplingResponder } from './harness.ts';
import { describeEndpoint, type ModelEndpoint, resolveModelEndpoint } from '../../scripts/model_endpoint.ts';

/** The prompt text of the last user message in a sampling request. */
export function promptOf(request: {
	params: { messages: Array<{ role: string; content: unknown }> };
}): string {
	const last = request.params.messages.at(-1);
	const content = last?.content as { type?: string; text?: string } | undefined;
	return content?.text ?? '';
}

/** Every `index: tag [label]` line of the prompt's element list. */
export function elementsOf(prompt: string): Array<{ index: number; tag: string; label: string; href: string }> {
	const out: Array<{ index: number; tag: string; label: string; href: string }> = [];
	for (const line of prompt.split('\n')) {
		const match = /^\s{2}(\d+): ([a-z0-9-]+)(?: \[([^\]]*)\])?(?: -> (\S+))?\s*$/.exec(line);
		if (match === null) continue;
		out.push({
			index: Number(match[1]),
			tag: match[2] ?? '',
			label: match[3] ?? '',
			href: match[4] ?? '',
		});
	}
	return out;
}

/** Wraps a plain-text answer as a sampling result. */
function reply(model: string, text: string): {
	model: string;
	role: 'assistant';
	content: { type: 'text'; text: string };
} {
	return { model, role: 'assistant', content: { type: 'text', text } };
}

/**
 * Answers extraction questions by reading the page it was given.
 *
 * Deliberately narrow: it knows how to pull a labelled figure out of the
 * prompt, and it fails loudly when the prompt does not contain one. A responder
 * that shrugged and returned "I don't know" would let a broken observation
 * pipeline pass.
 */
export function extractionResponder(): SamplingResponder {
	return (request) => {
		const prompt = promptOf(request);
		const question = /Question:\s*(.*)$/s.exec(prompt)?.[1]?.trim() ?? '';

		// Everything below is read out of the real page text in the prompt.
		//
		// The patterns tolerate newlines where the page has inline markup: the
		// serializer emits one line per text node, so `<b>42 million euro</b>`
		// mid-sentence arrives on a line of its own. Table values are anchored on
		// the element ids the serializer keeps, which is the stable half.
		const answers: Array<[RegExp, RegExp]> = [
			[/revenue/i, /revenue of\s+([\s\S]+?)\s+for the third quarter/i],
			[/chief executive|ceo/i, /chief executive is\s+([A-Z][a-z]+ [A-Z][a-z]+)/],
			[/headquarter|based/i, /id=hq[^>]*>\s*([A-Za-z]+)/],
			[/employee/i, /id=emp[^>]*>\s*([0-9]+)/],
		];
		for (const [asks, finds] of answers) {
			if (!asks.test(question)) continue;
			const found = finds.exec(prompt)?.[1];
			if (found !== undefined) return Promise.resolve(reply('fixture-responder', found.trim()));
		}
		// The nonce question: proof the responder really saw this run's page.
		const nonce = /Run nonce ([0-9a-f]+)/.exec(prompt)?.[1];
		if (/nonce/i.test(question) && nonce !== undefined) {
			return Promise.resolve(reply('fixture-responder', nonce));
		}
		return Promise.resolve(
			reply('fixture-responder', `NOT-FOUND: the page did not answer ${JSON.stringify(question)}`),
		);
	};
}

/**
 * Drives a browser task by reading the live page each turn.
 *
 * It is a real policy over real observations: it looks at what the page shows
 * now and picks the next action, exactly as a model would. It just happens to
 * be a policy small enough to be deterministic.
 */
export function agentResponder(): SamplingResponder {
	return (request) => {
		const prompt = promptOf(request);
		const task = /^Task:\s*(.*)$/m.exec(prompt)?.[1]?.trim() ?? '';
		const elements = elementsOf(prompt);
		const page = prompt.slice(prompt.indexOf('Page:'));

		const act = (action: Record<string, unknown>) => Promise.resolve(reply('fixture-agent', JSON.stringify(action)));

		// Task 1: press the button, then report what the page ended up saying.
		if (/press the button/i.test(task)) {
			const clicked = /clicked-([0-9a-f]+)/.exec(page)?.[0];
			if (clicked !== undefined) return act({ action: 'done', answer: clicked });
			const button = elements.find((element) => element.tag === 'button');
			if (button === undefined) return act({ action: 'done', answer: 'no button on this page' });
			return act({ thought: 'the button is the only control', action: 'click', index: button.index });
		}

		// Task 2: navigate somewhere and report the heading.
		if (/go to the second page/i.test(task)) {
			if (/arrived-at-second/.test(page)) {
				return act({ action: 'done', answer: 'arrived-at-second' });
			}
			const link = elements.find((element) => element.href.includes('/second'));
			if (link !== undefined) return act({ action: 'click', index: link.index });
			return act({ action: 'done', answer: 'no link to the second page' });
		}

		// Task 3: fill a field and report the echo.
		if (/type .* into the field/i.test(task)) {
			const wanted = /type "([^"]+)"/i.exec(task)?.[1] ?? 'hello';
			if (page.includes(wanted)) return act({ action: 'done', answer: wanted });
			const field = elements.find((element) => element.tag === 'input');
			if (field === undefined) return act({ action: 'done', answer: 'no field on this page' });
			return act({ action: 'type', index: field.index, text: wanted, clear: true });
		}

		// Task 4: something that cannot be done, to prove the loop gives up.
		if (/impossible/i.test(task)) {
			return act({ action: 'click', index: 999 });
		}

		return act({ action: 'done', answer: `no policy for ${JSON.stringify(task)}` });
	};
}

/** A responder whose replies are never valid JSON, for the malformed-reply path. */
export function babblingResponder(): SamplingResponder {
	return () => Promise.resolve(reply('fixture-babbler', 'Sure! I would be happy to help with that.'));
}

// --- the real-model leg -----------------------------------------------------

/**
 * Extra completion budget for a model that thinks before it answers.
 *
 * `maxTokens` in a sampling request means "at most this much *answer*" — the
 * server sized it against the action JSON it expects back. A reasoning model
 * spends tokens before it starts answering, and on an OpenAI-compatible
 * endpoint that spending comes out of the same allowance: asked for 64 tokens,
 * one of the models here returned 64 tokens of `reasoning_content`,
 * `finish_reason: "length"` and an **empty** message. So the client adds
 * headroom on top of what the server asked for, which is the client's call to
 * make — MCP leaves sampling parameters to the side that owns the model.
 *
 * Measured: a one-line question about a short page cost ~350 characters of
 * reasoning, while an agent step over a full page and its history cost 9 412 —
 * reasoning scales with the prompt, not with the answer.
 */
const REASONING_HEADROOM = 8_192;

/** How much further to stretch the budget after a reply that thought past it. */
const TRUNCATION_RETRY_FACTOR = 4;

/** The endpoint for the real-model leg, resolved once per process. */
const endpoint: ModelEndpoint | null = resolveModelEndpoint();

/**
 * Models observed to think before answering, by id.
 *
 * Learned rather than configured. Whether a model reasons is a property of the
 * model, not of the deployment, and it is plainly visible in its first reply —
 * so asking the person running the tests to declare it would be asking them for
 * something the endpoint already knows. Until a model has shown that it
 * reasons, its `maxTokens` is passed through exactly as the server set it,
 * which is what a non-reasoning model should get.
 */
const reasons = new Set<string>();

/** True when an opt-in real-model leg can run here. */
export function hasRealModel(): boolean {
	return endpoint !== null;
}

/** One line naming what the leg runs against — models and host, never the key. */
export function realModelDescription(): string {
	return endpoint === null ? 'none configured' : describeEndpoint(endpoint);
}

/** Every configured model id, in the order the configuration listed them. */
export function realModels(): readonly string[] {
	return endpoint?.models ?? [];
}

/**
 * A responder backed by one configured real model.
 *
 * The same prompts the deterministic responders see, sent to an actual model —
 * so the opt-in leg proves the prompts are ones a model can actually act on,
 * which no scripted policy can establish. One responder per model, because the
 * point of running several is that they answer differently.
 */
export function realModelResponder(model: string): SamplingResponder {
	if (endpoint === null) throw new Error('no real model is configured; guard with hasRealModel()');
	return endpoint.kind === 'anthropic' ? anthropicResponder(endpoint, model) : openAiResponder(endpoint, model);
}

interface Completion {
	readonly model: string;
	readonly text: string;
	readonly truncated: boolean;
	/** Length of a separate `reasoning_content` field, when the endpoint splits it out. */
	readonly reasoningChars: number;
	/** True when inline `<think>…</think>` had to be removed from the message itself. */
	readonly strippedThinking: boolean;
	readonly finishReason: string;
}

/** A responder speaking OpenAI `/chat/completions` — vLLM, llama.cpp, Ollama, or a hosted API. */
function openAiResponder(config: ModelEndpoint, model: string): SamplingResponder {
	return async (request) => {
		const system = (request.params as { systemPrompt?: string }).systemPrompt;
		const messages = [
			...(system === undefined ? [] : [{ role: 'system', content: system }]),
			...request.params.messages.map((message) => ({
				role: message.role === 'assistant' ? 'assistant' : 'user',
				content: (message.content as { text?: string }).text ?? '',
			})),
		];

		const asked = request.params.maxTokens ?? 1024;
		// Headroom only for a model already seen to reason. A non-reasoning model
		// gets exactly the budget the server asked for.
		const budget = asked + (reasons.has(model) ? REASONING_HEADROOM : 0);
		let completion = await complete(config, model, messages, budget);
		note(model, completion);

		// One retry, and only for the one cause a retry can fix. A model that
		// thought its way past the allowance produced nothing usable, but it is
		// not failing — it needs room, and how much room is a property of the
		// prompt, which the server cannot know when it sets `maxTokens`. The
		// first such reply is also how a reasoning model announces itself, so
		// this costs one round trip per model per process and nothing after.
		const stretched = asked + REASONING_HEADROOM * TRUNCATION_RETRY_FACTOR;
		if (completion.text === '' && completion.truncated) {
			reasons.add(model);
			completion = await complete(config, model, messages, stretched);
		}

		if (completion.text === '') {
			// Distinguishing the two is what makes a failure here actionable: a
			// truncated reply is a budget problem, an empty one is a model problem.
			const reason = completion.truncated
				? `still cut off at ${stretched} tokens after ${completion.reasoningChars} characters of reasoning`
				: `finish_reason ${JSON.stringify(completion.finishReason)}`;
			throw new Error(`${model} returned no text: ${reason}`);
		}
		return reply(completion.model, completion.text);
	};
}

/** Records that a model reasons, the first time it shows that it does. */
function note(model: string, completion: Completion): void {
	if (completion.reasoningChars > 0 || completion.strippedThinking) reasons.add(model);
}

async function complete(
	config: ModelEndpoint,
	model: string,
	messages: Array<{ role: string; content: string }>,
	maxTokens: number,
): Promise<Completion> {
	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			// A local server usually ignores this; sending it unconditionally would
			// put an empty bearer on the wire when there is no key.
			...(config.apiKey === '' ? {} : { authorization: `Bearer ${config.apiKey}` }),
		},
		body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
	});
	if (!response.ok) {
		throw new Error(`${config.netAuthority} ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	const body = await response.json() as {
		model?: string;
		choices?: Array<{
			finish_reason?: string;
			message?: { content?: string | null; reasoning_content?: string | null };
		}>;
	};
	const choice = body.choices?.[0];
	const raw = choice?.message?.content ?? '';
	const text = stripThinking(raw);
	return {
		model: body.model ?? model,
		text,
		truncated: choice?.finish_reason === 'length',
		reasoningChars: (choice?.message?.reasoning_content ?? '').length,
		strippedThinking: text !== raw.trim(),
		finishReason: choice?.finish_reason ?? 'missing',
	};
}

/**
 * Drops inline `<think>…</think>` blocks.
 *
 * Endpoints split on this: some return reasoning in its own `reasoning_content`
 * field, others leave it in the message wrapped in tags. The reasoning is not
 * the answer either way, and the agent loop takes the *first* balanced `{…}` it
 * finds — so a stray brace in the thinking would be executed as the action.
 */
function stripThinking(text: string): string {
	return text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').trim();
}

/** A responder backed by the Anthropic Messages API. */
function anthropicResponder(config: ModelEndpoint, model: string): SamplingResponder {
	return async (request) => {
		const system = (request.params as { systemPrompt?: string }).systemPrompt;
		const response = await fetch(`${config.baseUrl}/messages`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': config.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model,
				max_tokens: request.params.maxTokens ?? 1024,
				...(system === undefined ? {} : { system }),
				messages: request.params.messages.map((message) => ({
					role: message.role === 'assistant' ? 'assistant' : 'user',
					content: [{ type: 'text', text: (message.content as { text?: string }).text ?? '' }],
				})),
			}),
		});
		if (!response.ok) {
			throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
		}
		const body = await response.json() as {
			model: string;
			content: Array<{ type: string; text?: string }>;
		};
		const text = body.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
		return reply(body.model, text);
	};
}
