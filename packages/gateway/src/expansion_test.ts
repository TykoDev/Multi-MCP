import { assert, assertEquals } from '@std/assert';
import { generateApiKey } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { startGateway } from './server.ts';
import { A2UI_CATALOG_ID } from '@tykotech/wire';

Deno.test('expansion gateway: bearer and explicit scopes precede protocols, tasks and UI ownership', async (): Promise<void> => {
	const alice = await generateApiKey('alice', ['mcp:invoke', 'agent:invoke', 'a2ui:publish']);
	const bob = await generateApiKey('bob', ['mcp:invoke', 'agent:invoke', 'a2ui:publish', 'admin']);
	const ordinary = await generateApiKey('ordinary', ['mcp:invoke']);
	const gateway = await startGateway({
		config: loadConfig({
			TTK_HOST: '127.0.0.1',
			TTK_PORT: '0',
			TTK_API_KEYS: JSON.stringify([alice.record, bob.record, ordinary.record]),
		}),
		version: 'expansion-test',
		logger: createLogger({ level: 'error', write: (): void => {} }),
	});
	const request = (path: string, key?: string, body?: unknown): Promise<Response> =>
		fetch(`${gateway.url}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: {
				...(key ? { authorization: `Bearer ${key}` } : {}),
				...(body === undefined ? {} : { 'content-type': 'application/json', 'a2a-version': '1.0' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		const card = await request('/.well-known/agent-card.json');
		assertEquals(card.status, 200, card.ok ? undefined : await card.text());
		assertEquals((await card.json()).defaultInputModes, ['application/json']);
		for (const path of ['/api/v1/agent/tasks', '/api/v1/a2ui/surfaces', '/api/v1/a2ui/events']) {
			const anon = await request(path);
			assertEquals(anon.status, 401);
			await anon.body?.cancel();
			const denied = await request(path, ordinary.key);
			assertEquals(denied.status, 403);
			await denied.body?.cancel();
		}
		const rpc = {
			jsonrpc: '2.0',
			id: 1,
			method: 'SendMessage',
			params: {
				message: {
					messageId: 'read-sessions',
					role: 'ROLE_USER',
					parts: [{ data: { tool: 'browser_list_sessions', arguments: {} } }],
				},
			},
		};
		const denied = await request('/a2a', ordinary.key, rpc);
		assertEquals(denied.status, 403);
		await denied.body?.cancel();
		const response = await request('/a2a', alice.key, rpc);
		const task = (await response.json()).result.task;
		assertEquals(task.status.state, 'TASK_STATE_COMPLETED');
		// D-146 (amendment): the list is newest-created first, ties by id, and every task carries its creation time.
		const again = { ...rpc, id: 2, params: { message: { ...rpc.params.message, messageId: 'read-sessions-again' } } };
		const second = (await (await request('/a2a', alice.key, again)).json()).result.task;
		const listed = (await (await request('/api/v1/agent/tasks', alice.key)).json()).tasks as {
			id: string;
			created_at: string;
		}[];
		assertEquals(listed.map((entry) => entry.id).sort(), [task.id, second.id].sort());
		for (const entry of listed) assertEquals(new Date(entry.created_at).toISOString(), entry.created_at);
		const [newer, older] = listed as [{ id: string; created_at: string }, { id: string; created_at: string }];
		assert(
			newer.created_at > older.created_at ||
				(newer.created_at === older.created_at && newer.id.localeCompare(older.id) > 0),
			'newest-created first, ties by id',
		);
		const foreign = await request(`/api/v1/agent/tasks/${task.id}`, bob.key);
		assertEquals(foreign.status, 404);
		await foreign.body?.cancel();
		assertEquals((await (await request('/api/v1/agent/tasks', bob.key)).json()).tasks, []);
		const surface = await request('/api/v1/a2ui/surfaces', alice.key, {
			version: 'v0.9',
			createSurface: { surfaceId: 'owned', catalogId: A2UI_CATALOG_ID },
		});
		assertEquals(surface.status, 200);
		await surface.body?.cancel();
		assertEquals((await (await request('/api/v1/a2ui/surfaces', bob.key)).json()).surfaces, []);
		const foreignUi = await request('/api/v1/a2ui/surfaces', bob.key, {
			version: 'v0.9',
			deleteSurface: { surfaceId: 'owned' },
		});
		assertEquals(foreignUi.status, 404);
		await foreignUi.body?.cancel();
		const evilHost = await fetch(`${gateway.url}/.well-known/agent-card.json`, {
			headers: { origin: 'https://evil.example' },
		});
		assertEquals(evilHost.status, 403);
		await evilHost.body?.cancel();
	} finally {
		await gateway.shutdown();
		await gateway.finished;
	}
});
