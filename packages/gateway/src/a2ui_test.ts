import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { Hono } from 'hono';
import { A2UI_CATALOG_ID, type A2uiSurface } from '@tykotech/wire';
import { A2uiStore, attachA2uiRoutes } from './a2ui.ts';
import { HttpProblem } from './problem.ts';
import type { AppVariables } from './app.ts';

const scopes = new Set(['agent:invoke']);
function create(store: A2uiStore, id = 'surface', owner = 'alice'): void {
	store.publish(owner, { version: 'v0.9', createSurface: { surfaceId: id, catalogId: A2UI_CATALOG_ID } });
}
function buttons(store: A2uiStore): A2uiSurface {
	return (store.publish('alice', {
		version: 'v0.9',
		updateComponents: {
			surfaceId: 'surface',
			components: [
				{ id: 'root', component: 'Column', children: ['cancel'] },
				{
					id: 'cancel',
					component: 'Button',
					text: 'Cancel',
					action: { event: { name: 'cancelTask', context: { taskId: 'task' } } },
				},
			],
		},
	}).surface) as A2uiSurface;
}
function action(revision: number, context: Record<string, unknown> = { taskId: 'task' }): unknown {
	return {
		version: 'v0.9',
		action: {
			surfaceId: 'surface',
			sourceComponentId: 'cancel',
			name: 'cancelTask',
			timestamp: new Date().toISOString(),
			context,
		},
		metadata: { revision },
	};
}

Deno.test('A2UI owner isolation, limits and defensive snapshots', () => {
	const store = new A2uiStore();
	create(store);
	assertEquals(store.list('bob'), { surfaces: [] });
	assertThrows(() => store.delete('bob', 'surface'), HttpProblem);
	create(store, 'surface', 'bob');
	assertEquals((store.list('bob').surfaces as A2uiSurface[])[0]?.surfaceId, 'surface');
	store.delete('bob', 'surface');
	assertEquals((store.list('alice').surfaces as A2uiSurface[]).length, 1);
	const snapshot = buttons(store);
	snapshot.components.length = 0;
	assertEquals((store.list('alice').surfaces as A2uiSurface[])[0]?.components.length, 2);
	for (let n = 1; n < 32; n++) create(store, `surface${n}`);
	assertThrows(() => create(store, 'overflow'), HttpProblem);
	store.close();
});

Deno.test('A2UI invalid adjacency and unsafe payloads leave prior state untouched', () => {
	const store = new A2uiStore();
	create(store);
	buttons(store);
	const before = store.list('alice');
	for (
		const components of [
			[{ id: 'root', component: 'Column', children: ['root'] }],
			[{ id: 'other', component: 'Row', children: ['other'] }],
			[{ id: 'root', component: 'Text', text: 'a' }, { id: 'root', component: 'Text', text: 'b' }],
			[{ id: 'root', component: 'Image', url: 'https://example.com' }],
		]
	) {
		assertThrows(() =>
			store.publish('alice', { version: 'v0.9', updateComponents: { surfaceId: 'surface', components } })
		);
	}
	assertThrows(() =>
		store.publish(
			'alice',
			JSON.parse('{"version":"v0.9","updateDataModel":{"surfaceId":"surface","value":{"__proto__":{}}}}'),
		)
	);
	assertThrows(() =>
		store.publish('alice', {
			version: 'v0.9',
			updateDataModel: { surfaceId: 'surface', path: '/constructor/polluted', value: true },
		})
	);
	assertEquals(store.list('alice'), before);
	store.close();
});

Deno.test('A2UI aliases are independent across authentication realms and delimiters', () => {
	const store = new A2uiStore();
	create(store, 'shared', 'api-key:same-id');
	create(store, 'shared', 'oauth:same-id');
	store.publish('api-key:same-id', {
		version: 'v0.9',
		updateDataModel: { surfaceId: 'shared', value: { secret: 'owned' } },
	});
	assertEquals((store.list('oauth:same-id').surfaces as A2uiSurface[])[0]?.dataModel, {});
	store.delete('oauth:same-id', 'shared');
	assertEquals((store.list('api-key:same-id').surfaces as A2uiSurface[]).length, 1);
	assertThrows(() => store.delete('oauth:same-id', 'shared'), HttpProblem);
	store.close();
});

Deno.test('A2UI stale, forged, unsolicited and replayed actions never dispatch', async () => {
	let calls = 0;
	const store = new A2uiStore({
		cancelTask: (_principal, _scopes, taskId) => {
			calls++;
			return Promise.resolve({ canceled: taskId });
		},
	});
	create(store);
	const snapshot = buttons(store);
	await assertRejects(() => store.action('alice', scopes, action(snapshot.revision)), HttpProblem);
	store.registerAction('alice', 'surface', 'cancel', 'cancelTask', { kind: 'cancelTask', taskId: 'task' });
	await assertRejects(() => store.action('bob', scopes, action(snapshot.revision)), HttpProblem);
	await assertRejects(() => store.action('alice', new Set(), action(snapshot.revision)), HttpProblem);
	await assertRejects(() => store.action('alice', scopes, action(snapshot.revision - 1)), HttpProblem);
	await assertRejects(
		() => store.action('alice', scopes, action(snapshot.revision, { taskId: 'other', tool: 'sandbox_delete' })),
		HttpProblem,
	);
	assertEquals(calls, 0);
	const results = await Promise.allSettled([
		store.action('alice', scopes, action(snapshot.revision)),
		store.action('alice', scopes, action(snapshot.revision)),
	]);
	assertEquals(results.filter((result) => result.status === 'fulfilled').length, 1);
	assertEquals(calls, 1);
	store.delete('alice', 'surface');
	create(store);
	const recreated = buttons(store);
	store.registerAction('alice', 'surface', 'cancel', 'cancelTask', { kind: 'cancelTask', taskId: 'task' });
	assertEquals(recreated.revision > snapshot.revision, true);
	await assertRejects(() => store.action('alice', scopes, action(snapshot.revision)), HttpProblem);
	store.close();
});

Deno.test('A2UI model changes invalidate registered actions and permission callback is bounded to binding', async () => {
	const seen: string[] = [];
	const store = new A2uiStore({
		permissionDecision: (_owner, _scopes, id, option) => {
			seen.push(`${id}:${option}`);
			return Promise.resolve({ decided: true });
		},
	});
	create(store);
	const message = {
		version: 'v0.9',
		updateComponents: {
			surfaceId: 'surface',
			components: [{
				id: 'root',
				component: 'Button',
				text: 'Allow once',
				action: { event: { name: 'permissionDecision', context: {} } },
			}],
		},
	};
	store.publish('alice', message);
	store.registerAction('alice', 'surface', 'root', 'permissionDecision', {
		kind: 'permissionDecision',
		requestId: 'req',
		optionId: 'once',
	});
	const revision = ((store.list('alice').surfaces as A2uiSurface[])[0]!).revision;
	await store.action('alice', scopes, {
		version: 'v0.9',
		action: {
			name: 'permissionDecision',
			sourceComponentId: 'root',
			surfaceId: 'surface',
			timestamp: new Date().toISOString(),
			context: {},
		},
		metadata: { revision },
	});
	assertEquals(seen, ['req:once']);
	store.registerAction('alice', 'surface', 'root', 'permissionDecision', {
		kind: 'permissionDecision',
		requestId: 'req',
		optionId: 'once',
	});
	store.publish('alice', {
		version: 'v0.9',
		updateDataModel: { surfaceId: 'surface', path: '/progress', value: 'ready' },
	});
	assertEquals((store.list('alice').surfaces as A2uiSurface[])[0]?.availableActions, []);
	store.close();
});

Deno.test('A2UI subscriptions are private, bounded and cancellation frees capacity', async () => {
	const store = new A2uiStore();
	create(store);
	const stream = store.stream('bob');
	const reader = stream.body!.getReader();
	assertEquals(new TextDecoder().decode((await reader.read()).value).includes('surfaceId'), false);
	await reader.cancel();
	const readers = Array.from({ length: 4 }, () => store.stream('alice').body!.getReader());
	assertThrows(() => store.stream('alice'), HttpProblem);
	await readers[0]!.cancel();
	await store.stream('alice').body!.cancel();
	for (const other of readers.slice(1)) await other.cancel();
	store.close();
});

Deno.test('A2UI REST separates viewing/publishing scopes and caps bodies before parsing', async () => {
	const store = new A2uiStore();
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (ctx, next) => {
		ctx.set('requestId', 'test');
		ctx.set('principal', {
			id: 'alice',
			kind: 'api-key',
			scopes: new Set(ctx.req.header('x-scopes')?.split(',') ?? []) as AppVariables['principal']['scopes'],
		});
		await next();
	});
	attachA2uiRoutes(app, store);
	assertEquals((await app.request('/api/v1/a2ui/surfaces')).status, 403);
	assertEquals((await app.request('/api/v1/a2ui/surfaces', { headers: { 'x-scopes': 'agent:invoke' } })).status, 200);
	assertEquals(
		(await app.request('/api/v1/a2ui/surfaces', {
			method: 'POST',
			headers: { 'x-scopes': 'agent:invoke' },
			body: '{}',
		})).status,
		403,
	);
	assertEquals(
		(await app.request('/api/v1/a2ui/surfaces', {
			method: 'POST',
			headers: { 'x-scopes': 'a2ui:publish' },
			body: 'x'.repeat(262145),
		})).status,
		413,
	);
	const response = await app.request('/api/v1/a2ui/surfaces', {
		method: 'POST',
		headers: { 'x-scopes': 'a2ui:publish' },
		body: JSON.stringify({ version: 'v0.9', createSurface: { surfaceId: 'surface', catalogId: A2UI_CATALOG_ID } }),
	});
	assertEquals(response.status, 200);
	store.close();
});

Deno.test('GW-6: each A2UI route is gated exactly, so a surface named "actions" needs a2ui:publish to delete', async () => {
	const store = new A2uiStore();
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (ctx, next) => {
		ctx.set('requestId', 'test');
		ctx.set('principal', {
			id: 'alice',
			kind: 'api-key',
			scopes: new Set(ctx.req.header('x-scopes')?.split(',') ?? []) as AppVariables['principal']['scopes'],
		});
		await next();
	});
	attachA2uiRoutes(app, store);
	try {
		const created = await app.request('/api/v1/a2ui/surfaces', {
			method: 'POST',
			headers: { 'x-scopes': 'a2ui:publish' },
			body: JSON.stringify({ version: 'v0.9', createSurface: { surfaceId: 'actions', catalogId: A2UI_CATALOG_ID } }),
		});
		assertEquals(created.status, 200);
		await created.body?.cancel();
		// The old gate keyed on any path ending in /actions, which this DELETE does.
		const viewerDelete = await app.request('/api/v1/a2ui/surfaces/actions', {
			method: 'DELETE',
			headers: { 'x-scopes': 'agent:invoke' },
		});
		assertEquals(viewerDelete.status, 403);
		await viewerDelete.body?.cancel();
		assertEquals((store.list('api-key:alice').surfaces as A2uiSurface[]).length, 1, 'the surface survives');
		// POST /actions is still a viewer's route, and publishing is still not.
		const viewerAction = await app.request('/api/v1/a2ui/actions', {
			method: 'POST',
			headers: { 'x-scopes': 'agent:invoke' },
			body: JSON.stringify(action(1)),
		});
		assertEquals(viewerAction.status, 404, 'passes the gate; the handler knows no surface by that id');
		await viewerAction.body?.cancel();
		const actionAsPublisher = await app.request('/api/v1/a2ui/actions', {
			method: 'POST',
			headers: { 'x-scopes': 'a2ui:publish' },
			body: '{}',
		});
		assertEquals(actionAsPublisher.status, 403);
		await actionAsPublisher.body?.cancel();
		const publisherDelete = await app.request('/api/v1/a2ui/surfaces/actions', {
			method: 'DELETE',
			headers: { 'x-scopes': 'a2ui:publish' },
		});
		assertEquals(publisherDelete.status, 200);
		await publisherDelete.body?.cancel();
	} finally {
		store.close();
	}
});

Deno.test('B1 / G5: surfaces survive a restart without their action registrations; revisions keep counting up', async () => {
	const dir = `tests/.scratch/a2ui-${crypto.randomUUID()}`;
	const path = `${dir}/agents/surfaces.json`;
	const first = new A2uiStore({ persistPath: path });
	let second: A2uiStore | undefined;
	try {
		create(first);
		const published = buttons(first);
		first.registerAction('alice', 'surface', 'cancel', 'cancelTask', { kind: 'cancelTask', taskId: 'task' });
		create(first, 'gone', 'bob');
		first.delete('bob', 'gone');
		create(first, 'kept', 'bob');
		assertEquals((first.list('alice').surfaces as A2uiSurface[])[0]?.availableActions, ['cancel:cancelTask']);
		await first.close();
		const stored = JSON.parse(await Deno.readTextFile(path));
		assertEquals(stored.version, 1);
		assertEquals(JSON.stringify(stored).includes('availableActions'), false, 'action registrations are not written');

		second = new A2uiStore({ persistPath: path });
		const restored = (second.list('alice').surfaces as A2uiSurface[])[0]!;
		assertEquals(restored.revision, published.revision);
		assertEquals(restored.components, published.components);
		assertEquals(restored.availableActions, [], 'a restored surface has no actions until it is republished');
		await assertRejects(() => second!.action('alice', scopes, action(published.revision)), HttpProblem, 'Unknown');
		assertEquals((second.list('bob').surfaces as A2uiSurface[]).map((surface) => surface.surfaceId), ['kept']);
		// The global revision continues past everything restored, so an old event cannot match a new surface.
		create(second, 'fresh');
		const fresh = (second.list('alice').surfaces as A2uiSurface[]).find((surface) => surface.surfaceId === 'fresh')!;
		assertEquals(fresh.revision > stored.revision, true);
	} finally {
		await first.close();
		await second?.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('B1: a corrupt or tampered surface document is not trusted', async () => {
	const dir = `tests/.scratch/a2ui-${crypto.randomUUID()}`;
	const path = `${dir}/agents/surfaces.json`;
	await Deno.mkdir(`${dir}/agents`, { recursive: true });
	const warnings: string[] = [];
	try {
		await Deno.writeTextFile(path, '{not json');
		const corrupt = new A2uiStore({ persistPath: path, logger: { warn: (line) => void warnings.push(line) } });
		assertEquals(corrupt.list('alice').surfaces, []);
		await corrupt.close();
		await Deno.writeTextFile(
			path,
			JSON.stringify({
				version: 1,
				revision: 3,
				surfaces: [
					{
						owner: 'alice',
						snapshot: {
							surfaceId: 'html',
							catalogId: A2UI_CATALOG_ID,
							revision: 2,
							components: [{ id: 'root', component: 'Script', src: 'https://evil.example/x.js' }],
							dataModel: {},
						},
					},
					{
						owner: 'alice',
						snapshot: { surfaceId: 'ok', catalogId: A2UI_CATALOG_ID, revision: 3, components: [], dataModel: {} },
					},
				],
			}),
		);
		const tampered = new A2uiStore({ persistPath: path, logger: { warn: (line) => void warnings.push(line) } });
		assertEquals((tampered.list('alice').surfaces as A2uiSurface[]).map((surface) => surface.surfaceId), ['ok']);
		await tampered.close();
		assertEquals(warnings.length, 2, warnings.join('\n'));
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('R2-9: a restored surface’s theme passes the publish schema, and only known keys come back', async () => {
	const dir = `tests/.scratch/a2ui-${crypto.randomUUID()}`;
	const path = `${dir}/agents/surfaces.json`;
	await Deno.mkdir(`${dir}/agents`, { recursive: true });
	const warnings: string[] = [];
	const surface = (surfaceId: string, extra: Record<string, unknown>) => ({
		owner: 'alice',
		snapshot: { surfaceId, catalogId: A2UI_CATALOG_ID, revision: 2, components: [], dataModel: { n: 1 }, ...extra },
	});
	const theme = { primaryColor: '#336699', font: 'serif', radius: 6, density: 'comfortable' };
	try {
		await Deno.writeTextFile(
			path,
			JSON.stringify({
				version: 1,
				revision: 4,
				surfaces: [
					// CSS where a colour belongs: never published, so never restored.
					surface('css', { theme: { primaryColor: 'red;background:url(https://evil.example/x)' } }),
					surface('extra-key', { theme: { ...theme, fontFace: 'https://evil.example/f.woff' } }),
					surface('no-model', { dataModel: undefined }),
					// A valid theme survives; a key no snapshot has (a hand edit) does not.
					surface('themed', { theme, availableActions: ['forged:cancelTask'], injected: '<script>' }),
					surface('plain', {}),
				],
			}),
		);
		const store = new A2uiStore({ persistPath: path, logger: { warn: (line) => void warnings.push(line) } });
		const restored = store.list('alice').surfaces as A2uiSurface[];
		assertEquals(restored.map((s) => s.surfaceId).sort(), ['plain', 'themed']);
		const themed = restored.find((s) => s.surfaceId === 'themed')! as unknown as Record<string, unknown>;
		assertEquals(themed.theme, theme);
		assertEquals(themed.dataModel, { n: 1 });
		assertEquals('injected' in themed, false);
		assertEquals(themed.availableActions, [], 'no action survives a restart, forged or not');
		assertEquals('theme' in (restored.find((s) => s.surfaceId === 'plain')! as object), false);
		assertEquals(warnings.length, 1, warnings.join('\n'));
		assertStringIncludes(warnings[0]!, '3 surfaces');
		await store.close();
		// The rewritten document holds only what was restored.
		const written = await Deno.readTextFile(path);
		assertEquals(/evil|injected|forged/.test(written), false, written);
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

Deno.test('D-111: a surface keeps its closed theme, and the store refuses one that is not', () => {
	const store = new A2uiStore();
	try {
		const theme = { primaryColor: '#336699', font: 'mono' as const, radius: 4, density: 'compact' as const };
		const created = store.publish('alice', {
			version: 'v0.9',
			createSurface: { surfaceId: 'themed', catalogId: A2UI_CATALOG_ID, theme },
		}).surface as A2uiSurface;
		assertEquals(created.theme, theme);
		assertEquals((store.list('alice').surfaces as A2uiSurface[])[0]?.theme, theme);
		create(store, 'plain');
		assertEquals('theme' in ((store.list('alice').surfaces as A2uiSurface[])[1] ?? {}), false);
		assertThrows(() =>
			store.publish('alice', {
				version: 'v0.9',
				createSurface: { surfaceId: 'bad', catalogId: A2UI_CATALOG_ID, theme: { primaryColor: 'red;x:y' } },
			})
		);
	} finally {
		store.close();
	}
});

Deno.test('D-111: Html is served only by its route — owner-bound, agent:invoke, under the sandbox CSP', async () => {
	const store = new A2uiStore();
	const app = new Hono<{ Variables: AppVariables }>();
	app.use('*', async (ctx, next) => {
		ctx.set('requestId', 'test');
		ctx.set('principal', {
			id: ctx.req.header('x-user') ?? 'alice',
			kind: 'api-key',
			scopes: new Set(ctx.req.header('x-scopes')?.split(',') ?? []) as AppVariables['principal']['scopes'],
		});
		await next();
	});
	attachA2uiRoutes(app, store);
	const document = '<h1>Report</h1><script>parent.postMessage("ran","*")</script><p style="color:red">ok</p>';
	try {
		const owner = 'api-key:alice';
		create(store, 'report', owner);
		store.publish(owner, {
			version: 'v0.9',
			updateComponents: {
				surfaceId: 'report',
				components: [
					{ id: 'root', component: 'Column', children: ['frame', 'note'] },
					{ id: 'frame', component: 'Html', html: document, height: 200, title: 'Quarterly report' },
					{ id: 'note', component: 'Text', text: 'not html' },
				],
			},
		});
		const path = '/api/v1/a2ui/surfaces/report/html/frame';

		const served = await app.request(path, { headers: { 'x-scopes': 'agent:invoke' } });
		assertEquals(served.status, 200);
		assertEquals(await served.text(), document);
		assertEquals(served.headers.get('content-type'), 'text/html; charset=utf-8');
		assertEquals(
			served.headers.get('content-security-policy'),
			"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
		);
		assertEquals(served.headers.get('x-content-type-options'), 'nosniff');
		assertEquals(served.headers.get('cache-control'), 'no-store');
		assertEquals(served.headers.get('cross-origin-resource-policy'), 'same-origin');
		assertEquals(served.headers.get('access-control-allow-origin'), null, 'no CORS, ever');

		// Scope: publishing is not viewing.
		const publisherOnly = await app.request(path, { headers: { 'x-scopes': 'a2ui:publish' } });
		assertEquals(publisherOnly.status, 403);
		await publisherOnly.body?.cancel();
		// Owner binding: another principal's identical path is simply not there.
		const stranger = await app.request(path, { headers: { 'x-scopes': 'agent:invoke', 'x-user': 'mallory' } });
		assertEquals(stranger.status, 404);
		assertEquals(stranger.headers.get('content-security-policy'), null, 'a problem is not an HTML document');
		await stranger.body?.cancel();
		// Only Html components have a document; every other id answers 404.
		for (const missing of ['/api/v1/a2ui/surfaces/report/html/note', '/api/v1/a2ui/surfaces/report/html/none']) {
			const response = await app.request(missing, { headers: { 'x-scopes': 'agent:invoke' } });
			assertEquals(response.status, 404, missing);
			await response.body?.cancel();
		}
		const noSurface = await app.request('/api/v1/a2ui/surfaces/other/html/frame', {
			headers: { 'x-scopes': 'agent:invoke' },
		});
		assertEquals(noSurface.status, 404);
		await noSurface.body?.cancel();
		// The document never rides in a problem body or in a header.
		assertEquals(JSON.stringify([...served.headers]).includes('postMessage'), false);
	} finally {
		store.close();
	}
});

Deno.test('a surface belongs to a workspace: created with one, attached and detached over PATCH, kept across a restart', async () => {
	const dir = `tests/.scratch/a2ui-${crypto.randomUUID()}`;
	const path = `${dir}/agents/surfaces.json`;
	const workspaceId = '2276732b-a79d-436f-9cea-1a80b68a06b2';
	const store = new A2uiStore({ persistPath: path });
	let restored: A2uiStore | undefined;
	try {
		const app = new Hono<{ Variables: AppVariables }>();
		app.use('*', async (ctx, next) => {
			ctx.set('requestId', 'test');
			ctx.set('principal', {
				id: ctx.req.header('x-owner') ?? 'alice',
				kind: 'api-key',
				scopes: new Set(ctx.req.header('x-scopes')?.split(',') ?? []) as AppVariables['principal']['scopes'],
			});
			await next();
		});
		attachA2uiRoutes(app, store);
		const post = async (message: unknown): Promise<A2uiSurface> =>
			(await (await app.request('/api/v1/a2ui/surfaces', {
				method: 'POST',
				headers: { 'x-scopes': 'a2ui:publish' },
				body: JSON.stringify(message),
			})).json()).surface as A2uiSurface;
		const created = await post({
			version: 'v0.9',
			createSurface: { surfaceId: 'board', catalogId: A2UI_CATALOG_ID, workspaceId },
		});
		assertEquals(created.workspaceId, workspaceId);
		await post({ version: 'v0.9', createSurface: { surfaceId: 'loose', catalogId: A2UI_CATALOG_ID } });
		const patch = (id: string, body: unknown, headers: Record<string, string> = { 'x-scopes': 'a2ui:publish' }) =>
			app.request(`/api/v1/a2ui/surfaces/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

		assertEquals((await patch('loose', { workspaceId }, { 'x-scopes': 'agent:invoke' })).status, 403);
		assertEquals((await patch('loose', { workspaceId: 'not-a-uuid' })).status, 400);
		assertEquals((await patch('loose', { workspaceId, extra: 1 })).status, 400);
		assertEquals((await patch('loose', { workspaceId }, { 'x-scopes': 'a2ui:publish', 'x-owner': 'bob' })).status, 404);
		const attached = await patch('loose', { workspaceId });
		assertEquals(attached.status, 200);
		const surface = (await attached.json()).surface as A2uiSurface;
		assertEquals(surface.workspaceId, workspaceId);
		assertEquals(surface.revision > created.revision, true, 'attaching is a new revision');
		const detached = (await (await patch('board', { workspaceId: null })).json()).surface as A2uiSurface;
		assertEquals('workspaceId' in detached, false);

		await store.close();
		restored = new A2uiStore({ persistPath: path });
		const owner = [...JSON.parse(await Deno.readTextFile(path)).surfaces][0].owner as string;
		const byId = new Map((restored.list(owner).surfaces as A2uiSurface[]).map((entry) => [entry.surfaceId, entry]));
		assertEquals(byId.get('loose')?.workspaceId, workspaceId);
		assertEquals(byId.get('board')?.workspaceId, undefined);
	} finally {
		await store.close();
		await restored?.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});
