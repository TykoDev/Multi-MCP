import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { AcpClient, type AcpCommand, AgentError } from '../../packages/agents/mod.ts';
import { fromFileUrl } from '@std/path';

function command(): AcpCommand {
	return {
		id: 'fixture',
		executable: Deno.execPath(),
		args: ['run', '--no-config', fromFileUrl(new URL('./acp_fixture.ts', import.meta.url))],
		cwd: Deno.cwd(),
	};
}
async function session(client: AcpClient, mcpServers: readonly Record<string, unknown>[] = []): Promise<string> {
	await client.request('initialize', { protocolVersion: 1, clientCapabilities: { terminal: true } });
	return String((await client.request('session/new', { cwd: Deno.cwd(), mcpServers })).sessionId);
}

Deno.test('real ACP duplex process negotiates v1, streams updates and receives only operator MCP servers', async (): Promise<void> => {
	const updates: Record<string, unknown>[] = [];
	const servers = [{
		type: 'http',
		name: 'scoped',
		url: 'http://gateway:8787/mcp',
		headers: [{ name: 'Authorization', value: 'Bearer test-scoped-key-with-enough-entropy' }],
	}];
	const client = new AcpClient({ ...command(), mcpServers: servers }, {
		update: (params): void => {
			updates.push(params);
		},
	});
	try {
		const id = await session(client, servers);
		assertEquals(await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'mcp' }] }), {
			stopReason: 'end_turn',
		});
		assertEquals(updates.length, 1);
		const update = updates[0]!.update as { content: { text: string } };
		const digest = new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Bearer test-scoped-key-with-enough-entropy')),
		);
		assertEquals(JSON.parse(update.content.text), [{
			name: 'scoped',
			url: 'http://gateway:8787/mcp',
			bearerHash: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
		}]);
		await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'echo_credentials' }] });
		const echoed = (updates[1]!.update as { content: { text: string } }).content.text;
		assertEquals(echoed.includes('test-scoped-key-with-enough-entropy'), false);
		assertEquals(echoed.includes('[REDACTED]'), true);
		await assertRejects(
			() => client.request('session/new', { cwd: Deno.cwd(), mcpServers: [{ url: 'http://metadata/' }] }),
			AgentError,
			'delegation',
		);
		await assertRejects(() => client.request('fs/read_text_file', { path: '/etc/passwd' }), AgentError, 'unavailable');
	} finally {
		await client.close();
	}
});

Deno.test('A12: session/load is forwarded only when the agent advertised loadSession, and its replay reaches the caller', async () => {
	const updates: Record<string, unknown>[] = [];
	const client = new AcpClient(command(), { update: (params): void => void updates.push(params) });
	try {
		await session(client);
		await assertRejects(
			() => client.request('session/load', { sessionId: 'earlier', cwd: '/elsewhere', mcpServers: [] }),
			AgentError,
			'cwd',
		);
		// ACP answers a load with `null`; the client hands back an empty object rather than failing the transport.
		assertEquals(await client.request('session/load', { sessionId: 'earlier', cwd: Deno.cwd(), mcpServers: [] }), {});
		assertEquals((updates[0]?.update as { content: { text: string } }).content.text, 'replayed earlier');
		assertEquals(
			await client.request('session/prompt', { sessionId: 'earlier', prompt: [{ type: 'text', text: 'again' }] }),
			{ stopReason: 'end_turn' },
		);
	} finally {
		await client.close();
	}
	const plain = new AcpClient({ ...command(), args: [...command().args, '--no-load-session'] });
	try {
		await session(plain);
		await assertRejects(
			() => plain.request('session/load', { sessionId: 'earlier', cwd: Deno.cwd(), mcpServers: [] }),
			AgentError,
			'unavailable',
		);
	} finally {
		await plain.close();
	}
});

Deno.test('ACP permissions deny by default, reject persistent grants and support an explicit once choice', async (): Promise<void> => {
	for (const option of [undefined, 'always', 'once']) {
		const updates: Record<string, unknown>[] = [];
		const client = new AcpClient(command(), {
			update: (params): void => {
				updates.push(params);
			},
			...(option
				? {
					permission: (): Promise<Record<string, unknown>> =>
						Promise.resolve({ outcome: { outcome: 'selected', optionId: option } }),
				}
				: {}),
		});
		try {
			const id = await session(client);
			await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'permission' }] });
			const text = (updates[0]!.update as { content: { text: string } }).content.text;
			assertEquals(
				JSON.parse(text),
				option === 'once'
					? { outcome: { outcome: 'selected', optionId: 'once' } }
					: { outcome: { outcome: 'cancelled' } },
			);
		} finally {
			await client.close();
		}
	}
});

Deno.test('ACP cancellation interrupts prompt, parallel prompts fail, and malformed transport kills the process', async (): Promise<void> => {
	const client = new AcpClient(command());
	try {
		const id = await session(client);
		const pending = client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'hold' }] });
		await assertRejects(
			() => client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'also' }] }),
			AgentError,
			'already prompting',
		);
		await client.cancel(id);
		assertEquals(await pending, { stopReason: 'cancelled' });
		await assertRejects(
			() => client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'malformed' }] }),
			AgentError,
			'transport',
		);
	} finally {
		await client.close();
	}
	await assertRejects(() => client.request('initialize', { protocolVersion: 1 }), AgentError, 'closed');
	assertThrows(() => new AcpClient({ ...command(), executable: 'deno' }), AgentError, 'absolute');
});

Deno.test('ACP initialization, missing sessions, bounded framing and timeouts fail closed', async (): Promise<void> => {
	const client = new AcpClient(command());
	try {
		await assertRejects(
			() => client.request('session/new', { cwd: Deno.cwd(), mcpServers: [] }),
			AgentError,
			'initialize',
		);
		await assertRejects(() => client.request('initialize', { protocolVersion: 2 }), AgentError, 'v1');
		const id = await session(client);
		await assertRejects(() => client.cancel('missing'), AgentError, 'not found');
		await assertRejects(
			() => client.request('session/prompt', { sessionId: 'missing', prompt: [] }),
			AgentError,
			'not found',
		);
		await assertRejects(
			() => client.request('session/prompt', { sessionId: id, prompt: 'wrong' }),
			AgentError,
			'Invalid',
		);
		await assertRejects(
			() => client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'hold' }] }, 50),
			AgentError,
			'timed out',
		);
	} finally {
		await client.close();
	}
	const large = new AcpClient(command());
	try {
		const id = await session(large);
		await assertRejects(
			() =>
				large.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }),
			Error,
		);
	} finally {
		await large.close();
	}
	assert(true);
});
