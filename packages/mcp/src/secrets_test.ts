/**
 * Secret placeholders (R14). The properties under test are the security ones:
 * a value never appears in anything the store returns, and a secret pinned to
 * one origin cannot be spent on another.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';
import { assertFillable, describeFillTarget, parseSecrets, SecretStore } from './secrets.ts';
import { ToolError } from './errors.ts';

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
	// With nothing configured the text is passed through untouched rather than
	// erroring: a deployment with no secrets is not a deployment with a typo.
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
	// The refusal points at how to find the right name.
	assertStringIncludes(error.message, 'browser_get_state');
});

Deno.test('secrets: a pinned secret is refused off its origin', () => {
	// On its own domain it works...
	assertEquals(STORE.substitute('<secret>bank_pw</secret>', 'https://bank.example/login').text, 'hunter2-bank');
	// ...and anywhere else it is refused rather than substituted.
	const error = assertThrows(
		() => STORE.substitute('<secret>bank_pw</secret>', 'https://evil.example/login'),
		ToolError,
	);
	assertEquals(error.code, 'navigation-blocked');
	assertStringIncludes(error.message, 'bank_pw');
	assertStringIncludes(error.message, 'https://evil.example');
	// The value is not in the message.
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

// --- SEC-FH-23: the pin is a SECRET-scoping decision, not a navigation one ----
//
// The defect these rows exist for: `#permits` resolved the pin with `isUrlAllowed`, the NAVIGATION
// predicate, which allows `about:blank` and the new-tab URLs, allows `data:` and `blob:`
// unconditionally, and lets a scheme-less pattern cover `http:`. All three are right for "may the
// agent go here" and wrong for "may a credential be spent here", and the consequence was measured
// through the shipped handler: a secret pinned to a bank was typed at `about:blank`, at a `data:`
// document, at `blob:https://evil.example/…` — with the ledger recording the spend at the
// ATTACKER's origin — and over plaintext http. Nothing in this file covered any of it.
//
// Each URL below is a row from that measurement. They are asserted twice over, on both consumers of
// `#permits`, because `available_secrets` is an authorization statement and not a convenience: a
// predicate that permitted these would not merely allow the mistake, it would propose it.

/** Every shape the navigation predicate permitted and the secret predicate must not. */
const FAIL_OPEN_SHAPES: readonly { readonly what: string; readonly url: string }[] = [
	{ what: 'about:blank — a blank tab is not the pinned bank', url: 'about:blank' },
	{ what: 'a new-tab URL', url: 'chrome://newtab/' },
	{ what: 'a data: document, whose bytes the attacker wrote', url: 'data:text/html,<input name=p>' },
	{ what: "a blob: minted by the attacker's origin", url: 'blob:https://evil.example/9f0c-uuid' },
	{ what: 'a blob: minted by the pinned origin itself', url: 'blob:https://bank.example/9f0c-uuid' },
	{ what: 'the pinned host over plaintext http (a downgrade)', url: 'http://bank.example/login' },
];

/** Shapes the shipped predicate already refused. They must stay refused: this is not a rewrite. */
const ALREADY_CLOSED: readonly string[] = [
	'https://evil.example/collect',
	'about:srcdoc',
	'javascript:void(0)',
	'filesystem:https://evil.example/temporary/f',
	'',
	'https://accounts.bank.example/login',
	'not a url at all',
];

Deno.test('SEC-FH-23: a pinned secret is refused at every opaque and plaintext origin, and never advertised there', () => {
	for (const shape of FAIL_OPEN_SHAPES) {
		// (1) The pin itself. The value must not bind — `substitute` refuses rather than returning it.
		const error = assertThrows(
			() => STORE.substitute('<secret>bank_pw</secret>', shape.url),
			ToolError,
			undefined,
			`${shape.what} (${shape.url}) was permitted`,
		);
		assertEquals(error.code, 'navigation-blocked', shape.what);
		assertEquals(error.message.includes('hunter2-bank'), false, `${shape.what}: the refusal quoted the value`);

		// (2) The advertisement. `browser_get_state` must not tell the model the credential is usable
		// here — the amplifier that turned the predicate defect into an invitation.
		assertEquals(
			STORE.namesFor(shape.url),
			['anywhere'],
			`${shape.what}: browser_get_state would still advertise the pinned secret at ${shape.url}`,
		);
	}
});

Deno.test('SEC-FH-23: the shapes that were already refused stay refused', () => {
	for (const url of ALREADY_CLOSED) {
		assertThrows(() => STORE.substitute('<secret>bank_pw</secret>', url), ToolError, undefined, url);
		assertEquals(STORE.namesFor(url).includes('bank_pw'), false, url);
	}
});

Deno.test('SEC-FH-23: the fix does not over-refuse — an ordinary https fill on the pinned domain still works', () => {
	// The row the fix is worthless without. A control that refuses everything is not a control, it is
	// an outage, and the one-line change was accepted on the measurement that this row survives it.
	for (const url of ['https://bank.example/login', 'https://bank.example/', 'https://www.bank.example/login']) {
		assertEquals(STORE.substitute('<secret>bank_pw</secret>', url).text, 'hunter2-bank', url);
		assertEquals(STORE.namesFor(url), ['anywhere', 'bank_pw'], url);
	}
	// The wildcard pin and the unpinned secret are untouched by the scheme rule.
	assertEquals(STORE.substitute('<secret>wild</secret>', 'https://app.corp.example/').text, 'wild-value');
	assertEquals(STORE.substitute('<secret>anywhere</secret>', 'about:blank').text, 'plain-value');
});

Deno.test('SEC-FH-23: plaintext http needs an explicit http:// pattern, which still works', () => {
	// M4's escape hatch, and the reason the https-only default is a narrowing rather than a removal:
	// an operator with a credential that genuinely belongs on a plaintext host says so in the pattern,
	// out loud, instead of inheriting it from a predicate that was never asked the question.
	const explicit = new SecretStore([{ name: 'lan_pw', value: 'lan-value', domains: ['http://box.lan'] }]);
	assertEquals(explicit.substitute('<secret>lan_pw</secret>', 'http://box.lan/admin').text, 'lan-value');
	assertEquals(explicit.namesFor('http://box.lan/admin'), ['lan_pw']);
	// And it is still a pin: the same host is the only host, and the opaque shapes stay closed.
	assertThrows(() => explicit.substitute('<secret>lan_pw</secret>', 'http://other.lan/'), ToolError);
	for (const shape of ['about:blank', 'data:text/html,<input>', 'blob:http://box.lan/9f0c-uuid']) {
		assertThrows(() => explicit.substitute('<secret>lan_pw</secret>', shape), ToolError, undefined, shape);
	}
});

Deno.test('SEC-FH-23: the advertisement and the pin can never disagree', () => {
	// The structural half. Both consumers go through the one private predicate, and this row is what
	// notices if a future edit gives either of them a second opinion: for every shape in this file,
	// `namesFor` naming a secret and `substitute` binding it are the same answer.
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

Deno.test('R1-1: a document that is not JSON, or a name that is not one, is refused without quoting it', () => {
	// V8's own message quotes the input (`Unexpected token 'h', "hunter2-…" is not valid JSON`): a bare credential in
	// TTK_SECRETS, its file or its provider would be printed by the refusal. A fixed phrase, a position at most.
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
	// An inverted map puts the credential where the name belongs; an invalid name is located, never repeated.
	const inverted = assertThrows(() => parseSecrets(`{"ok": "v", "Q7SENTINEL/${'y'.repeat(70)}": "github"}`), Error);
	assert(!inverted.message.includes('Q7SENTINEL'), inverted.message);
	assertStringIncludes(inverted.message, 'invalid secret name (entry 2)');
});

// --- B2.8: the secret-fill element contract ----------------------------------

/** A node shaped the way `assertFillable` and `describeFillTarget` read one. */
function fillNode(nodeName: string, attributes: Record<string, string>) {
	return { nodeName, attributes };
}

Deno.test('B2.8: assertFillable accepts a password input, a text input and a textarea', () => {
	assertEquals(assertFillable(fillNode('INPUT', { type: 'password' }), 1), { tag: 'input', type: 'password' });
	assertEquals(assertFillable(fillNode('INPUT', { type: 'text' }), 1), { tag: 'input', type: 'text' });
	// An `<input>` with no `type` is a text input, which is what the browser does with it.
	assertEquals(assertFillable(fillNode('INPUT', {}), 1), { tag: 'input', type: 'text' });
	// `type` is compared case-insensitively, as HTML does: `TYPE="PASSWORD"` is a password field.
	assertEquals(assertFillable(fillNode('INPUT', { type: 'PASSWORD' }), 1), { tag: 'input', type: 'password' });
	assertEquals(assertFillable(fillNode('TEXTAREA', {}), 1), { tag: 'textarea', type: 'textarea' });
});

Deno.test('B2.8: assertFillable refuses everything else with element-not-interactable', () => {
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

Deno.test('B2.8: describeFillTarget names tag, type and id — and nothing the page filled in', () => {
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
	// And the refusal message built from it is clean too, which is the surface that actually reaches a
	// transcript: a description nobody puts in an error is a description nobody can leak through.
	const error = assertThrows(
		() => assertFillable(fillNode('DIV', { id: 'd', value: sentinel }), 1),
		ToolError,
	) as ToolError;
	assert(!error.message.includes(sentinel), error.message);
});

Deno.test('B2.8: the store answers `has` and `domainsOf` without ever handing back a value', () => {
	const store = new SecretStore([
		{ name: 'pinned', value: 'Zq8-PINNED', domains: ['bank.example.com'] },
		{ name: 'unpinned', value: 'Zq8-UNPINNED', domains: [] },
	]);
	assert(store.has('pinned'));
	assert(!store.has('nope'));
	assertEquals(store.domainsOf('pinned'), ['bank.example.com']);
	// The empty array is the meaningful answer `browser_fill_secret` refuses on; `undefined` is the
	// different answer "no such secret". Collapsing them would make an unpinned secret look absent.
	assertEquals(store.domainsOf('unpinned'), []);
	assertEquals(store.domainsOf('nope'), undefined);
	assert(!JSON.stringify([store.has('pinned'), store.domainsOf('pinned'), store.names()]).includes('Zq8-'));
});

Deno.test('S0: redact replaces every stored value of four or more characters, as written', () => {
	const store = new SecretStore([
		{ name: 'long', value: 'tok-A1b2.C3*', domains: [] },
		{ name: 'inner', value: 'A1b2', domains: ['bank.example'] },
		{ name: 'short', value: 'abc', domains: [] },
		{ name: 'mark', value: 'secret', domains: [] },
	]);
	// Every occurrence, pinned or not, with regex metacharacters taken literally.
	assertEquals(store.redact('a tok-A1b2.C3* b tok-A1b2.C3*'), 'a [secret] b [secret]');
	// The longer value wins where both match, so no fragment of it is left behind.
	assertEquals(store.redact('x=tok-A1b2.C3*&y=A1b2'), 'x=[secret]&y=[secret]');
	// One pass: a value that spells part of the marker cannot rewrite an earlier replacement.
	assertEquals(store.redact('tok-A1b2.C3* secret'), '[secret] [secret]');
	// Below four characters a value is left alone, and so is the case that was not written.
	assertEquals(store.redact('abc ABC a1b2'), 'abc ABC a1b2');
	// Pure: nothing configured, nothing to match, or nothing given is the text unchanged.
	assertEquals(new SecretStore().redact('tok-A1b2.C3*'), 'tok-A1b2.C3*');
	assertEquals(store.redact(''), '');
	assertEquals(store.redact('no values here'), 'no values here');
});
