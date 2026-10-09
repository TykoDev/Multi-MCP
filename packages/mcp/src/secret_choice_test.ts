/**
 * R5 (D-125, AC21): `browser_fill_secret`'s secret choice.
 *
 * Driven against the capture's own password field (`form_attributes`, element 6) inside a frame of
 * `https://bank.example.com/login`, with the CDP round trips the handler makes scripted and every dispatched event
 * recorded — so "nothing was typed" is a statement about what reached the page, not about a return value. Every
 * assertion that an offer or a message carries no value checks for the values' own marker string.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { ServerContext } from '@modelcontextprotocol/server';
import { captureHarness } from '../fixtures/capture_session.ts';
import { ToolError } from './errors.ts';
import { type SecretEntry, SecretStore } from './secrets.ts';
import * as tools from './tools.ts';
import { SECRET_CHOICE_KEY } from './tools/interaction.ts';
import type { ClientFacts, ToolContext, ToolResult } from './types.ts';

const FORM: ClientFacts = { sampling: false, samplingTools: false, elicitForm: true, elicitUrl: false };
const NO_FORM: ClientFacts = { sampling: false, samplingTools: false, elicitForm: false, elicitUrl: true };
/** Every configured value carries this marker, so one substring search finds any value anywhere. */
const MARK = 'Zq8-VALUE';
const SECRETS: SecretEntry[] = [
	{ name: 'bank_password', value: `${MARK}-bank`, domains: ['bank.example.com'] },
	{ name: 'bank_otp', value: `${MARK}-otp`, domains: ['bank.example.com'] },
	{ name: 'mail_password', value: `${MARK}-mail`, domains: ['mail.example.org'] },
	// Permitted everywhere by the pin predicate, and refused by this tool whatever the page (SEC-07): never offered.
	{ name: 'loose', value: `${MARK}-loose`, domains: [] },
];

function request(responses?: Record<string, unknown>): ServerContext {
	return {
		mcpReq: { method: 'tools/call', ...(responses === undefined ? {} : { inputResponses: responses }) },
	} as never;
}

async function harness(entries: SecretEntry[] = SECRETS) {
	const h = await captureHarness('form_attributes');
	const session = h.record.session as unknown as Record<string, unknown>;
	session.cdpClient = {
		send: {
			Page: {
				getFrameTree: () =>
					Promise.resolve({
						frameTree: {
							frame: { id: 'TOP', url: 'https://bank.example.com/login' },
							childFrames: [{
								frame: { id: 'A4B12682576331EE39AA9EFE83F974E0', url: 'https://bank.example.com/login' },
							}],
						},
					}),
				getLayoutMetrics: () =>
					Promise.resolve({
						layoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
						visualViewport: {
							offsetX: 0,
							offsetY: 0,
							pageX: 0,
							pageY: 0,
							clientWidth: 1280,
							clientHeight: 720,
							scale: 1,
						},
						contentSize: { x: 0, y: 0, width: 1280, height: 2000 },
					}),
			},
		},
	};
	session.sessionManager = { getOrCreateCdpSession: () => Promise.resolve({ sessionId: 'S1', targetId: 'T' }) };
	session.agentFocusTargetId = 'T';
	const typed: Array<{ text?: string; sensitiveKeyName?: string }> = [];
	const bus = h.record.session.eventBus as unknown as { dispatch(event: unknown): unknown };
	bus.dispatch = (event) => {
		typed.push(event as { text?: string; sensitiveKeyName?: string });
		return { eventResult: () => Promise.resolve('ok') };
	};
	const token = h.record.session.cachedBrowserState?.stateToken as string;
	const fill = (secret: string, extra: Partial<ToolContext> = {}): Promise<ToolResult> =>
		tools.browserFillSecret(
			{ index: 6, secret, state_token: token },
			{ ...h.ctx, secrets: new SecretStore(entries), ...extra },
		);
	return {
		...h,
		typed,
		fill,
		async [Symbol.asyncDispose]() {
			await h.registry.shutdown();
		},
	};
}

function offered(result: ToolResult): { message: string; names: string[]; whole: string } {
	assertEquals((result as { resultType?: string }).resultType, 'input_required');
	const entry = (result as { inputRequests: Record<string, { method: string; params: Record<string, unknown> }> })
		.inputRequests[SECRET_CHOICE_KEY]!;
	assertEquals(entry.method, 'elicitation/create');
	const schema = entry.params.requestedSchema as {
		properties: { secret: { type: string; enum: string[] } };
		required: string[];
	};
	assertEquals(schema.properties.secret.type, 'string');
	assertEquals(schema.required, ['secret']);
	return { message: String(entry.params.message), names: schema.properties.secret.enum, whole: JSON.stringify(result) };
}

async function refused(work: Promise<unknown>, code: string, words?: string): Promise<void> {
	const error = await assertRejects(() => work, ToolError);
	assertEquals(error.code, code, error.message);
	if (words !== undefined) assertStringIncludes(error.message, words);
}

Deno.test('AC21: a client without form elicitation gets exactly the refusals it always got', async () => {
	await using h = await harness();
	for (const extra of [{}, { client: NO_FORM, mcp: request() }, { client: FORM }]) {
		await refused(
			h.fill('nope', extra),
			'invalid-arguments',
			'no secret named nope; browser_get_state lists the names available on this page',
		);
		await refused(
			h.fill('mail_password', extra),
			'navigation-blocked',
			'the secret mail_password is not permitted on https://bank.example.com',
		);
	}
	assertEquals(h.typed, [], 'a refusal typed something');
});

Deno.test('AC21: an unknown or unusable name offers only the pinned names permitted on the live origin', async () => {
	await using h = await harness();
	for (
		const [secret, problem] of [
			['nope', 'there is no secret named nope'],
			['mail_password', 'the secret mail_password cannot be used on https://bank.example.com'],
		] as const
	) {
		const choice = offered(await h.fill(secret, { client: FORM, mcp: request() }));
		assertEquals(choice.names, ['bank_otp', 'bank_password'], secret);
		assertStringIncludes(choice.message, problem);
		assertStringIncludes(choice.message, 'element 6');
		assert(!choice.whole.includes(MARK), `the offer for ${secret} carried a secret value`);
		assert(!choice.names.includes('loose'), 'an unpinned secret was offered to a tool that refuses it');
	}
	assertEquals(h.typed, [], 'asking typed something');
});

Deno.test('AC21: the chosen name is filled, audited and reported — by name, never by value', async () => {
	await using h = await harness();
	const answer = request({ [SECRET_CHOICE_KEY]: { action: 'accept', content: { secret: 'bank_password' } } });
	const result = await h.fill('nope', { client: FORM, mcp: answer });
	const payload = (result as { structuredContent: Record<string, unknown> }).structuredContent;
	assertEquals(payload.secret, 'bank_password');
	assertEquals(h.typed.length, 1);
	assertEquals(h.typed[0]?.sensitiveKeyName, 'bank_password');
	assertEquals(h.typed[0]?.text, `${MARK}-bank`, 'the chosen secret is what was typed');
	assertEquals(h.record.audit.read({ principal: 'test', all: true }).entries.at(-1)?.secret, 'bank_password');
	assert(!JSON.stringify(result).includes(MARK), 'the result carried a secret value');
});

Deno.test('AC21: the choice is re-validated at retry, and a refusal on it types nothing', async () => {
	await using h = await harness();
	const choose = (secret: unknown) =>
		h.fill('nope', {
			client: FORM,
			mcp: request({ [SECRET_CHOICE_KEY]: { action: 'accept', content: { secret } } }),
		});
	await refused(choose('mail_password'), 'navigation-blocked', 'is not permitted on https://bank.example.com');
	await refused(choose('loose'), 'navigation-blocked', 'declares no domains');
	await refused(choose('nope2'), 'invalid-arguments', 'no secret named nope2');
	await refused(choose(''), 'invalid-arguments', 'the secret choice did not name a secret');
	await refused(choose(42), 'invalid-arguments', 'the secret choice did not name a secret');
	assertEquals(h.typed, []);
});

Deno.test('AC21: declining or cancelling the choice is user-declined and types nothing', async () => {
	await using h = await harness();
	for (const action of ['decline', 'cancel']) {
		await refused(
			h.fill('nope', { client: FORM, mcp: request({ [SECRET_CHOICE_KEY]: { action } }) }),
			'user-declined',
			action === 'decline' ? 'declined the secret choice' : 'cancelled the secret choice',
		);
	}
	assertEquals(h.typed, []);
});

Deno.test('AC21: with nothing usable to offer, a form-capable client gets the old refusal', async () => {
	await using h = await harness(SECRETS.filter((entry) => !entry.name.startsWith('bank_')));
	await refused(h.fill('nope', { client: FORM, mcp: request() }), 'invalid-arguments', 'no secret named nope');
	await refused(h.fill('mail_password', { client: FORM, mcp: request() }), 'navigation-blocked', 'is not permitted');
	assertEquals(h.typed, []);
});
