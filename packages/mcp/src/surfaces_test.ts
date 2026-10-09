/**
 * BF-8 — the parameterised surface matrix.
 *
 * Every surface that describes an element to a caller is enumerated here, by name, with a pinned
 * count, and each is fed the same three password fields carrying the same sentinel.
 *
 * **What the count pin does and does not do (R-6 of the independent review, corrected here).**
 * `assertEquals(SURFACES.length, SURFACE_COUNT)` compares the list to a constant declared a few lines
 * below it in this same file. It catches an edit to one without the other. It **cannot** catch someone
 * adding an element-describing surface to the product and never opening this file — the earlier
 * wording of this comment, and the build record that quoted it, claimed otherwise. A security
 * control's recorded proof must not be stronger than the control, so the claim is now what the
 * mechanism actually is.
 *
 * **The structural half is the call-site pin below.** Every element record in the product is built by
 * `buildElementRecord`, which has exactly two production call sites; `browser_find`,
 * `browser_locator_candidates` and `browser_verify_locator` all take their records from those. A third
 * call site is what a new element-describing surface looks like from here, and
 * "BF-8: the element-record producer has exactly the call sites this matrix covers" fails on it,
 * naming the file. That is a check on the *product*, not on this file's own bookkeeping.
 *
 * The containment check in `observe_test.ts` bounds where a value may be *read*; this matrix bounds
 * where one may be *emitted*. The two together are invariant I-14.
 */
import { assert, assertEquals } from '@std/assert';
import type { EnhancedDomTreeNode } from '@tykotech/browser';
import { mintStateToken } from '@tykotech/browser';
import { attrsOf, buildElementRecord, inputStateOf, resolveFields, textOf } from './element_record.ts';
import { buildDocumentIndex, locatorCandidates } from './locators.ts';
import { labelOf, type Observation, observationPayload, observationStructured, promptBlock } from './observe.ts';
import { focusPayload } from './events.ts';
import { AuditLedger } from './audit.ts';
import { assertFillable, describeFillTarget } from './secrets.ts';

const SENTINEL = 'Zq8-SURFACE-SENTINEL-3vP';

/** The three shapes the predicate must catch: declared, filled by a manager, and revealed. */
function passwordNodes(): EnhancedDomTreeNode[] {
	const make = (attributes: Record<string, string>) =>
		({
			nodeType: 1,
			nodeName: 'INPUT',
			nodeValue: '',
			attributes,
			frameId: 'F',
			sessionId: 'S',
			backendNodeId: 7,
			childrenNodes: [],
			shadowRoots: null,
			contentDocument: null,
			parentNode: null,
			axNode: { role: 'textbox', name: '', properties: [] },
			snapshotNode: {
				bounds: { x: 1, y: 2, width: 3, height: 4 },
				computedStyles: { display: 'block' },
				inputValue: SENTINEL,
				inputChecked: null,
				optionSelected: null,
				textValue: null,
			},
			isVisible: true,
			absolutePosition: { x: 1, y: 2, width: 3, height: 4 },
			compoundChildren: [],
		}) as unknown as EnhancedDomTreeNode;
	return [
		make({ type: 'password', value: SENTINEL }),
		make({ type: 'text', autocomplete: 'current-password', value: SENTINEL }),
		make({ type: 'text', name: 'password', value: SENTINEL, class: 'password-toggle' }),
	];
}

/** One surface: a name, and a function from a password node to whatever the surface emits. */
interface Surface {
	readonly name: string;
	readonly emit: (node: EnhancedDomTreeNode) => unknown;
}

function observationOf(node: EnhancedDomTreeNode): Observation {
	const record = buildElementRecord(1, node, {
		fields: resolveFields(['full']),
		scroll: { x: 0, y: 0 },
		locators: buildDocumentIndex(node),
		frameUrls: new Map([['F', 'https://example.com/']]),
		labelOf,
	});
	return {
		sessionId: 's',
		url: 'https://example.com/login',
		title: 'Sign in',
		humanHasControl: false,
		tabs: [],
		viewport: { width: 1280, height: 720 },
		scroll: { x: 0, y: 0, pixelsAbove: 0, pixelsBelow: 0 },
		elements: [record],
		page: '',
		stateToken: null,
		elementsTotal: 1,
		elementsTruncated: false,
		focusedIndex: null,
		frames: [],
		framesUnknown: [],
		captureTruncated: false,
	};
}

/**
 * The registry. Pinned at its count below; a surface added to the product without a row here is
 * a failing build, and a row removed without the surface going with it is one too.
 */
const SURFACES: readonly Surface[] = [
	{ name: 'element.label (browser_get_state, resources/read, both sampling prompts)', emit: labelOf },
	{ name: 'element.text', emit: textOf },
	{ name: 'element.attrs', emit: attrsOf },
	{ name: 'element.input', emit: inputStateOf },
	{ name: 'element.locators', emit: (node) => locatorCandidates(node, buildDocumentIndex(node)) },
	{ name: 'element record, full preset', emit: (node) => observationOf(node).elements[0] },
	{ name: 'browser_get_state text block', emit: (node) => observationPayload(observationOf(node)) },
	{ name: 'browser_get_state structuredContent', emit: (node) => observationStructured(observationOf(node)) },
	{ name: 'promptBlock (browser_extract_content, browser_run_task)', emit: (node) => promptBlock(observationOf(node)) },
	{
		name: 'state_token content half',
		emit: (node) => mintStateToken({ topUrl: 'https://example.com/', frames: [], selectorMap: new Map([[1, node]]) }),
	},
	{
		// B1.9. The matrix's own header named a `focus` event descriptor as a
		// surface that must join it before the kind could mint, and this is that
		// row. It exercises the **producer's own builder**, not a reconstruction:
		// the redaction contract is enforced at mint, so a test that rebuilt the
		// payload here would prove something about the test instead.
		name: 'focus event descriptor (events.ts focusPayload)',
		emit: (node) => focusPayload(1, node, node.frameId, labelOf(node)),
	},
	{
		// B2.1. `browser_element_at` and the live view's `hover` reply both build their record through
		// `elementAtPoint`, which calls this builder with the caller's fields (the socket: `core`).
		// The row exercises the builder at the widest preset the tool accepts, so a field a later
		// preset adds is caught here rather than on the socket.
		name: 'browser_element_at / live hover reply (elementAtPoint record)',
		emit: (node) =>
			buildElementRecord(1, node, {
				fields: resolveFields(['full']),
				scroll: { x: 0, y: 0 },
				locators: buildDocumentIndex(node),
				frameUrls: new Map([['F', 'https://example.com/']]),
				labelOf,
			}),
	},
	{
		// B2.8. `browser_fill_secret` names the element it refused, and the obvious way to do that is
		// to serialise the node's attribute map — which on a password field the browser has already
		// filled means putting the credential into an error string that reaches the transcript and the
		// logs. The row exercises the producer, not a reconstruction, against all three password
		// shapes; each of them carries the sentinel in the map this function must not iterate.
		name: 'browser_fill_secret refusal descriptor (secrets.ts describeFillTarget)',
		emit: (node) => describeFillTarget(node as unknown as { nodeName: string; attributes: Record<string, string> }),
	},
	{
		// B2.8. The refusal *message*, which is the string that actually travels — a clean descriptor
		// wrapped in a message that then quoted the node would leak just the same. `assertFillable`
		// throws for a password input only when the shape is wrong, so the row drives the `<div>` arm
		// carrying the same sentinel attributes.
		name: 'browser_fill_secret refusal message (secrets.ts assertFillable)',
		emit: (node) => {
			try {
				assertFillable({ nodeName: 'DIV', attributes: node.attributes as Record<string, string> }, 1);
				return null;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	},
	{
		// B2.8. The audit ledger's entry for a secret fill. It is built from the element, so it is a
		// surface a later field could be added to from the node — `index` and `frame_id` are already
		// there. The row exercises the ledger's own `append`, so the shape it actually mints is what
		// is asserted rather than a literal that agrees with it today.
		name: 'audit entry, secret-fill (audit.ts append)',
		emit: (node) => {
			const ledger = new AuditLedger();
			return ledger.append({
				session_id: 's',
				principal: 'p',
				kind: 'secret-fill',
				frame_id: node.frameId ?? '',
				origin: 'https://example.com',
				secret: 'bank_password',
				index: 1,
				ok: true,
			});
		},
	},
];

/**
 * Grows with the product. Every addition is a deliberate edit to both the list and this number.
 *
 * This is bookkeeping, not enforcement: it fires when the list and the number disagree, and says
 * nothing about a surface the product grew that nobody added here. The call-site pin below is the
 * half that watches the product.
 */
const SURFACE_COUNT = 15;

Deno.test('BF-8: the surface registry is pinned', () => {
	assertEquals(SURFACES.length, SURFACE_COUNT);
	assertEquals(new Set(SURFACES.map((surface) => surface.name)).size, SURFACES.length, 'names are unique');
});

/**
 * Where `buildElementRecord` is called in production, by module, with the call count.
 *
 * Every element record the product emits comes through here, so this is the waist a new
 * element-describing surface has to cross. Its own declaration is excluded; imports are not counted.
 */
const PRODUCER_CALL_SITES: Readonly<Record<string, number>> = {
	'packages/mcp/src/observe.ts': 1,
	'packages/mcp/src/tools/perception.ts': 1,
};

async function* sources(dir: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(dir)) {
		// Dot-directories are skipped as well as the build outputs, and the reason
		// is not tidiness: this walk starts at the repository root, and
		// `tests/.scratch` is created and destroyed by other test files *while it
		// runs* under `--parallel`. Enumerating a directory that is removed before
		// the recursion reaches it fails the whole test with a `NotFound` that has
		// nothing to do with what it asserts. None of these hold product source.
		if (entry.name.startsWith('.')) continue;
		if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
		if (entry.name === 'coverage') continue;
		const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
		if (entry.isDirectory) yield* sources(child);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts')) yield child;
	}
}

Deno.test('BF-8: the element-record producer has exactly the call sites this matrix covers', async () => {
	const root = new URL('../../../', import.meta.url);
	const counts: Record<string, number> = {};
	for await (const file of sources(root)) {
		const path = file.href.replace(root.href, '');
		if (path === 'packages/mcp/src/element_record.ts') continue;
		for (const line of (await Deno.readTextFile(file)).split('\n')) {
			if (/buildElementRecord\(/.test(line)) counts[path] = (counts[path] ?? 0) + 1;
		}
	}
	// A new call site is a new element-describing surface. Add it to SURFACES, bump SURFACE_COUNT,
	// and add it here — in that order, because the matrix is what proves it does not leak a value.
	assertEquals(
		counts,
		PRODUCER_CALL_SITES,
		'an element record is built somewhere this surface matrix does not cover',
	);
});

for (const surface of SURFACES) {
	Deno.test(`BF-8: ${surface.name} never carries a password value`, () => {
		for (const [i, node] of passwordNodes().entries()) {
			const emitted = JSON.stringify(surface.emit(node)) ?? '';
			assert(!emitted.includes(SENTINEL), `arm ${i + 1}: ${emitted}`);
			// Not a prefix or a length either: the value's first characters and its length are as
			// disclosing as the value on a field a caller knows to be a password.
			assert(!emitted.includes(SENTINEL.slice(0, 6)), `arm ${i + 1} leaks a prefix: ${emitted}`);
			assert(!emitted.includes(`"typed_length":${SENTINEL.length}`), `arm ${i + 1} leaks the length`);
		}
	});
}

Deno.test('BF-8: the matrix is not vacuous — an ordinary field DOES surface its value on the value-bearing rows', () => {
	const [password] = passwordNodes();
	assert(password !== undefined);
	const ordinary = { ...password, attributes: { type: 'text', name: 'city', value: 'London' } } as EnhancedDomTreeNode;
	(ordinary.snapshotNode as { inputValue: string | null }).inputValue = 'London';
	assertEquals(inputStateOf(ordinary)?.value, 'London');
	assertEquals(labelOf(ordinary), 'London');
	assert(JSON.stringify(observationStructured(observationOf(ordinary))).includes('London'));
});
