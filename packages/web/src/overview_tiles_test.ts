/// <reference lib="deno.ns" />
/**
 * D-155: the stored-data numbers — the Resources cards' and tree heads' item counts with their nouns, and the Sessions
 * dashboard's tiles (which sections become tiles, in what order, linking where) — against the fake document.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import type { Overview } from './api.ts';
import { counted, domainItems, overviewStrip, overviewTiles, withLiveSessions } from './overview_tiles.ts';
import { byClass, byTag, fake, withDocument } from './test_document.ts';

const FULL: Overview = {
	generated_at: '2026-10-07T12:00:00.000Z',
	sessions: { scope: 'own', count: 2, tabs: 3, viewers: 1, in_use: 1 },
	profiles: { count: 1, bytes: 2048, truncated: false },
	storage_states: { count: 2, bytes: 300 },
	recordings: { scope: 'all', count: 0, bytes: 0 },
	files: { count: 14, folders: 3, bytes: 5 * 1024 * 1024, truncated: false },
	skills: { count: 3 },
	prompts: { count: 0 },
	memory: { scope: 'own', collections: 2, items: 40 },
	workspaces: { scope: 'own', count: 1 },
	tasks: { scope: 'own', count: 5, active: 1, by_state: { completed: 3, working: 1, failed: 1 } },
	surfaces: { scope: 'own', count: 1 },
	providers: { count: 2, reachable: 1 },
	disk: { bytes: 3 * 1024 * 1024 * 1024, truncated: true },
};

Deno.test('overview (D-155): counts read with their noun, singular and plural', () => {
	assertEquals(counted(0, 'prompt'), '0 prompts');
	assertEquals(counted(1, 'workspace'), '1 workspace');
	assertEquals(counted(14, 'file'), '14 files');
});

Deno.test('overview (D-155): a Resources group counts what was added to it, never its tree leaves', () => {
	assertEquals(domainItems('server', FULL), null, 'nothing is added to the Server group: no count at all');
	assertEquals(domainItems('browser', FULL), { count: '2', text: '2 sessions' });
	assertEquals(domainItems('files', FULL), { count: '14', text: '14 files' });
	assertEquals(domainItems('skills', FULL), { count: '3', text: '3 skills' });
	assertEquals(domainItems('prompts', FULL), { count: '0', text: '0 prompts' });
	assertEquals(domainItems('sandbox', FULL), { count: '1', text: '1 workspace' });
	assertEquals(domainItems('agents', FULL), { count: '5', text: '5 tasks' });
	assertEquals(domainItems('surfaces', FULL), { count: '1', text: '1 surface' });
	// A capped walk is a floor; a sandbox that did not answer is unknown; a section left out is no count.
	assertEquals(domainItems('files', { ...FULL, files: { count: 20000, folders: 9, bytes: 1, truncated: true } }), {
		count: '20000+',
		text: '20000+ files',
	});
	assertEquals(domainItems('sandbox', { ...FULL, workspaces: { scope: 'own', count: null } }), {
		count: '—',
		text: 'workspaces unknown',
	});
	assertEquals(domainItems('agents', { generated_at: FULL.generated_at }), null);
	assertEquals(domainItems('files', null), null, 'before the route answers, or when it fails');
});

Deno.test('overview (D-155): the dashboard has one tile per section the server sent, in order, linked where managed', () => {
	const tiles = overviewTiles(FULL);
	assertEquals(tiles.map((tile) => tile.id), [
		'sessions',
		'profiles',
		'storage',
		'recordings',
		'files',
		'skills',
		'prompts',
		'workspaces',
		'tasks',
		'providers',
		'memory',
		'surfaces',
		'disk',
	]);
	const by = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
	assertEquals(by.files!.value, '14');
	assertEquals(by.files!.sub, '5.0 MB');
	assertEquals(by.files!.route, '#/resources/files');
	assertEquals(by.workspaces!.route, '#/workspaces');
	assertEquals(by.tasks!.route, '#/agents');
	assertEquals(by.tasks!.sub, '1 active');
	assertEquals(by.tasks!.tone, 'live', 'a task running now is news');
	assertEquals(by.tasks!.detail, 'completed 3 · failed 1 · working 1 · yours');
	assertEquals(by.sessions!.route, undefined, 'the session cards are on this very screen');
	assertEquals(by.memory!.route, undefined, 'memory is managed on an administrator screen: no link for one’s own');
	assertEquals(
		overviewTiles({ ...FULL, memory: { scope: 'all', collections: 3, items: 9 } }).find((tile) => tile.id === 'memory')
			?.route,
		'#/system/agents',
	);
	assertEquals(by.disk!.value, '≥ 3.0 GB', 'a capped walk is a floor');
	assertStringIncludes(by.sessions!.detail, 'yours');
	assertStringIncludes(by.recordings!.detail, 'everyone’s');
	// Only the sections the credential can read: a bare overview has no tiles.
	assertEquals(overviewTiles({ generated_at: FULL.generated_at }), []);
	assertEquals(
		overviewTiles({ generated_at: FULL.generated_at, workspaces: { scope: 'own', count: null } })[0]?.value,
		'—',
	);
});

Deno.test('overview (D-155): the live admin list replaces the Sessions section, everyone’s', () => {
	const merged = withLiveSessions(FULL, [
		{ tab_count: 2, viewer_count: 0, human_has_control: false },
		{ tab_count: 1, viewer_count: 2, human_has_control: true },
		{ tab_count: 4, viewer_count: 0, human_has_control: false },
	]);
	assertEquals(merged.sessions, { scope: 'all', count: 3, tabs: 7, viewers: 2, in_use: 1 });
	assertEquals(merged.files, FULL.files, 'the rest is the overview’s');
});

Deno.test('overview (D-155): the strip renders the tiles, updates them in place and drops a section that went', () => {
	withDocument(() => {
		const strip = overviewStrip();
		const node = fake(strip.node);
		assertEquals(node.getAttribute('aria-label'), 'Stored data');
		strip.paint({ generated_at: FULL.generated_at });
		assert(
			node.hasAttribute('hidden') || (strip.node as unknown as { hidden: boolean }).hidden,
			'no section, no strip',
		);

		strip.paint(FULL);
		assertEquals((strip.node as unknown as { hidden: boolean }).hidden, false);
		const items = byTag(node, 'li');
		assertEquals(items.length, 13);
		const links = byTag(node, 'a');
		assertEquals(
			links.map((link) => link.getAttribute('href')),
			[
				'#/resources/files',
				'#/resources/skills',
				'#/resources/prompts',
				'#/workspaces',
				'#/agents',
				'#/system/agents',
				'#/resources/surfaces',
				'#/system',
			],
		);
		const filesTile = items.find((item) => item.getAttribute('data-tile') === 'files')!;
		assertEquals(byClass(filesTile, 'tile-value')[0]!.textContent, '14');
		assertEquals(byClass(filesTile, 'tile-label')[0]!.textContent, 'Files');
		assertEquals(byClass(filesTile, 'tile-sub')[0]!.textContent, '5.0 MB');
		const prompts = items.find((item) => item.getAttribute('data-tile') === 'prompts')!;
		assert(byClass(prompts, 'tile')[0]!.classList.contains('zero'), 'a zero recedes');

		// A new number updates the same tile; a section the server stops sending is dropped.
		const { tasks: _gone, ...rest } = FULL;
		strip.paint({ ...rest, files: { count: 15, folders: 3, bytes: 10, truncated: false } });
		const after = byTag(node, 'li');
		assertEquals(after.length, 12);
		assert(after.includes(filesTile), 'the tile is updated in place, not rebuilt');
		assertEquals(byClass(filesTile, 'tile-value')[0]!.textContent, '15');
		assertEquals(after.find((item) => item.getAttribute('data-tile') === 'tasks'), undefined);
	});
});

Deno.test('overview (D-155): the Sessions screen shows the strip; the Resources cards count items, not leaves', async () => {
	const sessions = await Deno.readTextFile(new URL('./sessions_view.ts', import.meta.url));
	assertStringIncludes(sessions, 'overviewStrip()');
	assertStringIncludes(sessions, 'api.overview()');
	assert(!sessions.includes("statTile('tabs'"), 'the old sessions-only strip is folded into the dashboard');
	const resources = await Deno.readTextFile(new URL('./resources_view.ts', import.meta.url));
	assertStringIncludes(resources, 'domainItems(domain.id, stored)');
	assert(!/\$\{data\} \$\{data === 1 \? 'item' : 'items'\}/.test(resources), 'no generic "items" from tree leaves');
});
