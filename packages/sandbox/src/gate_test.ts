import { assertEquals, assertRejects } from '@std/assert';
import { Gate, GateError, Runs } from './gate.ts';

const RUN = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const tick = () => new Promise((r) => setTimeout(r, 5));

Deno.test('gate: two at once, the third waits its turn, in order', async () => {
	const gate = new Gate(2, 8, 10_000);
	const a = await gate.enter();
	const b = await gate.enter();
	assertEquals(gate.running, 2);
	const order: string[] = [];
	const c = gate.enter().then((release) => {
		order.push('c');
		return release;
	});
	const d = gate.enter().then((release) => {
		order.push('d');
		return release;
	});
	await tick();
	assertEquals(order, []);
	assertEquals(gate.waiting, 2);
	a();
	const releaseC = await c;
	assertEquals(order, ['c']);
	assertEquals(gate.running, 2);
	b();
	(await d)();
	releaseC();
	assertEquals(order, ['c', 'd']);
	assertEquals(gate.running, 0);
});

Deno.test('gate: a full queue is refused at once as busy', async () => {
	const gate = new Gate(1, 1, 10_000);
	const release = await gate.enter();
	const waiting = gate.enter();
	const refused = await assertRejects(() => gate.enter(), GateError);
	assertEquals([refused.status, refused.code], [429, 'busy']);
	release();
	(await waiting)();
});

Deno.test('gate: waiting too long is refused as busy', async () => {
	const gate = new Gate(1, 4, 30);
	const release = await gate.enter();
	const refused = await assertRejects(() => gate.enter(), GateError);
	assertEquals(refused.status, 429);
	assertEquals(gate.waiting, 0);
	release();
	assertEquals(gate.running, 0);
});

Deno.test('gate: a caller that goes away leaves the queue, and is told it was cancelled (SB-10)', async () => {
	const gate = new Gate(1, 4, 10_000);
	const release = await gate.enter();
	const controller = new AbortController();
	const waiting = gate.enter(controller.signal);
	controller.abort();
	const cancelled = await assertRejects(() => waiting, GateError);
	assertEquals([cancelled.status, cancelled.code], [499, 'cancelled']);
	assertEquals(gate.waiting, 0);
	// A caller already gone is refused at once, not left waiting for a timer.
	const late = await assertRejects(() => gate.enter(AbortSignal.abort()), GateError);
	assertEquals([late.status, late.code, gate.waiting], [499, 'cancelled', 0]);
	release();
	assertEquals(gate.running, 0);
});

Deno.test('gate: a release counts once, however often it is called', async () => {
	const gate = new Gate(1, 4, 10_000);
	const release = await gate.enter();
	release();
	release();
	assertEquals(gate.running, 0);
});

Deno.test('runs: one thing at a time per run', async () => {
	const runs = new Runs();
	let finish!: () => void;
	const first = runs.hold(RUN, undefined, () => new Promise<void>((r) => finish = r));
	const second = await assertRejects(() => runs.hold(RUN, undefined, async () => {}), GateError);
	assertEquals([second.status, second.code], [409, 'run_busy']);
	// Another run is not held up.
	await runs.hold('11111111-2222-4333-8444-555555555555', undefined, async () => {});
	finish();
	await first;
	await runs.hold(RUN, undefined, async () => {});
});

Deno.test('runs: removing a run stops what it has under way, and keeps new work out', async () => {
	const runs = new Runs();
	let cancelled = false;
	const working = runs.hold(RUN, undefined, (signal) =>
		new Promise<void>((resolve) => {
			signal.addEventListener('abort', () => {
				cancelled = true;
				setTimeout(resolve, 20);
			});
		}));
	let during: GateError | null = null;
	const removed = await runs.removing(RUN, async () => {
		during = await assertRejects(() => runs.hold(RUN, undefined, async () => {}), GateError);
		return 'gone';
	});
	await working;
	assertEquals(cancelled, true);
	assertEquals(removed, 'gone');
	assertEquals(during!.status, 409);
	await runs.hold(RUN, undefined, async () => {});
});

Deno.test("runs: the caller's own signal reaches the work", async () => {
	const runs = new Runs();
	const controller = new AbortController();
	const seen = runs.hold(
		RUN,
		controller.signal,
		(signal) => new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(true))),
	);
	controller.abort();
	assertEquals(await seen, true);
});
