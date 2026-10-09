import { assertEquals, assertRejects } from '@std/assert';
import { SandboxClient, SandboxClientError } from './client.ts';
import { GateError } from './gate.ts';
import { createSandboxHandler } from './http.ts';
import { LIMITS } from './limits.ts';
import { ApiError } from './sandbox.ts';

const token = 'test-only-sandbox-service-token-0123456789';

Deno.test('sandbox HTTP: bearer gate precedes parsing; authenticated principal envelope is strict', async (): Promise<void> => {
	let called = false;
	const handler = await createSandboxHandler({
		health: () => Promise.resolve({ ok: true, backend: 'bwrap' as const, clone: false }),
		call: (principal, operation, args): Promise<Record<string, unknown>> => {
			called = true;
			return Promise.resolve({ principal, operation, args });
		},
	}, token);
	const noAuth = await handler(new Request('http://sandbox/v1/create', { method: 'POST', body: 'bad JSON' }));
	assertEquals(noAuth.status, 401);
	assertEquals(called, false);
	const health = await handler(new Request('http://sandbox/healthz'));
	assertEquals(health.status, 200);
	// D-108: unauthenticated, and saying only whether it is ready, which backend runs commands, and (R12) whether it
	// clones.
	assertEquals(await health.json(), { ok: true, backend: 'bwrap', clone: false });
	const client = new SandboxClient({
		url: 'http://sandbox',
		token,
		fetch: ((input, init): Promise<Response> => handler(new Request(input, init))) as typeof fetch,
	});
	assertEquals(client.backend, null);
	assertEquals(client.clone, null);
	assertEquals(await client.ready(), true);
	assertEquals(client.backend, 'bwrap');
	assertEquals(client.clone, false);
	assertEquals(await client.call('alice', 'write', { principal: 'bob' }), {
		principal: 'alice',
		operation: 'write',
		args: { principal: 'bob' },
	});
	const invalid = await handler(
		new Request('http://sandbox/v1/create', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ principal: 'alice', args: {}, extra: true }),
		}),
	);
	assertEquals(invalid.status, 400);
});

Deno.test('sandbox client: error text, redirect failures, and malformed responses are sanitized', async (): Promise<void> => {
	for (
		const [response, code] of [
			[new Response(JSON.stringify({ error: 'cage_failed', message: token }), { status: 503 }), 'cage_failed'],
			[new Response(JSON.stringify({ error: token }), { status: 500 }), 'unavailable'],
			[new Response('[]'), 'invalid_response'],
			[new Response('broken JSON'), 'invalid_response'],
		] as const
	) {
		const client = new SandboxClient({
			url: 'http://sandbox',
			token,
			fetch: (() => Promise.resolve(response)) as typeof fetch,
		});
		const error = await assertRejects(() => client.call('alice', 'create', {}), SandboxClientError);
		assertEquals(error.code, code);
		assertEquals(error.message.includes(token), false);
	}
	const failing = new SandboxClient({
		url: 'http://sandbox',
		token,
		fetch: (() => Promise.reject(new Error(token))) as typeof fetch,
	});
	assertEquals(await failing.ready(), false);
	const error = await assertRejects(() => failing.call('alice', 'create', {}), SandboxClientError);
	assertEquals(error.message.includes(token), false);
	const handler = await createSandboxHandler({
		health: () => Promise.resolve({ ok: false, backend: 'bwrap' as const, clone: false }),
		call: (): Promise<Record<string, unknown>> => Promise.reject(new ApiError(503, 'cage_failed', token)),
	}, token);
	const response = await handler(
		new Request('http://sandbox/v1/create', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: '{"principal":"alice","args":{}}',
		}),
	);
	assertEquals(await response.json(), { error: 'cage_failed' });
});

Deno.test('sandbox client: a credential-shaped lowercase error code is never propagated', async (): Promise<void> => {
	const lowerToken = 'a'.repeat(32);
	const client = new SandboxClient({
		url: 'http://sandbox',
		token: lowerToken,
		fetch: (() =>
			Promise.resolve(new Response(JSON.stringify({ error: lowerToken }), { status: 500 }))) as typeof fetch,
	});
	const error = await assertRejects(() => client.call('alice', 'create', {}), SandboxClientError);
	assertEquals(error.code, 'unavailable');
	assertEquals(error.message.includes(lowerToken), false);
});

Deno.test('SB-6 sandbox HTTP: a reply as long as the service ever sends is accepted; a longer one is never sent', async (): Promise<void> => {
	let reply: Record<string, unknown> = {};
	const handler = await createSandboxHandler({
		health: () => Promise.resolve({ ok: true, backend: 'bwrap' as const, clone: false }),
		call: (): Promise<Record<string, unknown>> => Promise.resolve(reply),
	}, token);
	const client = new SandboxClient({
		url: 'http://sandbox',
		token,
		fetch: ((input, init): Promise<Response> => handler(new Request(input, init))) as typeof fetch,
	});
	// Escaped control bytes: just under the service's limit as JSON, far longer than the text.
	const control = String.fromCharCode(1);
	reply = { patch: control.repeat(Math.floor((LIMITS.responseBytes - 64) / 6)) };
	assertEquals((await client.call('alice', 'diff', { workspace_id: 'x' })).patch, reply.patch);
	reply = { patch: control.repeat(Math.ceil(LIMITS.responseBytes / 6) + 1) };
	const error = await assertRejects(() => client.call('alice', 'diff', { workspace_id: 'x' }), SandboxClientError);
	assertEquals(error.code, 'too_large');
});

Deno.test('SB-10 sandbox HTTP: a request cancelled while it queued is reported as cancelled', async (): Promise<void> => {
	const handler = await createSandboxHandler({
		health: () => Promise.resolve({ ok: true, backend: 'bwrap' as const, clone: false }),
		call: (): Promise<Record<string, unknown>> =>
			Promise.reject(new GateError(499, 'cancelled', 'The request was cancelled.')),
	}, token);
	const response = await handler(
		new Request('http://sandbox/v1/exec', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: '{"principal":"alice","args":{}}',
		}),
	);
	assertEquals(response.status, 499);
	assertEquals(await response.json(), { error: 'cancelled' });
});

Deno.test('D-108 sandbox client: the backend comes from /healthz, and only a known name is kept', async (): Promise<void> => {
	for (
		const [reply, expected] of [
			[{ ok: true, backend: 'docker' }, 'docker'],
			[{ ok: false, backend: 'docker' }, 'docker'],
			[{ ok: true }, null],
			[{ ok: true, backend: 'podman' }, null],
			[{ ok: true, backend: token }, null],
		] as const
	) {
		const client = new SandboxClient({
			url: 'http://sandbox',
			token,
			fetch: (() =>
				Promise.resolve(new Response(JSON.stringify(reply), { status: reply.ok ? 200 : 503 }))) as typeof fetch,
		});
		assertEquals(await client.ready(), reply.ok);
		assertEquals(client.backend, expected);
	}
});

Deno.test('C15 sandbox client: a caged file operation that timed out or failed keeps its code', async (): Promise<void> => {
	for (const [code, status] of [['file_timeout', 504], ['file_failed', 500]] as const) {
		const client = new SandboxClient({
			url: 'http://sandbox',
			token,
			fetch: (() => Promise.resolve(new Response(JSON.stringify({ error: code }), { status }))) as typeof fetch,
		});
		const error = await assertRejects(() => client.call('alice', 'read', {}), SandboxClientError);
		assertEquals([error.code, error.status], [code, status]);
	}
});

Deno.test('R12 sandbox HTTP: clone is an operation behind the bearer gate, and /healthz says whether it is offered', async (): Promise<void> => {
	const seen: string[] = [];
	const handler = await createSandboxHandler({
		health: () => Promise.resolve({ ok: true, backend: 'docker' as const, clone: true }),
		call: (_principal, operation): Promise<Record<string, unknown>> => {
			seen.push(operation);
			return Promise.resolve({});
		},
	}, token);
	assertEquals(await (await handler(new Request('http://sandbox/healthz'))).json(), {
		ok: true,
		backend: 'docker',
		clone: true,
	});
	const anonymous = await handler(new Request('http://sandbox/v1/clone', { method: 'POST', body: '{}' }));
	assertEquals(anonymous.status, 401);
	const client = new SandboxClient({
		url: 'http://sandbox',
		token,
		fetch: ((input, init): Promise<Response> => handler(new Request(input, init))) as typeof fetch,
	});
	assertEquals(await client.ready(), true);
	assertEquals(client.clone, true);
	await client.call('alice', 'clone', { remote: 'app' });
	assertEquals(seen, ['clone']);
});

Deno.test('R12 sandbox client: clone comes from /healthz only as a boolean, and its failures keep their codes', async (): Promise<void> => {
	for (
		const [reply, expected] of [
			[{ ok: true, backend: 'bwrap', clone: true }, true],
			[{ ok: true, backend: 'bwrap', clone: false }, false],
			// A service from before R12 says nothing; so does one that answers something other than a boolean.
			[{ ok: true, backend: 'bwrap' }, null],
			[{ ok: true, backend: 'bwrap', clone: 'yes' }, null],
		] as const
	) {
		const client = new SandboxClient({
			url: 'http://sandbox',
			token,
			fetch: (() => Promise.resolve(new Response(JSON.stringify(reply)))) as typeof fetch,
		});
		await client.ready();
		assertEquals(client.clone, expected, JSON.stringify(reply));
	}
	for (const [code, status] of [['clone_failed', 502], ['clone_timeout', 504]] as const) {
		const client = new SandboxClient({
			url: 'http://sandbox',
			token,
			fetch: (() => Promise.resolve(new Response(JSON.stringify({ error: code }), { status }))) as typeof fetch,
		});
		const error = await assertRejects(() => client.call('alice', 'clone', { remote: 'app' }), SandboxClientError);
		assertEquals([error.code, error.status], [code, status]);
	}
});
