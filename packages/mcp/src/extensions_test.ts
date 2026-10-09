import { assert, assertEquals, assertRejects } from '@std/assert';
import { McpServer } from '@modelcontextprotocol/server';
import { extensionTools } from './extension_tools.ts';
import { createToolExecutor, registerCatalog } from './server.ts';
import { SessionRegistry } from './registry.ts';
import type { Scope } from './scopes.ts';

Deno.test('extensions: injected tools require both the base and explicit execution grants on shared dispatch', async () => {
	const registry = new SessionRegistry();
	let executions = 0;
	const extraTools = extensionTools({
		sandbox_list: (_args, ctx): Promise<Record<string, unknown>> => {
			executions++;
			return Promise.resolve({ owner: ctx.principal, workspaces: [] });
		},
	});
	try {
		for (const grants of [[], ['sandbox:execute'], ['mcp:invoke']]) {
			const call = createToolExecutor({ registry, version: 'test', extraTools }, 'owner', new Set(grants as Scope[]));
			const denied = await call('sandbox_list', {});
			assert('isError' in denied && denied.isError);
		}
		assertEquals(executions, 0);
		const call = createToolExecutor(
			{ registry, version: 'test', extraTools },
			'owner',
			new Set(['mcp:invoke', 'sandbox:execute']),
		);
		const allowed = await call('sandbox_list', {});
		assert('structuredContent' in allowed);
		assertEquals(allowed.structuredContent, { result: { owner: 'owner', workspaces: [] } });
		const malformed = await call('sandbox_list', { principal: 'someone-else' });
		assert('isError' in malformed && malformed.isError);
		assertEquals(executions, 1);
	} finally {
		await registry.shutdown();
	}
});

Deno.test('extensions: optional tools disappear when unconfigured and duplicate names refuse composition', async () => {
	assertEquals(extensionTools({}), []);
	const registry = new SessionRegistry();
	const tools = extensionTools({
		sandbox_list: (): Promise<Record<string, unknown>> => Promise.resolve({ workspaces: [] }),
	});
	const server = new McpServer({ name: 'test', version: 'test' });
	try {
		await assertRejects(
			async (): Promise<void> => {
				await Promise.resolve(
					registerCatalog(server, { registry, version: 'test', extraTools: [...tools, ...tools] }, undefined),
				);
			},
			Error,
			'duplicate tool',
		);
	} finally {
		await server.close();
		await registry.shutdown();
	}
});

Deno.test('extensions (D-154): the memory tools take the library scopes, need an owner and no service, and envelope', async () => {
	const owners: string[] = [];
	const tools = extensionTools({
		memory_save: (_args, ctx) => {
			owners.push(ctx.principal);
			return Promise.resolve({ collection: 'c', embedder: 'builtin:lexical-512', created: true, ids: ['a'] });
		},
		memory_search: () => Promise.resolve({ collection: 'c', embedder: 'builtin:lexical-512', results: [] }),
		memory_delete: () => Promise.resolve({ collection: 'c', deleted: 0, dropped: false }),
		memory_list: () => Promise.resolve({ default_embedder: 'builtin:lexical-512', collections: [] }),
	});
	// D-075: persistent data on the data volume — reading is files:read, changing it files:write.
	assertEquals(tools.map((tool) => [tool.name, tool.scope, tool.mutates]), [
		['memory_save', 'files:write', true],
		['memory_search', 'files:read', false],
		['memory_delete', 'files:write', true],
		['memory_list', 'files:read', false],
	]);
	assert(tools.every((tool) => tool.available === undefined), 'no private service, so no health gate');
	const registry = new SessionRegistry();
	try {
		// The base grant plus the library's read grant: listing is allowed, saving is not.
		const call = createToolExecutor(
			{ registry, version: 'test', extraTools: tools },
			'owner',
			new Set(['mcp:invoke', 'files:read']),
		);
		const denied = await call('memory_save', { collection: 'c', items: [{ text: 'x' }] });
		assert('isError' in denied && denied.isError);
		const listed = await call('memory_list', {});
		assert('structuredContent' in listed);
		assertEquals(listed.structuredContent, { result: { default_embedder: 'builtin:lexical-512', collections: [] } });
		const writer = createToolExecutor(
			{ registry, version: 'test', extraTools: tools },
			'api-key:alice',
			new Set(['mcp:invoke', 'files:write']),
		);
		const saved = await writer('memory_save', { collection: 'c', items: [{ text: 'x' }] });
		assert(!('isError' in saved && saved.isError));
		assertEquals(owners, ['api-key:alice']);
		// Bounds a model reads in the schema: a name that is not lower-case, and an empty batch, never reach the action.
		for (const args of [{ collection: 'Notes', items: [{ text: 'x' }] }, { collection: 'c', items: [] }]) {
			const refused = await writer('memory_save', args);
			assert('isError' in refused && refused.isError);
		}
		assertEquals(owners.length, 1);
	} finally {
		await registry.shutdown();
	}
});
