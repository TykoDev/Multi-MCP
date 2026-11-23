/** `browser_find` — ranking over the merged element records. */
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
/** The longest href `href_pattern` is tested against; a longer one is not tested and does not match. */
export const HREF_PATTERN_MAX_HREF_CHARS = 2048;
/**
 * Unbounded quantifiers (`*`, `+`, `{n,}`, or a `{n,m}` spanning more than {@linkcode HREF_PATTERN_MAX_BOUNDED_SPAN})
 * an unanchored pattern may carry.
 */
const HREF_PATTERN_MAX_UNBOUNDED = 1;
/**
 * The same for a pattern anchored by a leading `^` with no top-level `|`: it is tried at one start only, so it may
 * carry one more (`^.*.*x` against 2 048 characters measured ~5 ms).
 */
const HREF_PATTERN_MAX_UNBOUNDED_ANCHORED = 2;
/** A bounded quantifier spanning more repetitions than this (`{0,17}`) is costed as unbounded. */
const HREF_PATTERN_MAX_BOUNDED_SPAN = 16;
/**
 * The cap on the product of the pattern's choice points: each `?` doubles the worst case, each `{n,m}` multiplies it
 * by `m - n + 1`, and each `|` by its branch count.
 */
const HREF_PATTERN_MAX_CHOICES = 16;
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
interface FindMatch {
	readonly element: ObservedElement;
	readonly score: number;
}

/**
 * Compiles `href_pattern` under its caps, refusing a malformed, over-long or potentially catastrophic pattern
 * as a caller error (`invalid-arguments`), before any href is tested.
 */
export function compileHrefPattern(pattern: string): RegExp {
	if (pattern.length > HREF_PATTERN_MAX_CHARS) {
		throw new ToolError('invalid-arguments', `href_pattern is longer than ${HREF_PATTERN_MAX_CHARS} characters`);
	}
	let compiled: RegExp;
	try {
		compiled = new RegExp(pattern);
	} catch (cause) {
		throw new ToolError('invalid-arguments', `href_pattern is not a valid regular expression: ${String(cause)}`);
	}
	// Only after the engine accepted the syntax: the scan below may then assume classes and groups close.
	assertBoundedPattern(pattern);
	return compiled;
}

/** One open group while {@linkcode assertBoundedPattern} scans. */
interface GroupFrame {
	/** `|`-separated branches seen so far. */
	branches: number;
	/** Whether the group holds a choice point (a quantifier or a `|`), directly or in a nested group. */
	choosy: boolean;
}

/** A quantifier: the repetition bounds and how many pattern characters it spans (lazy `?` included). */
interface Quantifier {
	readonly min: number;
	readonly max: number;
	readonly length: number;
}

function refuseHrefPattern(reason: string): never {
	throw new ToolError(
		'invalid-arguments',
		`href_pattern ${reason}, which could backtrack catastrophically and stall the server; ` +
			'use a simpler pattern (single characters, classes and escapes, each optionally quantified)',
	);
}

/** The quantifier starting at `i`, or `null` when there is none there. */
function quantifierAt(pattern: string, i: number): Quantifier | null {
	const c = pattern[i];
	let found: Quantifier | null = null;
	if (c === '*') found = { min: 0, max: Infinity, length: 1 };
	else if (c === '+') found = { min: 1, max: Infinity, length: 1 };
	else if (c === '?') found = { min: 0, max: 1, length: 1 };
	else if (c === '{') {
		// Without the `u` flag a `{` that does not spell a quantifier is a literal (Annex B), so only this shape counts.
		const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
		if (match !== null) {
			const min = Number(match[1]);
			const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
			found = { min, max, length: match[0].length };
		}
	}
	if (found === null) return null;
	// The lazy modifier reorders the search; it does not shrink it.
	return pattern[i + found.length] === '?' ? { ...found, length: found.length + 1 } : found;
}

/** Refuses a pattern whose worst-case backtracking is not small. */
function assertBoundedPattern(pattern: string): void {
	const stack: GroupFrame[] = [{ branches: 1, choosy: false }];
	let unbounded = 0;
	let choices = 1;
	const charge = (factor: number): void => {
		choices *= factor;
		if (choices > HREF_PATTERN_MAX_CHOICES) {
			refuseHrefPattern(`has more than ${HREF_PATTERN_MAX_CHOICES} combined choices (?, {n,m}, |)`);
		}
	};

	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i]!;
		const frame = stack[stack.length - 1]!;
		let quantifiable = false;
		let closed: GroupFrame | null = null;
		if (c === '\\') {
			const next = pattern[i + 1] ?? '';
			// `\k` is a literal `k` in a pattern with no named group, but refusing it costs nothing real.
			if (/[1-9]/.test(next) || next === 'k') refuseHrefPattern('uses a backreference');
			i += 2;
			quantifiable = true;
		} else if (c === '[') {
			// In JavaScript the first unescaped `]` closes a class, even right after `[` or `[^`.
			let j = i + 1;
			if (pattern[j] === '^') j += 1;
			while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
			i = j + 1;
			quantifiable = true;
		} else if (c === '(') {
			if (/^\(\?(?:=|!|<=|<!)/.test(pattern.slice(i, i + 4))) refuseHrefPattern('uses a lookaround');
			stack.push({ branches: 1, choosy: false });
			if (pattern.startsWith('(?:', i)) i += 3;
			else if (pattern.startsWith('(?<', i)) {
				// A named group: skip its name. The engine accepted the syntax, so the `>` is there.
				const end = pattern.indexOf('>', i);
				if (end < 0) refuseHrefPattern('has an unterminated group name');
				i = end + 1;
			} else i += 1;
		} else if (c === ')') {
			closed = stack.length > 1 ? stack.pop()! : { branches: 1, choosy: false };
			const parent = stack[stack.length - 1]!;
			parent.choosy ||= closed.choosy;
			charge(closed.branches);
			i += 1;
			quantifiable = true;
		} else if (c === '|') {
			frame.branches += 1;
			frame.choosy = true;
			i += 1;
		} else if (c === '^' || c === '$') {
			i += 1; // assertions: not quantifiable
		} else {
			i += 1; // a literal, `.`, or a `{` that spells no quantifier
			quantifiable = true;
		}
		if (!quantifiable) continue;

		const quantifier = quantifierAt(pattern, i);
		if (quantifier === null) continue;
		i += quantifier.length;
		const span = quantifier.max - quantifier.min;
		const holder = stack[stack.length - 1]!;
		if (span > 0) holder.choosy = true;
		if (closed !== null) {
			// The quantified group is where exponential backtracking lives. A plain group repeated a fixed number
			// of times, or made optional once, is a plain sequence with at most one extra choice.
			if (closed.choosy || span > 1) refuseHrefPattern('quantifies a group that is not plain and optional');
			if (span === 1) charge(2);
			continue;
		}
		if (span === 0) continue; // `{n}`: one way to match
		if (span > HREF_PATTERN_MAX_BOUNDED_SPAN) unbounded += 1;
		else charge(span + 1);
	}

	const top = stack[0]!;
	charge(top.branches);
	// A leading `^` with no top-level `|` is tried at one start only, which removes one factor of `n`.
	const anchored = pattern.startsWith('^') && top.branches === 1;
	const allowed = anchored ? HREF_PATTERN_MAX_UNBOUNDED_ANCHORED : HREF_PATTERN_MAX_UNBOUNDED;
	if (unbounded > allowed) {
		refuseHrefPattern(
			`has ${unbounded} unbounded quantifiers (*, +, {n,}); the limit is ${HREF_PATTERN_MAX_UNBOUNDED}, ` +
				`or ${HREF_PATTERN_MAX_UNBOUNDED_ANCHORED} when the pattern starts with ^ and has no top-level |`,
		);
	}
}

/** Ranks the records against the query. */
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
			// Over the length cap the worst case is not bounded (a `data:` URL); not tested, no match.
			if (element.href.length > HREF_PATTERN_MAX_HREF_CHARS) continue;
			hrefsTested += 1;
			const matched = hrefPattern.test(element.href);
			// After every test rather than every 256 elements: one admitted test is bounded, 256 of them are not small.
			if (now() > deadline) {
				throw new ToolError('timeout', `browser_find exceeded its ${FIND_BUDGET_MS} ms budget after ${i + 1} elements`);
			}
			if (!matched) continue;
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
