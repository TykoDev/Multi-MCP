/**
 * Secret placeholders. The properties under test are the security ones: a value never appears in anything the store
 * returns, and a secret pinned to one origin cannot be spent on another.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { assertFillable, describeFillTarget, parseSecrets, type SecretEntry, SecretStore } from './secrets.ts';
import { ToolError } from './errors.ts';
import { classifySensitiveText, SECRET_CHOICE_KEY } from './tools/interaction.ts';
import type { ServerContext } from '@modelcontextprotocol/server';
import { captureHarness } from '../fixtures/capture_session.ts';
import * as tools from './tools.ts';
import type { ClientFacts, ToolContext, ToolResult } from './types.ts';

const STORE = new SecretStore([
	{ name: 'anywhere', value: 'plain-value', domains: [] },
	{ name: 'bank_pw', value: 'hunter2-bank', domains: ['bank.example'] },
	{ name: 'wild', value: 'wild-value', domains: ['*.corp.example'] },
]);

Deno.test('secrets: an empty store is inert', () => {
	const empty = new SecretStore();
	assertEquals(empty.empty, true);
	assertEquals(empty.size, 0);
	assertEquals(empty.names(), []);
	const result = empty.substitute('<secret>x</secret>', 'https://a.test/');
	assertEquals(result.text, '<secret>x</secret>');
	assertEquals(result.substituted, false);
});

Deno.test('secrets: a placeholder is replaced with the configured value', () => {
	const result = STORE.substitute('user <secret>anywhere</secret> end', 'https://a.test/');
	assertEquals(result.text, 'user plain-value end');
	assertEquals(result.used, ['anywhere']);
	assertEquals(result.substituted, true);
});

Deno.test('secrets: several placeholders resolve, each reported once', () => {
	const result = STORE.substitute('<secret>anywhere</secret>:<secret>anywhere</secret>', 'https://a.test/');
	assertEquals(result.text, 'plain-value:plain-value');
	assertEquals(result.used, ['anywhere']);
});

Deno.test('secrets: text with no placeholder is untouched and costs nothing', () => {
	const result = STORE.substitute('an ordinary password', 'https://a.test/');
	assertEquals(result.text, 'an ordinary password');
	assertEquals(result.substituted, false);
	assertEquals(result.used, []);
});

Deno.test('secrets: an unknown name is refused, never typed literally', () => {
	const error = assertThrows(
		() => STORE.substitute('<secret>nope</secret>', 'https://a.test/'),
		ToolError,
	);
	assertEquals(error.code, 'invalid-arguments');
	assertStringIncludes(error.message, 'nope');
	assertStringIncludes(error.message, 'browser_get_state');
});

Deno.test('secrets: a pinned secret is refused off its origin', () => {
	assertEquals(STORE.substitute('<secret>bank_pw</secret>', 'https://bank.example/login').text, 'hunter2-bank');
	const error = assertThrows(
		() => STORE.substitute('<secret>bank_pw</secret>', 'https://evil.example/login'),
		ToolError,
	);
	assertEquals(error.code, 'navigation-blocked');
	assertStringIncludes(error.message, 'bank_pw');
	assertStringIncludes(error.message, 'https://evil.example');
	assertEquals(error.message.includes('hunter2'), false);
});

Deno.test('secrets: a lookalike domain does not match a pinned secret', () => {
	for (const origin of ['https://evil-bank.example/', 'https://bank.example.evil.test/', 'https://notbank.example/']) {
		assertThrows(() => STORE.substitute('<secret>bank_pw</secret>', origin), ToolError, undefined, origin);
	}
});

Deno.test('secrets: a wildcard pin matches its subdomains only', () => {
	assertEquals(STORE.substitute('<secret>wild</secret>', 'https://app.corp.example/').text, 'wild-value');
	assertThrows(() => STORE.substitute('<secret>wild</secret>', 'https://corp.example.attacker.test/'), ToolError);
});

Deno.test('secrets: namesFor lists only what this page may use', () => {
	assertEquals(STORE.names(), ['anywhere', 'bank_pw', 'wild']);
	assertEquals(STORE.namesFor('https://a.test/'), ['anywhere']);
	assertEquals(STORE.namesFor('https://bank.example/'), ['anywhere', 'bank_pw']);
	assertEquals(STORE.namesFor('https://x.corp.example/'), ['anywhere', 'wild']);
});

Deno.test('secrets: no accessor returns a value', () => {
	const serialized = JSON.stringify({ names: STORE.names(), forA: STORE.namesFor('https://bank.example/') });
	for (const value of ['plain-value', 'hunter2-bank', 'wild-value']) {
		assertEquals(serialized.includes(value), false, `${value} leaked through the name accessors`);
	}
});

// --- the pin is a SECRET-scoping decision, not a navigation one -------------

/** Every shape the navigation predicate permitted and the secret predicate must not. */
const FAIL_OPEN_SHAPES: readonly { readonly what: string; readonly url: string }[] = [
	{ what: 'about:blank — a blank tab is not the pinned bank', url: 'about:blank' },
	{ what: 'a new-tab URL', url: 'chrome://newtab/' },
	{ what: 'a data: document, whose bytes the attacker wrote', url: 'data:text/html,<input name=p>' },
	{ what: "a blob: minted by the attacker's origin", url: 'blob:https://evil.example/9f0c-uuid' },
	{ what: 'a blob: minted by the pinned origin itself', url: 'blob:https://bank.example/9f0c-uuid' },
	{ what: 'the pinned host over plaintext http (a downgrade)', url: 'http://bank.example/login' },
];

/** Shapes refused for other reasons — another host, no host, a script URL. They must stay refused. */
const ALREADY_CLOSED: readonly string[] = [
	'https://evil.example/collect',
	'about:srcdoc',
	'javascript:void(0)',
	'filesystem:https://evil.example/temporary/f',
	'',
	'https://accounts.bank.example/login',
	'not a url at all',
];

Deno.test('secret pin: a pinned secret is refused at every opaque and plaintext origin, and never advertised there', () => {
	for (const shape of FAIL_OPEN_SHAPES) {
		const error = assertThrows(
			() => STORE.substitute('<secret>bank_pw</secret>', shape.url),
			ToolError,
			undefined,
			`${shape.what} (${shape.url}) was permitted`,
		);
		assertEquals(error.code, 'navigation-blocked', shape.what);
		assertEquals(error.message.includes('hunter2-bank'), false, `${shape.what}: the refusal quoted the value`);

		assertEquals(
			STORE.namesFor(shape.url),
			['anywhere'],
			`${shape.what}: browser_get_state would still advertise the pinned secret at ${shape.url}`,
		);
	}
});

Deno.test('secret pin: another host, a host-less URL and a script URL are refused', () => {
	for (const url of ALREADY_CLOSED) {
		assertThrows(() => STORE.substitute('<secret>bank_pw</secret>', url), ToolError, undefined, url);
		assertEquals(STORE.namesFor(url).includes('bank_pw'), false, url);
	}
});

Deno.test('secret pin: the pin does not over-refuse — an ordinary https fill on the pinned domain works', () => {
	for (const url of ['https://bank.example/login', 'https://bank.example/', 'https://www.bank.example/login']) {
		assertEquals(STORE.substitute('<secret>bank_pw</secret>', url).text, 'hunter2-bank', url);
		assertEquals(STORE.namesFor(url), ['anywhere', 'bank_pw'], url);
	}
	assertEquals(STORE.substitute('<secret>wild</secret>', 'https://app.corp.example/').text, 'wild-value');
	assertEquals(STORE.substitute('<secret>anywhere</secret>', 'about:blank').text, 'plain-value');
});

Deno.test('secret pin: plaintext http needs an explicit http:// pattern, which works', () => {
	const explicit = new SecretStore([{ name: 'lan_pw', value: 'lan-value', domains: ['http://box.lan'] }]);
	assertEquals(explicit.substitute('<secret>lan_pw</secret>', 'http://box.lan/admin').text, 'lan-value');
	assertEquals(explicit.namesFor('http://box.lan/admin'), ['lan_pw']);
	assertThrows(() => explicit.substitute('<secret>lan_pw</secret>', 'http://other.lan/'), ToolError);
	for (const shape of ['about:blank', 'data:text/html,<input>', 'blob:http://box.lan/9f0c-uuid']) {
		assertThrows(() => explicit.substitute('<secret>lan_pw</secret>', shape), ToolError, undefined, shape);
	}
});

Deno.test('secret pin: the advertisement and the pin can never disagree', () => {
	const urls = [
		...FAIL_OPEN_SHAPES.map((shape) => shape.url),
		...ALREADY_CLOSED,
		'https://bank.example/login',
		'https://app.corp.example/',
		'https://a.test/',
	];
	for (const url of urls) {
		for (const name of STORE.names()) {
			const advertised = STORE.namesFor(url).includes(name);
			let bound: boolean;
			try {
				bound = STORE.substitute(`<secret>${name}</secret>`, url).substituted;
			} catch {
				bound = false;
			}
			assertEquals(advertised, bound, `${name} at ${url}: advertised=${advertised} but bound=${bound}`);
		}
	}
});

// --- parsing ----------------------------------------------------------------

Deno.test('secrets: the flat form maps names to values', () => {
	const entries = parseSecrets('{"a":"one","b":"two"}');
	assertEquals(entries.map((e) => e.name), ['a', 'b']);
	assertEquals(entries[0]?.domains, []);
});

Deno.test('secrets: the long form carries domains', () => {
	const entries = parseSecrets('{"a":{"value":"one","domains":["x.test"]}}');
	assertEquals(entries[0]?.domains, ['x.test']);
});

Deno.test('secrets: both forms may appear in one document', () => {
	const entries = parseSecrets('{"a":"one","b":{"value":"two","domains":["y.test"]}}');
	assertEquals(entries.length, 2);
	assertEquals(entries[1]?.domains, ['y.test']);
});

Deno.test('secrets: malformed configuration is refused with a reason', () => {
	const cases: Array<[string, string]> = [
		['not json', 'not valid JSON'],
		['[]', 'expected a JSON object'],
		['{"a":""}', 'is empty'],
		['{"a":123}', 'must be a string or an object'],
		['{"a":{}}', 'non-empty string value'],
		['{"a":{"value":"v","domains":"x"}}', 'array of strings'],
		['{"bad name":"v"}', 'invalid secret name'],
	];
	for (const [input, expected] of cases) {
		const error = assertThrows(() => parseSecrets(input), Error, undefined, input);
		assertStringIncludes(error.message, expected);
	}
});

Deno.test('secrets: a parse failure never quotes the value', () => {
	const error = assertThrows(() => parseSecrets('{"a":{"value":123}}'), Error);
	assertEquals(error.message.includes('123'), false);
});

Deno.test('parseSecrets: a document that is not JSON, or a name that is not one, is refused without quoting it', () => {
	for (
		const input of [
			'Q7SENTINEL-bare-password',
			`ghp_Q7SENTINEL${'x'.repeat(40)}`,
			'{"login": "Q7SENTINEL",, "b": "c"}',
			'{"login": "Q7SENTINEL"} Q7SENTINEL',
		]
	) {
		const error = assertThrows(() => parseSecrets(input), Error);
		assert(!error.message.includes('Q7SENTINEL'), error.message);
		assert(!error.message.includes('Unexpected token'), error.message);
		assert(/^not valid JSON( at position \d+)?$/.test(error.message), error.message);
	}
	const inverted = assertThrows(() => parseSecrets(`{"ok": "v", "Q7SENTINEL/${'y'.repeat(70)}": "github"}`), Error);
	assert(!inverted.message.includes('Q7SENTINEL'), inverted.message);
	assertStringIncludes(inverted.message, 'invalid secret name (entry 2)');
});

// --- the secret-fill element contract ----------------------------------------

/** A node shaped the way `assertFillable` and `describeFillTarget` read one. */
function fillNode(nodeName: string, attributes: Record<string, string>) {
	return { nodeName, attributes };
}

Deno.test('fill contract: assertFillable accepts a password input, a text input and a textarea', () => {
	assertEquals(assertFillable(fillNode('INPUT', { type: 'password' }), 1), { tag: 'input', type: 'password' });
	assertEquals(assertFillable(fillNode('INPUT', { type: 'text' }), 1), { tag: 'input', type: 'text' });
	assertEquals(assertFillable(fillNode('INPUT', {}), 1), { tag: 'input', type: 'text' });
	assertEquals(assertFillable(fillNode('INPUT', { type: 'PASSWORD' }), 1), { tag: 'input', type: 'password' });
	assertEquals(assertFillable(fillNode('TEXTAREA', {}), 1), { tag: 'textarea', type: 'textarea' });
});

Deno.test('fill contract: assertFillable refuses everything else with element-not-interactable', () => {
	const refused = [
		fillNode('BUTTON', { type: 'button' }),
		fillNode('DIV', { contenteditable: 'true' }),
		fillNode('A', { href: '#' }),
		fillNode('SELECT', {}),
		fillNode('INPUT', { type: 'checkbox' }),
		fillNode('INPUT', { type: 'file' }),
		fillNode('INPUT', { type: 'hidden' }),
		fillNode('INPUT', { type: 'email' }),
		fillNode('INPUT', { type: 'search' }),
	];
	for (const node of refused) {
		const error = assertThrows(() => assertFillable(node, 7), ToolError, undefined, JSON.stringify(node));
		assertEquals((error as ToolError).code, 'element-not-interactable');
		assertEquals((error as ToolError).extras.index, 7);
	}
});

Deno.test('fill contract: describeFillTarget names tag, type and id — and nothing the page filled in', () => {
	const sentinel = 'P4ssw0rd-SENTINEL-DO-NOT-LEAK';
	const node = fillNode('INPUT', {
		type: 'password',
		id: 'pw',
		name: 'password',
		value: sentinel,
		'aria-label': sentinel,
		placeholder: sentinel,
		title: sentinel,
	});
	const described = describeFillTarget(node);
	assertEquals(described, '<input type=password #pw>');
	assert(!described.includes(sentinel), described);
	const error = assertThrows(
		() => assertFillable(fillNode('DIV', { id: 'd', value: sentinel }), 1),
		ToolError,
	) as ToolError;
	assert(!error.message.includes(sentinel), error.message);
});

Deno.test('fill contract: the store answers `has` and `domainsOf` without ever handing back a value', () => {
	const store = new SecretStore([
		{ name: 'pinned', value: 'Zq8-PINNED', domains: ['bank.example.com'] },
		{ name: 'unpinned', value: 'Zq8-UNPINNED', domains: [] },
	]);
	assert(store.has('pinned'));
	assert(!store.has('nope'));
	assertEquals(store.domainsOf('pinned'), ['bank.example.com']);
	assertEquals(store.domainsOf('unpinned'), []);
	assertEquals(store.domainsOf('nope'), undefined);
	assert(!JSON.stringify([store.has('pinned'), store.domainsOf('pinned'), store.names()]).includes('Zq8-'));
});

Deno.test('redact replaces every stored value of four or more characters, as written', () => {
	const store = new SecretStore([
		{ name: 'long', value: 'tok-A1b2.C3*', domains: [] },
		{ name: 'inner', value: 'A1b2', domains: ['bank.example'] },
		{ name: 'short', value: 'abc', domains: [] },
		{ name: 'mark', value: 'secret', domains: [] },
	]);
	assertEquals(store.redact('a tok-A1b2.C3* b tok-A1b2.C3*'), 'a [secret] b [secret]');
	assertEquals(store.redact('x=tok-A1b2.C3*&y=A1b2'), 'x=[secret]&y=[secret]');
	assertEquals(store.redact('tok-A1b2.C3* secret'), '[secret] [secret]');
	assertEquals(store.redact('abc ABC a1b2'), 'abc ABC a1b2');
	assertEquals(new SecretStore().redact('tok-A1b2.C3*'), 'tok-A1b2.C3*');
	assertEquals(store.redact(''), '');
	assertEquals(store.redact('no values here'), 'no values here');
});

Deno.test('masking: short text is never sensitive, whatever it looks like', () => {
	for (const text of ['', 'a', 'pw', 'a@b.c']) {
		assertEquals(classifySensitiveText(text).sensitive, false, text);
	}
});

Deno.test('masking: email-shaped text masks as <email> from 6 characters up', () => {
	const result = classifySensitiveText('ab@c.de');
	assertEquals(result, { sensitive: true, kind: 'email', display: '<email>' });
	assertEquals(classifySensitiveText('someone@example.test').display, '<email>');
});

Deno.test('masking: 16+ alphanumeric-plus-.-_ masks as <credential>', () => {
	assertEquals(classifySensitiveText('hunter2hunter2hunter').kind, 'credential');
	assertEquals(classifySensitiveText('sk-live_AbCd.1234-XY').display, '<credential>');
	assertEquals(classifySensitiveText('a'.repeat(16)).kind, 'credential');
	assertEquals(classifySensitiveText('a'.repeat(15)).sensitive, false);
});

Deno.test('masking: long prose is not a credential — the character class excludes spaces', () => {
	const prose = 'the quick brown fox jumps over the lazy dog';
	assertEquals(classifySensitiveText(prose).sensitive, false);
	assertEquals(classifySensitiveText(prose).display, prose);
});

Deno.test('masking: text with punctuation outside .-_ is not a credential', () => {
	assertEquals(classifySensitiveText('search: widgets & gizmos!').sensitive, false);
});

Deno.test('masking: a long opaque identifier is masked — the accepted false positive of the heuristic', () => {
	assertEquals(classifySensitiveText('ORDER-2026-000123456').kind, 'credential');
});

Deno.test('masking: the raw value never appears in the display string', () => {
	for (const text of ['someone@example.test', 'p4ssw0rd-with-length-16']) {
		const result = classifySensitiveText(text);
		assertEquals(result.sensitive, true);
		assertEquals(result.display.includes(text), false);
	}
});

// --- `browser_fill_secret`'s secret choice. ---

const FORM: ClientFacts = { sampling: false, samplingTools: false, elicitForm: true, elicitUrl: false };
const NO_FORM: ClientFacts = { sampling: false, samplingTools: false, elicitForm: false, elicitUrl: true };
/** Every configured value carries this marker, so one substring search finds any value anywhere. */
const MARK = 'Zq8-VALUE';
const SECRETS: SecretEntry[] = [
	{ name: 'bank_password', value: `${MARK}-bank`, domains: ['bank.example.com'] },
	{ name: 'bank_otp', value: `${MARK}-otp`, domains: ['bank.example.com'] },
	{ name: 'mail_password', value: `${MARK}-mail`, domains: ['mail.example.org'] },
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

Deno.test('secret choice: a client without form elicitation gets the plain refusals', async () => {
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

Deno.test('secret choice: an unknown or unusable name offers only the pinned names permitted on the live origin', async () => {
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

Deno.test('secret choice: the chosen name is filled, audited and reported — by name, never by value', async () => {
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

Deno.test('secret choice: the choice is re-validated at retry, and a refusal on it types nothing', async () => {
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

Deno.test('secret choice: declining or cancelling the choice is user-declined and types nothing', async () => {
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

Deno.test('secret choice: with nothing usable to offer, a form-capable client gets the plain refusal', async () => {
	await using h = await harness(SECRETS.filter((entry) => !entry.name.startsWith('bank_')));
	await refused(h.fill('nope', { client: FORM, mcp: request() }), 'invalid-arguments', 'no secret named nope');
	await refused(h.fill('mail_password', { client: FORM, mcp: request() }), 'navigation-blocked', 'is not permitted');
	assertEquals(h.typed, []);
});
