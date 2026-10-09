import { assert, assertEquals, assertInstanceOf, assertStringIncludes } from '@std/assert';

import {
	CdpConnectionClosedError,
	CdpError,
	CdpFrameTooLargeError,
	CdpProtocolError,
	CdpRequestTimeoutError,
	toCdpError,
} from './errors.ts';

Deno.test('cdp errors: every subclass descends from CdpError and carries its own name', () => {
	const errors = [
		new CdpError('base'),
		new CdpProtocolError({ code: -32000, message: 'boom', method: 'Page.navigate' }),
		new CdpRequestTimeoutError({ method: 'Page.navigate', timeoutMs: 60_000 }),
		new CdpFrameTooLargeError({ byteLength: 10, limitBytes: 5 }),
		new CdpConnectionClosedError({ intentional: true }),
	];
	for (const error of errors) {
		assertInstanceOf(error, CdpError);
		assertInstanceOf(error, Error);
	}
	assertEquals(errors.map((error) => error.name), [
		'CdpError',
		'CdpProtocolError',
		'CdpRequestTimeoutError',
		'CdpFrameTooLargeError',
		'CdpConnectionClosedError',
	]);
});

Deno.test('cdp errors: CdpProtocolError carries the CDP code, message, method and session', () => {
	const error = new CdpProtocolError({
		code: -32000,
		message: 'Cannot navigate to invalid URL',
		method: 'Page.navigate',
		sessionId: 'S1',
		requestId: 7,
		data: 'detail',
	});
	assertEquals(error.code, -32000);
	assertEquals(error.method, 'Page.navigate');
	assertEquals(error.sessionId, 'S1');
	assertEquals(error.requestId, 7);
	assertEquals(error.data, 'detail');
	assertStringIncludes(error.message, '-32000');
	assertStringIncludes(error.message, 'Cannot navigate to invalid URL');
	assertStringIncludes(error.message, 'detail');
});

Deno.test('cdp errors: CdpRequestTimeoutError names the method and the budget it blew', () => {
	const error = new CdpRequestTimeoutError({ method: 'DOMSnapshot.captureSnapshot', timeoutMs: 60_000 });
	assertEquals(error.timeoutMs, 60_000);
	assertStringIncludes(error.message, 'DOMSnapshot.captureSnapshot');
	assertStringIncludes(error.message, '60000ms');
});

Deno.test('cdp errors: CdpFrameTooLargeError reports the measurement and the budget', () => {
	const error = new CdpFrameTooLargeError({ byteLength: 300, limitBytes: 200, requestId: 3 });
	assertEquals(error.byteLength, 300);
	assertEquals(error.limitBytes, 200);
	assertEquals(error.requestId, 3);
	assertStringIncludes(error.message, '300 bytes');
	assertStringIncludes(error.message, '200 byte budget');
});

Deno.test('cdp errors: CdpConnectionClosedError discriminates intentional from dropped', () => {
	const intentional = new CdpConnectionClosedError({ intentional: true, code: 1000 });
	const dropped = new CdpConnectionClosedError({
		intentional: false,
		code: 1006,
		reason: 'abnormal',
		method: 'Page.navigate',
	});
	assert(intentional.intentional);
	assert(!dropped.intentional);
	assertStringIncludes(dropped.message, 'unexpectedly');
	assertStringIncludes(dropped.message, 'Page.navigate');
	assertStringIncludes(dropped.message, '1006');
});

Deno.test('cdp errors: toCdpError never lets a non-Error escape as a throw value', () => {
	const original = new CdpError('already typed');
	assertEquals(toCdpError(original, 'ignored'), original);

	const fromString = toCdpError('kaboom', 'aborted');
	assertInstanceOf(fromString, CdpError);
	assertEquals(fromString.message, 'aborted: kaboom');

	const fromObject = toCdpError({ weird: true }, 'aborted');
	assertInstanceOf(fromObject, CdpError);
	assertEquals(fromObject.message, 'aborted');
	assertEquals((fromObject as CdpError).cause, { weird: true });
});
