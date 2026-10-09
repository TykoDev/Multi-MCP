/// <reference lib="deno.ns" />
/**
 * The pure decisions behind four screens and the live embed, asserted without a DOM (rendered review, run
 * mcp-recommendations): which family a tool is listed under (RV-5), whose session a card shows (RV-7), which ticket
 * refusal ends a Live View for good (RV-2), and what the live embed says to the person in the chat versus the operator
 * (RV-10). Real Chromium renders the same states in `tests/e2e/ownership_e2e_test.ts` and `mcp_apps_e2e_test.ts`.
 * Run containment-otel-links adds the Inspector's event stream across a reconnect (FXD-N3).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ApiError } from './api.ts';
import { refusalWords } from './embed_bridge.ts';
import { eventStream } from './inspector.ts';
import { ownerOf } from './sessions_view.ts';
import { familyOf } from './tool_families.ts';
import { isMissingSession } from './viewer_view.ts';

/** Every `browser_*` tool the MCP layer declares: the catalog files, plus the share tool the library composes. */
async function browserTools(): Promise<Set<string>> {
	const names = new Set<string>();
	const catalog = new URL('../../mcp/src/catalog/', import.meta.url);
	for await (const entry of Deno.readDir(catalog)) {
		if (!entry.isFile || !entry.name.endsWith('.ts') || entry.name.endsWith('_test.ts')) continue;
		const code = await Deno.readTextFile(new URL(entry.name, catalog));
		for (const [, name = ''] of code.matchAll(/name: '(browser_[a-z_]+)'/g)) names.add(name);
	}
	const library = await Deno.readTextFile(new URL('../../mcp/src/library_tools.ts', import.meta.url));
	assertStringIncludes(library, "'browser_save_to_share'");
	names.add('browser_save_to_share');
	return names;
}

Deno.test('screens (RV-5): every browser tool is listed under a family of its own, none under Other', async () => {
	const names = await browserTools();
	assert(names.size >= 50, `the catalog was read (${names.size} browser tools)`);
	// App-only: the Tools console never lists it (`tool_visibility.ts`), so it needs no family.
	names.delete('browser_live_ticket');
	assertEquals([...names].filter((name) => familyOf(name)[0] === 'Other').sort(), []);
	// The ruling: what the run added, by what each tool is for.
	const added = [
		'network_log',
		'console_log',
		'har_export',
		'accessibility_snapshot',
		'performance',
		'pdf',
		'file_link',
		'save_to_share',
		'request_human',
		'live_view',
	];
	assertEquals(Object.fromEntries(added.map((short) => [short, familyOf(`browser_${short}`)])), {
		network_log: ['Perception', 'eye'],
		console_log: ['Perception', 'eye'],
		har_export: ['Perception', 'eye'],
		accessibility_snapshot: ['Perception', 'eye'],
		performance: ['Perception', 'eye'],
		pdf: ['Files', 'file'],
		file_link: ['Files', 'file'],
		save_to_share: ['Files', 'file'],
		request_human: ['Session', 'sessions'],
		live_view: ['Session', 'sessions'],
	});
	// Extension tools keep their prefix families, and an unknown name still lands somewhere.
	assertEquals(familyOf('file_read'), ['File share', 'folder']);
	assertEquals(familyOf('a2ui_publish'), ['Surfaces', 'surface']);
	assertEquals(familyOf('somebody_elses_tool'), ['Other', 'box']);
});

Deno.test('screens (RV-7): a session card names its owner only when the server says who it is', async () => {
	assertEquals(ownerOf({}), null, 'shared mode, or a credential that is not admin: no owner, no chip');
	assertEquals(ownerOf({ owner: '' }), null);
	assertEquals(ownerOf({ owner: 'api-key:alice' }), { name: 'alice', tip: 'Owner · api-key:alice' });
	assertEquals(ownerOf({ owner: 'oauth:auth0|5f1c' }), { name: 'auth0|5f1c', tip: 'Owner · oauth:auth0|5f1c' });
	assertEquals(ownerOf({ owner: 'standalone' }), { name: 'standalone', tip: 'Owner · standalone' });
	// The card draws it, and a change of owner alone redraws the list (the poll compares a signature).
	const code = await Deno.readTextFile(new URL('./sessions_view.ts', import.meta.url));
	assertStringIncludes(code, 'ownerOf(session)');
	assert(
		/JSON\.stringify\(\s*sessions\.map\(\(s\) => \[[^\]]*s\.owner/.test(code),
		'the render signature carries the owner',
	);
});

Deno.test('screens (RV-2): only a ticket refused as unknown-session ends the Live View; the rest retry', () => {
	const problem = (slug: string, status: number) => ({
		type: `https://tykotech.eu/problems/${slug}`,
		title: slug,
		status,
		detail: `no session x`,
	});
	// In owner mode another principal's session and a session that never existed answer alike (no existence leak).
	assert(isMissingSession(new ApiError(404, problem('unknown-session', 404), 'Not Found')));
	// A 404 that is not the server's problem document (a proxy, a rolling deploy) may pass on the next attempt.
	assert(!isMissingSession(new ApiError(404, null, 'Not Found')));
	assert(!isMissingSession(new ApiError(429, problem('rate-limited', 429), 'Too Many Requests', 30_000)));
	assert(!isMissingSession(new ApiError(503, problem('service-unavailable', 503), 'Service Unavailable')));
	assert(!isMissingSession(new TypeError('Failed to fetch')));
	assert(!isMissingSession(undefined));
});

Deno.test('screens (RV-10): a refused live embed speaks to the person in the chat; the operator detail is apart', () => {
	const server = 'origin "http://localhost:59992" is not admitted: it must be listed in TTK_MCP_APPS_ORIGINS and ' +
		'allowed for this credential';
	const origin = refusalWords('invalid-arguments', server);
	assertEquals(origin.retryable, false, 'an unadmitted origin stays refused, so Watch is not offered again');
	for (const leak of ['TTK_', 'localhost', 'invalid-arguments', 'origin "']) {
		assert(!origin.user.includes(leak), `the chat user is not shown ${leak}: ${origin.user}`);
	}
	assertEquals(origin.detail, `invalid-arguments: ${server}`);

	const socket = refusalWords('connection-refused', 'refused before it opened (TTK_ALLOWED_ORIGINS)');
	assertEquals(socket.retryable, true);
	assert(!socket.user.includes('TTK_'), socket.user);
	assertStringIncludes(socket.detail, 'TTK_ALLOWED_ORIGINS');

	const other = refusalWords('scope-required', 'this credential cannot watch');
	assertEquals(other.retryable, true);
	assert(!other.user.includes('scope-required'), other.user);
	assertEquals(other.detail, 'scope-required: this credential cannot watch');
	// Every sentence for the chat is a sentence.
	for (const words of [origin, socket, other]) assert(/^[A-Z].*\.$/.test(words.user), words.user);
});

Deno.test('screens (FXD-N3): a reconnected socket is subscribed again only while the toggle says Streaming', async () => {
	const sent: string[] = [];
	const stream = eventStream((message) => sent.push(message.type));
	// The first socket reaches meta: nothing was asked for, so nothing is sent.
	stream.socketReady();
	assertEquals(sent, []);
	// The operator turns the stream on; the socket drops and a new one reaches meta: it is asked again.
	assertEquals(stream.toggle(), true);
	assertEquals(sent, ['events.subscribe']);
	stream.socketReady();
	assertEquals(sent, ['events.subscribe', 'events.subscribe']);
	assertEquals(stream.subscribed, true, 'a reconnect leaves the toggle as the operator set it');
	// Turned off after the reconnect: the next socket is not subscribed.
	assertEquals(stream.toggle(), false);
	assertEquals(sent, ['events.subscribe', 'events.subscribe', 'events.unsubscribe']);
	stream.socketReady();
	assertEquals(sent, ['events.subscribe', 'events.subscribe', 'events.unsubscribe']);

	// The viewer tells the Inspector on every meta (first and reconnected), and the Inspector hands it to the stream.
	const viewer = await Deno.readTextFile(new URL('./viewer_view.ts', import.meta.url));
	assert(/onMeta: \(meta\) => \{[^}]*inspector\.socketReady\(\);\s*\}/s.test(viewer), 'onMeta calls socketReady');
	const inspector = await Deno.readTextFile(new URL('./inspector.ts', import.meta.url));
	assert(/socketReady\(\) \{\s*stream\.socketReady\(\);/.test(inspector), 'the Inspector forwards it');
});
