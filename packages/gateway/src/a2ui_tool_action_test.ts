/**
 * E-4: operator-configured A2UI tool actions, end to end through the gateway: a published button bound to a
 * configured action calls the operator's tool with the operator's arguments plus the declared context, under the
 * clicking principal's own scopes.
 *
 * X-1 (D-141, AC24): a button whose configured tool cannot run indirectly (`NOT_TASKABLE`) is refused by the
 * dispatcher too, for a configuration that reached the store without passing `expansionConfig()`.
 */
import { assert, assertEquals, assertRejects } from '@std/assert';
import { type Scope, SessionRegistry, ToolError } from '@tykotech/mcp';
import type { SandboxClient } from '@tykotech/sandbox';
import { A2UI_CATALOG_ID } from '@tykotech/wire';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createExpansionServices } from './expansion.ts';
import { createLogger } from './logger.ts';
import { NOT_TASKABLE, notTaskable } from './taskable.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const WORKSPACE = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';

Deno.test('A2UI tool actions: configured tool, fixed arguments, declared context, target scope re-checked', async () => {
	// One key, so both requests share an owner; its scopes are narrowed between the two clicks by key reload.
	const full = await generateApiKey('ops', ['mcp:invoke', 'agent:invoke', 'a2ui:publish', 'sandbox:execute']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([full.record]),
		TTK_A2UI_ACTIONS: JSON.stringify([
			{ name: 'listSources', tool: 'sandbox_list', arguments: { path: 'src' }, context: ['workspace_id'] },
		]),
	});
	const calls: Array<{ operation: string; args: Record<string, unknown> }> = [];
	const sandbox = {
		ready: () => Promise.resolve(true),
		call: (_principal: string, operation: string, args: Record<string, unknown>) => {
			calls.push({ operation, args });
			return Promise.resolve({ entries: [{ name: 'main.ts', type: 'file' }], truncated: false });
		},
	} as unknown as SandboxClient;
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox,
	});
	const headers = {
		host: '127.0.0.1:8787',
		authorization: `Bearer ${full.key}`,
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
	};
	const publish = async (message: unknown) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'a2ui_publish', arguments: { message } },
			}),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)).result.structuredContent.result;
	};
	const surfaces = async () =>
		await (await gateway.app.request(`${ORIGIN}/api/v1/a2ui/surfaces`, {
			headers: { host: headers.host, authorization: headers.authorization },
		})).json();
	const click = async (revision: number, component: string, name: string, context: Record<string, unknown>) =>
		await gateway.app.request(`${ORIGIN}/api/v1/a2ui/actions`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				version: 'v0.9',
				action: {
					surfaceId: 's',
					sourceComponentId: component,
					name,
					timestamp: new Date().toISOString(),
					context,
				},
				metadata: { revision },
			}),
		});
	try {
		await publish({ version: 'v0.9', createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID } });
		await publish({ version: 'v0.9', updateDataModel: { surfaceId: 's', path: '/ws', value: WORKSPACE } });
		const published = await publish({
			version: 'v0.9',
			updateComponents: {
				surfaceId: 's',
				components: [
					{ id: 'root', component: 'Column', children: ['list', 'sneaky'] },
					{
						id: 'list',
						component: 'Button',
						text: 'List sources',
						action: { event: { name: 'listSources', context: { workspace_id: { path: '/ws' } } } },
					},
					{
						// Asks for more context than the operator allowed: never bound.
						id: 'sneaky',
						component: 'Button',
						text: 'Sneaky',
						action: { event: { name: 'listSources', context: { workspace_id: WORKSPACE, path: '/' } } },
					},
				],
			},
		});
		const revision: number = published.surface.revision;
		const listed = (await surfaces()).surfaces[0];
		assertEquals(listed.availableActions, ['list:listSources']);

		const response = await click(revision, 'list', 'listSources', { workspace_id: WORKSPACE });
		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.tool, 'sandbox_list');
		assertEquals(calls, [{ operation: 'list', args: { path: 'src', workspace_id: WORKSPACE } }]);
		// One-shot: the same click again is refused.
		assertEquals((await click(revision, 'list', 'listSources', { workspace_id: WORKSPACE })).status, 400);
		// The unbound button never dispatches.
		const sneaky = await click(revision, 'sneaky', 'listSources', { workspace_id: WORKSPACE, path: '/' });
		assert(sneaky.status >= 400);

		// Without the target tool's scope, the click reaches the tool gate and is refused there.
		const narrowed = await generateApiKey('ops', ['mcp:invoke', 'agent:invoke', 'a2ui:publish']);
		verifier.replaceApiKeys([{ ...narrowed.record, sha256: full.record.sha256 }]);
		const again = await publish({
			version: 'v0.9',
			updateDataModel: { surfaceId: 's', path: '/ws', value: WORKSPACE },
		});
		const refused = await click(again.surface.revision, 'list', 'listSources', { workspace_id: WORKSPACE });
		const refusal = await refused.json();
		assertEquals(refusal.result?.structuredContent?.error?.code ?? refusal.status, 'scope-required');
		assertEquals(calls.length, 1, 'the narrowed click never reached the sandbox');
	} finally {
		await gateway.close();
	}
});

Deno.test('X-1 (AC24): the dispatcher refuses a NOT_TASKABLE action that bypassed configuration, before any call', async () => {
	// `sandbox_delete` is in the confirmation set (G5). Built straight into the expansion config, as a store that never
	// passed `expansionConfig()` would hold it; `loadConfig` itself refuses it (expansion_config_test.ts).
	assert(NOT_TASKABLE.has('sandbox_delete'));
	const expansion = {
		...loadConfig({}).expansion,
		a2uiActions: [{ name: 'wipe', tool: 'sandbox_delete', arguments: {}, context: ['workspace_id'] }],
	};
	const calls: string[] = [];
	const sandbox = {
		ready: () => Promise.resolve(true),
		call: (_principal: string, operation: string) => {
			calls.push(operation);
			return Promise.resolve({ removed: true });
		},
	} as unknown as SandboxClient;
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const services = createExpansionServices(expansion, { registry, version: 'test' }, sandbox);
	const owner = 'api-key:ops';
	const scopes: ReadonlySet<Scope> = new Set(['mcp:invoke', 'agent:invoke', 'a2ui:publish', 'sandbox:execute']);
	try {
		services.publish(owner, { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: A2UI_CATALOG_ID } });
		const published = services.publish(owner, {
			version: 'v0.9',
			updateComponents: {
				surfaceId: 's',
				components: [{
					id: 'wipe',
					component: 'Button',
					text: 'Wipe',
					action: { event: { name: 'wipe', context: { workspace_id: WORKSPACE } } },
				}],
			},
		}) as { surface: { revision: number } };
		const click = {
			version: 'v0.9',
			action: {
				surfaceId: 's',
				sourceComponentId: 'wipe',
				name: 'wipe',
				timestamp: new Date().toISOString(),
				context: { workspace_id: WORKSPACE },
			},
			metadata: { revision: published.surface.revision },
		};
		const refused = await assertRejects(() => services.surfaces.action(owner, scopes, click), ToolError);
		assertEquals(refused.code, 'invalid-arguments');
		assertEquals(refused.message, `invalid-arguments: ${notTaskable('sandbox_delete')}`);
		assertEquals(calls, [], 'the refused click never reached the sandbox');
	} finally {
		await services.close();
		await registry.shutdown();
	}
});
