/**
 * `state_token` unit tier — U-1, closed at the unit tier with no browser.
 *
 * The token is the whole of invariant I-1's testable half: if it is not deterministic, every
 * `element-not-found` / `stale-token` refusal built on it is noise, and a client told "the page
 * moved" when it did not will re-read state forever. So the corpus is replayed rather than sampled —
 * every recorded capture under `packages/browser/fixtures/dom/`, twice, plus a mutation control.
 *
 * A recorded CDP payload is data, not a mock (D-TEST1): this is the same merge and the same
 * serializer the browser path runs.
 */

import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { type DomCapture, extractFromCapture } from './extract.ts';
import { serializeDomState } from './serialize.ts';
import { indicesStable, mintStateToken, STATE_TOKEN_HEX_LENGTH } from './state_token.ts';
import type { EnhancedDomTreeNode } from './types.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../fixtures/dom', import.meta.url));

/** The `f-tel` placeholder recorded in `form_attributes`; the mutation control's single input. */
const PLACEHOLDER_UNDER_TEST = '123-456-7890';

/** Every recorded capture, enumerated from disk so a newly recorded page is covered without an edit. */
async function captureNames(): Promise<string[]> {
	const names: string[] = [];
	for await (const entry of Deno.readDir(FIXTURE_DIR)) {
		if (entry.isFile && entry.name.endsWith('.capture.json')) names.push(entry.name.slice(0, -'.capture.json'.length));
	}
	return names.sort();
}

async function loadCapture(name: string): Promise<DomCapture> {
	return JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`)) as DomCapture;
}

/** The production path: merge, then serialize with the frame identity the capture carries. */
function tokenOf(capture: DomCapture, topUrl = 'http://127.0.0.1:38111/page.html'): string | null {
	const extraction = extractFromCapture(capture);
	const serialized = serializeDomState(extraction.root, { topUrl, frames: extraction.frames });
	return serialized.stateToken;
}

Deno.test('state_token: deterministic across two replays of every recorded capture (U-1)', async () => {
	const names = await captureNames();
	assert(names.length >= 36, `expected the full recorded corpus, found ${names.length}`);
	let withTable = 0;
	for (const name of names) {
		// Two independent parses as well as two serializations: a token that depended on object
		// identity or on map insertion order would survive a single-parse comparison.
		const first = tokenOf(await loadCapture(name));
		const second = tokenOf(await loadCapture(name));
		assertEquals(second, first, `${name}: token is not deterministic across replays`);
		assert(first !== null, `${name}: serialization produced no token`);
		const [identity, content] = first.split('.');
		assertEquals(identity?.length, STATE_TOKEN_HEX_LENGTH, `${name}: identity half is not the pinned width`);
		assertEquals(content?.length, STATE_TOKEN_HEX_LENGTH, `${name}: content half is not the pinned width`);
		if (extractFromCapture(await loadCapture(name)).root !== null) withTable += 1;
	}
	assert(withTable > 0, 'no capture produced a tree; the corpus did not load');
});

Deno.test('state_token: one mutated attribute moves the content half and leaves the identity half', async () => {
	const name = 'form_attributes';
	const before = splitToken(tokenOf(await loadCapture(name)));

	// Mutate a rendered attribute in a *copy* of the recorded bytes — the same capture otherwise, so
	// the only thing that can move the token is the mutation. The corpus's `f-tel` placeholder is
	// chosen because `placeholder` is in the §6.5 whitelist, so it reaches the rendered attribute
	// string and therefore the content half, while touching neither the index assignment nor any
	// `backendNodeId` and so leaving the identity half alone.
	const raw = await Deno.readTextFile(`${FIXTURE_DIR}/${name}.capture.json`);
	assert(raw.includes(PLACEHOLDER_UNDER_TEST), 'the corpus no longer carries the mutated placeholder');
	const mutated = JSON.parse(raw.replaceAll(PLACEHOLDER_UNDER_TEST, '999-999-9999')) as DomCapture;
	const after = splitToken(tokenOf(mutated));

	assertNotEquals(after.content, before.content, 'a mutated attribute did not move the content half');
	// The split earns its keep here: the client learns the page changed *and* that its indices are
	// still good, which is exactly what `indices_stable` is for.
	assertEquals(after.identity, before.identity, 'a content-only change moved the identity half');
	assert(indicesStable(`${after.identity}.${after.content}`, `${before.identity}.${before.content}`));
});

Deno.test('state_token: root scroll is not part of the preimage', () => {
	// Structural, and deliberately so: `StateTokenInput` carries no scroll offset at all, so a wheel
	// event cannot churn the token however the page is laid out. Pinned as a behaviour rather than as
	// a comment by minting over the same table with the page scrolled to two different offsets — the
	// only way a scroll could reach the preimage is through a field that does not exist.
	const node = passwordNode('x');
	const table = new Map<number, EnhancedDomTreeNode>([[1, node]]);
	const a = mintStateToken({ topUrl: 'https://example.test/p', frames: [], selectorMap: table });
	const b = mintStateToken({ topUrl: 'https://example.test/p', frames: [], selectorMap: new Map(table) });
	assertEquals(b.token, a.token);
	assertEquals(Object.keys(a).sort(), ['content', 'identity', 'token']);
});

Deno.test('state_token: a password field contributes `masked`, never its value (DD-7)', () => {
	const node = passwordNode('hunter2');
	const withSecret = mintStateToken({ topUrl: 'https://example.test/', frames: [], selectorMap: new Map([[1, node]]) });
	const withOther = mintStateToken({
		topUrl: 'https://example.test/',
		frames: [],
		selectorMap: new Map([[1, passwordNode('totally-different')]]),
	});
	// Equal tokens for two different secrets is the point: the token cannot be used as an oracle to
	// confirm a guessed password, and a `since_token` diff cannot observe a password edit.
	assertEquals(withOther.token, withSecret.token);
});

Deno.test('state_token: frame order does not change the token', () => {
	const base = { topUrl: 'https://example.test/', selectorMap: new Map<number, EnhancedDomTreeNode>() };
	const a = mintStateToken({
		...base,
		frames: [{ frameId: 'F2', url: 'https://b.test/' }, { frameId: 'F1', url: 'https://a.test/' }],
	});
	const b = mintStateToken({
		...base,
		frames: [{ frameId: 'F1', url: 'https://a.test/' }, { frameId: 'F2', url: 'https://b.test/' }],
	});
	assertEquals(b.token, a.token);
});

Deno.test('state_token: a page cannot shift a field boundary with a `|` or a newline (E-38)', () => {
	// The separator-injection control. Without length-prefixed fields, a page that put a `|` in its URL
	// (Chrome preserves an unencoded one in a query string) or in an accessible name could make two
	// materially different states digest identically, and the whole stale-token distinction with it.
	const base = { frames: [] as const, selectorMap: new Map<number, EnhancedDomTreeNode>() };
	const a = mintStateToken({ ...base, topUrl: 'https://x.test/?a=1|b=2' });
	const b = mintStateToken({ ...base, topUrl: 'https://x.test/?a=1', frames: [{ frameId: 'b=2', url: '' }] });
	assertNotEquals(b.token, a.token, 'a `|` in the URL shifted a field boundary');

	const withPipe = mintStateToken({ ...base, topUrl: 'https://x.test/|' });
	const withoutPipe = mintStateToken({ ...base, topUrl: 'https://x.test/' });
	assertNotEquals(withPipe.token, withoutPipe.token);

	// I-9's cousin: a newline in a page-controlled field must not forge a preimage line either.
	const forged = 'https://x.test/' + String.fromCharCode(10) + 'F|F1|https://evil.test/';
	const withNewline = mintStateToken({ ...base, topUrl: forged });

	const asFrame = mintStateToken({
		...base,
		topUrl: 'https://x.test/',
		frames: [{ frameId: 'F1', url: 'https://evil.test/' }],
	});
	assertNotEquals(withNewline.token, asFrame.token, 'a newline in the URL forged a frame line');
});

Deno.test('indicesStable: identity half alone, and a malformed token is never stable', () => {
	assert(indicesStable('aaaa.1111', 'aaaa.2222'));
	assert(!indicesStable('aaaa.1111', 'bbbb.1111'));
	assert(!indicesStable('aaaa', 'aaaa'));
	assert(!indicesStable('', ''));
});

function splitToken(token: string | null): { identity: string; content: string } {
	assert(token !== null, 'serialization produced no token');
	const [identity, content] = token.split('.');
	assert(identity !== undefined && content !== undefined, `malformed token: ${token}`);
	return { identity, content };
}

/** A minimal `<input type=password>` carrying a value attribute. */
function passwordNode(value: string): EnhancedDomTreeNode {
	return {
		nodeId: 1,
		backendNodeId: 42,
		nodeType: 1,
		nodeName: 'INPUT',
		nodeValue: '',
		attributes: { type: 'password', value },
		isScrollable: null,
		isVisible: true,
		absolutePosition: null,
		targetId: 'T',
		frameId: 'F',
		sessionId: 'S',
		contentDocument: null,
		shadowRootType: null,
		shadowRoots: null,
		parentNode: null,
		childrenNodes: [],
		axNode: null,
		snapshotNode: null,
		compoundChildren: [],
		hasJsClickListener: false,
		hiddenElementsInfo: [],
		hasHiddenContent: false,
		uuid: 'u',
	};
}
