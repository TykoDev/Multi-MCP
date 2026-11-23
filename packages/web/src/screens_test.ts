/// <reference lib="deno.ns" />
/**
 * The pure decisions behind the Sessions screen, the Live View and the live embed: whose session a card shows, which
 * ticket refusal ends a Live View for good, and what the live embed says to the person in the chat versus the
 * operator. Real Chromium renders the same states in `tests/e2e/ownership_e2e_test.ts` and `mcp_apps_e2e_test.ts`.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { ApiError } from './api.ts';
import { refusalWords } from './embed_bridge.ts';
import { duration, ownerOf } from './sessions_view.ts';
import { isMissingSession } from './viewer_view.ts';

Deno.test('screens: a session card names its owner only when the server says who it is', () => {
	assertEquals(ownerOf({}), null, 'shared mode, or a credential that is not admin');
	assertEquals(ownerOf({ owner: '' }), null);
	assertEquals(ownerOf({ owner: 'api-key:alice' }), 'alice');
	assertEquals(ownerOf({ owner: 'api-key:admin:root' }), 'admin:root');
	assertEquals(ownerOf({ owner: 'standalone' }), 'standalone');
	assertEquals([duration(45), duration(720), duration(7500), duration(7200)], ['45 s', '12 min', '2 h 5 min', '2 h']);
});

Deno.test('screens: only a ticket refused as unknown-session ends the Live View; the rest retry', () => {
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
	assert(!isMissingSession(new TypeError('Failed to fetch')));
	assert(!isMissingSession(undefined));
});

Deno.test('screens: a refused live embed speaks to the person in the chat; the operator detail is apart', () => {
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
	// Every sentence for the chat is a sentence.
	for (const words of [origin, socket, other]) assert(/^[A-Z].*\.$/.test(words.user), words.user);
});
