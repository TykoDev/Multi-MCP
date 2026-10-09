/**
 * The `console` producer (owner item 3): armed by the ring's refcount, minting
 * one record per `Runtime.consoleAPICalled` / `exceptionThrown`, and never a
 * handle, url or source position.
 */
import { assert, assertEquals } from '@std/assert';
import { SessionEventRing } from './events.ts';
import type { SessionRecord } from './registry.ts';
import { consoleLevelOf, ConsoleProducer, MAX_CONSOLE_TEXT } from './page_console.ts';

type Listener = (params: Record<string, unknown>) => void;

function stub(): {
	client: unknown;
	fire(event: string, params: Record<string, unknown>): void;
	listeners: Map<string, Set<Listener>>;
} {
	const listeners = new Map<string, Set<Listener>>();
	const client = {
		on(event: string, listener: Listener) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
	};
	return {
		client,
		listeners,
		fire(event, params) {
			for (const listener of listeners.get(event) ?? []) listener(params);
		},
	};
}

function rig() {
	const s = stub();
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	const record = { id: 'sess', events: ring, lock: null, session: { cdpClient: s.client } } as unknown as SessionRecord;
	const producer = ConsoleProducer.attach(record)!;
	assert(producer !== null);
	// The registry hands the ring the arm callback; a subscriber then arms it.
	ring.setConsoleArmed(producer.setArmed);
	return {
		producer,
		stub: s,
		ring,
		records: () => ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }),
	};
}

Deno.test('console: nothing is minted before a subscriber arms the kind', () => {
	const r = rig();
	r.stub.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'before' }] });
	assertEquals(r.records().filter((entry) => entry.kind === 'console').length, 0);
});

Deno.test('console: an armed subscriber receives a record with a mapped level and joined text', () => {
	const r = rig();
	r.ring.armConsole();
	assertEquals(r.producer.armed, true);
	r.stub.fire('Runtime.consoleAPICalled', {
		type: 'warning',
		args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }],
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload, { level: 'warn', text: 'hello 42', truncated: false });
});

Deno.test('console: an exception mints an error record from text and description', () => {
	const r = rig();
	r.ring.armConsole();
	r.stub.fire('Runtime.exceptionThrown', {
		exceptionDetails: {
			text: 'Uncaught',
			exception: { description: 'TypeError: x is not a function' },
			url: 'https://secret.example/token',
		},
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload.level, 'error');
	assertEquals(record.payload.text, 'Uncaught TypeError: x is not a function');
	// The url is never on the wire — a url is where a token lives.
	assertEquals(JSON.stringify(record.payload).includes('secret.example'), false);
});

Deno.test('console: no object handle reaches the record', () => {
	const r = rig();
	r.ring.armConsole();
	r.stub.fire('Runtime.consoleAPICalled', {
		type: 'log',
		args: [{ type: 'object', objectId: 'obj-123-live-handle', description: 'Object' }],
	});
	const record = r.records().find((entry) => entry.kind === 'console');
	assert(record !== undefined);
	assertEquals(record.payload.text, 'Object');
	assertEquals(JSON.stringify(record.payload).includes('obj-123'), false, 'no live handle reaches the wire');
});

Deno.test('console: disarming on the last subscriber stops the listener', () => {
	const r = rig();
	r.ring.armConsole();
	r.ring.disarmConsole();
	assertEquals(r.producer.armed, false);
	r.stub.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after' }] });
	assertEquals(r.records().filter((entry) => entry.kind === 'console').length, 0);
});

Deno.test('console: the level map is closed', () => {
	assertEquals(consoleLevelOf('error'), 'error');
	assertEquals(consoleLevelOf('assert'), 'error');
	assertEquals(consoleLevelOf('warning'), 'warn');
	assertEquals(consoleLevelOf('debug'), 'debug');
	assertEquals(consoleLevelOf('info'), 'info');
	assertEquals(consoleLevelOf('table'), 'log', 'an unmapped type falls to log, never echoed');
});

Deno.test('R2-7: a console line is redacted before its cap, so a secret straddling it leaves no prefix', () => {
	const s = stub();
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	const record = { id: 'sess', events: ring, lock: null, session: { cdpClient: s.client } } as unknown as SessionRecord;
	const secret = 'Zq8-CONSOLE-SECRET';
	const producer = ConsoleProducer.attach(record, (text) => text.replaceAll(secret, '[secret]'))!;
	ring.setConsoleArmed(producer.setArmed);
	ring.armConsole();
	// The secret starts three characters before the cap: cut-then-redact would keep `Zq8`.
	const line = `${'a'.repeat(MAX_CONSOLE_TEXT - 3)}${secret}`;
	s.fire('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: line }] });
	s.fire('Runtime.exceptionThrown', { exceptionDetails: { text: line } });
	const texts = ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 })
		.filter((entry) => entry.kind === 'console')
		.map((entry) => String(entry.payload.text));
	assertEquals(texts.length, 2);
	for (const text of texts) {
		assert(text.length <= MAX_CONSOLE_TEXT);
		assert(!text.endsWith('Zq8'), text.slice(-6));
	}
});
