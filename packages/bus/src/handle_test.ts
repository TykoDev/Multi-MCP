import { assertEquals, assertRejects } from '@std/assert';
import { expect } from '@std/expect';
import { BaseEvent, createEventHandle, createSettledHandle, firstRejected, type HandlerOutcome } from '../mod.ts';
import { withDeadline } from './deadline.ts';

class HdlProbeEvent extends BaseEvent<string> {}

function outcome(overrides: Partial<HandlerOutcome<string>> = {}): HandlerOutcome<string> {
	return {
		handlerName: 'probe',
		status: 'fulfilled',
		value: undefined,
		error: undefined,
		durationMs: 1,
		...overrides,
	};
}

Deno.test('handle: catch() and finally() derive from the same settlement', async () => {
	const boom = new Error('handler exploded');
	const handle = createEventHandle(
		new HdlProbeEvent(),
		Promise.resolve([outcome({ status: 'rejected', error: boom })]),
	);
	assertEquals(await handle.catch((error) => error), boom);
	let ranFinally = false;
	await handle.finally(() => {
		ranFinally = true;
	}).catch(() => {});
	assertEquals(ranFinally, true);
	assertEquals(Object.prototype.toString.call(handle), '[object EventHandle]');
});

Deno.test('handle: a rejected settlement degrades into a bus-level outcome, never an unhandled rejection', async () => {
	const boom = new Error('run failed');
	const handle = createEventHandle(
		new HdlProbeEvent(),
		Promise.reject<readonly HandlerOutcome<string>[]>(boom),
	);
	const outcomes = await handle.outcomes();
	assertEquals(outcomes.length, 1);
	assertEquals(outcomes[0]?.handlerName, '<bus>');
	assertEquals(await assertRejects(async () => await handle), boom);
});

Deno.test('handle: a settled handle has no outcomes and no result', async () => {
	const handle = createSettledHandle(new HdlProbeEvent());
	await handle;
	assertEquals(await handle.outcomes(), []);
	expect(await handle.eventResult()).toBeUndefined();
});

Deno.test('handle: firstRejected finds a handler that threw undefined', () => {
	// undefined-means: the subject of the test — a handler that threw `undefined`, so the patch must
	// override the factory's default `error` rather than leave it in place.
	const outcomes = [outcome(), outcome({ status: 'rejected', error: undefined })];
	assertEquals(firstRejected(outcomes)?.status, 'rejected');
	assertEquals(firstRejected([outcome()]), undefined);
});

Deno.test('deadline: a non-positive or non-finite budget disables the deadline', async () => {
	assertEquals(await withDeadline(Promise.resolve('value'), 0), { timedOut: false, value: 'value' });
	assertEquals(await withDeadline(Promise.resolve('value'), Number.NaN), { timedOut: false, value: 'value' });
});

Deno.test('deadline: rejections propagate and the timer is still cleared', async () => {
	const boom = new Error('inner');
	assertEquals(await assertRejects(() => withDeadline(Promise.reject(boom), 60_000)), boom);
});
