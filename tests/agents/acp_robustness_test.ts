import { assert, assertEquals, assertRejects } from '@std/assert';
import { AcpClient, type AcpCommand, AgentError } from '../../packages/agents/mod.ts';
import { lines } from '../../packages/agents/src/util.ts';
import { fromFileUrl } from '@std/path';

function command(): AcpCommand {
	return {
		id: 'robustness',
		executable: Deno.execPath(),
		args: ['run', '--no-config', fromFileUrl(new URL('./acp_robustness_fixture.ts', import.meta.url))],
		cwd: Deno.cwd(),
	};
}
async function initialize(client: AcpClient): Promise<void> {
	await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
}
async function session(client: AcpClient, mcpServers: readonly Record<string, unknown>[] = []): Promise<string> {
	return String((await client.request('session/new', { cwd: Deno.cwd(), mcpServers })).sessionId);
}
function text(update: Record<string, unknown>): string {
	return (update.update as { content: { text: string } }).content.text;
}

Deno.test('AG-3: agent diagnostics far beyond 256 KiB are drained and discarded without killing the agent', async (): Promise<void> => {
	const updates: Record<string, unknown>[] = [];
	const client = new AcpClient(command(), {
		update: (params): void => {
			updates.push(params);
		},
	});
	try {
		await initialize(client);
		const id = await session(client);
		const flood = { sessionId: id, prompt: [{ type: 'text', text: 'stderr_flood' }] };
		assertEquals(await client.request('session/prompt', flood), { stopReason: 'end_turn' });
		const after = { sessionId: id, prompt: [{ type: 'text', text: 'after' }] };
		assertEquals(await client.request('session/prompt', after), { stopReason: 'end_turn' });
		assertEquals(updates.map(text), ['fixture processed: stderr_flood', 'fixture processed: after']);
	} finally {
		await client.close();
	}
});

Deno.test('AG-4: a timed-out prompt fails alone, is cancelled at the agent, and the process keeps serving', async (): Promise<void> => {
	const updates: Record<string, unknown>[] = [];
	const client = new AcpClient(command(), {
		update: (params): void => {
			updates.push(params);
		},
	});
	try {
		await initialize(client);
		const id = await session(client);
		const other = await session(client);
		await assertRejects(
			() => client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'hold' }] }, 100),
			AgentError,
			'timed out',
		);
		// The prompt lock is released, the cancelled turn's late reply is dropped, and every session still works.
		assertEquals(
			await client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'same session' }] }),
			{ stopReason: 'end_turn' },
		);
		assertEquals(
			await client.request('session/prompt', { sessionId: other, prompt: [{ type: 'text', text: 'other session' }] }),
			{ stopReason: 'end_turn' },
		);
		assertEquals(updates.map(text), ['fixture processed: same session', 'fixture processed: other session']);
	} finally {
		await client.close();
	}
});

Deno.test('AG-9: agent requests of any method count against the 64 outstanding-callback bound', async (): Promise<void> => {
	const client = new AcpClient(command());
	try {
		await initialize(client);
		const id = await session(client);
		// The fixture stops reading and sends 100 unsupported-method requests whose replies cannot be written.
		await assertRejects(
			() =>
				client.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: 'flood_requests' }] }, 10_000),
			AgentError,
			'transport',
		);
		await assertRejects(() => client.request('session/new', { cwd: Deno.cwd(), mcpServers: [] }), AgentError, 'closed');
	} finally {
		await client.close();
	}
});

Deno.test('AG-8: a JSON-escaped delegation token is redacted from the parsed agent output', async (): Promise<void> => {
	const secret = 'test-escaped-scoped-key-with-enough-entropy';
	const allowed = { type: 'http', name: 'scoped', url: 'http://gateway:8787/mcp' };
	const updates: Record<string, unknown>[] = [];
	const client = new AcpClient({ ...command(), mcpServers: [allowed] }, {
		update: (params): void => {
			updates.push(params);
		},
	});
	try {
		await initialize(client);
		const id = await session(client, [{ ...allowed, headers: [{ name: 'Authorization', value: `Bearer ${secret}` }] }]);
		const prompt = { sessionId: id, prompt: [{ type: 'text', text: 'echo_escaped' }] };
		assertEquals(await client.request('session/prompt', prompt), { stopReason: 'end_turn' });
		assertEquals(updates.length, 1);
		assertEquals(JSON.stringify(updates).includes(secret), false);
		assertEquals(JSON.parse(text(updates[0]!))[0].headers[0].value, 'Bearer [REDACTED]');
	} finally {
		await client.close();
	}
});

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (offset >= bytes.length) return controller.close();
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}
async function collect(stream: ReadableStream<Uint8Array>, max?: number): Promise<string[]> {
	const out: string[] = [];
	for await (const line of lines(stream, max)) out.push(line);
	return out;
}

Deno.test('AG-11: a long line in small chunks is framed in linear time', async (): Promise<void> => {
	const payload = 'a'.repeat(768 * 1024);
	const bytes = new TextEncoder().encode(`${payload}\n{"next":true}\n`);
	const started = performance.now();
	const out = await collect(chunked(bytes, 16));
	const elapsed = performance.now() - started;
	assertEquals(out.length, 2);
	assertEquals(out[0]!.length, payload.length);
	assertEquals(out[1], '{"next":true}');
	// Re-encoding the whole partial line per chunk took several seconds here; the scan is now linear.
	assert(elapsed < 2_000, `framing took ${Math.round(elapsed)} ms`);
});

Deno.test('AG-11: byte framing keeps strict UTF-8, the line bound and blank-line semantics', async (): Promise<void> => {
	const encoder = new TextEncoder();
	// A multi-byte character split across one-byte chunks, CRLF, blank lines and a leading byte order mark.
	assertEquals(
		await collect(chunked(encoder.encode('\uFEFF{"a":"\u00E9\u20AC\u{1F600}"}\r\n\n  \n{"b":1}\n'), 1)),
		['{"a":"\u00E9\u20AC\u{1F600}"}\r', '{"b":1}'],
	);
	// Only the stream-leading BOM is dropped.
	assertEquals(await collect(chunked(encoder.encode('a\n\uFEFFb\n'), 3)), ['a', '\uFEFFb']);
	// The bound counts UTF-8 bytes, excluding the newline, for complete and still-partial lines alike.
	assertEquals(await collect(chunked(encoder.encode(`${'\u00E9'.repeat(8)}\n`), 5), 16), ['\u00E9'.repeat(8)]);
	await assertRejects(() => collect(chunked(encoder.encode(`${'\u00E9'.repeat(9)}\n`), 64), 16), AgentError, 'exceeds');
	await assertRejects(() => collect(chunked(encoder.encode('x'.repeat(17)), 4), 16), AgentError, 'exceeds');
	await assertRejects(() => collect(chunked(encoder.encode('{"a":1}\n{"b"'), 4)), AgentError, 'Incomplete');
	assertEquals(await collect(chunked(encoder.encode('{"a":1}\n  '), 4)), ['{"a":1}']);
	await assertRejects(() => collect(chunked(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]), 2)), TypeError);
	await assertRejects(() => collect(chunked(new Uint8Array([0x7b, 0xe2, 0x82, 0x0a]), 1)), TypeError);
	await assertRejects(() => collect(chunked(new Uint8Array([0x7b, 0xe2, 0x82]), 1)), TypeError);
});
