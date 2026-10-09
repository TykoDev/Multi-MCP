/// <reference lib="deno.ns" />
/**
 * `jsonFacts` (run model-providers-ui, frontend §2b/§4): a JSON value becomes fact groups, chips and tables — never
 * markup — against the fake document in `test_document.ts`. Real Chromium paints the same shapes in the Resources
 * viewer's Facts tab (F2's e2e walk).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { jsonFacts } from './json_facts.ts';
import { all, byClass, byRole, byTag, fake, withDocument } from './test_document.ts';

const texts = (nodes: ReadonlyArray<{ textContent: string }>): string[] => nodes.map((node) => node.textContent);

Deno.test('json facts: an object is one fact group — a heading that names it, one row per member, values in mono', () => {
	withDocument(() => {
		const root = fake(jsonFacts({ name: 'edge', port: 8787, secure: true, nothing: null }));
		const groups = byRole(root, 'group');
		assertEquals(groups.length, 1);
		const [group] = groups;
		assert(group !== undefined);
		assertStringIncludes(group.className, 'fact-group');
		const heading = byTag(group, 'h3')[0];
		assert(heading !== undefined);
		assertEquals(heading.textContent, 'Facts');
		assertEquals(group.getAttribute('aria-labelledby'), heading.id, 'the group is named by its heading');
		const rows = byRole(group, 'listitem');
		assertEquals(texts(rows.map((row) => byClass(row, 'fact-key')[0]!)), ['name', 'port', 'secure', 'nothing']);
		const values = rows.map((row) => byClass(row, 'fact-val')[0]!);
		assertEquals(texts(values), ['edge', '8787', 'true', 'null']);
		for (const value of values) assert(value.classList.contains('mono'), 'data in mono (DESIGN-SYSTEM §1.5)');
	});
});

Deno.test('json facts: an array of scalars is a row of glyph-less chips; an empty one reads as a dash', () => {
	withDocument(() => {
		const root = fake(jsonFacts({ transports: ['sse', 'ws'], kinds: [] }));
		const [chips, none] = byRole(root, 'listitem').map((row) => byClass(row, 'fact-val')[0]!);
		assert(chips !== undefined && none !== undefined);
		const tags = byTag(chips, 'wa-tag');
		assertEquals(texts(tags), ['sse', 'ws']);
		assertEquals(byTag(chips, 'svg'), [], 'no glyph on a chip (D-092 amended)');
		assertEquals(none.textContent, '—');
	});
});

Deno.test('json facts: an array of objects is a table with scoped column headers, the union of keys as columns', () => {
	withDocument(() => {
		const root = fake(jsonFacts({
			providers: [{ id: 'main', kind: 'openai', models: 3 }, { id: 'local', reachable: false }],
		}));
		const table = byClass(root, 'facts-table')[0];
		assert(table !== undefined);
		assertEquals(table.tagName, 'table');
		const heads = byTag(table, 'th');
		assertEquals(texts(heads), ['id', 'kind', 'models', 'reachable']);
		for (const head of heads) assertEquals(head.getAttribute('scope'), 'col');
		const rows = byTag(byTag(table, 'tbody')[0]!, 'tr');
		assertEquals(rows.length, 2);
		assertEquals(texts(byTag(rows[1]!, 'td')), ['local', '—', '—', 'false'], 'a key an object lacks reads as a dash');
		for (const cell of byTag(table, 'td')) assert(cell.classList.contains('mono'));
		// The table is a named group, titled by the key.
		const section = table.closest('section');
		assert(section !== null);
		assertEquals(section.getAttribute('role'), 'group');
		assertEquals(byTag(section, 'h3')[0]!.textContent, 'providers');
		assertEquals(byTag(section, 'h3')[0]!.id, section.getAttribute('aria-labelledby'));
	});
});

Deno.test('json facts: nested objects are collapsible groups, open through depth 2 and closed below', () => {
	withDocument(() => {
		const root = fake(jsonFacts({ live_view: { max_fps: 15, ceilings: { width: 1920, more: { x: 1 } } } }));
		const details = byTag(root, 'wa-details');
		assertEquals(details.map((node) => node.getAttribute('summary')), ['live_view', 'ceilings', 'more']);
		assertEquals(details.map((node) => node.hasAttribute('open')), [true, true, false]);
		// Each level keeps its own rows in its own group, and its children after them.
		const [outer] = details;
		assert(outer !== undefined);
		const group = outer.children.find((child) => child.classList.contains('fact-group'));
		assert(group !== undefined);
		assertEquals(texts(byClass(group, 'fact-key')), ['max_fps']);
		assertEquals(byTag(group, 'h3')[0]!.textContent, 'live_view');
		// `depth: 1` closes the second level.
		const shallow = fake(jsonFacts({ a: { b: { c: 1 } } }, { depth: 1 }));
		assertEquals(byTag(shallow, 'wa-details').map((node) => node.hasAttribute('open')), [true, false]);
	});
});

Deno.test('json facts: omitted paths are left out; everything else stays', () => {
	withDocument(() => {
		const root = fake(jsonFacts(
			{ version: '0.2.0', events: { transports: ['sse'], ring_size: 512 }, state_token: 'abc' },
			{ omit: ['version', 'events.transports'] },
		));
		const keys = texts(byClass(root, 'fact-key'));
		assert(!keys.includes('version'));
		assert(!keys.includes('transports'));
		assertEquals(keys, ['ring_size', 'state_token']);
		assert(!root.textContent.includes('0.2.0'));
	});
});

Deno.test('json facts: members without a group of their own gather in a trailing Other group, never dropped', () => {
	withDocument(() => {
		const root = fake(jsonFacts(
			{ state_token: 'abc', live_view: { max_fps: 15 }, future_flag: true },
			{ labels: { live_view: 'Live view' } },
		));
		const order = root.children.map((child) =>
			child.tagName === 'wa-details' ? child.getAttribute('summary') : byTag(child, 'h3')[0]!.textContent
		);
		assertEquals(order, ['Live view', 'Other'], 'the labelled nested group first, the leftovers last');
		const other = root.children[1]!;
		assertEquals(texts(byClass(other, 'fact-key')), ['state_token', 'future_flag']);
		// A label also renames a nested group's own heading, and the root group when the root has no nested members.
		assertEquals(byTag(root.children[0]!, 'h3')[0]!.textContent, 'Live view');
		const flat = fake(jsonFacts({ a: 1 }, { labels: { '': 'Server' } }));
		assertEquals(byTag(flat, 'h3')[0]!.textContent, 'Server');
	});
});

Deno.test('json facts: keys and values that look like markup stay text — no element is ever parsed from a value', () => {
	withDocument(() => {
		const key = '<b>bold</b>';
		const value = '<script>alert(1)</script>';
		const root = fake(jsonFacts({
			[key]: value,
			list: ['<i>x</i>'],
			rows: [{ '<img src=x onerror=alert(1)>': '<td>cell</td>' }],
			nest: { '<h1>': '<a href="x">y</a>' },
		}));
		for (const forbidden of ['script', 'b', 'i', 'img', 'a', 'h1']) {
			assertEquals(byTag(root, forbidden), [], `no <${forbidden}> was created`);
		}
		const text = all(root).map((node) => node.textContent).join('\n');
		assertStringIncludes(text, key);
		assertStringIncludes(text, value);
		assertStringIncludes(text, '<i>x</i>');
		assertStringIncludes(text, '<td>cell</td>');
		assertStringIncludes(text, '<a href="x">y</a>');
	});
});

Deno.test('json facts: a scalar or an array at the root is still a group, and an empty object says so', () => {
	withDocument(() => {
		const scalar = fake(jsonFacts('plain'));
		assertEquals(texts(byClass(scalar, 'fact-key')), ['value']);
		assertEquals(byClass(scalar, 'fact-val')[0]!.textContent, 'plain');
		const list = fake(jsonFacts([1, 2]));
		assertEquals(texts(byTag(list, 'wa-tag')), ['1', '2']);
		const nothing = fake(jsonFacts({}));
		assertEquals(texts(byClass(nothing, 'fact-key')), ['members']);
		assertEquals(byClass(nothing, 'fact-val')[0]!.textContent, 'none');
	});
});
