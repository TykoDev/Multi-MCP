/**
 * The derived members the serializer consumes (§6.1) and the interactivity predicate that decides
 * which nodes get a tag line at all (§6.3/§6.4).
 *
 * The predicate is the single largest source of output drift in the whole serializer — a rule that
 * fires one element too often changes every index on the page — so each of its ordered rules is pinned
 * individually here.
 */

import { assert, assertEquals } from '@std/assert';
import { buildIr, type FixtureNode } from '../../fixtures/serializer/_ir.ts';
import {
	collapseWhitespace,
	defaultDerived,
	getAllChildrenText,
	getMeaningfulTextForLlm,
	isActuallyScrollable,
	isNodeVisible,
	scrollInfo,
	shouldShowScrollInfo,
	tagName,
	xpath,
} from './serialize_derived.ts';
import { isInteractiveElement } from './serialize_simplify.ts';
import { domNodeDerived, normalizeWhitespace } from './derived.ts';

/** Is this node interactive under the default predicate? */
function interactive(node: FixtureNode): boolean {
	return isInteractiveElement(buildIr(node), defaultDerived);
}

/**
 * ERRATUM(E-33) — the anti-drift gate for this file.
 *
 * `serialize_derived.ts` and `derived.ts` each carried a full implementation of §6.1's seven derived
 * members, and they had drifted on three of them while both test suites stayed green. The differential
 * test in `serialize_test.ts` could not catch it: it re-renders the goldens with `domNodeDerived`
 * injected, but the renderer only calls four of the seven, so the other three were unreachable from
 * any fixture.
 *
 * Identity, not equality, is the fix. Behavioural agreement has to be re-measured after every edit and
 * is only ever as good as the inputs someone thought to try; `===` cannot drift. If a future edit
 * reintroduces a local implementation here, this fails on the first assertion rather than on whichever
 * page a user happens to load.
 */
Deno.test('dom-derived: defaultDerived IS the extraction half, member for member (E-33)', () => {
	const members = [
		'tagName',
		'xpath',
		'isActuallyScrollable',
		'shouldShowScrollInfo',
		'scrollInfo',
		'getAllChildrenText',
		'getMeaningfulTextForLlm',
	] as const;
	assertEquals(Object.keys(defaultDerived).sort(), [...members].sort());
	for (const member of members) {
		assert(
			defaultDerived[member] === domNodeDerived[member],
			`${member} must be the one implementation in derived.ts, not a second copy of it`,
		);
	}
	// The serializer's spelling of the whitespace helper is an alias, not a third copy of the regex.
	assert(collapseWhitespace === normalizeWhitespace);
});

Deno.test('dom-derived: tagName lowercases the CDP node name', () => {
	assertEquals(tagName(buildIr({ tag: 'CUSTOM-BUTTON' })), 'custom-button');
});

Deno.test('dom-derived: xpath counts same-tag siblings and passes shadow boundaries', () => {
	const root = buildIr({
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [
				{ tag: 'DIV' },
				{
					tag: 'DIV',
					children: [{ tag: 'SPAN' }, { tag: 'BUTTON' }],
					shadow: [{ type: 'open', children: [{ tag: 'BUTTON' }] }],
				},
			],
		}],
	});
	const body = root.childrenNodes[0];
	const second = body?.childrenNodes[1];
	const lightButton = second?.childrenNodes[1];
	const shadowButton = second?.shadowRoots?.[0]?.childrenNodes[0];
	assert(lightButton !== undefined && shadowButton !== undefined);
	// `html` and `body` are lone children of their tag and carry no position; the two `div`s are not.
	assertEquals(xpath(lightButton), 'html/body/div[2]/button');
	assertEquals(xpath(shadowButton), 'html/body/div[2]/button');
});

Deno.test('dom-derived: xpath stops at the iframe boundary', () => {
	const root = buildIr({
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [{ tag: 'IFRAME', document: { tag: '#document', children: [{ tag: 'MAIN' }] } }],
		}],
	});
	const inner = root.childrenNodes[0]?.childrenNodes[0]?.contentDocument?.childrenNodes[0];
	assert(inner !== undefined);
	assertEquals(xpath(inner), 'main');
});

Deno.test('dom-derived: getMeaningfulTextForLlm prefers the attribute ladder over children text', () => {
	assertEquals(
		getMeaningfulTextForLlm(buildIr({ tag: 'INPUT', attrs: { value: 'typed' }, children: [{ text: 'ignored' }] })),
		'typed',
	);
	assertEquals(
		getMeaningfulTextForLlm(buildIr({ tag: 'BUTTON', attrs: { 'aria-label': 'Save' } })),
		'Save',
	);
	assertEquals(
		getMeaningfulTextForLlm(buildIr({ tag: 'BUTTON', attrs: { value: '  ' }, children: [{ text: 'Fallback' }] })),
		'Fallback',
	);
});

/**
 * ERRATUM(E-33) — §6.5 anti-exfiltration, asserted on the *serializer's* handle to the predicate.
 *
 * `derived.ts` has always skipped `value` for password fields; the copy that used to live in this file
 * had no password gate at all, so `defaultDerived.getMeaningfulTextForLlm` returned the secret. That
 * object is exported through `packages/core/mod.ts`, so it was reachable API surface, and the two
 * `isPasswordField` definitions of E-29 had already shown that "the other copy has the rule" is not a
 * property anyone was checking. Pinned here as well as in `derived_test.ts` because the hole was in
 * *this* module's export, and a §6.5 rule is worth asserting at every door it can leave by.
 */
Deno.test('dom-derived: the serializer default never yields a password value (§6.5, E-33)', () => {
	const secret = 'hunter2';
	const cases: Record<string, string>[] = [
		{ type: 'password', value: secret },
		// E-29's case: a text-typed field a password manager fills.
		{ type: 'text', autocomplete: 'current-password', value: secret },
		{ type: 'text', autocomplete: 'new-password', value: secret },
	];
	for (const attrs of cases) {
		const node = buildIr({ tag: 'INPUT', attrs });
		assertEquals(getMeaningfulTextForLlm(node), '', `${JSON.stringify(attrs)} must yield no text`);
		assertEquals(defaultDerived.getMeaningfulTextForLlm(node), '');
	}
	// The ladder still runs — it just steps over `value`.
	assertEquals(
		getMeaningfulTextForLlm(buildIr({
			tag: 'INPUT',
			attrs: { type: 'password', value: secret, 'aria-label': 'Account password' },
		})),
		'Account password',
	);
});

Deno.test('dom-derived: getAllChildrenText collapses whitespace, honours visibility and the depth cap', () => {
	const node = buildIr({
		tag: 'DIV',
		children: [
			{ text: ' Hello \n world ' },
			{ text: 'hidden', visible: false },
			{ tag: 'SPAN', children: [{ tag: 'B', children: [{ text: 'deep' }] }] },
		],
	});
	assertEquals(getAllChildrenText(node, 3), 'Hello world deep');
	assertEquals(getAllChildrenText(node, 1), 'Hello world');
	assertEquals(collapseWhitespace('  a \t\n b  '), 'a b');
});

Deno.test('dom-derived: visibility inherits only when the node itself does not know', () => {
	const node = buildIr({ tag: 'DIV', visible: false, children: [{ text: 'a', visible: null }] });
	assert(!isNodeVisible(node));
	const child = node.childrenNodes[0];
	assert(child !== undefined && !isNodeVisible(child));
	assert(isNodeVisible(buildIr({ tag: 'DIV', visible: null })), 'unknown all the way up reads as visible');
});

Deno.test('dom-derived: scroll geometry drives isActuallyScrollable and the suffix gate', () => {
	const flagged = buildIr({ tag: 'DIV', scrollable: true });
	assert(isActuallyScrollable(flagged), 'flagged without geometry stays scrollable');
	assertEquals(scrollInfo(flagged), null);
	assertEquals(shouldShowScrollInfo(flagged), false);

	const noOverflow = buildIr({ tag: 'DIV', scrollable: true, client: [0, 0, 100, 100], scroll: [0, 0, 100, 100] });
	assert(!isActuallyScrollable(noOverflow));

	const overflow = buildIr({ tag: 'DIV', scrollable: true, client: [0, 0, 100, 100], scroll: [0, 50, 100, 300] });
	assert(isActuallyScrollable(overflow));
	assertEquals(scrollInfo(overflow), { pagesAbove: 0.5, pagesBelow: 1.5, horizontalPercent: null });

	assert(!isActuallyScrollable(buildIr({ tag: 'DIV' })), 'isScrollable null is not scrollable');
	assertEquals(scrollInfo(buildIr({ tag: 'DIV', scroll: [0, 0, 10, 10] })), null, 'no client rect, no geometry');
});

Deno.test('dom-interactivity: negative gates win over every positive rule', () => {
	assert(!interactive({ tag: 'BUTTON', visible: false }));
	assert(!interactive({ tag: 'BUTTON', styles: { 'pointer-events': 'none' } }));
	assert(!interactive({ text: 'plain text' }));
});

Deno.test('dom-interactivity: tag rules', () => {
	assert(interactive({ tag: 'A', attrs: { href: '/x' } }));
	// An hrefless anchor is still indexed: the reference indexes `#l-nohref`, whose AX role is
	// `generic` and which no later rule reaches (DECISION-REGISTER §9.6 (E-23) item 4).
	assert(interactive({ tag: 'A' }), 'an anchor without href is still an anchor');
	for (const tag of ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS', 'IFRAME', 'FRAME']) {
		assert(interactive({ tag }), `${tag} must be interactive`);
	}
	for (const tag of ['DIV', 'SPAN', 'OPTION', 'LABEL', 'P']) {
		assert(!interactive({ tag }), `${tag} must not be interactive on its own`);
	}
});

Deno.test('dom-interactivity: a disabled control is never interactive', () => {
	assert(!interactive({ tag: 'BUTTON', attrs: { disabled: '' } }));
	assert(!interactive({ tag: 'DIV', ax: { role: 'radio' }, attrs: { 'aria-disabled': 'true' } }));
	assert(!interactive({ tag: 'SELECT', ax: { role: 'combobox', props: { disabled: true } } }));
	assert(interactive({ tag: 'DIV', ax: { role: 'radio' }, attrs: { 'aria-disabled': 'false' } }));
});

Deno.test('dom-interactivity: a label is interactive only when it wraps its control', () => {
	assert(interactive({ tag: 'LABEL', clickable: true, children: [{ tag: 'INPUT' }] }));
	// `for=`-only labels are Chrome-clickable and the reference indexes none of them.
	assert(!interactive({ tag: 'LABEL', clickable: true, attrs: { for: 'x' } }));
	// A wrapped *disabled* control still makes the label a target — Chrome drops `isClickable` there
	// and the reference indexes the label anyway (`radio_checkbox_group` `#r-overnight`'s label).
	assert(interactive({ tag: 'LABEL', children: [{ tag: 'INPUT', attrs: { disabled: '' } }] }));
});

Deno.test('dom-interactivity: a click affordance inherited from an anchor is not the node own', () => {
	const anchor = buildIr({
		tag: 'A',
		attrs: { href: '/x' },
		children: [{ tag: 'SPAN', cursor: 'pointer', clickable: true }],
	});
	const span = anchor.childrenNodes[0];
	assert(span !== undefined);
	assert(!isInteractiveElement(span, defaultDerived), 'a span inside a link is not a second link');
	// The same span outside an anchor keeps its own signal.
	assert(interactive({ tag: 'SPAN', cursor: 'pointer', clickable: true }));
});

Deno.test('dom-interactivity: attribute, role and listener rules', () => {
	assert(interactive({ tag: 'DIV', attrs: { contenteditable: '' } }));
	assert(interactive({ tag: 'DIV', attrs: { contenteditable: 'true' } }));
	assert(interactive({ tag: 'DIV', attrs: { contenteditable: 'plaintext-only' } }));
	assert(!interactive({ tag: 'DIV', attrs: { contenteditable: 'false' } }));
	assert(interactive({ tag: 'DIV', attrs: { tabindex: '0' } }));
	assert(!interactive({ tag: 'DIV', attrs: { tabindex: '-1' } }));
	assert(interactive({ tag: 'DIV', ax: { role: 'combobox' } }));
	assert(!interactive({ tag: 'DIV', ax: { role: 'presentation' } }));
	assert(interactive({ tag: 'DIV', clickable: true }));
	assert(interactive({ tag: 'DIV', jsClick: true }));
	assert(interactive({ tag: 'DIV', cursor: 'pointer' }));
	assert(interactive({ tag: 'DIV', styles: { cursor: 'pointer' } }));
	assert(!interactive({ tag: 'DIV', cursor: 'text' }));
});
