/**
 * `browser_find` — ranking over the merged element records (`report_design.md` §6.4, needed-browser-functions §1.3).
 *
 * Pure: it takes the records an observation produced and a query, and returns the matches in score
 * order. Every predicate in the query must hold for an element to match (the query is a conjunction);
 * `score` is a ranking aid, not a probability — the mean of the satisfied predicates' scores — and ties
 * break by ascending `index`, so the ordering is total and a replay is deterministic.
 *
 * `href_pattern` is a caller-supplied regular expression evaluated server-side. The mitigations are
 * partial and are stated as such (IR-3, F-3): the pattern is capped at 200 characters, at most 2000
 * hrefs are tested, and the call runs under a 2 000 ms wall-clock budget checked every 256 elements.
 * One pathological evaluation is not interruptible in JavaScript, so a caller can still hang its own
 * call for the duration of one backtracking run against a session it already controls.
 */
import type { ObservedElement } from './element_record.ts';
import { ToolError } from './errors.ts';

/** The query, as the tool takes it. Every present member must be satisfied. */
export interface FindQuery {
	readonly role?: string;
	readonly name?: string;
	readonly text?: string;
	readonly href_pattern?: string;
	readonly near?: { x: number; y: number };
	readonly frame_id?: string;
}

export const HREF_PATTERN_MAX_CHARS = 200;
export const HREF_PATTERN_MAX_HREFS = 2000;
export const FIND_BUDGET_MS = 2000;
export const FIND_BUDGET_CHECK_INTERVAL = 256;
export const FIND_DEFAULT_LIMIT = 5;

/** Score of one satisfied string predicate. */
function stringScore(candidate: string | undefined, wanted: string): number | null {
	if (candidate === undefined || candidate === '') return null;
	if (candidate === wanted) return 1;
	if (candidate.toLowerCase() === wanted.toLowerCase()) return 0.95;
	if (candidate.toLowerCase().includes(wanted.toLowerCase())) return 0.8;
	return null;
}

/** A match: the record plus its score. */
export interface FindMatch {
	readonly element: ObservedElement;
	readonly score: number;
}

/** Compiles `href_pattern` under its cap, refusing a malformed or over-long pattern as a caller error. */
export function compileHrefPattern(pattern: string): RegExp {
	if (pattern.length > HREF_PATTERN_MAX_CHARS) {
		throw new ToolError('invalid-arguments', `href_pattern is longer than ${HREF_PATTERN_MAX_CHARS} characters`);
	}
	try {
		return new RegExp(pattern);
	} catch (cause) {
		throw new ToolError('invalid-arguments', `href_pattern is not a valid regular expression: ${String(cause)}`);
	}
}

/**
 * Ranks the records against the query. The records must carry `bounds` when `near` is given (an
 * element with `bounds: null` is unrankable by distance and is excluded rather than sorted last with a
 * made-up number), `frame_id` when `frame_id` is given, and `text` when `text` is given.
 */
export function rankElements(
	elements: readonly ObservedElement[],
	query: FindQuery,
	options: { now?: () => number } = {},
): FindMatch[] {
	const hrefPattern = query.href_pattern === undefined ? null : compileHrefPattern(query.href_pattern);
	const now = options.now ?? Date.now;
	const deadline = now() + FIND_BUDGET_MS;
	const matches: FindMatch[] = [];
	let hrefsTested = 0;

	for (let i = 0; i < elements.length; i++) {
		if (i % FIND_BUDGET_CHECK_INTERVAL === FIND_BUDGET_CHECK_INTERVAL - 1 && now() > deadline) {
			throw new ToolError('timeout', `browser_find exceeded its ${FIND_BUDGET_MS} ms budget after ${i} elements`);
		}
		const element = elements[i]!;
		if (query.frame_id !== undefined && element.frame_id !== query.frame_id) continue;

		const scores: number[] = [];
		if (query.role !== undefined) {
			const score = stringScore(element.role ?? element.tag, query.role);
			if (score === null) continue;
			scores.push(score);
		}
		if (query.name !== undefined) {
			const score = stringScore(element.label, query.name);
			if (score === null) continue;
			scores.push(score);
		}
		if (query.text !== undefined) {
			const score = stringScore(element.text ?? element.label, query.text);
			if (score === null) continue;
			scores.push(score);
		}
		if (hrefPattern !== null) {
			if (element.href === undefined) continue;
			if (hrefsTested >= HREF_PATTERN_MAX_HREFS) continue;
			hrefsTested += 1;
			if (!hrefPattern.test(element.href)) continue;
			scores.push(0.9);
		}
		if (query.near !== undefined) {
			const bounds = element.bounds;
			if (bounds === null || bounds === undefined) continue;
			const dx = bounds.x + bounds.w / 2 - query.near.x;
			const dy = bounds.y + bounds.h / 2 - query.near.y;
			scores.push(1 / (1 + Math.hypot(dx, dy) / 100));
		}
		const score = scores.length === 0 ? 1 : scores.reduce((sum, value) => sum + value, 0) / scores.length;
		matches.push({ element, score });
	}

	matches.sort((a, b) => b.score - a.score || a.element.index - b.element.index);
	return matches;
}
