/**
 * E-6: `sandbox_create { from_share }`, the reachable directory listing, and the new reply fields, through the
 * gateway's tools against a fake sandbox service and a real library on a scratch data directory.
 *
 * FXC-N1 (design §2.8, AC27): every sandbox tool but `sandbox_clone` (whose own table `sandbox_clone_test.ts` pins)
 * names a failure by the service's private code in fixed words, and echoes nothing the service said.
 */
import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { LibraryStore, SessionRegistry } from '@tykotech/mcp';
import type { SandboxClient } from '@tykotech/sandbox';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';

Deno.test('sandbox tools: from_share seeds from the library and needs files:read; list reaches a directory', async () => {
	const dir = join('tests/.scratch', `seed-${crypto.randomUUID().slice(0, 8)}`);
	const library = new LibraryStore({ dataDir: dir });
	await library.initialize();
	await library.mkdir('templates/app/src');
	await library.writeBytes('templates/app/README.md', new TextEncoder().encode('# app\n'));
	await library.writeBytes('templates/app/src/main.ts', new TextEncoder().encode('console.log(1);\n'));
	await library.writeBytes('templates/bin/blob.bin', new Uint8Array([0, 159, 146, 150]));

	const both = await generateApiKey('both', ['mcp:invoke', 'sandbox:execute', 'files:read']);
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([both.record, coder.record]),
	});
	const calls: { operation: string; args: Record<string, unknown> }[] = [];
	const sandbox = {
		ready: () => Promise.resolve(true),
		call: (_principal: string, operation: string, args: Record<string, unknown>) => {
			calls.push({ operation, args });
			// D-113: the real service's reply shapes, which the tools' typed output schemas now check.
			return Promise.resolve(
				operation === 'create'
					? {
						workspace_id: 'w',
						created_at: new Date(0).toISOString(),
						name: 'from template',
						limits: {
							disk_budget_bytes: 1,
							disk_used_bytes: 0,
							file_bytes: 262144,
							exec_timeout_default_ms: 300000,
							exec_timeout_max_ms: 900000,
							exec_output_bytes: 1048576,
							session_idle_ms: 1800000,
							session_lifetime_ms: 14400000,
							session_input_bytes: 16384,
						},
					}
					: { entries: [], truncated: false },
			);
		},
	} as unknown as SandboxClient;
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox,
		library,
	});
	const call = async (key: string, name: string, args: Record<string, unknown>) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)).result;
	};
	try {
		const created = await call(both.key, 'sandbox_create', {
			name: 'from template',
			from_share: 'templates/app',
			files: { 'README.md': '# mine\n' },
		});
		assertEquals(created.isError, undefined);
		assertEquals(created.structuredContent.result.limits.file_bytes, 262144);
		assertEquals(calls.at(-1), {
			operation: 'create',
			args: { name: 'from template', files: { 'README.md': '# mine\n', 'src/main.ts': 'console.log(1);\n' } },
		});

		// Without files:read the share is not readable through the sandbox either.
		const refused = await call(coder.key, 'sandbox_create', { from_share: 'templates/app' });
		assertEquals(refused.structuredContent.error.code, 'scope-required');
		// A binary file is refused rather than seeded in part; a missing folder says so.
		const binary = await call(both.key, 'sandbox_create', { from_share: 'templates/bin' });
		assertEquals(binary.structuredContent.error.code, 'invalid-arguments');
		const missing = await call(both.key, 'sandbox_create', { from_share: 'templates/none' });
		assertEquals(missing.structuredContent.error.code, 'file-unavailable');
		assertEquals(calls.length, 1, 'no refused create reached the sandbox');

		// The listing inside a workspace is reachable; a path without a workspace is refused at the schema.
		const workspace = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
		await call(coder.key, 'sandbox_list', { workspace_id: workspace, path: 'src' });
		assertEquals(calls.at(-1), { operation: 'list', args: { workspace_id: workspace, path: 'src' } });
		const bad = await call(coder.key, 'sandbox_list', { path: 'src' });
		assertEquals(bad.structuredContent.error.code, 'invalid-arguments');
		assert(String(bad.content[0].text).includes('path needs workspace_id'));
	} finally {
		await gateway.close();
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
});

/** The general table of design §2.8, verbatim: private code → [HTTP status the service answers with, fixed words]. */
const SANDBOX_FAILURE_TEXTS: Readonly<Record<string, readonly [number, string]>> = {
	no_workspace: [404, 'no such workspace'],
	run_busy: [409, 'a command is already running in this workspace'],
	busy: [429, 'the sandbox is at capacity; retry later'],
	over_budget: [507, 'the workspace is over its disk or time budget'],
	too_large: [413, 'the file or output is too large'],
	bad_checkout: [409, 'the workspace checkout is not usable'],
	no_session: [404, 'no such shell session'],
	session_open: [409, 'a shell session is already open'],
	session_ended: [409, 'the shell session has ended'],
	no_repository: [409, 'the workspace has no repository'],
	diff_failed: [500, 'the diff could not be computed'],
	diff_timeout: [504, 'the operation timed out'],
	file_timeout: [504, 'the operation timed out'],
	disk_full: [507, 'the sandbox disk is full'],
};

Deno.test('FXC-N1 (AC27): each sandbox tool names each service failure code in fixed words, echoing nothing', async () => {
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([coder.record]),
		// 11 tools × 17 failures from one key: above the default 120 per minute.
		TTK_RATE_RPM: '100000',
	});
	const upstream = 'fatal: /srv/ws/0f0e token=ghp_upstream_secret at https://user:pass@internal.example/x';
	let failure: { status: number; code: string } = { status: 500, code: 'internal' };
	// What `SandboxClient.call` throws: a status and a private code. The message stands in for anything upstream.
	const sandbox = {
		ready: () => Promise.resolve(true),
		call: () => Promise.reject(Object.assign(new Error(upstream), failure)),
	} as unknown as SandboxClient;
	const gateway = createGatewayApp({
		config,
		verifier: new VerifierChain({ config, allowAnonymous: false }),
		registry: new SessionRegistry({ reapIntervalMs: 0 }),
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox,
	});
	const call = async (name: string, args: Record<string, unknown>) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: {
				host: '127.0.0.1:8787',
				authorization: `Bearer ${coder.key}`,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length)).result;
	};
	const ws = '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f';
	// Every sandbox tool except `sandbox_clone`, with arguments its schema accepts.
	const tools: Record<string, Record<string, unknown>> = {
		sandbox_create: { name: 'w' },
		sandbox_list: { workspace_id: ws },
		sandbox_read: { workspace_id: ws, path: 'a.txt' },
		sandbox_write: { workspace_id: ws, path: 'a.txt', content: 'x' },
		sandbox_exec: { workspace_id: ws, command: 'true' },
		sandbox_diff: { workspace_id: ws },
		sandbox_delete: { workspace_id: ws },
		sandbox_session_open: { workspace_id: ws },
		sandbox_session_input: { session_id: ws, data: 'ls\n' },
		sandbox_session_read: { session_id: ws },
		sandbox_session_close: { session_id: ws },
	};
	const generic = (name: string, code: string) =>
		`Error: ${code}: ${name} could not complete; check the service configuration and operation`;
	try {
		for (const [name, args] of Object.entries(tools)) {
			for (const [privateCode, [status, words]] of Object.entries(SANDBOX_FAILURE_TEXTS)) {
				failure = { status, code: privateCode };
				const result = await call(name, args);
				// The status-to-code mapping is unchanged: 404 → file-unavailable, anything else here → feature-unavailable.
				const code = status === 404 ? 'file-unavailable' : 'feature-unavailable';
				assertEquals(result.isError, true, `${name} ${privateCode}`);
				assertEquals(result.structuredContent.error.code, code, `${name} ${privateCode}`);
				assertEquals(result.content[0].text, `Error: ${code}: ${name} could not complete: ${words}`);
				assert(!/fatal|ghp_|user:pass|internal\.example|\/srv\//.test(JSON.stringify(result)), name);
			}
			// `cage_failed` and an unlisted code keep the generic words; a 400 stays invalid-arguments.
			for (
				const [status, privateCode, code] of [
					[503, 'cage_failed', 'feature-unavailable'],
					[500, 'internal', 'feature-unavailable'],
					[400, 'invalid_request', 'invalid-arguments'],
				] as const
			) {
				failure = { status, code: privateCode };
				const result = await call(name, args);
				assertEquals(result.content[0].text, generic(name, code), `${name} ${privateCode}`);
			}
		}
	} finally {
		await gateway.close();
	}
});
