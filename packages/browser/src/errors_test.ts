import { assert, assertEquals, assertInstanceOf, assertStringIncludes } from '@std/assert';
import { BrowserError, CdpDisconnectedError, InterruptedError, UrlNotAllowedError } from './errors.ts';

Deno.test('errors: BrowserError carries the two memory hints, defaulting to null', () => {
	const bare = new BrowserError('click failed');
	assertInstanceOf(bare, Error);
	assertEquals(bare.name, 'BrowserError');
	assertEquals(bare.message, 'click failed');
	assertEquals([bare.shortTermMemory, bare.longTermMemory], [null, null]);

	const withMemory = new BrowserError('no such option', {
		shortTermMemory: 'Available options: A, B, C',
		longTermMemory: 'Dropdown at index 12 has no option "D"',
	});
	assertEquals(withMemory.shortTermMemory, 'Available options: A, B, C');
	assertEquals(withMemory.longTermMemory, 'Dropdown at index 12 has no option "D"');
});

Deno.test('errors: a cause is threaded through without stringifying it', () => {
	const cause = new RangeError('backendNodeId 0');
	const error = new BrowserError('node resolution failed', { cause });
	assertEquals(error.cause, cause);
	assertEquals(new BrowserError('no cause').cause, undefined);
});

Deno.test('errors: UrlNotAllowedError is a BrowserError with a default long-term memory line', () => {
	const error = new UrlNotAllowedError('http://127.0.0.1:8080/private');
	assertInstanceOf(error, BrowserError);
	assertEquals(error.name, 'UrlNotAllowedError');
	assertEquals(error.url, 'http://127.0.0.1:8080/private');
	assertEquals(error.reason, 'blocked by domain policy');
	assertStringIncludes(error.message, 'is not allowed');
	assertStringIncludes(error.longTermMemory ?? '', 'was blocked by the configured domain policy');

	const custom = new UrlNotAllowedError('http://127.0.0.1:8080/x', 'ip addresses are blocked', {
		longTermMemory: 'custom',
	});
	assertEquals(custom.reason, 'ip addresses are blocked');
	assertEquals(custom.longTermMemory, 'custom');
	assertStringIncludes(custom.message, 'ip addresses are blocked');
});

Deno.test('errors: CdpDisconnectedError defaults its message and scopes to a target when given', () => {
	const global = new CdpDisconnectedError();
	assertInstanceOf(global, BrowserError);
	assertEquals(global.name, 'CdpDisconnectedError');
	assertEquals(global.targetId, null);
	assertStringIncludes(global.message, 'CDP connection is not available');

	const scoped = new CdpDisconnectedError('target session died', 'TARGET-1');
	assertEquals(scoped.targetId, 'TARGET-1');
	assertEquals(scoped.message, 'target session died');
});

Deno.test('errors: InterruptedError stays outside the BrowserError taxonomy (AGENT-RUNTIME §4)', () => {
	const error = new InterruptedError();
	assertInstanceOf(error, Error);
	assert(!(error instanceof BrowserError), 'the error funnel must not treat an interrupt as a failure');
	assertEquals(error.name, 'InterruptedError');
	assertEquals(error.message, 'Agent run interrupted');
	assertEquals(new InterruptedError('paused by user').message, 'paused by user');
});
