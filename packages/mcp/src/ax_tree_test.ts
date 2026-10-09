/**
 * The accessibility snapshot's value rules (R11, design §2.8, D-120), against the AX trees Chromium recorded for the
 * DOM capture corpus (D-TEST1) — so "what a typed value looks like in the tree" is what Chromium produced, not what a
 * fake asserted. `live_value_vs_attribute` and `react_controlled_inputs` type into fields by script after load;
 * `form_attributes` carries a filled password field, a field whose label repeats its value, and a contenteditable.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { fromFileUrl } from '@std/path';
import { AX_VALUE_CONTAIN_MIN, type AxOut, buildAxTree, count, outlineOf, type RawAxNode } from './ax_tree.ts';

const FIXTURE_DIR = fromFileUrl(new URL('../../browser/fixtures/dom', import.meta.url));

async function axNodesOf(page: string): Promise<RawAxNode[]> {
	const capture = JSON.parse(await Deno.readTextFile(`${FIXTURE_DIR}/${page}.capture.json`)) as {
		sessions: Array<{ axNodes: RawAxNode[] }>;
	};
	return capture.sessions[0]!.axNodes;
}

/** Every node of a tree, flattened. */
function all(tree: AxOut): AxOut[] {
	const out: AxOut[] = [];
	const walk = (node: AxOut) => {
		out.push(node);
		node.children.forEach(walk);
	};
	walk(tree);
	return out;
}

/** The emitted subtree under the first node matching `role` and `name`. */
function find(tree: AxOut, role: string, name?: string): AxOut | undefined {
	return all(tree).find((node) => node.role === role && (name === undefined || node.name === name));
}

Deno.test('R11: a typed value appears nowhere — not as a value, not as the field’s text, not in its name', async () => {
	const nodes = await axNodesOf('live_value_vs_attribute');
	// The capture does carry the values: the rule is about what leaves, so prove the input has them first.
	const raw = JSON.stringify(nodes);
	assertStringIncludes(raw, 'live-typed-value');
	const { tree, outline } = buildAxTree(nodes, { interestingOnly: true, maxNodes: 1000 });
	const emitted = JSON.stringify(tree);
	for (const text of [emitted, outline]) {
		assert(!text.includes('live-typed-value'), 'the typed text must not leave');
		assert(!text.includes('"value"'), 'no node carries a value key');
	}
	const textbox = find(tree, 'textbox');
	assert(textbox !== undefined, outline);
	assertEquals(textbox.name, 'Text, markup says markup-only-value', 'a label that does not repeat the value stays');
	assertEquals(textbox.children, [], "the field's inner editor and its text runs are not emitted");
	// The spin button's 42 and the slider's 9 travel the same way, as a text run and as valuenow.
	const spin = find(tree, 'spinbutton');
	assert(spin !== undefined);
	assertEquals(spin.children, []);
	assertEquals(spin.properties.valuenow, undefined);
	assertEquals(find(tree, 'slider')?.properties.valuenow, undefined);
	assertEquals(all(tree).filter((node) => node.role === 'StaticText' && node.name === '42'), []);
	// Page text outside the controls is untouched.
	assert(find(tree, 'heading', 'Live value versus markup attribute') !== undefined, outline);
});

Deno.test('R11: a select keeps its options; a text field and a textarea keep none of their text', async () => {
	const nodes = await axNodesOf('react_controlled_inputs');
	const { tree, outline } = buildAxTree(nodes, { interestingOnly: true, maxNodes: 1000 });
	const combobox = find(tree, 'combobox', 'Controlled select');
	assert(combobox !== undefined, outline);
	const options = all(combobox).filter((node) => node.role === 'option').map((node) => node.name);
	assertEquals(options, ['One', 'Two', 'Three'], 'a choice list is structure, not a typed value');
	for (const name of ['Controlled text', 'Controlled textarea']) {
		const field = find(tree, 'textbox', name);
		assert(field !== undefined, `${name}: ${outline}`);
		assertEquals(field.children, []);
	}
	// Review R2-4 (rule 5): "mirror: initial-state" is the page's own paragraph, but it repeats the text field's
	// current value, so it is blanked like any name that carries a typed value.
	const mirror = all(tree).filter((node) => node.name.includes('initial-state')).map((node) => node.name);
	assertEquals(mirror, []);
	assert(!JSON.stringify(tree).includes('area-state'), 'the textarea value must not leave');
});

Deno.test('R11: a name that repeats the value is blanked, and a password field keeps only its label', async () => {
	const nodes = await axNodesOf('form_attributes');
	const passwordNode = nodes.find((node) => node.name?.value === 'Account password');
	assert(passwordNode?.backendDOMNodeId !== undefined);
	const { tree, outline } = buildAxTree(nodes, {
		interestingOnly: true,
		maxNodes: 2000,
		passwordBackendIds: new Set([passwordNode.backendDOMNodeId]),
	});
	const emitted = JSON.stringify(tree);
	// The two fields whose accessible name IS their value (`aria-label` = value, and a value-named field).
	assert(!emitted.includes('duplicated-attribute-value'), outline);
	assert(!emitted.includes('"abc"'), outline);
	assert(!emitted.includes('short-value'), 'a long label stays, the value it does not contain still does not leave');
	assert(!emitted.includes('editable content'), 'a contenteditable region is a field like any other');
	const password = find(tree, 'textbox', 'Account password');
	assert(password !== undefined, outline);
	assertEquals(password.children, []);
	// Chromium masks a password's own value with bullets; neither the mask nor any run of it is emitted.
	assert(!emitted.includes('•'), 'no masked value either');
});

Deno.test('R11: a node the caller marks as a password field is a field whatever role the page gave it', () => {
	const nodes: RawAxNode[] = [
		{ nodeId: '1', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: ['2'], backendDOMNodeId: 1 },
		{
			nodeId: '2',
			ignored: false,
			role: { type: 'role', value: 'button' },
			name: { type: 'computedString', value: 'hunter2' },
			value: { type: 'string', value: 'hunter2' },
			childIds: ['3'],
			parentId: '1',
			backendDOMNodeId: 2,
		},
		{
			nodeId: '3',
			ignored: false,
			role: { type: 'role', value: 'StaticText' },
			name: { type: 'computedString', value: 'hunter2' },
			parentId: '2',
			backendDOMNodeId: 3,
		},
	];
	const plain = buildAxTree(nodes, { interestingOnly: false, maxNodes: 10 });
	assertStringIncludes(JSON.stringify(plain.tree), 'hunter2', 'without the DOM fact a button is page text');
	const marked = buildAxTree(nodes, { interestingOnly: false, maxNodes: 10, passwordBackendIds: new Set([2]) });
	assert(!JSON.stringify(marked.tree).includes('hunter2'), JSON.stringify(marked.tree));
});

Deno.test('R11: every emitted string passes the redactor, and the outline is built from the redacted tree', () => {
	const nodes: RawAxNode[] = [
		{
			nodeId: '1',
			ignored: false,
			role: { type: 'role', value: 'RootWebArea' },
			name: { type: 'computedString', value: 'Welcome sw0rdfish' },
			childIds: ['2'],
			backendDOMNodeId: 1,
		},
		{
			nodeId: '2',
			ignored: false,
			role: { type: 'role', value: 'link' },
			name: { type: 'computedString', value: 'profile' },
			description: { type: 'computedString', value: 'for sw0rdfish' },
			properties: [{ name: 'url', value: { type: 'string', value: 'https://x.test/?k=sw0rdfish' } }],
			parentId: '1',
			backendDOMNodeId: 2,
		},
	];
	const { tree, outline } = buildAxTree(nodes, {
		interestingOnly: true,
		maxNodes: 10,
		redact: (text) => text.replaceAll('sw0rdfish', '[secret]'),
	});
	assert(!JSON.stringify(tree).includes('sw0rdfish'));
	assert(!outline.includes('sw0rdfish'));
	assertEquals(tree.name, 'Welcome [secret]');
	assertEquals(tree.children[0]?.description, 'for [secret]');
	assertEquals(tree.children[0]?.properties.url, 'https://x.test/?k=[secret]');
});

Deno.test('R11: max_nodes keeps the first nodes in document order and reports the whole', async () => {
	const nodes = await axNodesOf('form_attributes');
	const whole = buildAxTree(nodes, { interestingOnly: true, maxNodes: 5000 });
	assert(!whole.truncated);
	assertEquals(count(whole.tree), whole.nodesTotal);
	const cut = buildAxTree(nodes, { interestingOnly: true, maxNodes: 7 });
	assert(cut.truncated);
	assertEquals(cut.nodesTotal, whole.nodesTotal);
	assertEquals(count(cut.tree), 7);
	assertEquals(cut.outline.split('\n').length, 7);
	// Pre-order: the first seven lines of the whole outline, exactly.
	assertEquals(cut.outline, whole.outline.split('\n').slice(0, 7).join('\n'));
});

Deno.test('R11: interesting_only drops ignored nodes, unnamed containers and text runs, hoisting children', async () => {
	const nodes = await axNodesOf('live_value_vs_attribute');
	const lean = buildAxTree(nodes, { interestingOnly: true, maxNodes: 5000 });
	const full = buildAxTree(nodes, { interestingOnly: false, maxNodes: 5000 });
	assert(lean.nodesTotal < full.nodesTotal, `${lean.nodesTotal} < ${full.nodesTotal}`);
	assertEquals(all(lean.tree).filter((node) => node.role === 'InlineTextBox' || node.role === 'none'), []);
	assert(all(full.tree).some((node) => node.role === 'InlineTextBox'));
	// A heading's text run repeats the heading and is dropped; the heading is not.
	const heading = find(lean.tree, 'heading');
	assertEquals(heading?.children, []);
	// The rules about values hold either way.
	assert(!JSON.stringify(full.tree).includes('live-typed-value'));
});

Deno.test('R11: indices come from the held table, keyed by backend node id', async () => {
	const nodes = await axNodesOf('live_value_vs_attribute');
	const button = nodes.find((node) => node.name?.value === 'Tail control');
	assert(button?.backendDOMNodeId !== undefined);
	const { tree, outline } = buildAxTree(nodes, {
		interestingOnly: true,
		maxNodes: 1000,
		indexByBackendId: new Map([[button.backendDOMNodeId, 12]]),
	});
	assertEquals(find(tree, 'button', 'Tail control')?.index, 12);
	assertStringIncludes(outline, '- button "Tail control" [12]');
});

Deno.test('R11: a partial or malformed tree neither loops nor throws', () => {
	// A partial tree: one element whose parent was not fetched, naming children that were not either.
	const partial: RawAxNode[] = [{
		nodeId: '9',
		ignored: false,
		role: { type: 'role', value: 'button' },
		name: { type: 'computedString', value: 'Save' },
		properties: [{ name: 'focusable', value: { type: 'booleanOrUndefined', value: true } }],
		parentId: '4',
		childIds: ['10', '11'],
		backendDOMNodeId: 9,
	}];
	const one = buildAxTree(partial, { interestingOnly: true, maxNodes: 10 });
	assertEquals(one.tree, { role: 'button', name: 'Save', properties: { focusable: true }, children: [] });
	assertEquals(one.nodesTotal, 1);
	// A cycle.
	const cyclic: RawAxNode[] = [
		{ nodeId: 'a', ignored: false, role: { type: 'role', value: 'group' }, childIds: ['b'], backendDOMNodeId: 1 },
		{ nodeId: 'b', ignored: false, role: { type: 'role', value: 'group' }, childIds: ['a'], parentId: 'a' },
	];
	assertEquals(buildAxTree(cyclic, { interestingOnly: false, maxNodes: 10 }).nodesTotal, 2);
	assertEquals(buildAxTree([], { interestingOnly: true, maxNodes: 10 }).nodesTotal, 0);
});

Deno.test('R11: the outline prints role, name, index and the states that matter', () => {
	const tree: AxOut = {
		role: 'RootWebArea',
		name: 'Doc',
		properties: {},
		children: [
			{ role: 'checkbox', name: 'Agree', properties: { checked: 'true', focusable: true }, index: 3, children: [] },
			{ role: 'heading', name: 'Title', properties: { level: '2' }, children: [] },
			{ role: 'button', name: '', properties: { disabled: true, expanded: false }, children: [] },
		],
	};
	assertEquals(
		outlineOf(tree),
		['- RootWebArea "Doc"', '  - checkbox "Agree" [3] checked', '  - heading "Title" level=2', '  - button disabled']
			.join('\n'),
	);
});

// --- review R2-4: another node's name is not a way around the value rule ------------------------------------------

/** One raw AX node, as Chromium shapes it. */
function axNode(nodeId: string, role: string, name: string, extra: Record<string, unknown> = {}): RawAxNode {
	return {
		nodeId,
		ignored: false,
		role: { type: 'role', value: role },
		name: { type: 'computedString', value: name },
		...extra,
	} as unknown as RawAxNode;
}

Deno.test('R2-4: a name Chromium computed from another field’s value is blanked (aria-labelledby, wrapping label)', () => {
	const { tree, outline } = buildAxTree([
		axNode('1', 'RootWebArea', 'page', { childIds: ['2', '3', '4', '5', '6'] }),
		axNode('2', 'textbox', 'Query', {
			value: { type: 'string', value: 'typed-Q-VALUE' },
			childIds: [],
			backendDOMNodeId: 10,
		}),
		axNode('3', 'button', 'typed-Q-VALUE', { childIds: [], backendDOMNodeId: 11 }),
		axNode('4', 'checkbox', 'Send to  typed-EM-VALUE', { childIds: [], backendDOMNodeId: 12 }),
		axNode('5', 'textbox', 'Email', {
			value: { type: 'string', value: 'typed-EM-VALUE' },
			childIds: [],
			backendDOMNodeId: 13,
		}),
		axNode('6', 'link', 'Ordinary link', { description: { type: 'computedString', value: 'see typed-Q-VALUE' } }),
	], { interestingOnly: true, maxNodes: 100 });
	const emitted = JSON.stringify(tree);
	assert(!emitted.includes('typed-Q-VALUE') && !emitted.includes('typed-EM-VALUE'), outline);
	assertStringIncludes(outline, 'textbox "Query"');
	assertStringIncludes(outline, 'link "Ordinary link"');
});

Deno.test('R2-4: beside a password field, a run of masking bullets is blanked wherever it is a name', () => {
	const nodes = () => [
		axNode('1', 'RootWebArea', 'page', { childIds: ['2', '3', '4'] }),
		axNode('2', 'textbox', 'Password', {
			value: { type: 'string', value: '•••••••••••••••' },
			childIds: [],
			backendDOMNodeId: 20,
		}),
		axNode('3', 'button', '•••••••••••••••', { childIds: [], backendDOMNodeId: 21 }),
		axNode('4', 'StaticText', '• Home', { childIds: [] }),
	];
	const masked = buildAxTree(nodes(), {
		interestingOnly: true,
		maxNodes: 100,
		passwordBackendIds: new Set([20]),
	});
	assert(!JSON.stringify(masked.tree).includes('••'), masked.outline);
	// A single list bullet is page text, not a mask: it stays.
	assertStringIncludes(masked.outline, '"• Home"');
});

Deno.test('R2-4: a one- or two-character value blanks only a name that is exactly it', () => {
	assertEquals(AX_VALUE_CONTAIN_MIN, 3);
	const { tree, outline } = buildAxTree([
		axNode('1', 'RootWebArea', 'page', { childIds: ['2', '3', '4'] }),
		axNode('2', 'spinbutton', 'Quantity', { value: { type: 'string', value: '42' }, childIds: [] }),
		axNode('3', 'button', '42', { childIds: [] }),
		axNode('4', 'heading', 'Top 42 deals', { childIds: [] }),
	], { interestingOnly: true, maxNodes: 100 });
	assertEquals(all(tree).filter((node) => node.role === 'button').map((node) => node.name), ['']);
	assertStringIncludes(outline, 'heading "Top 42 deals"');
});
