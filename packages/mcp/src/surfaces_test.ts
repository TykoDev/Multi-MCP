/** The parameterised surface matrix. */
import { assert, assertEquals } from '@std/assert';
import { type EnhancedDomTreeNode, mintStateToken } from '@tykotech/browser';
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
		name: 'focus event descriptor (events.ts focusPayload)',
		emit: (node) => focusPayload(1, node, node.frameId, labelOf(node)),
	},
	{
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
		name: 'browser_fill_secret refusal descriptor (secrets.ts describeFillTarget)',
		emit: (node) => describeFillTarget(node as unknown as { nodeName: string; attributes: Record<string, string> }),
	},
	{
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

/** Grows with the product. Every addition is a deliberate edit to both the list and this number. */
const SURFACE_COUNT = 15;

Deno.test('the surface registry is pinned', () => {
	assertEquals(SURFACES.length, SURFACE_COUNT);
	assertEquals(new Set(SURFACES.map((surface) => surface.name)).size, SURFACES.length, 'names are unique');
});

/** Where `buildElementRecord` is called in production, by module, with the call count. */
const PRODUCER_CALL_SITES: Readonly<Record<string, number>> = {
	'packages/mcp/src/observe.ts': 1,
	'packages/mcp/src/tools/perception.ts': 1,
};

async function* sources(dir: URL): AsyncGenerator<URL> {
	for await (const entry of Deno.readDir(dir)) {
		if (entry.name.startsWith('.')) continue;
		if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.name === 'dist') continue;
		if (entry.name === 'coverage') continue;
		const child = new URL(`${entry.name}${entry.isDirectory ? '/' : ''}`, dir);
		if (entry.isDirectory) yield* sources(child);
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('_test.ts')) yield child;
	}
}

Deno.test('the element-record producer has exactly the call sites this matrix covers', async () => {
	const root = new URL('../../../', import.meta.url);
	const counts: Record<string, number> = {};
	for await (const file of sources(root)) {
		const path = file.href.replace(root.href, '');
		if (path === 'packages/mcp/src/element_record.ts') continue;
		for (const line of (await Deno.readTextFile(file)).split('\n')) {
			if (/buildElementRecord\(/.test(line)) counts[path] = (counts[path] ?? 0) + 1;
		}
	}
	assertEquals(
		counts,
		PRODUCER_CALL_SITES,
		'an element record is built somewhere this surface matrix does not cover',
	);
});

for (const surface of SURFACES) {
	Deno.test(`surface matrix: ${surface.name} never carries a password value`, () => {
		for (const [i, node] of passwordNodes().entries()) {
			const emitted = JSON.stringify(surface.emit(node)) ?? '';
			assert(!emitted.includes(SENTINEL), `arm ${i + 1}: ${emitted}`);
			assert(!emitted.includes(SENTINEL.slice(0, 6)), `arm ${i + 1} leaks a prefix: ${emitted}`);
			assert(!emitted.includes(`"typed_length":${SENTINEL.length}`), `arm ${i + 1} leaks the length`);
		}
	});
}

Deno.test('the surface matrix is not vacuous — an ordinary field DOES surface its value on the value-bearing rows', () => {
	const [password] = passwordNodes();
	assert(password !== undefined);
	const ordinary = { ...password, attributes: { type: 'text', name: 'city', value: 'London' } } as EnhancedDomTreeNode;
	(ordinary.snapshotNode as { inputValue: string | null }).inputValue = 'London';
	assertEquals(inputStateOf(ordinary)?.value, 'London');
	assertEquals(labelOf(ordinary), 'London');
	assert(JSON.stringify(observationStructured(observationOf(ordinary))).includes('London'));
});
