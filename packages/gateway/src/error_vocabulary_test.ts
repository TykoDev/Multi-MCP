/** The three shipped error vocabularies are frozen wire: the whole membership is pinned, not a count. */
import { assertEquals } from '@std/assert';
import { TOOL_ERROR_CODES } from '@tykotech/mcp';
import { WS_ERROR_CODES } from '@tykotech/wire';
import { PROBLEM_SLUGS } from './problem.ts';

Deno.test('the three vocabularies are closed, and their sizes are stated by name', () => {
	assertEquals([...TOOL_ERROR_CODES].sort(), [
		'browser-crashed',
		'browser-error',
		'browser-unavailable',
		'dialog-open',
		'download-failed',
		'element-not-found',
		'element-not-interactable',
		'feature-unavailable',
		'file-unavailable',
		'human-has-control',
		'invalid-arguments',
		'navigation-blocked',
		'scope-required',
		'session-limit',
		'timeout',
		'unknown-file',
		'unknown-index',
		'unknown-session',
		'unknown-tab',
		'user-declined',
	]);
	assertEquals([...PROBLEM_SLUGS].sort(), [
		'conflict',
		'csrf-failed',
		'forbidden-scope',
		'host-forbidden',
		'internal',
		'invalid-request',
		'not-found',
		'origin-forbidden',
		'payload-too-large',
		'persistence-required',
		'rate-limited',
		'service-unavailable',
		'ticket-consumed',
		'ticket-expired',
		'ticket-invalid',
		'unauthenticated',
		'unknown-session',
	]);
	assertEquals([...WS_ERROR_CODES].sort(), [
		'bad-message',
		'browser-crashed',
		'input-rejected',
		'internal',
		'lock-held',
		'navigation-blocked',
		'not-holder',
		'not-ready',
	]);
});
