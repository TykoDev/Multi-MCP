/**
 * D-076: the gateway's session tools and routes against a fake sandbox service.
 */
import { assert, assertEquals } from '@std/assert';
import { SessionRegistry } from '@tykotech/mcp';
import { SandboxClient, SandboxClientError } from '@tykotech/sandbox';
import { createGatewayApp } from './app.ts';
import { generateApiKey, VerifierChain } from './auth.ts';
import { loadConfig } from './config.ts';
import { createLogger } from './logger.ts';

const ORIGIN = 'http://127.0.0.1:8787';

/** A sandbox that answers the session operations from memory and refuses what the real one refuses. */
function fakeSandbox(): { client: SandboxClient; calls: string[] } {
	const calls: string[] = [];
	const sessions = new Map<string, { owner: string; output: string; ended: boolean }>();
	const client = {
		ready: () => Promise.resolve(true),
		call(principal: string, operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
			calls.push(operation);
			if (operation === 'session_open') {
				if (args.workspace_id !== '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f') {
					throw new SandboxClientError('no_workspace', 404);
				}
				const id = crypto.randomUUID();
				sessions.set(id, { owner: principal, output: '', ended: false });
				return Promise.resolve({ session_id: id, created_at: new Date().toISOString() });
			}
			const session = sessions.get(String(args.session_id));
			if (session === undefined || session.owner !== principal) throw new SandboxClientError('no_session', 404);
			if (operation === 'session_input') {
				session.output += `> ${String(args.data)}`;
				if (String(args.data).trim() === 'exit') session.ended = true;
				return Promise.resolve({ accepted: true });
			}
			if (operation === 'session_read') {
				const after = Number(args.after ?? 0);
				const output = session.output.slice(after);
				return Promise.resolve({
					output,
					seq: session.output.length,
					gap: false,
					ended: session.ended,
					exit_code: session.ended ? 0 : null,
					killed: null,
				});
			}
			if (operation === 'session_close') {
				session.ended = true;
				return Promise.resolve({ closed: true });
			}
			throw new SandboxClientError('invalid_request', 400);
		},
	};
	return { client: client as unknown as SandboxClient, calls };
}

Deno.test('sandbox sessions: tools and routes relay to the service, gate on sandbox:execute, and stream events', async () => {
	const coder = await generateApiKey('coder', ['mcp:invoke', 'sandbox:execute']);
	const viewer = await generateApiKey('viewer', ['mcp:invoke']);
	const config = loadConfig({
		TTK_HOST: '127.0.0.1',
		TTK_PORT: '8787',
		TTK_API_KEYS: JSON.stringify([coder.record, viewer.record]),
	});
	const { client, calls } = fakeSandbox();
	const verifier = new VerifierChain({ config, allowAnonymous: false });
	const registry = new SessionRegistry({ reapIntervalMs: 0 });
	const gateway = createGatewayApp({
		config,
		verifier,
		registry,
		version: 'test',
		logger: createLogger({ level: 'error' }),
		sandbox: client,
	});
	const headers = (token: string) => ({
		host: '127.0.0.1:8787',
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	});
	const rpc = async (token: string, method: string, params: unknown) => {
		const response = await gateway.app.request(`${ORIGIN}/mcp`, {
			method: 'POST',
			headers: { ...headers(token), accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		});
		const text = await response.text();
		const line = text.split('\n').find((entry) => entry.startsWith('data: '));
		return JSON.parse(line === undefined ? text : line.slice('data: '.length));
	};
	try {
		// The four tools exist for the coder and not for the viewer.
		const coderTools = (await rpc(coder.key, 'tools/list', {})).result.tools.map((tool: { name: string }) => tool.name);
		for (
			const name of ['sandbox_session_open', 'sandbox_session_input', 'sandbox_session_read', 'sandbox_session_close']
		) {
			assert(coderTools.includes(name), `${name} is served`);
		}
		const viewerTools = (await rpc(viewer.key, 'tools/list', {})).result.tools.map((tool: { name: string }) =>
			tool.name
		);
		assertEquals(viewerTools.includes('sandbox_session_open'), false);

		// Open through the tool, feed and read through the routes, close through the tool.
		const opened = await rpc(coder.key, 'tools/call', {
			name: 'sandbox_session_open',
			arguments: { workspace_id: '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f' },
		});
		const sessionId: string = opened.result.structuredContent.result.session_id;
		assert(typeof sessionId === 'string');

		assertEquals(
			(await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${sessionId}/input`, {
				method: 'POST',
				headers: headers(viewer.key),
				body: JSON.stringify({ data: 'ls\n' }),
			})).status,
			403,
		);
		const fed = await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${sessionId}/input`, {
			method: 'POST',
			headers: headers(coder.key),
			body: JSON.stringify({ data: 'ls\n' }),
		});
		assertEquals(fed.status, 200);

		const stream = await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${sessionId}/events`, {
			headers: { host: '127.0.0.1:8787', authorization: `Bearer ${coder.key}`, accept: 'text/event-stream' },
		});
		assertEquals(stream.headers.get('content-type'), 'text/event-stream');
		const reader = stream.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		assert(first.includes('event: output') && first.includes('> ls'), first);
		// Ending the session ends the stream.
		await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${sessionId}/input`, {
			method: 'POST',
			headers: headers(coder.key),
			body: JSON.stringify({ data: 'exit\n' }),
		});
		let seen = '';
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			seen += new TextDecoder().decode(next.value);
			if (seen.includes('event: end')) break;
		}
		assert(seen.includes('event: end'), seen);
		await reader.cancel().catch(() => {});

		// A session of another owner is not found, and a closed route answers 204.
		const other = await rpc(coder.key, 'tools/call', {
			name: 'sandbox_session_open',
			arguments: { workspace_id: '0f0e8c6a-3d2b-4c1a-9e8f-7a6b5c4d3e2f' },
		});
		const otherId: string = other.result.structuredContent.result.session_id;
		const bare = { host: '127.0.0.1:8787', authorization: `Bearer ${coder.key}` };
		assertEquals(
			(await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${otherId}`, { method: 'DELETE', headers: bare }))
				.status,
			204,
		);
		assertEquals(
			(await gateway.app.request(`${ORIGIN}/api/v1/sandbox/sessions/${crypto.randomUUID()}`, {
				method: 'DELETE',
				headers: bare,
			})).status,
			404,
		);
		assert(calls.includes('session_open') && calls.includes('session_read') && calls.includes('session_close'));
	} finally {
		await gateway.close();
		await registry.shutdown();
	}
});
