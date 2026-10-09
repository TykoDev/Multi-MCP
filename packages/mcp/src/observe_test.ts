/**
 * SEC-04: one password predicate, one implementation, and the containment
 * check that keeps it that way.
 *
 * The live defect this closes (E-34): `labelOf` read `node.attributes.value` as
 * a label candidate and this module carried no password predicate at all, so an
 * `<input type="password" value="…">` with no accessible name shipped its value
 * as the element's label — on the `browser_get_state` result, on the
 * `resources/read` observation, and on both sampling prompts, which send it to
 * the caller's model. It is the third instance of the class after E-29 and
 * E-33, which is why the containment check below is a test rather than a
 * convention.
 */
import { assert, assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { labelOf, promptBlock } from './observe.ts';

/** A seed chosen so its length collides with nothing legitimate in a label. */
const SECRET = 'Q7x-SEED-9fk';

function node(attributes: Record<string, string>, axName?: string): EnhancedDomTreeNode {
	return {
		nodeName: 'INPUT',
		attributes,
		axNode: axName === undefined ? null : { name: axName, role: 'textbox' },
		childrenNodes: [],
		compoundChildren: [],
	} as unknown as EnhancedDomTreeNode;
}

// --- the predicate, arm by arm ----------------------------------------------

Deno.test('observe: a password field never contributes its value to a label', () => {
	const cases: Array<[string, Record<string, string>]> = [
		['type=password', { type: 'password', value: SECRET }],
		['type=PASSWORD, case-insensitive', { type: 'PASSWORD', value: SECRET }],
		['type=password with surrounding space', { type: ' password ', value: SECRET }],
		// E-29's arm: a text-typed input a password manager fills.
		['autocomplete=current-password', { type: 'text', autocomplete: 'current-password', value: SECRET }],
		['autocomplete=new-password', { type: 'text', autocomplete: 'NEW-PASSWORD', value: SECRET }],
	];
	for (const [name, attributes] of cases) {
		// No accessible name, no aria-label, no placeholder: `value` was the only
		// remaining candidate, which is exactly when the defect fired.
		assertEquals(labelOf(node(attributes)), '', name);
	}
});

Deno.test('observe: the emitted element carries no `label` key at all for an unnamed password field', () => {
	// Not an empty string on the wire: `observe` drops the key when the label is
	// empty, so a client cannot mistake a scrubbed value for a blank one.
	const label = labelOf(node({ type: 'password', value: SECRET }));
	assertEquals(label, '');
});

Deno.test('observe: a password field still gets a label from a real accessible name', () => {
	// Over-scrubbing the value must not blind a model to the field's identity:
	// the accessible name is what a screen reader announces and is never sourced
	// from a password input's value.
	assertEquals(labelOf(node({ type: 'password', value: SECRET }, 'Password')), 'Password');
	assertEquals(labelOf(node({ type: 'password', value: SECRET, 'aria-label': 'Your password' })), 'Your password');
	assertEquals(labelOf(node({ type: 'password', value: SECRET, placeholder: 'Password' })), 'Password');
});

Deno.test('observe: an ordinary text input still shows its value, which is the point of the fallback', () => {
	assertEquals(labelOf(node({ type: 'text', value: 'London' })), 'London');
	assertEquals(labelOf(node({ type: 'submit', value: 'Sign in' })), 'Sign in');
});

Deno.test('observe: no surface derived from a label leaks a password (the sampling paths)', () => {
	// `promptBlock` is what `browser_extract_content` and `browser_run_task`
	// send to the caller's model, which puts the value outside this deployment.
	const observation = {
		sessionId: 's',
		url: 'https://example.com/login',
		title: 'Sign in',
		humanHasControl: false,
		tabs: [],
		viewport: { width: 1280, height: 720 },
		scroll: { x: 0, y: 0, pixelsAbove: 0, pixelsBelow: 0 },
		elements: [{ index: 1, tag: 'input' }],
		page: 'Sign in',
		stateToken: null,
		elementsTotal: 1,
		elementsTruncated: false,
		focusedIndex: null,
		frames: [],
		framesUnknown: [],
		captureTruncated: false,
	};
	const rendered = promptBlock(observation);
	assert(!rendered.includes(SECRET), rendered);
});

// --- the containment check ---------------------------------------------------

/**
 * Where a password value may be read from.
 *
 * `derived.ts` owns the predicate and gates `value` out of both the attribute
 * string and `getMeaningfulTextForLlm`; `serialize_attrs.ts` delegates to it and
 * is the B1/B2 masking stage; `default_action.ts` reads `value` only for a node
 * it has already proven to be a button (`<button>`, `role=button`, or
 * `<input type=button|submit>`), which a password field can never be, and
 * compares the result against a fixed label list without emitting it;
 * `observe.ts` is this module, gated by `isPasswordField`; `state_token.ts`
 * folds the value into the `state_token` content half and is gated by the same
 * predicate, substituting the literal `masked` so the token cannot be used as an
 * oracle against a guessed password (DD-7, B1.4); `extract_snapshot.ts` decodes
 * the live value columns the capture carries (E-39) onto the IR for the one
 * consumer below; `element_record.ts` builds `input.value` from those columns
 * and the attribute, behind the predicate, substituting the literal `•••` (B1.5).
 */
const READERS: Readonly<Record<string, number>> = {
	'browser/src/dom/extract_snapshot.ts': 2,
	'browser/src/dom/serialize_attrs.ts': 1,
	'browser/src/dom/state_token.ts': 1,
	'browser/src/watchdogs/default_action.ts': 1,
	'mcp/src/element_record.ts': 3,
	'mcp/src/observe.ts': 1,
};

/**
 * Every way a module can ask for an element's value.
 *
 * The AX pattern is keyed on the property-name **string**, not on a function
 * name: the AX tree is reached through a private `axProperty` helper that
 * exists in two independent copies, so a check keyed on the helper's name would
 * miss a third copy added tomorrow.
 */
const VALUE_READS: readonly RegExp[] = [
	/\battributes\s*\.\s*value\b/,
	/\battributes\s*\[\s*(['"`])value\1\s*\]/,
	/\battributes\s*\.\s*valuetext\b/,
	/\battributes\s*\[\s*(['"`])valuetext\1\s*\]/,
	/\(\s*node[^,)]*,\s*(['"`])(?:value|valuetext)\1\s*\)/,
	/\baxNode\s*\??\.\s*value\b/,
	// E-39: the live value columns are a fourth way to read a value. `extract_snapshot.ts` decodes
	// them (two column reads) and `element_record.ts` consumes them behind the predicate.
	/\.\s*(?:inputValue|textValue)\b/,
];

async function* walk(dir: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(dir)) {
		if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
		const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
		if (entry.isDirectory) yield* walk(child);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts')) yield child;
	}
}

Deno.test('observe: only the named modules read an element value, and each reads it once (I-14)', async () => {
	const root = new URL('../../', import.meta.url);
	const counts: Record<string, number> = {};
	for await (const file of walk(root)) {
		const path = file.href.replace(root.href, '');
		for (const line of (await Deno.readTextFile(file)).split('\n')) {
			if (VALUE_READS.some((pattern) => pattern.test(line))) counts[path] = (counts[path] ?? 0) + 1;
		}
	}

	// 1. No module outside the allowlist reads a value.
	assertEquals(
		Object.keys(counts).filter((path) => !(path in READERS)).sort(),
		[],
		`an element value is read outside the password predicate's reach: ${Object.keys(counts).join(', ')}`,
	);
	// 2. Every allowlisted module still reads one. A check that only forbids new
	//    readers passes an implementation that deleted the masking stage.
	assertEquals(Object.keys(counts).sort(), Object.keys(READERS).sort());
	// 3. The count per module is pinned, so an added read inside an allowlisted
	//    file is a deliberate test edit rather than a silent widening.
	assertEquals(counts, READERS);
	// 4. And the pattern list cannot be quietly emptied.
	assertEquals(VALUE_READS.length, 7);
});
