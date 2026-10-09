/**
 * §6.1 element hashes and the §6.6 replay cascade.
 *
 * The hashes are only useful in relation to each other — what matters is which page changes each one
 * survives — so most cases here assert a *pair* of nodes, not a literal digest.
 */

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { buildIr, type FixtureNode } from '../../fixtures/serializer/_ir.ts';
import {
	buildInteractedElement,
	elementHash,
	filterDynamicClasses,
	HASH_HEX_LENGTH,
	isDynamicClassToken,
	MATCH_LEVEL_ORDER,
	matchInteractedElement,
	matchLevelName,
	parentBranchHash,
	type ReplayCandidate,
	stableHash,
	tagPath,
} from './hashes.ts';
import { MatchLevel } from './types.ts';

/** `<html><body><div><button …>` with the button returned. */
function button(attributes: Record<string, string>, axName?: string): FixtureNode {
	return {
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [{
				tag: 'DIV',
				children: [{ tag: 'BUTTON', attrs: attributes, ax: axName === undefined ? undefined : { name: axName } }],
			}],
		}],
	};
}

/** Digs the single BUTTON out of a {@linkcode button} tree. */
function pick(tree: FixtureNode) {
	const root = buildIr(tree);
	const body = root.childrenNodes[0];
	const div = body?.childrenNodes[0];
	const target = div?.childrenNodes[0];
	assert(target !== undefined, 'fixture must contain the button');
	return target;
}

Deno.test('dom-hashes: elementHash is 16 hex characters and deterministic', async () => {
	const node = pick(button({ id: 'save' }, 'Save'));
	const first = await elementHash(node);
	const second = await elementHash(node);
	assertEquals(first, second);
	assertEquals(first.length, HASH_HEX_LENGTH);
	assert(/^[0-9a-f]+$/.test(first));
});

Deno.test('dom-hashes: elementHash separates tag path, static attributes and AX name', async () => {
	const base = await elementHash(pick(button({ id: 'save' }, 'Save')));
	assertNotEquals(base, await elementHash(pick(button({ id: 'other' }, 'Save'))), 'attributes are in scope');
	assertNotEquals(base, await elementHash(pick(button({ id: 'save' }, 'Cancel'))), 'the AX name is in scope');
	const deeper: FixtureNode = {
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [{
				tag: 'DIV',
				children: [{ tag: 'SPAN', children: [{ tag: 'BUTTON', attrs: { id: 'save' }, ax: { name: 'Save' } }] }],
			}],
		}],
	};
	const nested = buildIr(deeper).childrenNodes[0]?.childrenNodes[0]?.childrenNodes[0]?.childrenNodes[0];
	assert(nested !== undefined);
	assertNotEquals(base, await elementHash(nested), 'the parent tag path is in scope');
});

Deno.test('dom-hashes: elementHash ignores style and on* handlers', async () => {
	const plain = await elementHash(pick(button({ id: 'save' })));
	const styled = await elementHash(pick(button({ id: 'save', style: 'left: 3px', onclick: 'go()' })));
	assertEquals(plain, styled);
});

Deno.test('dom-hashes: stableHash survives dynamic class churn where elementHash does not', async () => {
	const before = pick(button({ id: 'save', class: 'btn css-1x2y3z is-active' }));
	const after = pick(button({ id: 'save', class: 'btn css-9z8y7x' }));
	assertNotEquals(await elementHash(before), await elementHash(after));
	assertEquals(await stableHash(before), await stableHash(after));
	// A genuine authored class still separates two elements.
	const other = pick(button({ id: 'save', class: 'btn btn-primary' }));
	assertNotEquals(await stableHash(before), await stableHash(other));
});

Deno.test('dom-hashes: parentBranchHash is the tag path alone', async () => {
	const one = pick(button({ id: 'a' }, 'One'));
	const two = pick(button({ id: 'b' }, 'Two'));
	assertEquals(await parentBranchHash(one), await parentBranchHash(two));
	assertNotEquals(await parentBranchHash(one), await elementHash(one));
	assertEquals(tagPath(one), 'html/body/div/button');
});

Deno.test('dom-hashes: tagPath stops at the iframe boundary', () => {
	const root = buildIr({
		tag: 'HTML',
		children: [{
			tag: 'BODY',
			children: [{
				tag: 'IFRAME',
				document: { tag: '#document', children: [{ tag: 'SECTION', children: [{ tag: 'BUTTON' }] }] },
			}],
		}],
	});
	const iframe = root.childrenNodes[0]?.childrenNodes[0];
	const inner = iframe?.contentDocument?.childrenNodes[0]?.childrenNodes[0];
	assert(inner !== undefined);
	assertEquals(tagPath(inner), 'section/button');
});

Deno.test('dom-hashes: the dynamic-class heuristic', () => {
	for (const token of ['css-1x2y3z', 'sc-bdVaJa', 'emotion_abc12', 'header-1a2b3c4d', 'a1b2c3d4e5', 'is-active']) {
		assert(isDynamicClassToken(token), `${token} should be dynamic`);
	}
	for (const token of ['btn', 'btn-primary', 'col-md-6', 'nav__item', 'grid-2']) {
		assert(!isDynamicClassToken(token), `${token} should be static`);
	}
	assertEquals(filterDynamicClasses('  btn   css-1x2y3z  btn-primary '), 'btn btn-primary');
});

Deno.test('dom-hashes: buildInteractedElement captures the §6.6 record', async () => {
	const node = pick(button({ 'id': 'save', 'name': 'submit', 'aria-label': 'Save it', 'class': 'x' }, 'Save it'));
	const record = await buildInteractedElement(node, '/html[1]/body[1]/div[1]/button[1]');
	assertEquals(record.attributes, { 'name': 'submit', 'id': 'save', 'aria-label': 'Save it' });
	assertEquals(record.axName, 'Save it');
	assertEquals(record.xPath, '/html[1]/body[1]/div[1]/button[1]');
	assertEquals(record.frameId, 'frame-main');
	assertEquals(record.elementHash, await elementHash(node));
	assertEquals(record.stableHash, await stableHash(node));
});

Deno.test('dom-hashes: MatchLevel is tried in ascending numeric order', () => {
	assertEquals(MATCH_LEVEL_ORDER, [1, 2, 3, 4, 5]);
	assertEquals(MATCH_LEVEL_ORDER.map(matchLevelName), ['EXACT', 'STABLE', 'XPATH', 'AX_NAME', 'ATTRIBUTE']);
});

Deno.test('dom-hashes: the replay cascade descends level by level', async () => {
	const original = pick(button({ id: 'save', class: 'btn css-aaa111' }, 'Save'));
	const target = await buildInteractedElement(original, '/html[1]/body[1]/div[1]/button[1]');

	const identical: ReplayCandidate = { node: original, xPath: target.xPath };
	const restyled: ReplayCandidate = {
		node: pick(button({ id: 'save', class: 'btn css-bbb222' }, 'Save')),
		xPath: target.xPath,
	};
	const samePath: ReplayCandidate = {
		node: pick(button({ id: 'changed', class: 'other' }, 'Different')),
		xPath: target.xPath,
	};
	const sameName: ReplayCandidate = {
		node: pick(button({ id: 'changed' }, 'Save')),
		xPath: '/html[1]/body[1]/div[1]/button[7]',
	};
	const sameAttributes: ReplayCandidate = {
		node: pick(button({ id: 'save' }, 'Renamed')),
		xPath: '/html[1]/body[1]/div[1]/button[9]',
	};

	assertEquals((await matchInteractedElement(target, [samePath, identical]))?.level, MatchLevel.EXACT);
	assertEquals((await matchInteractedElement(target, [samePath, restyled]))?.level, MatchLevel.STABLE);
	assertEquals((await matchInteractedElement(target, [sameName, samePath]))?.level, MatchLevel.XPATH);
	assertEquals((await matchInteractedElement(target, [sameAttributes, sameName]))?.level, MatchLevel.AX_NAME);
	assertEquals((await matchInteractedElement(target, [sameAttributes]))?.level, MatchLevel.ATTRIBUTE);
	assertEquals(await matchInteractedElement(target, []), null);
});

Deno.test('dom-hashes: ATTRIBUTE level requires a unique match', async () => {
	const original = pick(button({ id: 'save' }, 'Save'));
	const target = await buildInteractedElement(original, '/a[1]');
	const twin = (): ReplayCandidate => ({ node: pick(button({ id: 'save' }, 'Renamed')), xPath: '/b[1]' });
	assertEquals((await matchInteractedElement(target, [twin()]))?.level, MatchLevel.ATTRIBUTE);
	assertEquals(await matchInteractedElement(target, [twin(), twin()]), null);
});

Deno.test('dom-hashes: a frameId narrows the candidate pool when it is represented', async () => {
	const original = pick(button({ id: 'save' }, 'Save'));
	const target = await buildInteractedElement(original, '/a[1]');
	const inFrame = buildIr({ tag: 'BUTTON', frame: 'frame-main', attrs: { id: 'save' }, ax: { name: 'Save' } });
	const elsewhere = buildIr({ tag: 'BUTTON', frame: 'frame-other', attrs: { id: 'save' }, ax: { name: 'Save' } });

	const narrowed = await matchInteractedElement(target, [
		{ node: elsewhere, xPath: '/b[1]' },
		{ node: inFrame, xPath: '/a[1]' },
	]);
	assertEquals(narrowed?.node, inFrame);

	// No candidate carries the frame: the hint is dropped rather than failing the whole lookup.
	const fallback = await matchInteractedElement(target, [{ node: elsewhere, xPath: '/b[1]' }]);
	assertEquals(fallback?.node, elsewhere);
});
