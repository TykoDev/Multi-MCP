/// <reference lib="deno.ns" />
/**
 * The primitives run model-providers-ui adds to `ui.ts` (frontend §3, §4): the segmented switch, fact groups, meter
 * bars, the diff table and the menu button — their roles, names, keyboard paths and live regions, against the fake
 * document in `test_document.ts`. Real Chromium exercises them on the Agents, System and Resources screens.
 */
import { assert, assertEquals } from '@std/assert';
import { diffView, factGroup, menuButton, meterBar, segmented, tag } from './ui.ts';
import { byClass, byRole, byTag, fake, withDocument } from './test_document.ts';

Deno.test('segmented: a tablist of worded tabs — aria-selected on the active one, the rest out of the Tab order', () => {
	withDocument(() => {
		const chosen: string[] = [];
		const built = segmented(
			[
				{ id: 'ask', label: 'Ask agent', icon: 'message' },
				{ id: 'tool', label: 'Run tool', icon: 'wrench' },
				{ id: 'delegate', label: 'Delegate', icon: 'delegate' },
			],
			'ask',
			(id) => chosen.push(id),
		);
		const node = fake(built.node);
		assertEquals(node.getAttribute('role'), 'tablist');
		assert(node.classList.contains('worded'));
		const tabs = byRole(node, 'tab');
		assertEquals(tabs.length, 3);
		assertEquals(tabs.map((tab) => tab.tagName), ['button', 'button', 'button']);
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-selected')), ['true', 'false', 'false']);
		assertEquals(tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1']);
		assertEquals(tabs.map((tab) => byClass(tab, 'label')[0]!.textContent), ['Ask agent', 'Run tool', 'Delegate']);
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-pressed')), [null, null, null], 'tabs are not toggles');
		// A click reports the change once and repaints.
		tabs[1]!.fire('click');
		assertEquals(chosen, ['tool']);
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-selected')), ['false', 'true', 'false']);
		tabs[1]!.fire('click');
		assertEquals(chosen, ['tool'], 'choosing the active tab again reports nothing');
		// `set` paints without reporting, for state changed by another route.
		built.set('delegate');
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-selected')), ['false', 'false', 'true']);
		assertEquals(chosen, ['tool']);
	});
});

Deno.test('segmented: Left and Right move the selection and the focus, wrapping; Home and End reach the ends', () => {
	withDocument((document) => {
		const chosen: string[] = [];
		const node = fake(
			segmented(
				[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
				'a',
				(id) => chosen.push(id),
			).node,
		);
		const tabs = byRole(node, 'tab');
		assert(node.fire('keydown', { key: 'ArrowRight' }).defaultPrevented);
		assertEquals(chosen, ['b']);
		assertEquals(document.activeElement, tabs[1]);
		node.fire('keydown', { key: 'ArrowLeft' });
		node.fire('keydown', { key: 'ArrowLeft' });
		assertEquals(chosen, ['b', 'a', 'c'], 'Left from the first wraps to the last');
		node.fire('keydown', { key: 'ArrowRight' });
		assertEquals(chosen, ['b', 'a', 'c', 'a'], 'Right from the last wraps to the first');
		node.fire('keydown', { key: 'End' });
		node.fire('keydown', { key: 'Home' });
		assertEquals(chosen, ['b', 'a', 'c', 'a', 'c', 'a']);
		assert(!node.fire('keydown', { key: 'Enter' }).defaultPrevented, 'other keys pass through');
		assertEquals(tabs.map((tab) => tab.getAttribute('tabindex')), ['0', '-1', '-1']);
	});
});

Deno.test('segmented: the icon-only form keeps each label as the accessible name and the tooltip', () => {
	withDocument(() => {
		const node = fake(
			segmented(
				[{ id: 'grid', label: 'Grid', icon: 'grid' }, { id: 'list', label: 'List', icon: 'list' }],
				'grid',
				() => {},
				false,
			).node,
		);
		assert(!node.classList.contains('worded'));
		const tabs = byRole(node, 'tab');
		assertEquals(tabs.map((tab) => tab.getAttribute('aria-label')), ['Grid', 'List']);
		assertEquals(tabs.map((tab) => tab.getAttribute('data-tip')), ['Grid', 'List']);
		assertEquals(byClass(node, 'label'), [], 'no visible words');
		assertEquals(byTag(node, 'svg').length, 2);
	});
});

Deno.test('fact group: a group named by its heading; an explanation is the key’s tooltip and a hidden sentence', () => {
	withDocument(() => {
		const node = fake(factGroup('Reachability', [
			{
				key: 'TTK_HOST',
				value: '0.0.0.0',
				explain: 'The interface the gateway listens on.',
				tags: [tag('set'), tag('widens reach', undefined, 'warn')],
			},
			{ key: 'TTK_PORT', value: '8787' },
			{ key: 'TTK_PUBLIC_URL', value: tag('not reported') },
		]));
		assertEquals(node.tagName, 'section');
		assertEquals(node.getAttribute('role'), 'group');
		const heading = byTag(node, 'h3')[0]!;
		assertEquals(heading.textContent, 'Reachability');
		assertEquals(node.getAttribute('aria-labelledby'), heading.id);
		assert(heading.id !== '');
		const rows = byRole(node, 'listitem');
		assertEquals(rows.length, 3);
		const [host, port, url] = rows;
		const hostKey = byClass(host!, 'fact-key')[0]!;
		assertEquals(hostKey.textContent, 'TTK_HOST');
		assertEquals(hostKey.getAttribute('data-tip'), 'The interface the gateway listens on.');
		assertEquals(hostKey.getAttribute('tabindex'), '0', 'the tooltip is reachable from the keyboard');
		assertEquals(byClass(host!, 'sr-only')[0]!.textContent, 'The interface the gateway listens on.');
		assertEquals(byTag(byClass(host!, 'fact-tags')[0]!, 'wa-tag').map((chip) => chip.textContent), [
			'set',
			'widens reach',
		]);
		const portKey = byClass(port!, 'fact-key')[0]!;
		assertEquals(portKey.getAttribute('data-tip'), null);
		assertEquals(portKey.getAttribute('tabindex'), null);
		assertEquals(byClass(port!, 'sr-only'), []);
		assert(byClass(port!, 'fact-val')[0]!.classList.contains('mono'), 'a string value is mono');
		assertEquals(byTag(byClass(url!, 'fact-val')[0]!, 'wa-tag')[0]!.textContent, 'not reported');
		// Two groups never share a heading id.
		const other = fake(factGroup('Other', []));
		assert(byTag(other, 'h3')[0]!.id !== heading.id);
	});
});

Deno.test('meter bar: a role=meter with its value in words, the fill a CSSOM property, no glyph', () => {
	withDocument(() => {
		const node = fake(meterBar('Heap', 0.25, '128 MB of 512 MB'));
		assertEquals(node.getAttribute('role'), 'meter');
		assertEquals(node.getAttribute('aria-label'), 'Heap');
		assertEquals(node.getAttribute('aria-valuemin'), '0');
		assertEquals(node.getAttribute('aria-valuemax'), '100');
		assertEquals(node.getAttribute('aria-valuenow'), '25');
		assertEquals(node.getAttribute('aria-valuetext'), '128 MB of 512 MB');
		assertEquals(byClass(node, 'meter-label')[0]!.textContent, 'Heap');
		assertEquals(byClass(node, 'meter-words')[0]!.textContent, '128 MB of 512 MB');
		assertEquals(byClass(node, 'meter-fill')[0]!.style.getPropertyValue('--fill'), '0.25');
		assertEquals(byTag(node, 'svg'), [], 'drawn by the stylesheet, not a glyph');
		assertEquals(node.attributes.has('style'), false);
		// Out-of-range and non-finite fractions clamp; a nearly full meter is marked.
		assertEquals(fake(meterBar('x', 7, '')).getAttribute('aria-valuenow'), '100');
		assertEquals(fake(meterBar('x', Number.NaN, '')).getAttribute('aria-valuenow'), '0');
		assert(fake(meterBar('x', 0.95, '')).classList.contains('high'));
		assert(!node.classList.contains('high'));
	});
});

Deno.test('diff view: a table with scoped column headers under a polite summary that counts the changes', () => {
	withDocument(() => {
		const node = fake(diffView([
			{ key: 'TTK_HOST', before: '127.0.0.1', after: '0.0.0.0', tags: [tag('widens reach', undefined, 'warn')] },
			{ key: 'TTK_PUBLIC_URL', after: 'http://gateway.lan:8787' },
			{ key: 'TTK_API_KEYS_FILE', before: '/run/secrets/old', after: '/run/secrets/ttk_api_keys' },
		]));
		const summary = byClass(node, 'diff-summary')[0]!;
		assertEquals(summary.textContent, '3 changes');
		assertEquals(summary.getAttribute('aria-live'), 'polite');
		assertEquals(summary.getAttribute('role'), 'status');
		const table = byTag(node, 'table')[0]!;
		assertEquals(table.className, 'diff-table');
		const heads = byTag(table, 'th');
		assertEquals(heads.map((head) => head.textContent), ['Key', 'Before', 'After', 'Tags']);
		for (const head of heads) assertEquals(head.getAttribute('scope'), 'col');
		const rows = byTag(byTag(table, 'tbody')[0]!, 'tr');
		assertEquals(rows.length, 3);
		const cells = (row: number) => byTag(rows[row]!, 'td');
		assertEquals(cells(0).map((cell) => cell.textContent), ['TTK_HOST', '127.0.0.1', '0.0.0.0', 'widens reach']);
		assert(cells(0)[0]!.classList.contains('mono') && cells(0)[1]!.classList.contains('mono'));
		// An absent `before` reads as a dash, and as "not set" to assistive technology.
		const before = cells(1)[1]!;
		assert(before.classList.contains('none'));
		assertEquals(before.children.map((child) => child.textContent), ['—', 'not set']);
		assertEquals(byClass(before, 'sr-only')[0]!.textContent, 'not set');
		// Singular and empty.
		assertEquals(byClass(fake(diffView([{ key: 'a', after: '1' }])), 'diff-summary')[0]!.textContent, '1 change');
		const none = fake(diffView([]));
		assertEquals(byClass(none, 'diff-summary')[0]!.textContent, 'No changes');
		assertEquals(byTag(none, 'table'), [], 'no empty table');
		// Without tags there is no tags column.
		assertEquals(byTag(fake(diffView([{ key: 'a', after: '1' }])), 'th').length, 3);
	});
});

Deno.test('menu button: one primary that opens a popover menu of worded buttons; a choice runs and closes it', () => {
	withDocument((document) => {
		const ran: string[] = [];
		const trigger = fake(menuButton('Add', 'plus', [
			{ label: 'Upload files', icon: 'upload', run: () => ran.push('upload') },
			{ label: 'New folder', icon: 'folder-plus', run: () => ran.push('folder') },
			{
				label: 'New note',
				icon: 'file-plus',
				run: () => ran.push('note'),
				disabled: true,
				reason: 'Read-only credential',
			},
		]));
		assertEquals(trigger.tagName, 'button');
		assert(trigger.classList.contains('wa-brand'), 'the trigger is the one primary');
		assertEquals(trigger.getAttribute('aria-haspopup'), 'menu');
		assertEquals(trigger.getAttribute('aria-expanded'), 'false');
		assertEquals(byClass(trigger, 'label')[0]!.textContent, 'Add');
		assertEquals(byTag(trigger, 'svg').length, 2, 'the glyph and a caret');
		assertEquals(document.body.children, [], 'nothing until it opens');
		trigger.fire('click');
		assertEquals(trigger.getAttribute('aria-expanded'), 'true');
		const popover = document.body.children[0]!;
		assertEquals(popover.tagName, 'wa-popover');
		assert(popover.classList.contains('menu-pop'));
		assertEquals(popover.getAttribute('for'), trigger.id);
		assert(trigger.id !== '', 'the trigger was given an id to anchor to');
		assert(popover.open);
		const menu = byRole(popover, 'menu')[0]!;
		assertEquals(menu.getAttribute('aria-label'), 'Add');
		const items = byRole(menu, 'menuitem');
		assertEquals(items.map((item) => byClass(item, 'label')[0]!.textContent), [
			'Upload files',
			'New folder',
			'New note',
		]);
		assertEquals(items.map((item) => item.disabled), [false, false, true]);
		assertEquals(items[2]!.parentNode!.getAttribute('data-tip'), 'Read-only credential', 'the reason is the tooltip');
		assertEquals(document.activeElement, items[0], 'focus lands on the first enabled entry');
		// Up/Down move among the enabled entries, wrapping.
		menu.fire('keydown', { key: 'ArrowDown' });
		assertEquals(document.activeElement, items[1]);
		menu.fire('keydown', { key: 'ArrowDown' });
		assertEquals(document.activeElement, items[0], 'the disabled entry is skipped');
		menu.fire('keydown', { key: 'ArrowUp' });
		assertEquals(document.activeElement, items[1]);
		// A choice closes the menu first, then runs.
		items[1]!.fire('click');
		assertEquals(ran, ['folder']);
		assert(!popover.open);
		popover.fire('wa-after-hide');
		assertEquals(document.body.children, [], 'the popover is removed once hidden');
		assertEquals(trigger.getAttribute('aria-expanded'), 'false');
		// It opens again, fresh.
		trigger.fire('click');
		assertEquals(document.body.children.length, 1);
	});
});

Deno.test('menu button: inside a modal overlay the menu lives in the overlay, where it is not inert', () => {
	withDocument((document) => {
		const trigger = fake(menuButton('Add', 'plus', [{ label: 'One', icon: 'plus', run: () => {} }]));
		const dialog = document.createElement('wa-dialog');
		dialog.append(trigger);
		document.body.append(dialog);
		trigger.fire('click');
		assertEquals(document.body.children.length, 1, 'nothing was appended to the body');
		assertEquals(dialog.children.map((child) => child.tagName), ['button', 'wa-popover']);
	});
});
