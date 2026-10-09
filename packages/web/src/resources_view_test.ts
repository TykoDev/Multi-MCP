/// <reference lib="deno.ns" />
/**
 * The pure decisions of the Resources screen (run model-providers-ui, F2): the route a selection key writes, which
 * `routeOf` must read back as the same thing; the tree item a key marks; and when JSON text reads as facts.
 */
import { assertEquals } from '@std/assert';
import { routeOf } from './resources_route.ts';
import { domainOf } from './resources_tools.ts';
import { DOMAINS, jsonValueOf, matchesQuery, routeFor, treeKeyOf } from './resources_view.ts';

Deno.test('resources: a key writes the route routeOf reads back', () => {
	assertEquals(routeFor('group:files'), 'files');
	assertEquals(routeFor('folder:docs/reports'), 'files/docs/reports');
	assertEquals(routeFor('file:docs/a b.md'), 'files/docs/a%20b.md');
	assertEquals(routeFor('skill:code-review'), 'skills/code-review');
	assertEquals(routeFor('prompt:summarise'), 'prompts/summarise');
	assertEquals(routeFor('group:templates'), 'templates');
	assertEquals(routeFor('template:2'), 'templates');
	assertEquals(routeFor('uri:ttk://capabilities'), encodeURIComponent('ttk://capabilities'));
	// D-152: every group is a route of its own; the overview is the bare screen.
	assertEquals(routeFor('group:overview'), '');
	assertEquals(routeFor('group:server'), 'server');
	assertEquals(routeFor('group:sessions'), 'sessions');
	assertEquals(routeFor('session:default'), 'sessions/default');
	assertEquals(routeFor('group:tools'), 'tools');
	assertEquals(routeFor('tools:files'), 'tools/@files');
	assertEquals(routeFor('family:Navigation'), 'tools/@browser');
	assertEquals(routeFor('tool:browser_navigate'), 'tools/browser_navigate');
	assertEquals(routeFor('agent:a2a'), 'agents/a2a');
	assertEquals(routeFor('provider:local'), 'agents/provider/local');
	assertEquals(routeFor('surface:status'), 'surfaces/status');
	assertEquals(routeFor('surfaces:actions'), 'surfaces/@actions');
	assertEquals(routeFor('workspace:w1'), 'sandbox/w1');

	// Round trip through the router's reading, with the segments decoded as `app.ts` decodes the hash.
	const back = (key: string) => routeOf(decodeURIComponent(routeFor(key)));
	assertEquals(back('folder:docs/reports'), { kind: 'group', group: 'files', rest: 'docs/reports' });
	assertEquals(back('skill:code-review'), { kind: 'group', group: 'skills', rest: 'code-review' });
	assertEquals(back('group:prompts'), { kind: 'group', group: 'prompts' });
	assertEquals(back('uri:ttk://capabilities'), { kind: 'uri', uri: 'ttk://capabilities' });
	assertEquals(back('group:overview'), { kind: 'none' });
	assertEquals(back('group:server'), { kind: 'group', group: 'server' });
	assertEquals(back('tool:browser_navigate'), { kind: 'group', group: 'tools', rest: 'browser_navigate' });
	assertEquals(back('tools:skills'), { kind: 'group', group: 'tools', rest: '@skills' });
	assertEquals(back('provider:local'), { kind: 'group', group: 'agents', rest: 'provider/local' });
});

Deno.test("resources (D-152): every tool hangs under one group, the browser's file tools under Browser", () => {
	assertEquals(DOMAINS.map((domain) => domain.id), [
		'server',
		'browser',
		'files',
		'skills',
		'prompts',
		'sandbox',
		'agents',
		'surfaces',
	]);
	assertEquals(domainOf('browser_navigate'), 'browser');
	assertEquals(domainOf('browser_save_to_share'), 'browser');
	assertEquals(domainOf('file_read'), 'files');
	assertEquals(domainOf('skill_get'), 'skills');
	assertEquals(domainOf('prompt_render'), 'prompts');
	assertEquals(domainOf('sandbox_exec'), 'sandbox');
	assertEquals(domainOf('agent_delegate'), 'agents');
	assertEquals(domainOf('a2ui_publish'), 'surfaces');
	assertEquals(domainOf('health'), 'server');
});

Deno.test('resources (D-152): the search matches every term, in any order, case-insensitively', () => {
	assertEquals(matchesQuery('Navigate browser_navigate Go to a URL', ''), true);
	assertEquals(matchesQuery('Navigate browser_navigate Go to a URL', 'navigate'), true);
	assertEquals(matchesQuery('Navigate browser_navigate Go to a URL', 'url   GO'), true);
	assertEquals(matchesQuery('Navigate browser_navigate Go to a URL', 'url back'), false);
});

Deno.test('resources: a file marks its folder in the tree; everything else marks itself', () => {
	assertEquals(treeKeyOf('file:docs/notes.md'), 'folder:docs');
	assertEquals(treeKeyOf('file:notes.md'), 'group:files');
	assertEquals(treeKeyOf('folder:docs'), 'folder:docs');
	assertEquals(treeKeyOf('skill:x'), 'skill:x');
	assertEquals(treeKeyOf('uri:ttk://capabilities'), 'uri:ttk://capabilities');
});

Deno.test('resources: JSON reads as facts when it is an object or an array, never a scalar or plain text', () => {
	assertEquals(jsonValueOf('{"a":1}'), { a: 1 });
	assertEquals(jsonValueOf('[1,2]'), [1, 2]);
	assertEquals(jsonValueOf('42'), undefined);
	assertEquals(jsonValueOf('"text"'), undefined);
	assertEquals(jsonValueOf('null'), undefined);
	assertEquals(jsonValueOf('not json'), undefined);
});
