/**
 * GW-3: the A2UI and agent-task event streams re-earn their authorization on the gateway's own horizon and end at a
 * hard lifetime, as the session event stream already did (`eventstream.ts`).
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { Hono } from 'hono';
import { AgentRuntime } from '@tykotech/agents';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { A2uiStore, attachA2uiRoutes, StreamGuard } from './a2ui.ts';
import type { AppVariables } from './app.ts';
import type { Principal } from './auth.ts';
import { EVENT_STREAM_LIFETIME_MS, EVENT_STREAM_REVALIDATE_MS } from './eventstream.ts';
import { attachExpansionRoutes, type ExpansionServices } from './expansion.ts';

const encoder = new TextEncoder();

/** An endless source that records whether the guard released it. */
function source(): { stream: ReadableStream<Uint8Array>; canceled: () => boolean; push(text: string): void } {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let canceled = false;
	return {
		stream: new ReadableStream<Uint8Array>({
			start: (value) => {
				controller = value;
			},
			cancel: () => {
				canceled = true;
			},
		}),
		canceled: () => canceled,
		push: (text) => controller?.enqueue(encoder.encode(text)),
	};
}

async function readAll(stream: ReadableStream<Uint8Array>, ms = 2_000): Promise<{ text: string; ended: boolean }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + ms;
	let text = '';
	try {
		while (Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const next = await Promise.race([
				reader.read(),
				new Promise<'timeout'>((resolve) => timer = setTimeout(() => resolve('timeout'), deadline - Date.now())),
			]);
			clearTimeout(timer);
			if (next === 'timeout') break;
			if (next.done) return { text, ended: true };
			text += decoder.decode(next.value, { stream: true });
		}
		return { text, ended: false };
	} finally {
		await reader.cancel().catch(() => {});
	}
}

Deno.test('GW-3: the guard defaults to the session event stream’s horizons', () => {
	const guard = new StreamGuard();
	assertEquals(guard.revalidateMs, EVENT_STREAM_REVALIDATE_MS);
	assertEquals(guard.lifetimeMs, EVENT_STREAM_LIFETIME_MS);
});

Deno.test('GW-3: a stream whose principal stops being authorized ends with bye at the next re-check', async () => {
	const guard = new StreamGuard({ revalidateMs: 10 });
	const inner = source();
	let authorized = true;
	const outer = guard.wrap(inner.stream, () => authorized);
	inner.push('event: surfaces\ndata: {}\n\n');
	const reader = outer.getReader();
	assertStringIncludes(new TextDecoder().decode((await reader.read()).value), 'surfaces');
	reader.releaseLock();
	authorized = false;
	const { text, ended } = await readAll(outer);
	assert(ended);
	assertStringIncludes(text, 'event: bye');
	assertStringIncludes(text, 'stream-expired');
	assert(inner.canceled(), 'the subscription behind the stream is released');
	assertEquals(guard.size, 0);
});

Deno.test('GW-3: a stream ends at its lifetime even while its principal stays authorized', async () => {
	const guard = new StreamGuard({ lifetimeMs: 20 });
	const inner = source();
	const { text, ended } = await readAll(guard.wrap(inner.stream, () => true));
	assert(ended);
	assertStringIncludes(text, 'event: bye');
	assert(inner.canceled());
});

Deno.test('GW-3: revalidateAll closes only the streams that fail now; closeAll ends the rest', async () => {
	const guard = new StreamGuard();
	const revoked = source();
	const kept = source();
	const first = guard.wrap(revoked.stream, () => false);
	const second = guard.wrap(kept.stream, () => true);
	assertEquals(guard.size, 2);
	guard.revalidateAll();
	assertEquals(guard.size, 1);
	assert((await readAll(first)).ended);
	assertEquals(kept.canceled(), false);
	guard.closeAll();
	assert((await readAll(second)).ended);
	assert(kept.canceled());
	assertEquals(guard.size, 0);
});

Deno.test('GW-3: a consumer that disconnects releases its timers and its subscription', async () => {
	const guard = new StreamGuard();
	const inner = source();
	const reader = guard.wrap(inner.stream, () => true).getReader();
	await reader.cancel();
	assert(inner.canceled());
	assertEquals(guard.size, 0);
});

function principalApp(principal: Principal): Hono<{ Variables: AppVariables }> {
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (ctx, next) => {
		ctx.set('requestId', 'gw-3');
		ctx.set('principal', principal);
		await next();
	});
	return app;
}

const viewer: Principal = { kind: 'oauth', id: 'subject', scopes: new Set(['agent:invoke']) };

Deno.test('GW-3: GET /api/v1/a2ui/events re-checks its principal and closes when authority lapses', async () => {
	const store = new A2uiStore();
	const streams = new StreamGuard({ revalidateMs: 10 });
	let authorized = true;
	const app = principalApp(viewer);
	attachA2uiRoutes(app, store, undefined, { streams, authorized: () => authorized });
	try {
		const response = await app.request('/api/v1/a2ui/events');
		assertEquals(response.status, 200);
		authorized = false;
		const { text, ended } = await readAll(response.body!);
		assert(ended, 'an OAuth (or revoked) principal’s stream does not run forever');
		assertStringIncludes(text, 'event: bye');
	} finally {
		streams.closeAll();
		store.close();
	}
});

Deno.test('GW-3: GET /api/v1/agent/tasks/:id/events re-checks its principal and closes when authority lapses', async () => {
	const runtime = new AgentRuntime({
		invoke: (_tool, _args, _owner, _scopes, signal): Promise<Record<string, unknown>> =>
			new Promise((resolve) => signal?.addEventListener('abort', () => resolve({}), { once: true })),
	});
	const streams = new StreamGuard({ revalidateMs: 10 });
	const services: ExpansionServices = {
		runtime,
		surfaces: new A2uiStore(),
		tools: [],
		streams,
		publish: () => ({}),
		// D-143 (S0): the members a hand-built services object needs beyond what these streams exercise.
		taskableTools: () => [],
		actionNames: ['cancelTask', 'permissionDecision'],
		acp: false,
		modelProviders: { default: null, providers: [] },
		close: async (): Promise<void> => {},
	};
	let authorized = true;
	const app = principalApp(viewer);
	attachExpansionRoutes(app, services, 'http://127.0.0.1:8787', () => authorized);
	try {
		const task = runtime.submit('oauth:subject', new Set(['agent:invoke', 'mcp:invoke']), {
			messageId: 'gw-3',
			role: 'ROLE_USER',
			parts: [{ data: { tool: 'browser_list_sessions', arguments: {} } }],
		});
		const response = await app.request(`/api/v1/agent/tasks/${task.id}/events`);
		assertEquals(response.status, 200);
		authorized = false;
		const { text, ended } = await readAll(response.body!);
		assert(ended);
		assertStringIncludes(text, 'event: bye');
	} finally {
		streams.closeAll();
		services.surfaces.close();
		await runtime.close();
	}
});

Deno.test('GW-3: the A2UI route still serves a live principal its snapshot', async () => {
	const store = new A2uiStore();
	store.publish('oauth:subject', { version: 'v0.9', createSurface: { surfaceId: 'live', catalogId: A2UI_CATALOG_ID } });
	const streams = new StreamGuard();
	const app = principalApp(viewer);
	attachA2uiRoutes(app, store, undefined, { streams, authorized: () => true });
	try {
		const response = await app.request('/api/v1/a2ui/events');
		const reader = response.body!.getReader();
		assertStringIncludes(new TextDecoder().decode((await reader.read()).value), 'live');
		await reader.cancel();
		assertEquals(streams.size, 0);
	} finally {
		store.close();
	}
});
