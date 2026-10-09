/// <reference lib="deno.ns" />
/**
 * `task_composer.ts`: the body each kind submits, the target options a providers answer offers (and why one is
 * disabled), the tool list, and the form's painted options over stubbed requests under the fake document.
 *
 * The e2e gateway cannot be given a providers fixture (`harness()` builds its config with no `modelProviders`, and
 * `loadConfig` never reads `TTK_MODEL_PROVIDERS_FILE` from `env`), so the `reachable:false → disabled, tooltip =
 * reason` step (design §7 item 10) and the preselected-target case (F-01) are proved here over a stubbed
 * `GET /api/v1/agent/providers` answer instead of in `tests/e2e/a2ui_e2e_test.ts`.
 *
 * The fake models a select's `value` as a plain property (`test_document.ts`), not the kit's getter, which reads
 * `''` until a microtask after `replaceChildren`; the F-01 test blanks the property by hand to stand in for that.
 */
import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import type { McpTool } from './mcp.ts';
import type { ProvidersResponse } from './api.ts';
import {
	ACP_TARGET,
	AGENT_UNAVAILABLE,
	defaultTarget,
	delegateArgs,
	KIND_OPTIONS,
	NEEDS_SCOPE,
	newSurfaceHome,
	NO_ACP,
	offeredTools,
	preferredTarget,
	preferTarget,
	targetOptions,
	taskComposer,
	textTaskBody,
	toolTaskParts,
} from './task_composer.ts';
import { TASK_EXCLUDED_TOOLS } from './task_kinds.ts';
import { all, byClass, byRole, byTag, fake, FakeDocument, type FakeElement } from './test_document.ts';

/**
 * `withDocument` restores the global as soon as `fn` returns; the composer paints its targets after an awaited
 * request, so the fake must stay installed across that await.
 */
async function withDocumentAsync<T>(fn: (document: FakeDocument) => Promise<T>): Promise<T> {
	const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const fakeDocument = new FakeDocument();
	Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
	try {
		return await fn(fakeDocument);
	} finally {
		if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
		else Object.defineProperty(globalThis, 'document', priorDocument);
	}
}

const PROVIDERS: ProvidersResponse = {
	invocable: true,
	acp: false,
	default: 'openai-main',
	providers: [
		{
			id: 'openai-main',
			kind: 'openai',
			label: 'OpenAI',
			models: ['gpt-4.1', 'gpt-4.1-mini'],
			default_model: 'gpt-4.1-mini',
			reachable: true,
			host: 'api.openai.com:443',
		},
		{
			id: 'local',
			kind: 'openai',
			label: 'Ollama',
			models: ['llama3'],
			default_model: 'llama3',
			reachable: false,
			host: '127.0.0.1:11434',
			reason: 'no-net-grant',
		},
	],
};

Deno.test('task_composer: the kind switch has the three kinds, worded, in metadata order', () => {
	assertEquals(KIND_OPTIONS.map((option) => option.id), ['text', 'tool', 'delegation']);
	assertEquals(KIND_OPTIONS.map((option) => option.label), ['Ask agent', 'Run tool', 'Delegate']);
});

Deno.test('task_composer: target options — ACP first, one per provider and model, unreachable disabled with its reason', () => {
	const options = targetOptions(PROVIDERS);
	assertEquals(options.map((option) => option.label), [
		'Coding agent (ACP)',
		'OpenAI · gpt-4.1',
		'OpenAI · gpt-4.1-mini',
		'Ollama · llama3',
	]);
	assertEquals(options[0], {
		value: ACP_TARGET,
		label: 'Coding agent (ACP)',
		disabled: true,
		reason: NO_ACP,
		warn: false,
	});
	assertEquals(options[1]?.disabled, false);
	assertEquals(options[1]?.provider, 'openai-main');
	assertEquals(options[1]?.model, 'gpt-4.1');
	// Design §7 item 10: `reachable:false` → disabled, the tooltip is the server's `reason`, and a warn dot.
	assertEquals(options[3], {
		value: 'local',
		label: 'Ollama · llama3',
		disabled: true,
		reason: 'no-net-grant',
		warn: true,
		provider: 'local',
		model: 'llama3',
	});
	// The default provider's default model is chosen when no bridge is configured.
	assertEquals(defaultTarget(options, PROVIDERS), 2);
	// With a bridge, the coding agent comes first and is the default (§3.10: a bridge serves text without a selection).
	const withAcp = targetOptions({ ...PROVIDERS, acp: true });
	assertEquals(withAcp[0]?.disabled, false);
	assertEquals(defaultTarget(withAcp, { ...PROVIDERS, acp: true }), 0); // D-158: an administrator's chosen model for the built-in agent comes before the default provider's default.
	const chosen = { ...PROVIDERS, agent_default: { provider: 'openai-main', model: 'gpt-4.1' } };
	assertEquals(options[defaultTarget(options, chosen)]?.model, 'gpt-4.1');
	assertEquals(defaultTarget(withAcp, { ...chosen, acp: true }), 0);
});

Deno.test('task_composer: without model:invoke every provider option is disabled with "needs model:invoke" (F9)', () => {
	const options = targetOptions({ ...PROVIDERS, invocable: false });
	for (const option of options.slice(1)) {
		assertEquals(option.disabled, true);
		assertEquals(option.reason, NEEDS_SCOPE);
		assertEquals(option.warn, false, 'reachability is not shown to a caller who cannot use it');
	}
	assertEquals(defaultTarget(options, { ...PROVIDERS, invocable: false }), -1, 'nothing can be sent');
	assertEquals(defaultTarget(targetOptions({ ...PROVIDERS, invocable: false, acp: true }), PROVIDERS), 0);
});

Deno.test('task_composer: a provider with no model list still gets one option', () => {
	const options = targetOptions({
		invocable: true,
		acp: false,
		default: null,
		providers: [{ id: 'p', kind: 'anthropic', label: 'Anthropic', models: [], default_model: null, reachable: true }],
	});
	assertEquals(options.slice(1), [{ value: 'p', label: 'Anthropic', disabled: false, warn: false, provider: 'p' }]);
});

Deno.test('task_composer: the three bodies — text with provider/model only when chosen; tool as one data part; delegate args', () => {
	const options = targetOptions(PROVIDERS);
	assertEquals(textTaskBody('hello', undefined), { message: 'hello' });
	assertEquals(textTaskBody('hello', options[0]), { message: 'hello' }, 'the coding agent names no provider');
	assertEquals(textTaskBody('hello', options[2]), { message: 'hello', provider: 'openai-main', model: 'gpt-4.1-mini' });
	assertEquals(textTaskBody('hello', { value: 'p', label: 'P', disabled: false, warn: false, provider: 'p' }), {
		message: 'hello',
		provider: 'p',
	});
	assertEquals(toolTaskParts('browser_navigate', { url: 'https://example.test/' }), [
		{ data: { tool: 'browser_navigate', arguments: { url: 'https://example.test/' } } },
	]);
	assertEquals(delegateArgs('reviewer', 'look at this'), { peer: 'reviewer', message: 'look at this' });
});

Deno.test('task_composer: D-156 — SlopLord follows the ACP agent, is gated on availability, scope and a default, sends agent', () => {
	const agent = {
		id: 'sloplord',
		name: 'SlopLord',
		description: 'coding',
		available: true,
		card_url: 'http://127.0.0.1:8787/a2a/agents/sloplord/.well-known/agent-card.json',
	};
	const options = targetOptions({ ...PROVIDERS, agents: [agent] });
	assertEquals(options[1], {
		value: 'agent:sloplord',
		label: 'SlopLord (coding)',
		disabled: false,
		warn: false,
		agent: 'sloplord',
	});
	assertEquals(textTaskBody('fix it', options[1]), { message: 'fix it', agent: 'sloplord' });
	// The default stays the default provider's default model: SlopLord is chosen, never imposed.
	assertEquals(options[defaultTarget(options, PROVIDERS)]?.model, 'gpt-4.1-mini');
	assertEquals(targetOptions({ ...PROVIDERS, agents: [{ ...agent, available: false }] })[1]?.reason, AGENT_UNAVAILABLE);
	assertEquals(targetOptions({ ...PROVIDERS, invocable: false, agents: [agent] })[1]?.reason, NEEDS_SCOPE);
	assertEquals(targetOptions({ ...PROVIDERS, default: null, agents: [agent] })[1]?.disabled, true);
	// Another screen may ask the next composer to start on it — once, and only while it is enabled.
	preferTarget('agent:sloplord');
	assertEquals(preferredTarget(options, 2), 1);
	assertEquals(preferredTarget(options, 2), 2, 'the request is consumed');
	preferTarget('agent:sloplord');
	assertEquals(preferredTarget(targetOptions({ ...PROVIDERS, agents: [{ ...agent, available: false }] }), 2), 2);
});

Deno.test('task_composer: the tool select never offers an excluded or app-only tool, and lists by family', () => {
	const tool = (name: string, extra: object = {}): McpTool => ({ name, inputSchema: {}, ...extra });
	const offered = offeredTools([
		tool('skill_list'),
		tool('browser_run_task'),
		tool('browser_navigate'),
		tool('a2ui_delete'),
		tool('browser_click'),
		tool('browser_live_ticket', { _meta: { ui: { visibility: ['app'] } } }),
		tool('agent_delegate'),
	]).map((entry) => entry.name);
	assertEquals(offered, ['browser_navigate', 'browser_click', 'skill_list', 'agent_delegate']);
	for (const name of TASK_EXCLUDED_TOOLS) assert(!offered.includes(name), name);
});

Deno.test('task_composer: the one New-surface action lives in the header, or the empty state, or nowhere (D-092)', () => {
	assertEquals(newSurfaceHome(2, true), 'header');
	assertEquals(newSurfaceHome(0, true), 'empty');
	assertEquals(newSurfaceHome(0, false), 'none');
	assertEquals(newSurfaceHome(5, false), 'none');
});

Deno.test('task_composer: the form paints three role=tab kinds, #agent-prompt, and the target options with reasons', async () => {
	const calls: string[] = [];
	await withDocumentAsync(async (document) => {
		const status = fake(document.createElement('p'));
		const composer = taskComposer({
			providers: () => Promise.resolve(PROVIDERS),
			tools: () => Promise.resolve([]),
			peers: () => Promise.resolve([]),
			createTask: (body) => {
				calls.push(JSON.stringify(body));
				return Promise.resolve({});
			},
			sendParts: () => Promise.resolve({}),
			delegate: () => Promise.resolve({}),
			onSubmitted: () => calls.push('submitted'),
			status: status as unknown as HTMLElement,
		});
		await composer.ready;
		const root = fake(composer.node);
		const tabs = byRole(root, 'tab');
		assertEquals(tabs.map((tab) => tab.textContent), ['Ask agent', 'Run tool', 'Delegate']);
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false']);
		assertEquals(byRole(root, 'tablist').length, 1);
		assert(all(root).some((node) => node.id === 'agent-prompt'), 'the prompt keeps its id');
		const select = all(root).find((node) => node.id === 'agent-target');
		assert(select !== undefined);
		const options = byTag(select, 'wa-option');
		assertEquals(options.length, 4);
		assertEquals(options[0]?.hasAttribute('disabled'), true);
		assertEquals(options[0]?.getAttribute('data-tip'), NO_ACP);
		assertEquals(options[1]?.hasAttribute('disabled'), false);
		assertEquals(options[1]?.getAttribute('data-tip'), null);
		// The unreachable provider: disabled, its tooltip is the server's reason, a warn dot beside it.
		assertEquals(options[3]?.hasAttribute('disabled'), true);
		assertEquals(options[3]?.getAttribute('data-tip'), 'no-net-grant');
		assertEquals(byRole(options[3]!, 'img').map((dot) => dot.getAttribute('aria-label')), ['no-net-grant']);
		assertEquals(select.value, '2', 'the default provider and model are preselected');
		// FE-2: a disabled option's reason is in its content too (visually hidden), not only in the tooltip.
		assertEquals(byClass(options[3]!, 'sr-only').map((node) => node.textContent), [' — no-net-grant']);
		assertEquals(byClass(options[1]!, 'sr-only').length, 0);
		// Nothing of the server's secrets is in the DOM: no host, no key-like string.
		assert(!all(root).some((node) => node.textContent.includes('api.openai.com')));
	});
	assertEquals(calls, []);
});

/** The fake has no `hidden` property; the composer sets it as a plain one. */
const hiddenOf = (node: FakeElement): boolean => (node as unknown as { hidden: boolean }).hidden;

/** The one submit of the composer. */
function submitOf(root: FakeElement): FakeElement {
	const submit = byTag(root, 'button').find((node) => node.getAttribute('type') === 'submit');
	assert(submit !== undefined);
	// `busy()` looks for the button's glyph with `querySelector`, which the fake does not model.
	(submit as unknown as { querySelector: () => null }).querySelector = () => null;
	return submit;
}

Deno.test('task_composer: a fresh render with a reachable provider has submit enabled, and the default target survives the kit reading "" (F-01/CRW-2)', async () => {
	using time = new FakeTime();
	const calls: string[] = [];
	await withDocumentAsync(async (document) => {
		const status = fake(document.createElement('p'));
		const composer = taskComposer({
			providers: () => Promise.resolve(PROVIDERS),
			tools: () => Promise.resolve([]),
			peers: () => Promise.resolve([]),
			createTask: (body) => {
				calls.push(JSON.stringify(body));
				return Promise.resolve({});
			},
			sendParts: () => Promise.resolve({}),
			delegate: () => Promise.resolve({}),
			onSubmitted: () => calls.push('submitted'),
			status: status as unknown as HTMLElement,
		});
		await composer.ready;
		const root = fake(composer.node);
		const submit = submitOf(root);
		// The positive case: nothing touched, the default provider is chosen and the task can be sent.
		assertEquals(submit.disabled, false, 'submit is enabled on a fresh render');
		assertEquals(submit.getAttribute('aria-label'), 'Send to agent');
		assertEquals(submit.getAttribute('data-tip'), 'Send to agent');
		// F-01: the kit's `value` getter reads '' until its option cache catches up; the form's own index stands in.
		const select = all(root).find((node) => node.id === 'agent-target');
		assert(select !== undefined);
		select.value = undefined;
		select.fire('change');
		const prompt = all(root).find((node) => node.id === 'agent-prompt');
		assert(prompt !== undefined);
		prompt.value = 'hello';
		root.fire('submit');
		await time.runMicrotasks();
		await time.runMicrotasks();
		time.runAll();
		assertEquals(calls, [
			JSON.stringify({ message: 'hello', provider: 'openai-main', model: 'gpt-4.1-mini' }),
			'submitted',
		]);
		assertEquals(submit.disabled, false, 'still enabled after the send');
	});
});

Deno.test('task_composer: when the providers request fails the reason is named, a retry is offered, and a plain text task still sends (BUG-5)', async () => {
	using time = new FakeTime();
	const calls: string[] = [];
	let attempts = 0;
	await withDocumentAsync(async (document) => {
		const status = fake(document.createElement('p'));
		const composer = taskComposer({
			providers: () => {
				attempts += 1;
				return attempts === 1 ? Promise.reject(new Error('HTTP 503')) : Promise.resolve(PROVIDERS);
			},
			tools: () => Promise.resolve([]),
			peers: () => Promise.resolve([]),
			createTask: (body) => {
				calls.push(JSON.stringify(body));
				return Promise.resolve({});
			},
			sendParts: () => Promise.resolve({}),
			delegate: () => Promise.resolve({}),
			onSubmitted: () => calls.push('submitted'),
			status: status as unknown as HTMLElement,
		});
		await composer.ready;
		const root = fake(composer.node);
		const submit = submitOf(root);
		const select = all(root).find((node) => node.id === 'agent-target');
		assert(select !== undefined);
		const retry = byClass(root, 'ag-target-retry')[0];
		assert(retry !== undefined, 'the retry button exists');
		// The real reason, on the select's tooltip and in the live region; the submit is not stuck on "Loading…".
		assertEquals(select.getAttribute('data-tip'), 'Could not load the targets: HTTP 503');
		assertEquals(select.getAttribute('placeholder'), 'Targets unavailable');
		assertEquals(status.textContent, 'Could not load the targets: HTTP 503');
		assertEquals(hiddenOf(retry), false, 'the retry is offered');
		assertEquals(submit.disabled, false, 'a plain text task is still sendable');
		assertEquals(submit.getAttribute('data-tip'), 'Send to agent');
		// It sends `{message}` alone — the server accepts that with no provider named.
		const prompt = all(root).find((node) => node.id === 'agent-prompt');
		assert(prompt !== undefined);
		prompt.value = 'hello';
		root.fire('submit');
		await time.runMicrotasks();
		await time.runMicrotasks();
		time.runAll();
		assertEquals(calls, [JSON.stringify({ message: 'hello' }), 'submitted']);
		// Try again: the targets paint, the retry hides, the tooltip goes.
		(retry as unknown as { querySelector: () => null }).querySelector = () => null;
		retry.fire('click');
		await time.runMicrotasks();
		await time.runMicrotasks();
		assertEquals(attempts, 2);
		assertEquals(byTag(select, 'wa-option').length, 4);
		assertEquals(hiddenOf(retry), true);
		assertEquals(select.getAttribute('data-tip'), null);
		assertEquals(select.value, '2');
		assertEquals(submit.disabled, false);
	});
});

Deno.test('task_composer: with no usable target the submit is disabled and says why', async () => {
	await withDocumentAsync(async (document) => {
		const status = fake(document.createElement('p'));
		const composer = taskComposer({
			providers: () => Promise.resolve({ ...PROVIDERS, invocable: false }),
			tools: () => Promise.resolve([]),
			peers: () => Promise.resolve([]),
			createTask: () => Promise.resolve({}),
			sendParts: () => Promise.resolve({}),
			delegate: () => Promise.resolve({}),
			onSubmitted: () => {},
			status: status as unknown as HTMLElement,
		});
		await composer.ready;
		const submit = byTag(fake(composer.node), 'button').find((node) => node.getAttribute('type') === 'submit');
		assert(submit !== undefined);
		assertEquals(submit.disabled, true);
		assertEquals(submit.getAttribute('data-tip'), 'No coding agent or model provider is available');
	});
});
