/**
 * The `dom.settled` producer (owner item 3, D-8): debounces mutation batches
 * into one record per quiet transition, carries the state token, and reads
 * nothing while no subscriber wants the kind.
 */
import { assert, assertEquals } from '@std/assert';
import { FakeTime } from '@std/testing/time';
import { SessionEventRing } from './events.ts';
import type { SessionRecord } from './registry.ts';
import { DOM_SETTLE_QUIET_MS, DomSettleProducer } from './page_dom_settle.ts';

function rig(options: { token?: string | null; onRead?: () => void } = {}) {
	const ring = new SessionEventRing({ now: () => 1_000_000 });
	let reads = 0;
	const record = {
		id: 'sess',
		events: ring,
		session: {
			getBrowserStateSummary: () => {
				reads += 1;
				options.onRead?.();
				return Promise.resolve({ stateToken: options.token ?? 'stk1:abc:def' });
			},
		},
	} as unknown as SessionRecord;
	const producer = new DomSettleProducer({ record });
	return {
		producer,
		ring,
		reads: () => reads,
		records: () => ring.read({ kind: 'cursor', epoch: ring.epoch, seq: 0 }),
	};
}

Deno.test('dom.settled: no subscriber, no read — mutations are observed for free', async () => {
	using time = new FakeTime();
	const r = rig();
	r.producer.onMutation(3);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(r.reads(), 0, 'an unwatched session must do no state read');
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0);
});

Deno.test('dom.settled: an armed subscriber gets one record after the quiet window, carrying the token', async () => {
	using time = new FakeTime();
	const r = rig({ token: 'stk1:aaaa:bbbb' });
	r.ring.armDomSettled();
	r.producer.onMutation(2);
	r.producer.onMutation(5);
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0, 'not before the window elapses');
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	const record = r.records().find((entry) => entry.kind === 'dom.settled');
	assert(record !== undefined);
	assertEquals(record.payload, { token: 'stk1:aaaa:bbbb', mutations: 7, quiet_ms: DOM_SETTLE_QUIET_MS });
});

Deno.test('dom.settled: a mutation before the window elapses restarts it — a busy page never settles', async () => {
	using time = new FakeTime();
	const r = rig();
	r.ring.armDomSettled();
	for (let i = 0; i < 5; i += 1) {
		r.producer.onMutation(1);
		await time.tickAsync(DOM_SETTLE_QUIET_MS - 100); // never a full quiet window
	}
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0, 'the window kept restarting');
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(
		r.records().filter((entry) => entry.kind === 'dom.settled').length,
		1,
		'one settle once it finally goes quiet',
	);
});

Deno.test('dom.settled: the mutation count resets after each settle', async () => {
	using time = new FakeTime();
	const r = rig();
	r.ring.armDomSettled();
	r.producer.onMutation(4);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	r.producer.onMutation(1);
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	const settled = r.records().filter((entry) => entry.kind === 'dom.settled');
	assertEquals(settled.map((entry) => entry.payload.mutations), [4, 1]);
});

Deno.test('dom.settled: dispose stops any pending settle', async () => {
	using time = new FakeTime();
	const r = rig();
	r.ring.armDomSettled();
	r.producer.onMutation(3);
	r.producer.dispose();
	await time.tickAsync(DOM_SETTLE_QUIET_MS + 10);
	assertEquals(r.reads(), 0);
	assertEquals(r.records().filter((entry) => entry.kind === 'dom.settled').length, 0);
});
