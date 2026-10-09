/**
 * R12 (design §2.19, AC33): `sandbox_clone` through the gateway's own MCP mount, against a fake sandbox service whose
 * `/healthz` says whether it clones. Offered only while the sandbox is up and says `clone: true`; otherwise absent
 * from `tools/list`, and a call answers `feature-unavailable` naming the sandbox's switches, without a `feature`
 * extra. The admin diagnostics carry the same fact.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { SandboxClient } from '@tykotech/sandbox';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { ServiceHealth } from './service_health.ts';

const ORIGIN = 'http://127.0.0.1:8787';
const HEADERS = { host: '127.0.0.1:8787' };
const WORKSPACE = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
const LIMITS = {
	disk_budget_bytes: 1,
	disk_used_bytes: 0,
	file_bytes: 262144,
	exec_timeout_default_ms: 300000,
	exec_timeout_max_ms: 900000,
	exec_output_bytes: 1048576,
	session_idle_ms: 1800000,
	session_lifetime_ms: 14400000,
	session_input_bytes: 16384,
};

async function gatewayWith(
	health: { ok: boolean; clone?: boolean },
	watched = false,
	/** R3-9: what the sandbox answers a clone with, in place of a landed clone. */
	failure?: { status: number; body: Record<string, unknown> },
) {
	const admin = await generateApiKey('admin', ['admin']);
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const watcher = await generateApiKey('watcher', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([admin.record, coder.record, watcher.record]),
	});
	const calls: { path: string; body: unknown }[] = [];
	const sandbox = new SandboxClient({
		url: 'http://sandbox:8080',
		token: 'test-only-sandbox-service-token-0123456789',
		fetch: ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const path = new URL(String(input)).pathname;
			if (path === '/healthz') {
				return Promise.resolve(
					new Response(JSON.stringify({ ...health, backend: 'bwrap' }), { status: health.ok ? 200 : 503 }),
				);
			}
			calls.push({ path, body: JSON.parse(String(init?.body)) });
			if (failure !== undefined) {
				return Promise.resolve(new Response(JSON.stringify(failure.body), { status: failure.status }));
			}
			return Promise.resolve(
				new Response(JSON.stringify({
					workspace_id: WORKSPACE,
					created_at: new Date(0).toISOString(),
					commit: '80445e2e21d609fd261502c216b1847b40923c7d',
					ref: 'main',
					limits: LIMITS,
				})),
			);
		}) as typeof fetch,
	});
	await sandbox.ready();
	const services = watched ? new ServiceHealth({ sandbox: () => sandbox.ready() }, { intervalMs: 60_000 }) : undefined;
	await services?.start();
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox,
		...(services === undefined ? {} : { health: services }),
	});
	const rpc = async (key: string, method: string, params: Record<string, unknown>) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				...HEADERS,
				authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)).result;
	};
	const listed = async (key: string): Promise<string[]> =>
		((await rpc(key, 'tools/list', {})).tools as { name: string }[]).map((tool) => tool.name);
	const clone = (key: string, args: Record<string, unknown>) =>
		rpc(key, 'tools/call', { name: 'sandbox_clone', arguments: args });
	const diagnostics = async () => {
		const response = await gateway.app.request(`${ORIGIN}/api/v1/system/diagnostics`, {
			headers: { ...HEADERS, authorization: `Bearer ${admin.key}` },
		});
		return (await response.json()).config as Record<string, unknown>;
	};
	return {
		calls,
		listed,
		clone,
		diagnostics,
		coder: coder.key,
		watcher: watcher.key,
		close: async () => {
			services?.stop();
			await gateway.close();
		},
	};
}

Deno.test('R12 gateway: sandbox_clone is offered, and reaches the clone operation, only when /healthz says clone', async () => {
	const g = await gatewayWith({ ok: true, clone: true });
	try {
		assert((await g.listed(g.coder)).includes('sandbox_clone'));
		// Explicit scope: a caller who cannot run commands neither sees nor calls it (the message names no scope).
		assert(!(await g.listed(g.watcher)).includes('sandbox_clone'));
		assertEquals((await g.clone(g.watcher, { remote: 'app' })).structuredContent.error.code, 'scope-required');
		const result = await g.clone(g.coder, { remote: 'app', ref: 'main', depth: 3 });
		assertEquals(result.isError, undefined);
		assertEquals(result.structuredContent.result.commit, '80445e2e21d609fd261502c216b1847b40923c7d');
		assertEquals(g.calls.map((call) => [call.path, (call.body as { args: unknown }).args]), [
			['/v1/clone', { remote: 'app', ref: 'main', depth: 3 }],
		]);
		// Exactly one of url and remote, checked before the sandbox is asked.
		for (const args of [{}, { url: 'https://github.com/a.git', remote: 'app' }, { remote: 'app', depth: 0 }]) {
			assertEquals((await g.clone(g.coder, args)).structuredContent.error.code, 'invalid-arguments');
		}
		assertEquals(g.calls.length, 1);
		assertEquals((await g.diagnostics()).sandboxClone, true);
	} finally {
		await g.close();
	}
});

Deno.test('R12 gateway: without clone on the sandbox, sandbox_clone is withheld and names the sandbox switches', async () => {
	// A sandbox that says false, and one from before R12 that says nothing.
	for (const health of [{ ok: true, clone: false }, { ok: true }]) {
		const g = await gatewayWith(health);
		try {
			const tools = await g.listed(g.coder);
			assert(tools.includes('sandbox_create') && !tools.includes('sandbox_clone'), JSON.stringify(health));
			const refused = await g.clone(g.coder, { url: 'https://github.com/acme/app.git' });
			assertEquals(refused.isError, true);
			assertEquals(refused.structuredContent.error.code, 'feature-unavailable');
			assertEquals(refused.structuredContent.error.feature, undefined);
			assertStringIncludes(refused.content[0].text, 'TTK_SANDBOX_GIT_HOSTS');
			assertStringIncludes(refused.content[0].text, 'TTK_SANDBOX_GIT_REMOTES_FILE');
			assertEquals(g.calls, []);
			assertEquals((await g.diagnostics()).sandboxClone, false);
		} finally {
			await g.close();
		}
	}
});

Deno.test('R3-9 gateway: a failed clone says why in fixed words, under feature-unavailable, echoing nothing upstream', async () => {
	// What the sandbox service answers (workspaces.ts), plus an upstream diagnostic that must never reach the caller.
	const upstream = 'fatal: unable to access https://x-access-token:ghp_upstream_secret@github.com/acme/app.git';
	const cases: [number, string, string][] = [
		[502, 'clone_failed', 'the clone did not complete'],
		[504, 'clone_timeout', 'took longer than its time limit'],
		[507, 'over_budget', 'disk budget'],
		[409, 'run_busy', 'busy or removed'],
		[429, 'busy', 'provisioning another workspace'],
	];
	const texts = new Set<string>();
	for (const [status, code, says] of cases) {
		const g = await gatewayWith({ ok: true, clone: true }, false, { status, body: { error: code, message: upstream } });
		try {
			const refused = await g.clone(g.coder, { remote: 'app' });
			assertEquals(refused.isError, true, code);
			// No new MCP code: the wire keeps feature-unavailable for every one of them.
			assertEquals(refused.structuredContent.error.code, 'feature-unavailable', code);
			const text = refused.content[0].text as string;
			assertStringIncludes(text, says, code);
			assert(!/fatal|ghp_|x-access-token|github\.com|check the service configuration/.test(text), text);
			texts.add(text);
		} finally {
			await g.close();
		}
	}
	assertEquals(texts.size, cases.length, 'each code has its own words');
	// A failure outside the clone vocabulary keeps the generic, fixed text.
	const g = await gatewayWith({ ok: true, clone: true }, false, { status: 503, body: { error: 'cage_failed' } });
	try {
		const refused = await g.clone(g.coder, { remote: 'app' });
		assertEquals(refused.structuredContent.error.code, 'feature-unavailable');
		assertStringIncludes(refused.content[0].text, 'check the service configuration');
	} finally {
		await g.close();
	}
});

Deno.test('FXC-N1 (AC27): sandbox_clone keeps all five R3-9 texts exactly; other codes read the general sandbox table', async () => {
	const upstream = 'fatal: unable to access https://x-access-token:ghp_upstream_secret@github.com/acme/app.git';
	// R3-9's words, verbatim (F6): the general table's entries for run_busy, busy and over_budget must not replace them.
	const own: [number, string, string][] = [
		[
			502,
			'clone_failed',
			'the clone did not complete: check the url or remote, the ref, and that the repository exists and is ' +
			'reachable from the sandbox',
		],
		[504, 'clone_timeout', 'the clone took longer than its time limit: try a smaller depth or a larger timeout_ms'],
		[
			507,
			'over_budget',
			'the repository does not fit the workspace disk budget, or your workspaces already use your disk quota: try ' +
			'a smaller depth or remove a workspace',
		],
		[409, 'run_busy', 'the new workspace was busy or removed while it was being cloned: try again'],
		[
			429,
			'busy',
			'the sandbox is provisioning another workspace, or the workspace limit is reached: try again shortly or ' +
			'remove a workspace',
		],
	];
	// Codes outside the clone table fall to the general one, under the code their status always mapped to.
	const general: [number, string, string, string][] = [
		[404, 'no_workspace', 'file-unavailable', 'no such workspace'],
		[507, 'disk_full', 'feature-unavailable', 'the sandbox disk is full'],
		[413, 'too_large', 'feature-unavailable', 'the file or output is too large'],
	];
	const cases = [
		...own.map(([status, code, text]) => [status, code, 'feature-unavailable', text] as const),
		...general,
	];
	for (const [status, code, mcpCode, text] of cases) {
		const g = await gatewayWith({ ok: true, clone: true }, false, { status, body: { error: code, message: upstream } });
		try {
			const refused = await g.clone(g.coder, { remote: 'app' });
			assertEquals(refused.isError, true, code);
			assertEquals(refused.structuredContent.error.code, mcpCode, code);
			assertEquals(refused.content[0].text, `Error: ${mcpCode}: sandbox_clone could not complete: ${text}`, code);
		} finally {
			await g.close();
		}
	}
});

Deno.test('R12 gateway: a sandbox that clones but is down withholds sandbox_clone with the D-082 reason', async () => {
	const g = await gatewayWith({ ok: false, clone: true }, true);
	try {
		assert(!(await g.listed(g.coder)).includes('sandbox_clone'));
		const refused = await g.clone(g.coder, { remote: 'app' });
		assertEquals(refused.structuredContent.error.code, 'feature-unavailable');
		assertStringIncludes(refused.content[0].text, 'not reachable');
		assertEquals(g.calls, []);
	} finally {
		await g.close();
	}
});
