import { assertEquals } from '@std/assert';
import { BaseEvent, DEFAULT_HISTORY_LIMIT, EventHistory } from '../mod.ts';

class HistNoteEvent extends BaseEvent<void> {
	constructor(readonly tag: string) {
		super();
	}
}

function tags(events: Iterable<BaseEvent<unknown>>): string[] {
	return [...events].map((event) => (event as HistNoteEvent).tag);
}

Deno.test('history: keeps insertion order until the limit is reached', () => {
	const history = new EventHistory(4);
	assertEquals(history.limit, 4);
	for (const tag of ['a', 'b', 'c']) history.push(new HistNoteEvent(tag));
	assertEquals(history.size, 3);
	assertEquals(tags(history.toArray()), ['a', 'b', 'c']);
});

Deno.test('history: evicts the oldest entry once full', () => {
	const history = new EventHistory(3);
	for (const tag of ['a', 'b', 'c', 'd', 'e']) history.push(new HistNoteEvent(tag));
	assertEquals(history.size, 3);
	assertEquals(tags(history.toArray()), ['c', 'd', 'e']);
	assertEquals(tags(history), ['c', 'd', 'e'], 'iterable form matches toArray()');
});

Deno.test('history: recent(n) returns the n newest entries, oldest first', () => {
	const history = new EventHistory(10);
	for (const tag of ['a', 'b', 'c', 'd']) history.push(new HistNoteEvent(tag));
	assertEquals(tags(history.recent(2)), ['c', 'd']);
	assertEquals(tags(history.recent(99)), ['a', 'b', 'c', 'd']);
	assertEquals(history.recent(0), []);
	assertEquals(history.recent(-1), []);
});

Deno.test('history: a zero or invalid limit disables retention', () => {
	for (const limit of [0, -5, Number.NaN]) {
		const history = new EventHistory(limit);
		history.push(new HistNoteEvent('a'));
		assertEquals(history.size, 0);
		assertEquals(history.toArray(), []);
	}
});

Deno.test('history: clear() empties the ring and the default limit is exported', () => {
	const history = new EventHistory();
	assertEquals(history.limit, DEFAULT_HISTORY_LIMIT);
	history.push(new HistNoteEvent('a'));
	history.clear();
	assertEquals(history.size, 0);
	assertEquals(history.toArray(), []);
	history.push(new HistNoteEvent('b'));
	assertEquals(tags(history.toArray()), ['b']);
});
