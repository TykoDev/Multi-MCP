/**
 * R4 (D-116): the request log — redaction at mint, the header-block and memory bounds, redirect hops, paging, and
 * the URL cutting a reader without `network:read` gets (F3). Driven through a stand-in CDP client whose `on`
 * registry is real enough to deliver typed events and to prove detachment.
 */
import { assert, assertEquals } from '@std/assert';
import type { CdpClient } from '@tykotech/cdp';
import {
	boundHeaders,
	cutHeaderValue,
	cutUrl,
	isSensitiveHeader,
	loggedPath,
	MAX_HEADER_BLOCK_BYTES,
	MAX_LOGGED_URL_CHARS,
	NETWORK_LOG_MAX_BYTES,
	NETWORK_LOG_MAX_ENTRIES,
	NetworkLog,
	projectHeaders,
	REDACTED_HEADER,
	utf8Length,
} from './network_log.ts';

type Listener = (params: unknown, sessionId?: string) => void;

/** The `on` half of a CDP client: listeners by event name, an `emit`, and a count of what is still attached. */
function fakeCdp(): CdpClient & {
	emit(event: string, params: unknown, sessionId?: string): void;
	listeners(): number;
} {
	const listeners = new Map<string, Set<Listener>>();
	const client = {
		on(event: string, listener: Listener) {
			const set = listeners.get(event) ?? new Set<Listener>();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
		emit(event: string, params: unknown, sessionId?: string) {
			for (const listener of listeners.get(event) ?? []) listener(params, sessionId);
		},
		listeners() {
			return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
		},
	};
	return client as unknown as CdpClient & {
		emit(event: string, params: unknown, sessionId?: string): void;
		listeners(): number;
	};
}

/** One complete request: sent, answered, finished. */
function request(
	cdp: ReturnType<typeof fakeCdp>,
	id: string,
	url: string,
	options: {
		readonly requestHeaders?: Record<string, string>;
		readonly responseHeaders?: Record<string, string>;
		readonly status?: number;
		readonly type?: string;
		readonly postData?: string;
		readonly sessionId?: string;
	} = {},
): void {
	cdp.emit('Network.requestWillBeSent', {
		requestId: id,
		loaderId: 'L',
		documentURL: url,
		request: {
			url,
			method: options.postData === undefined ? 'GET' : 'POST',
			headers: options.requestHeaders ?? {},
			...(options.postData === undefined ? {} : { postData: options.postData, hasPostData: true }),
		},
		timestamp: 100,
		wallTime: 1_767_225_600,
		initiator: {},
		type: options.type ?? 'Document',
		frameId: 'FRAME',
	}, options.sessionId ?? 'S1');
	cdp.emit('Network.responseReceived', {
		requestId: id,
		loaderId: 'L',
		timestamp: 100.01,
		type: options.type ?? 'Document',
		response: {
			url,
			status: options.status ?? 200,
			statusText: 'OK',
			headers: options.responseHeaders ?? { 'content-type': 'text/html' },
			mimeType: 'text/html',
			connectionReused: false,
			connectionId: 1,
			encodedDataLength: 120,
		},
	});
	cdp.emit('Network.dataReceived', { requestId: id, timestamp: 100.02, dataLength: 42, encodedDataLength: 40 });
	cdp.emit('Network.loadingFinished', { requestId: id, timestamp: 100.05, encodedDataLength: 160 });
}

Deno.test('network log: the design’s bounds, verbatim', () => {
	assertEquals(NETWORK_LOG_MAX_ENTRIES, 500);
	assertEquals(NETWORK_LOG_MAX_BYTES, 524_288);
	assertEquals(MAX_HEADER_BLOCK_BYTES, 8 * 1024);
});

Deno.test('network log (AC4): credentials are [redacted] at mint, by header name', () => {
	for (const name of ['Authorization', 'proxy-authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'X-CSRF-Token']) {
		assert(isSensitiveHeader(name), name);
	}
	for (const name of ['x-session-id', 'X-XSRF-TOKEN', 'x-secret', 'X-Auth-User', 'Cookie2']) {
		assert(isSensitiveHeader(name), name);
	}
	for (const name of ['content-type', 'accept', 'referer', 'location', 'user-agent']) {
		assert(!isSensitiveHeader(name), name);
	}

	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'R1', 'https://app.example/login', {
		requestHeaders: { Authorization: 'Bearer Zq8-BEARER', 'X-Api-Key': 'Zq8-KEY', accept: 'text/html' },
		responseHeaders: { 'Set-Cookie': 'sid=Zq8-SID', 'content-type': 'text/html' },
		postData: 'password=Zq8-POST-BODY',
	});
	const [entry] = log.snapshot();
	assert(entry !== undefined);
	assertEquals(entry.request_headers, {
		Authorization: REDACTED_HEADER,
		'X-Api-Key': REDACTED_HEADER,
		accept: 'text/html',
	});
	assertEquals(entry.response_headers['Set-Cookie'], REDACTED_HEADER);
	const everything = JSON.stringify(log.snapshot());
	for (const secret of ['Zq8-BEARER', 'Zq8-KEY', 'Zq8-SID', 'Zq8-POST-BODY']) {
		assert(!everything.includes(secret), `${secret} reached the log`);
	}
	assertEquals(entry.method, 'POST');
});

Deno.test('network log: one entry carries origin, path, has_query, status, MIME type, size, timing and its CDP session', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'R1', 'https://app.example/a/b?token=Zq8', { sessionId: 'S-PAGE' });
	const entry = log.get('R1');
	assert(entry !== undefined);
	assertEquals(entry.seq, 1);
	assertEquals(entry.origin, 'https://app.example');
	assertEquals(entry.path, '/a/b');
	assertEquals(entry.has_query, true);
	assertEquals(entry.url_full, 'https://app.example/a/b?token=Zq8');
	assertEquals(entry.status, 200);
	assertEquals(entry.mime_type, 'text/html');
	assertEquals(entry.bytes, 42, 'decoded chunks, when the browser reported them');
	assertEquals(entry.duration_ms, 50);
	assertEquals(entry.started_at, '2026-01-01T00:00:00.000Z');
	assertEquals(entry.frame_id, 'FRAME');
	assertEquals(log.sessionOf('R1'), 'S-PAGE');
});

Deno.test('network log: a redirect chain is one entry per hop, the first finished with its 3xx', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	cdp.emit('Network.requestWillBeSent', {
		requestId: 'R',
		request: { url: 'https://a.example/start', method: 'GET', headers: {} },
		timestamp: 1,
		wallTime: 0,
		type: 'Document',
	});
	cdp.emit('Network.requestWillBeSent', {
		requestId: 'R',
		request: { url: 'https://b.example/landing?code=Zq8', method: 'GET', headers: {} },
		timestamp: 1.2,
		wallTime: 0,
		type: 'Document',
		redirectResponse: {
			url: 'https://a.example/start',
			status: 302,
			headers: { location: 'https://b.example/landing?code=Zq8' },
			mimeType: '',
			encodedDataLength: 0,
		},
	});
	cdp.emit('Network.loadingFailed', {
		requestId: 'R',
		timestamp: 1.3,
		type: 'Document',
		errorText: 'net::ERR_ABORTED',
	});
	const [first, second] = log.snapshot();
	assertEquals(first?.status, 302);
	assertEquals(first?.duration_ms, 200);
	assertEquals(first?.response_headers.location, 'https://b.example/landing?code=Zq8');
	assertEquals(second?.origin, 'https://b.example');
	assertEquals(second?.failed, true);
	assertEquals(second?.error_text, 'net::ERR_ABORTED');
	assertEquals(log.get('R')?.seq, 2, 'the id names the newest hop');
});

Deno.test('network log (AC5): 600 requests stay within 500 entries and 512 KiB, and dropped counts the rest', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	for (let index = 0; index < 600; index++) {
		request(cdp, `R${index}`, `https://app.example/item/${index}?q=${'x'.repeat(200)}`, {
			requestHeaders: { accept: 'text/html', 'user-agent': 'u'.repeat(300) },
		});
	}
	assert(log.size <= 500, `${log.size} entries`);
	assert(log.bytes <= 524_288, `${log.bytes} bytes`);
	const serialized = utf8Length(JSON.stringify(log.snapshot()));
	assert(serialized <= 524_288 + log.size, `the accounting under-counts: ${serialized}`);
	assert(log.dropped > 0);
	assertEquals(log.dropped + log.size, 600);
	const page = log.read({ limit: 10 });
	assertEquals(page.dropped, log.dropped, 'a reader from the start is told what it missed');
	assertEquals(page.entries[0]?.seq, log.dropped + 1);
});

Deno.test('network log: a big page of bytes is bounded by bytes before it is bounded by count', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog({ maxBytes: 20_000 });
	log.attach(cdp);
	for (let index = 0; index < 100; index++) {
		request(cdp, `R${index}`, `https://app.example/${'p'.repeat(800)}/${index}`);
	}
	assert(log.bytes <= 20_000);
	assert(log.size < 100);
	assert(log.dropped > 0);
});

Deno.test('network log: one entry’s header block is bounded, and truncation is said', () => {
	const huge: Record<string, string> = {};
	for (let index = 0; index < 40; index++) huge[`x-header-${index}`] = 'v'.repeat(400);
	const bounded = boundHeaders(huge, MAX_HEADER_BLOCK_BYTES);
	assert(bounded.used <= MAX_HEADER_BLOCK_BYTES);
	assertEquals(bounded.truncated, true);

	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'R1', 'https://app.example/', { requestHeaders: huge, responseHeaders: huge });
	const entry = log.get('R1');
	assert(entry !== undefined);
	assertEquals(entry.headers_truncated, true);
	const block = utf8Length(Object.entries({ ...entry.request_headers, ...entry.response_headers }).flat().join(''));
	assert(block <= MAX_HEADER_BLOCK_BYTES, `${block}`);
});

Deno.test('network log: a data: URL is capped in path and url_full', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'D', `data:text/html,${'a'.repeat(100_000)}`);
	const entry = log.get('D');
	assert(entry !== undefined);
	assert(entry.path.length <= 1024);
	assert(entry.url_full.length <= 4096);
});

Deno.test('network log: read pages by seq and filters by type and failure without re-scanning', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'A', 'https://app.example/a', { type: 'Document' });
	request(cdp, 'B', 'https://app.example/b.js', { type: 'Script' });
	request(cdp, 'C', 'https://app.example/c', { type: 'XHR' });
	cdp.emit('Network.loadingFailed', { requestId: 'C', timestamp: 101, type: 'XHR', errorText: 'net::ERR_FAILED' });
	const first = log.read({ limit: 2 });
	assertEquals(first.entries.map((entry) => entry.request_id), ['A', 'B']);
	assertEquals(first.nextSince, 2);
	const rest = log.read({ since: first.nextSince, limit: 2 });
	assertEquals(rest.entries.map((entry) => entry.request_id), ['C']);
	assertEquals(rest.nextSince, 3);
	assertEquals(log.read({ limit: 10, resourceTypes: ['script'] }).entries.map((entry) => entry.request_id), ['B']);
	const failed = log.read({ limit: 10, failedOnly: true });
	assertEquals(failed.entries.map((entry) => entry.request_id), ['C']);
	assertEquals(failed.nextSince, 3, 'the filtered-out entries are behind the cursor, not ahead of it');
});

Deno.test('network log: close detaches every listener and drops every entry', () => {
	const cdp = fakeCdp();
	const log = new NetworkLog();
	const off = log.attach(cdp);
	assertEquals(cdp.listeners(), 6);
	off();
	assertEquals(cdp.listeners(), 0);
	log.attach(cdp);
	request(cdp, 'R', 'https://app.example/');
	log.close();
	assertEquals(cdp.listeners(), 0);
	assertEquals(log.size, 0);
	request(cdp, 'R2', 'https://app.example/');
	assertEquals(log.size, 0, 'a closed log mints nothing');
});

Deno.test('network log (F3): URLs inside header values are cut to origin and path for a reader without the scope', () => {
	assertEquals(cutUrl('https://idp.example/cb?code=Zq8#frag'), 'https://idp.example/cb');
	assertEquals(cutUrl('/relative/path?token=Zq8'), '/relative/path');
	assertEquals(cutHeaderValue('Referer', 'https://app.example/page?session=Zq8'), 'https://app.example/page');
	assertEquals(cutHeaderValue('location', '/cb?code=Zq8'), '/cb');
	assertEquals(cutHeaderValue('Content-Location', 'https://a.example/x?y=Zq8'), 'https://a.example/x');
	assertEquals(
		cutHeaderValue('link', '<https://cdn.example/a.css?v=Zq8>; rel=preload, </b.js?t=Zq8>; rel=preload'),
		'<https://cdn.example/a.css>; rel=preload, </b.js>; rel=preload',
	);
	assertEquals(cutHeaderValue('Refresh', "0; url='/next?s=Zq8'"), "0; url='/next'");
	assertEquals(cutHeaderValue('refresh', '5; URL=https://x.example/n?s=Zq8'), '5; URL=https://x.example/n');
	// Any header: an absolute URL anywhere in a value is cut.
	assertEquals(
		cutHeaderValue('x-trace', 'from https://svc.example/api?key=Zq8 at 12:00'),
		'from https://svc.example/api at 12:00',
	);
	assertEquals(cutHeaderValue('authorization', REDACTED_HEADER), REDACTED_HEADER);

	const projected = projectHeaders(
		{ referer: 'https://app.example/p?q=Zq8', accept: 'text/html' },
		false,
		(text) => text.replaceAll('text', '[secret]'),
	);
	assertEquals(projected, { referer: 'https://app.example/p', accept: '[secret]/html' });
	assertEquals(
		projectHeaders({ referer: 'https://app.example/p?q=Zq8' }, true, (text) => text).referer,
		'https://app.example/p?q=Zq8',
	);
});

// ---------------------------------------------------------------------------
// Review R2-3 / R2-7
// ---------------------------------------------------------------------------

Deno.test('R2-3: the credential-shaped header names the reviewer listed are redacted at mint', () => {
	// tests/.scratch/r2_unit_probe.ts R2-U2's list (17 of these 24 were kept before), minus the two the ruling's
	// parts do not name (`X-MFA-Code`, `X-Forwarded-User`: a residual, stated).
	const names = [
		'Authorization',
		'X-Api-Key',
		'X-Access-Token',
		'X-CSRF-Token',
		'Cookie',
		'Set-Cookie',
		'X-Password',
		'Password',
		'X-Pass',
		'X-Credential',
		'X-Amz-Credential',
		'X-Signature',
		'X-Hub-Signature-256',
		'X-JWT-Assertion',
		'Bearer',
		'DPoP',
		'X-OTP',
		'Sec-WebSocket-Protocol',
		'X-Goog-IAP-JWT-Assertion',
		'X-Ms-Client-Principal',
		'X-Vault-Token',
		'X-Upstream-Pwd',
	];
	assertEquals(names.filter((name) => !isSensitiveHeader(name)), []);
	for (const name of ['content-type', 'accept', 'referer', 'location', 'user-agent', 'cache-control', 'etag']) {
		assert(!isSensitiveHeader(name), name);
	}
});

Deno.test('R2-3: without the scope every ?query / #fragment reference in every header value is cut', () => {
	const projected = projectHeaders(
		{
			'Reporting-Endpoints': 'default="/r?token=Zq8-T1", other="https://rep.example/o?k=Zq8-T2"',
			'X-Redirect': '/cb?code=Zq8-C2',
			'Content-Security-Policy': "default-src 'self'; report-uri /csp?sig=Zq8-S3; script-src 'self'",
			'Location': '/cb?code=Zq8-C4',
			'Referer': 'https://a.example/p?q=Zq8-Q5#frag',
			'X-Odd': 'see /x?a=1;token=Zq8-T6 and #anchor-Zq8-F7',
		},
		false,
		(text) => text,
	);
	assert(!JSON.stringify(projected).includes('Zq8'), JSON.stringify(projected));
	assertEquals(projected['Reporting-Endpoints'], 'default="/r", other="https://rep.example/o"');
	assertEquals(projected['Content-Security-Policy'], "default-src 'self'; report-uri /csp script-src 'self'");
	assertEquals(projected['X-Redirect'], '/cb');
	// With the scope, values are as minted.
	assertEquals(
		projectHeaders({ 'X-Redirect': '/cb?code=Zq8-C2' }, true, (text) => text)['X-Redirect'],
		'/cb?code=Zq8-C2',
	);
});

Deno.test('R2-3: path carries no matrix parameters, and a data: URL only its media type', () => {
	assertEquals(loggedPath('https://shop.example/app/cart;jsessionid=Zq8-SESS6?x=1'), '/app/cart');
	assertEquals(loggedPath('https://shop.example/a;v=1/b;jsessionid=Zq8/c'), '/a/b/c');
	assertEquals(loggedPath('data:text/plain,totp-secret-Zq8-JBSWY3DPEHPK3PXP'), 'text/plain');
	assertEquals(loggedPath('data:IMAGE/PNG;base64,iVBORw0KGgo='), 'image/png');
	assertEquals(loggedPath('data:,Zq8-plain'), '');
	assertEquals(loggedPath('not a url'), '');
	assertEquals(cutUrl('https://shop.example/app;jsessionid=Zq8?x=1'), 'https://shop.example/app');
	assertEquals(cutUrl('data:text/html;base64,Zq8Zq8'), 'data:text/html');

	const cdp = fakeCdp();
	const log = new NetworkLog();
	log.attach(cdp);
	request(cdp, 'M', 'https://shop.example/app/cart;jsessionid=Zq8-SESS6?x=1');
	request(cdp, 'D', 'data:text/plain,totp-secret-Zq8-JBSWY3DPEHPK3PXP');
	assertEquals(log.get('M')?.path, '/app/cart');
	assertEquals(log.get('D')?.path, 'text/plain');
	assertEquals(log.get('D')?.origin, 'data:');
});

Deno.test('R2-7: a configured secret straddling the URL cap is redacted before the cut, never halved', () => {
	const secret = 'Zq8-STRADDLING-SECRET-VALUE';
	const prefix = 'https://app.example/?q=';
	// The secret starts 6 characters before the cap, so a cut-then-redact keeps `Zq8-ST`.
	const url = `${prefix}${'a'.repeat(MAX_LOGGED_URL_CHARS - 6 - prefix.length)}${secret}`;
	const cdp = fakeCdp();
	const log = new NetworkLog({ redact: (text) => text.replaceAll(secret, '[secret]') });
	log.attach(cdp);
	request(cdp, 'S', url);
	const entry = log.get('S');
	assert(entry !== undefined);
	assert(entry.url_full.length <= MAX_LOGGED_URL_CHARS);
	assert(!entry.url_full.includes(secret.slice(0, 6)), entry.url_full.slice(-12));
	// The path is redacted before its own cap as well.
	request(cdp, 'P', `https://app.example/${'p'.repeat(1024 - 5)}${secret}`);
	assert(!(log.get('P')?.path ?? '').includes(secret.slice(0, 4)));
});
