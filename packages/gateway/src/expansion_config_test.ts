import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { ConfigError, loadConfig } from './config.ts';
import { resolveSecrets, SecretError } from './secrets.ts';
import { NOT_TASKABLE } from './taskable.ts';

Deno.test('C4 / B1 / A11: agent task bounds and the push host list parse with their ranges and defaults', () => {
	const defaults = loadConfig({}).expansion;
	assertEquals(defaults.taskTimeoutMs, 600_000);
	assertEquals(defaults.taskRetentionMs, 86_400_000);
	assertEquals(defaults.pushAllowedHosts, [], 'empty: push is not offered');
	const set = loadConfig({
		TTK_AGENT_TASK_TIMEOUT_S: '10',
		TTK_AGENT_TASK_RETENTION_S: '2592000',
		TTK_A2A_PUSH_ALLOWED_HOSTS: ' Hooks.Example.com , hooks.example.com:443,hooks.example.com:8443,[2001:db8::1] ',
	}).expansion;
	assertEquals(set.taskTimeoutMs, 10_000);
	assertEquals(set.taskRetentionMs, 2_592_000_000);
	assertEquals(set.pushAllowedHosts, ['hooks.example.com', 'hooks.example.com:8443', '[2001:db8::1]']);
	for (const value of ['9', '86401', '1.5', '-1', 'ten']) {
		assertThrows(() => loadConfig({ TTK_AGENT_TASK_TIMEOUT_S: value }), ConfigError, 'TTK_AGENT_TASK_TIMEOUT_S');
	}
	for (const value of ['59', '2592001']) {
		assertThrows(() => loadConfig({ TTK_AGENT_TASK_RETENTION_S: value }), ConfigError, 'TTK_AGENT_TASK_RETENTION_S');
	}
	// Private addresses are always refused, so a list naming one refuses startup rather than failing every delivery.
	for (
		const value of [
			'localhost',
			'127.0.0.1',
			'10.0.0.5',
			'169.254.169.254',
			'[::1]',
			'[fd00::1]',
			'https://hooks.example.com',
			'hooks.example.com/path',
			'user@hooks.example.com',
		]
	) assertThrows(() => loadConfig({ TTK_A2A_PUSH_ALLOWED_HOSTS: value }), ConfigError, 'TTK_A2A_PUSH_ALLOWED_HOSTS');
});

Deno.test('expansion config: execution services are absent by default and require file-backed credentials', () => {
	assertEquals(loadConfig({}).expansion, {
		sandbox: null,
		bridge: null,
		peers: [],
		a2uiActions: [],
		taskTimeoutMs: 600_000,
		taskRetentionMs: 86_400_000,
		pushAllowedHosts: [],
	});
	// E-4: configured A2UI actions are validated at startup; built-in names and argument overrides are refused.
	for (
		const actions of [
			[{ name: 'cancelTask', tool: 'sandbox_list' }],
			[{ name: 'go', tool: 'sandbox_list', arguments: { path: 'x' }, context: ['path'] }],
			[{ name: 'go', tool: 'sandbox_list' }, { name: 'go', tool: 'sandbox_diff' }],
			[{ name: 'go', tool: 'Bad Tool' }],
		]
	) assertThrows(() => loadConfig({ TTK_A2UI_ACTIONS: JSON.stringify(actions) }), ConfigError);
	for (
		const env of [
			{ TTK_SANDBOX_URL: 'http://sandbox:8080' },
			{ TTK_SANDBOX_TOKEN_FILE: '/secret' },
			{ TTK_AGENT_BRIDGE_URL: 'http://agent-runner:8789' },
		]
	) assertThrows(() => loadConfig(env), ConfigError);
	assertThrows(() =>
		loadConfig({ TTK_SANDBOX_URL: 'http://sandbox:8080' }, {
			secrets: { TTK_SANDBOX_TOKEN: 'short' },
		}), ConfigError);
});

Deno.test('X-1 (AC24): an A2UI action naming a NOT_TASKABLE tool refuses startup; taskable actions are unchanged', () => {
	for (const tool of NOT_TASKABLE) {
		const error = assertThrows(
			() =>
				loadConfig({
					TTK_A2UI_ACTIONS: JSON.stringify([
						{ name: 'fine', tool: 'sandbox_list' },
						{ name: 'go', tool, arguments: {}, context: [] },
					]),
				}),
			ConfigError,
		);
		assertEquals(error.message, `TTK_A2UI_ACTIONS: action "go" names ${tool}, which cannot run indirectly`, tool);
	}
	// A taskable tool is configured exactly as before.
	assertEquals(
		loadConfig({
			TTK_A2UI_ACTIONS: JSON.stringify([{ name: 'list', tool: 'sandbox_list', context: ['workspace_id'] }]),
		}).expansion.a2uiActions,
		[{ name: 'list', tool: 'sandbox_list', arguments: {}, context: ['workspace_id'] }],
	);
});

Deno.test('expansion config: service addresses cannot contain hidden credentials or request-controlled suffixes', () => {
	for (
		const url of [
			'file:///tmp/socket',
			'http://user:pass@sandbox:8080',
			'http://sandbox:8080?x=1',
			'http://sandbox:8080#x',
		]
	) {
		assertThrows(() =>
			loadConfig({ TTK_SANDBOX_URL: url }, {
				secrets: { TTK_SANDBOX_TOKEN: 'a'.repeat(32) },
			}), ConfigError);
	}
});

Deno.test('expansion config: peer token references resolve by argument and only operator-fixed peers survive', async () => {
	const values: Record<string, string> = {
		'/peers': JSON.stringify([{ id: 'worker', url: 'https://worker.example/a2a', token_file: '/peer-token' }]),
		'/peer-token': 'test-peer-token\n',
		'/sandbox-token': 'a'.repeat(32),
	};
	const env = {
		TTK_AGENT_PEERS_FILE: '/peers',
		TTK_SANDBOX_URL: 'http://sandbox:8080',
		TTK_SANDBOX_TOKEN_FILE: '/sandbox-token',
	};
	const secrets = await resolveSecrets({
		env,
		// A path the test does not name is absent, as on a real disk: the implicit admin-record file (C6) is read too.
		readFile: (path: string): Promise<string> =>
			values[path] === undefined ? Promise.reject(new Deno.errors.NotFound(path)) : Promise.resolve(values[path]),
	});
	const config = loadConfig(env, { secrets });
	assertEquals(config.expansion.peers, [{ id: 'worker', url: 'https://worker.example/a2a', token: 'test-peer-token' }]);
	assertEquals(config.expansion.sandbox?.token, 'a'.repeat(32));
	assertEquals(Object.keys(env).includes('TTK_SANDBOX_TOKEN'), false);
	assertEquals(Object.keys(env).includes('TTK_AGENT_PEERS'), false);
});

Deno.test('expansion config: duplicate, unknown, malformed peers fail without exposing secret-bearing content', async () => {
	for (
		const raw of [
			JSON.stringify([{ id: 'x', url: 'https://peer.example' }, { id: 'x', url: 'https://peer.example' }]),
			JSON.stringify([{ id: 'x', url: 'https://peer.example', token: 'sensitive-test-value' }]),
			JSON.stringify([{ id: '../x', url: 'https://peer.example' }]),
			'sensitive-test-value',
		]
	) {
		const error = await assertRejects(() =>
			resolveSecrets({
				env: { TTK_AGENT_PEERS_FILE: '/peers' },
				readFile: (): Promise<string> => Promise.resolve(raw),
			}), SecretError);
		assertEquals(error.message.includes('sensitive-test-value'), false);
	}
});
