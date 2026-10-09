/// <reference lib="deno.ns" />
/**
 * The SPA's HTTP client: what `send()` puts on the wire (R1-6) and what a sign-out may claim (R1-3).
 *
 * `fetch` is replaced for each test and restored after it; nothing here reaches a network. The package's `lib` is
 * browser-only, so this file opts back into the runtime types it needs, as `web_test.ts` does.
 */
import { assert, assertEquals, assertInstanceOf } from '@std/assert';

type Call = { path: string; init: RequestInit };

/** Replaces `fetch` for the length of `run`, answering every call with `answer`. */
async function withFetch(
	answer: (call: Call) => Promise<Response>,
	run: (calls: Call[]) => Promise<void>,
): Promise<void> {
	const calls: Call[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
		const call = { path: String(input), init };
		calls.push(call);
		return answer(call);
	}) as typeof fetch;
	try {
		await run(calls);
	} finally {
		globalThis.fetch = realFetch;
	}
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

Deno.test("R1-6: send() keeps a caller's content type; only an untyped body is sent as JSON", async () => {
	await withFetch(() => Promise.resolve(json(201, { name: 'b.bin' })), async (calls) => {
		const { api, send } = await import('./api.ts');
		const file = new Blob([new Uint8Array([0, 1, 2, 0xff])]);
		await api.shareUpload('a/b.bin', file);
		await send('/api/v1/share/mkdir', { method: 'POST', body: '{}' });
		await send('/x', { method: 'PUT', body: 'text', headers: { 'Content-Type': 'text/plain' } });
		await send('/y', {
			method: 'POST',
			body: '{}',
			headers: new Headers({ 'content-type': 'application/merge-patch+json' }),
		});
		const types = calls.map(({ init }) => new Headers(init.headers).get('content-type'));
		assertEquals(types, ['application/octet-stream', 'application/json', 'text/plain', 'application/merge-patch+json']);
		assertInstanceOf(calls[0]?.init.body, Blob, 'the upload is sent as the file, not re-encoded');
		// A body-less request still carries no content type at all.
		await send('/z');
		assertEquals(new Headers(calls[4]?.init.headers).get('content-type'), null);
	});
});

Deno.test('R1-3: a sign-out is reported only when the server confirmed it', async () => {
	let reply: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 204 }));
	await withFetch(
		(call) => call.path === '/api/v1/auth/logout' ? reply() : Promise.resolve(json(200, {})),
		async () => {
			const { endSession, isSignedIn, setSession } = await import('./api.ts');

			// Refused by the rate limiter: still signed in, and the wait the server asked for is passed on.
			setSession({ csrf: 'csrf-one' });
			reply = () =>
				Promise.resolve(
					json(429, { type: 'https://tykotech.eu/problems/rate-limited', detail: 'too many requests' }, {
						'retry-after': '7',
					}),
				);
			const limited = await endSession();
			assert(limited.kind === 'failed');
			assertEquals(limited.retryAfterMs, 7000);
			assertEquals(limited.message, 'too many requests');
			assertEquals(isSignedIn(), true, 'nothing claims a sign-out the server did not make');

			// The network failed, or the server could not end the session: the same.
			reply = () => Promise.reject(new TypeError('Failed to fetch'));
			const offline = await endSession();
			assert(offline.kind === 'failed');
			assertEquals(offline.retryAfterMs, null);
			assertEquals(isSignedIn(), true);
			reply = () => Promise.resolve(json(500, { type: 'https://tykotech.eu/problems/internal', detail: 'store down' }));
			assertEquals((await endSession()).kind, 'failed');
			assertEquals(isSignedIn(), true);

			// The server confirmed it.
			reply = () => Promise.resolve(new Response(null, { status: 204 }));
			assertEquals(await endSession(), { kind: 'signed-out' });
			assertEquals(isSignedIn(), false);

			// The server no longer honours the sign-in at all (and cleared the cookie with its 401): signed out too.
			setSession({ csrf: 'csrf-two' });
			reply = () => Promise.resolve(json(401, { type: 'https://tykotech.eu/problems/unauthenticated' }));
			assertEquals(await endSession(), { kind: 'signed-out' });
			assertEquals(isSignedIn(), false);
		},
	);
});

Deno.test('R1-3: the shell signs out only on a confirmed outcome and keeps a failed one retrying', async () => {
	const shell = await Deno.readTextFile(new URL('./shell.ts', import.meta.url));
	assert(!/logout\(\)[\s\S]{0,40}\.finally\(/.test(shell), 'no sign-out that clears the page whatever the server said');
	assert(/endSession\(\)/.test(shell), 'the shell asks endSession() what happened');
	assert(/beforeunload/.test(shell), 'an unconfirmed sign-out holds a reload or close until the user has seen it');
});
