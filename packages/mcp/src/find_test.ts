/**
 * `browser_find`'s ranking (B1.6) against the recorded corpus and against a fixed record set: the
 * conjunction rule, the scores, the tie-break, `near`'s exclusion of boxless elements, and the three
 * `href_pattern` mitigations (the cap, the budget, the malformed refusal).
 */
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { captureHarness } from '../fixtures/capture_session.ts';
import { type ObservedElement, resolveFields } from './element_record.ts';
import { ToolError } from './errors.ts';
import {
	compileHrefPattern,
	FIND_BUDGET_CHECK_INTERVAL,
	FIND_BUDGET_MS,
	HREF_PATTERN_MAX_CHARS,
	HREF_PATTERN_MAX_HREFS,
	rankElements,
} from './find.ts';
import { observe } from './observe.ts';
import * as tools from './tools.ts';

function el(index: number, extra: Partial<ObservedElement> = {}): ObservedElement {
	return { index, tag: 'a', ...extra };
}

Deno.test('find: every named predicate must hold, and the score is their mean', () => {
	const records = [
		el(1, { label: 'Sign in', href: '/login', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
		el(2, { label: 'sign in', href: '/signin', bounds: { x: 100, y: 0, w: 10, h: 10 } }),
		el(3, { label: 'Register', href: '/register', bounds: { x: 200, y: 0, w: 10, h: 10 } }),
	];
	const exact = rankElements(records, { name: 'Sign in' });
	assertEquals(exact.map((m) => [m.element.index, m.score]), [[1, 1], [2, 0.95]]);
	// A predicate that fails excludes the element outright: `Register` never matches `name: 'Sign in'`.
	const both = rankElements(records, { name: 'Sign in', href_pattern: '^/sign' });
	assertEquals(both.map((m) => m.element.index), [2]);
	assertEquals(both[0]?.score, (0.95 + 0.9) / 2);
	// Substring is 0.8; case-insensitive substring too.
	assertEquals(rankElements(records, { name: 'IGN' }).map((m) => m.score), [0.8, 0.8]);
});

Deno.test('find: ties break by ascending index, so a replay is deterministic', () => {
	const records = [el(9, { label: 'Go' }), el(3, { label: 'Go' }), el(5, { label: 'Go' })];
	assertEquals(rankElements(records, { name: 'Go' }).map((m) => m.element.index), [3, 5, 9]);
});

Deno.test('find: near ranks by distance to the bounds centre and excludes a boxless element', () => {
	const records = [
		el(1, { bounds: { x: 0, y: 0, w: 10, h: 10 } }),
		el(2, { bounds: { x: 95, y: 0, w: 10, h: 10 } }),
		el(3, { bounds: null }),
	];
	const ranked = rankElements(records, { near: { x: 100, y: 5 } });
	assertEquals(ranked.map((m) => m.element.index), [2, 1]);
	assertEquals(ranked[0]?.score, 1);
	assertEquals(ranked[1]?.score, 1 / (1 + 95 / 100));
});

Deno.test('find: role matches the ARIA role, else the tag; frame_id restricts', () => {
	const records = [
		el(1, { tag: 'a', role: 'link', frame_id: 'top' }),
		el(2, { tag: 'button', frame_id: 'top' }),
		el(3, { tag: 'button', frame_id: 'child' }),
	];
	assertEquals(rankElements(records, { role: 'button' }).map((m) => m.element.index), [2, 3]);
	assertEquals(rankElements(records, { role: 'button', frame_id: 'child' }).map((m) => m.element.index), [3]);
	assertEquals(rankElements(records, { role: 'link' }).map((m) => m.element.index), [1]);
});

Deno.test('find: href_pattern is capped in length, refused when malformed, and tests at most 2000 hrefs', () => {
	assertThrows(() => compileHrefPattern('('), ToolError, 'not a valid regular expression');
	assertThrows(() => compileHrefPattern('a'.repeat(HREF_PATTERN_MAX_CHARS + 1)), ToolError, 'longer than');
	const many = Array.from({ length: HREF_PATTERN_MAX_HREFS + 10 }, (_, i) => el(i, { href: `/p/${i}` }));
	const ranked = rankElements(many, { href_pattern: '^/p/' });
	assertEquals(ranked.length, HREF_PATTERN_MAX_HREFS, 'hrefs beyond the cap are not tested and do not match');
});

Deno.test('find: the wall-clock budget is checked every 256 elements and answers timeout, never hangs', () => {
	const many = Array.from({ length: FIND_BUDGET_CHECK_INTERVAL * 3 }, (_, i) => el(i, { label: 'x' }));
	let calls = 0;
	// The first call sets the deadline; every check after it reads a clock past it.
	const now = () => (calls++ === 0 ? 0 : FIND_BUDGET_MS + 1);
	const error = assertThrows(() => rankElements(many, { name: 'x' }, { now }), ToolError);
	assertEquals(error.code, 'timeout');
});

Deno.test('find: on a recorded page, role+name, href_pattern and near all return the same element', async () => {
	const h = await captureHarness('text_nodes_and_links');
	try {
		const observation = await observe(h.record, { fields: resolveFields(['core']), elementLimit: 5000 });
		const link = observation.elements.find((e) => e.href !== undefined && e.label !== undefined);
		assert(link !== undefined && link.bounds !== null && link.bounds !== undefined, 'the fixture has a labelled link');
		const byName = rankElements(observation.elements, { role: 'link', name: link.label! });
		const byHref = rankElements(observation.elements, {
			href_pattern: `^${link.href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
		});
		const byNear = rankElements(observation.elements, {
			near: { x: link.bounds.x + link.bounds.w / 2, y: link.bounds.y + link.bounds.h / 2 },
		});
		assertEquals(byName[0]?.element.index, link.index);
		assertEquals(byHref[0]?.element.index, link.index);
		assertEquals(byNear[0]?.element.index, link.index);
		assertEquals(byNear[0]?.score, 1, 'distance zero scores 1');
	} finally {
		await h.registry.shutdown();
	}
});

Deno.test('find tool: an empty query is a caller error, and the result carries the token, total and truncation', async () => {
	const h = await captureHarness('text_nodes_and_links');
	try {
		await assertRejects(() => tools.browserFind({ query: {} }, h.ctx), ToolError, 'at least one');
		const result = await tools.browserFind({ query: { role: 'link' }, limit: 1 }, h.ctx) as {
			structuredContent: {
				matches: Array<Record<string, unknown>>;
				total: number;
				truncated: boolean;
				state_token: string;
			};
		};
		const payload = result.structuredContent;
		assertEquals(payload.matches.length, 1);
		assert(payload.total > 1);
		assertEquals(payload.truncated, true);
		assert(typeof payload.state_token === 'string');
		// The internal fields the predicates read are projected away when the caller did not ask.
		const match = payload.matches[0]!;
		assert('score' in match && 'bounds' in match, 'core fields plus the score');
		assert(!('text' in match), 'text was read for the predicate only');
	} finally {
		await h.registry.shutdown();
	}
});
