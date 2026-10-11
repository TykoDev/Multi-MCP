/**
 * The reported `a2ui_publish` / `a2ui_delete` failures (2026-10-11), driven through the composed services and the
 * same executor the dispatcher uses: every message a specification client sends — as JSON text, without `version`,
 * naming the basic catalog — publishes; and every refusal names its cause instead of "Invalid input" or "check the
 * service configuration".
 */
import { assertEquals, assertStringIncludes } from '@std/assert';
import { createToolExecutor, type Scope, SessionRegistry, type ToolResult } from '@tykotech/mcp';
import { loadConfig } from './config.ts';
import { createExpansionServices } from './expansion.ts';

const SCOPES: ReadonlySet<Scope> = new Set(['mcp:invoke', 'agent:invoke', 'a2ui:publish']);
const OWNER = 'api-key:alice';
const CATALOG = 'https://tykotech.eu/a2ui/catalog/v0.9';

function harness() {
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const core = { registry, version: 'a2ui-tools' };
	const services = createExpansionServices(loadConfig({}).expansion, core);
	const call = createToolExecutor({ ...core, extraTools: services.tools }, OWNER, SCOPES);
	return {
		call,
		async [Symbol.asyncDispose]() {
			await services.close();
			await registry.shutdown();
		},
	};
}

function outcome(result: ToolResult): { ok: true; result: Record<string, unknown> } | { ok: false; text: string } {
	const call = result as { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: unknown };
	if (call.isError === true) return { ok: false, text: call.content[0]?.text ?? '' };
	return { ok: true, result: (call.structuredContent as { result: Record<string, unknown> }).result };
}

function ok(result: ToolResult): Record<string, unknown> {
	const read = outcome(result);
	if (!read.ok) throw new Error(`expected a success, got ${read.text}`);
	return read.result;
}

function refused(result: ToolResult): string {
	const read = outcome(result);
	if (read.ok) throw new Error('expected a refusal');
	return read.text;
}

Deno.test('a2ui tools: all four operations publish when the message arrives as JSON text', async () => {
	await using h = harness();
	const text = (message: unknown) => ({ message: JSON.stringify(message) });
	ok(await h.call('a2ui_publish', text({ version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: CATALOG } })));
	const updated = ok(
		await h.call(
			'a2ui_publish',
			text({
				version: 'v0.9',
				updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Text', text: 'hi' }] },
			}),
		),
	);
	assertEquals((updated.surface as { components: unknown[] }).components.length, 1);
	const model = ok(
		await h.call('a2ui_publish', text({ version: 'v0.9', updateDataModel: { surfaceId: 's1', path: '/n', value: 1 } })),
	);
	assertEquals((model.surface as { dataModel: unknown }).dataModel, { n: 1 });
	assertEquals(ok(await h.call('a2ui_publish', text({ version: 'v0.9', deleteSurface: { surfaceId: 's1' } }))), {
		removed: true,
		surfaceId: 's1',
	});
});

Deno.test('a2ui tools: the specification spellings (no version, the basic catalog id) publish', async () => {
	await using h = harness();
	const created = ok(
		await h.call('a2ui_publish', {
			message: {
				createSurface: { surfaceId: 's2', catalogId: 'https://a2ui.org/specification/v0_9/basic_catalog.json' },
			},
		}),
	);
	assertEquals((created.surface as { catalogId: string }).catalogId, CATALOG);
	ok(await h.call('a2ui_publish', { message: { deleteSurface: { surfaceId: 's2' } } }));
});

Deno.test('a2ui tools: refusals name the field, the missing surface and the duplicate', async () => {
	await using h = harness();
	const wrongCatalog = refused(
		await h.call('a2ui_publish', {
			message: { version: 'v0.9', createSurface: { surfaceId: 's3', catalogId: 'https://example.test/catalog.json' } },
		}),
	);
	assertStringIncludes(wrongCatalog, 'Error: invalid-arguments: message.createSurface.catalogId');

	const missing = refused(
		await h.call('a2ui_publish', {
			message: {
				version: 'v0.9',
				updateComponents: { surfaceId: 'nope', components: [{ id: 'root', component: 'Text', text: 'x' }] },
			},
		}),
	);
	assertStringIncludes(missing, 'Error: invalid-arguments: you have no A2UI surface "nope"');

	const deleted = refused(await h.call('a2ui_delete', { surface_id: 'nope' }));
	assertStringIncludes(deleted, 'Error: invalid-arguments: you have no A2UI surface "nope"');
	assertEquals(deleted.includes('service configuration'), false);

	ok(
		await h.call('a2ui_publish', {
			message: { version: 'v0.9', createSurface: { surfaceId: 's3', catalogId: CATALOG } },
		}),
	);
	const duplicate = refused(
		await h.call('a2ui_publish', {
			message: { version: 'v0.9', createSurface: { surfaceId: 's3', catalogId: CATALOG } },
		}),
	);
	assertStringIncludes(duplicate, 'Error: invalid-arguments: Surface already exists');

	const badTree = refused(
		await h.call('a2ui_publish', {
			message: {
				version: 'v0.9',
				updateComponents: { surfaceId: 's3', components: [{ id: 'root', component: 'Column', children: ['root'] }] },
			},
		}),
	);
	assertStringIncludes(badTree, 'Error: invalid-arguments: A2UI cycle or depth exceeded');
});

Deno.test('tools: a number sent as text reaches the tool as the number (agent_list_tasks limit)', async () => {
	await using h = harness();
	assertEquals(ok(await h.call('agent_list_tasks', { limit: '5' })).tasks, []);
	assertStringIncludes(refused(await h.call('agent_list_tasks', { limit: 'five' })), 'Error: invalid-arguments: limit');
});
