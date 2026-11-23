/// <reference lib="deno.ns" />
/**
 * `task_composer.ts`: the targets a providers answer offers (and why one is disabled), the body each submits, and the
 * form's gate over stubbed requests under the fake document. The e2e gateway cannot be given a providers fixture, so
 * the reachable and unreachable cases are proved here.
 */
import { assert, assertEquals } from '@std/assert';
import type { ProvidersResponse } from './api.ts';
import {
	AGENT_UNAVAILABLE,
	defaultTarget,
	NEEDS_SCOPE,
	submittedTaskId,
	targetOptions,
	taskComposer,
	textTaskBody,
} from './task_composer.ts';
import { byTag, fake, FakeDocument } from './test_document.ts';

const PROVIDERS: ProvidersResponse = {
	invocable: true,
	default: 'openai-main',
	providers: [
		{
			id: 'openai-main',
			kind: 'openai',
			label: 'OpenAI',
			models: ['gpt-4.1', 'gpt-4.1-mini'],
			default_model: 'gpt-4.1-mini',
			reachable: true,
		},
		{
			id: 'local',
			kind: 'openai',
			label: 'Ollama',
			models: ['llama3'],
			default_model: 'llama3',
			reachable: false,
			reason: 'no-net-grant',
		},
	],
};

const SLOPLORD = { id: 'sloplord', name: 'SlopLord', description: 'coding', available: true, card_url: 'http://x/' };

Deno.test('task_composer: one target per provider and model, unreachable disabled with its reason, then the peers', () => {
	const options = targetOptions(PROVIDERS, ['reviewer']);
	assertEquals(options.map((option) => option.label), [
		'OpenAI · gpt-4.1',
		'OpenAI · gpt-4.1-mini',
		'Ollama · llama3',
		'Peer · reviewer',
	]);
	assertEquals(options[2]?.disabled, true);
	assertEquals(options[2]?.reason, 'no-net-grant');
	assertEquals(options[3]?.peer, 'reviewer');
	// The default provider's default model is chosen; an administrator's choice for the built-in agent comes first.
	assertEquals(defaultTarget(options, PROVIDERS), 1);
	const chosen = { ...PROVIDERS, agent_default: { provider: 'openai-main', model: 'gpt-4.1' } };
	assertEquals(defaultTarget(options, chosen), 0);
	// Without model:invoke nothing can be sent to a provider.
	const refused = targetOptions({ ...PROVIDERS, invocable: false });
	assert(refused.every((option) => option.disabled && option.reason === NEEDS_SCOPE));
	assertEquals(defaultTarget(refused, { ...PROVIDERS, invocable: false }), -1);
	// A provider with no model list still gets one option.
	assertEquals(
		targetOptions({
			invocable: true,
			default: null,
			providers: [{ id: 'p', kind: 'anthropic', label: 'Anthropic', models: [], default_model: null, reachable: true }],
		}).map((option) => option.label),
		['Anthropic'],
	);
});

Deno.test('task_composer: SlopLord comes first, gated on availability, scope and a default; the bodies', () => {
	const options = targetOptions({ ...PROVIDERS, agents: [SLOPLORD] });
	assertEquals(options[0]?.label, 'SlopLord (coding)');
	assertEquals(textTaskBody('fix it', options[0]), { message: 'fix it', agent: 'sloplord' });
	// SlopLord is offered, never imposed: the default stays the default provider's default model.
	assertEquals(options[defaultTarget(options, PROVIDERS)]?.model, 'gpt-4.1-mini');
	assertEquals(
		targetOptions({ ...PROVIDERS, agents: [{ ...SLOPLORD, available: false }] })[0]?.reason,
		AGENT_UNAVAILABLE,
	);
	assertEquals(targetOptions({ ...PROVIDERS, invocable: false, agents: [SLOPLORD] })[0]?.reason, NEEDS_SCOPE);
	assertEquals(targetOptions({ ...PROVIDERS, default: null, agents: [SLOPLORD] })[0]?.disabled, true);
	assertEquals(textTaskBody('hello', undefined), { message: 'hello' });
	assertEquals(textTaskBody('hello', options[2]), { message: 'hello', provider: 'openai-main', model: 'gpt-4.1-mini' });
	// The new task's id, from each envelope that answers a submission.
	const task = { id: 't1', status: { state: 'TASK_STATE_SUBMITTED' } };
	assertEquals(submittedTaskId({ task }), 't1');
	assertEquals(submittedTaskId({ result: { task } }), 't1');
	assertEquals(submittedTaskId({ result: task }), 't1');
	assertEquals(submittedTaskId({ result: { ok: true } }), null);
});

/** Builds the composer under the fake document, kept installed across the awaited providers request. */
async function composerOver(providers: () => Promise<ProvidersResponse>): Promise<{ submit: boolean; reason: string }> {
	const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
	Object.defineProperty(globalThis, 'document', { value: new FakeDocument(), configurable: true });
	try {
		const composer = taskComposer({
			providers,
			peers: () => Promise.resolve([]),
			createTask: () => Promise.resolve({}),
			delegate: () => Promise.resolve({}),
			onSubmitted: () => {},
		});
		await composer.ready;
		const root = fake(composer.node);
		const submit = byTag(root, 'button').find((node) => node.getAttribute('type') === 'submit');
		const reason = byTag(root, 'span').find((node) => node.getAttribute('class') === 'ag-reason');
		return { submit: submit?.disabled === false, reason: reason?.textContent ?? '' };
	} finally {
		if (prior === undefined) delete (globalThis as { document?: unknown }).document;
		else Object.defineProperty(globalThis, 'document', prior);
	}
}

Deno.test('task_composer: the submit waits for a usable target and says why while there is none', async () => {
	assertEquals(await composerOver(() => Promise.resolve(PROVIDERS)), { submit: true, reason: '' });
	assertEquals(await composerOver(() => Promise.resolve({ invocable: true, default: null, providers: [] })), {
		submit: false,
		reason: 'No agent or model provider is available',
	});
	const failed = await composerOver(() => Promise.reject(new Error('503 Service Unavailable')));
	assertEquals(failed, { submit: false, reason: 'Could not load the targets: 503 Service Unavailable' });
});
