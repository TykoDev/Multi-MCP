/// <reference lib="deno.ns" />
/**
 * `routeOf` is the one reading of `#/resources/…` the router and the screen
 * share: a scheme means a live resource, a known group name means a branch of
 * the tree, and anything else is handed to the resource reader as it was.
 */
import { assertEquals } from '@std/assert';
import { routeOf } from './resources_route.ts';

Deno.test('resources route: a parameter with a scheme is a URI, whatever follows the colon', () => {
	assertEquals(routeOf('ttk://capabilities'), { kind: 'uri', uri: 'ttk://capabilities' });
	assertEquals(routeOf('ttk://session/default/screenshot'), { kind: 'uri', uri: 'ttk://session/default/screenshot' });
	assertEquals(routeOf('https://example.test/doc'), { kind: 'uri', uri: 'https://example.test/doc' });
	assertEquals(routeOf('file:'), { kind: 'uri', uri: 'file:' });
	assertEquals(routeOf('file:///share/notes.md'), { kind: 'uri', uri: 'file:///share/notes.md' });
	// A scheme is letters, digits, `+`, `.` and `-` after a letter: `web+ttk:` is one, `1ttk:` and `files/a:b` are not.
	assertEquals(routeOf('web+ttk:x'), { kind: 'uri', uri: 'web+ttk:x' });
	assertEquals(routeOf('files/a:b'), { kind: 'group', group: 'files', rest: 'a:b' });
});

Deno.test('resources route: each group, bare and with a remainder', () => {
	assertEquals(routeOf('files'), { kind: 'group', group: 'files' });
	assertEquals(routeOf('files/docs/reports'), { kind: 'group', group: 'files', rest: 'docs/reports' });
	assertEquals(routeOf('skills'), { kind: 'group', group: 'skills' });
	assertEquals(routeOf('skills/triage'), { kind: 'group', group: 'skills', rest: 'triage' });
	assertEquals(routeOf('prompts'), { kind: 'group', group: 'prompts' });
	assertEquals(routeOf('prompts/daily-summary'), { kind: 'group', group: 'prompts', rest: 'daily-summary' });
	assertEquals(routeOf('templates'), { kind: 'group', group: 'templates' });
	assertEquals(routeOf('templates/x'), { kind: 'group', group: 'templates', rest: 'x' });
	// A trailing slash is the bare group, with no empty remainder to carry.
	assertEquals(routeOf('files/'), { kind: 'group', group: 'files' });
});

Deno.test('resources route: nothing selected, and an unknown word stays a URI for the reader to refuse', () => {
	assertEquals(routeOf(undefined), { kind: 'none' });
	assertEquals(routeOf(''), { kind: 'none' });
	assertEquals(routeOf('library'), { kind: 'uri', uri: 'library' });
	assertEquals(routeOf('Files'), { kind: 'uri', uri: 'Files' });
});

Deno.test("resources route (D-152): the tree's other groups, the tools and their filters", () => {
	assertEquals(routeOf('tools'), { kind: 'group', group: 'tools' });
	assertEquals(routeOf('tools/browser_navigate'), { kind: 'group', group: 'tools', rest: 'browser_navigate' });
	assertEquals(routeOf('tools/@files'), { kind: 'group', group: 'tools', rest: '@files' });
	assertEquals(routeOf('sessions/default'), { kind: 'group', group: 'sessions', rest: 'default' });
	assertEquals(routeOf('agents/provider/local'), { kind: 'group', group: 'agents', rest: 'provider/local' });
	assertEquals(routeOf('surfaces/@actions'), { kind: 'group', group: 'surfaces', rest: '@actions' });
	for (const group of ['server', 'browser', 'sandbox', 'agents', 'surfaces'] as const) {
		assertEquals(routeOf(group), { kind: 'group', group });
	}
});
