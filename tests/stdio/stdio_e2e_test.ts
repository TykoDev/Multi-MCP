/**
 * The stdio transport, driven as a real client would: spawn the CLI, speak
 * JSON-RPC over its stdin/stdout, and confirm the protocol owns stdout alone.
 */
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';

const ROOT = fromFileUrl(new URL('../..', import.meta.url));

interface Exchange {
	responses: Map<number, Record<string, unknown>>;
	stderr: string;
}

/** Sends a scripted set of requests and collects the replies. */
async function converse(
	messages: unknown[],
	expectIds: number[],
	options: { allowNet?: string; env?: Record<string, string> } = {},
): Promise<Exchange> {
	const command = new Deno.Command(Deno.execPath(), {
		args: [
			'run',
			`--allow-net=${options.allowNet ?? '127.0.0.1'}`,
			'--allow-read=.',
			'--allow-env',
			'packages/cli/mod.ts',
			'stdio',
		],
		cwd: ROOT,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped',
		env: { TTK_LOG_LEVEL: 'error', ...options.env },
	});
	const child = command.spawn();
	const writer = child.stdin.getWriter();
	const encoder = new TextEncoder();
	for (const message of messages) {
		await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
	}

	const responses = new Map<number, Record<string, unknown>>();
	const decoder = new TextDecoder();
	const reader = child.stdout.getReader();
	let buffer = '';
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline && !expectIds.every((id) => responses.has(id))) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim() === '') continue;
			try {
				const message = JSON.parse(line) as { id?: number };
				if (typeof message.id === 'number') responses.set(message.id, message as Record<string, unknown>);
			} catch {
				// A non-JSON line on stdout is itself a finding; captured below.
				responses.set(-1, { raw: line });
			}
		}
	}

	reader.releaseLock();
	await writer.close().catch(() => {});

	// Read stderr before killing, then close every stream: a child pipe left
	// open outlives the test and the sanitizer reports it as a leak.
	const errReader = child.stderr.getReader();
	const stderrChunk = await Promise.race([
		errReader.read(),
		new Promise<{ value: undefined }>((resolve) => setTimeout(() => resolve({ value: undefined }), 500)),
	]);
	const stderr = decoder.decode(stderrChunk.value ?? new Uint8Array());
	errReader.releaseLock();

	try {
		child.kill();
	} catch {
		// Already exited.
	}
	await child.status;
	await child.stdout.cancel().catch(() => {});
	await child.stderr.cancel().catch(() => {});
	return { responses, stderr };
}

Deno.test('stdio: initialize, tools/list and a tool call round-trip', async () => {
	const { responses } = await converse([
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
		},
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_list_sessions', arguments: {} } },
	], [1, 2, 3]);

	const initialize = responses.get(1);
	assert(initialize !== undefined, 'no initialize response');
	assertEquals((initialize.result as { protocolVersion?: string }).protocolVersion, '2025-06-18');
	// R14 (D-122, AC16): the identity and the instructions on stdio — a title and a description, but neither a
	// website nor an icon, because a stdio process has no public URL to point either at.
	const { serverInfo, instructions } = initialize.result as {
		serverInfo: Record<string, unknown>;
		instructions?: unknown;
	};
	assertEquals(serverInfo.name, 'tykotech-mcp');
	assertEquals(serverInfo.title, 'Multi-MCP');
	assert(typeof serverInfo.description === 'string' && serverInfo.description !== '', 'a description');
	assertEquals(serverInfo.websiteUrl, undefined, 'stdio advertises no website');
	assertEquals(serverInfo.icons, undefined, 'stdio advertises no icon');
	assert(typeof instructions === 'string' && new TextEncoder().encode(instructions).byteLength <= 2048, 'instructions');
	assert(!instructions.includes('live view'), 'stdio serves no live view, so the instructions say nothing about it');

	const list = responses.get(2);
	const names = ((list?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
	// stdio has no auth gate, so the caller is trusted with every tool its
	// *scopes* allow — which is `DEFAULT_SCOPES`, not the whole vocabulary (SEC-01).
	// Two other absences here have a different cause again: `browser_storage_state`
	// and `browser_record` carry R5 availability predicates, and this invocation
	// configures neither a data directory nor an encoder.
	assert(names.includes('browser_navigate'), names.join(','));
	// **SEC-01b inverted this assertion, and that is the finding rather than a
	// casualty of it.** `task` left the default grant in 0.2.0, so the stdio mount —
	// which carries no credential and therefore no explicit grant — no longer offers
	// the autonomous loop. An operator who wants it on stdio names it in
	// `TTK_ANON_SCOPES`. Asserting the absence rather than deleting the line keeps
	// the deny path tested on the tier that actually runs the mount.
	assert(!names.includes('browser_run_task'), 'SEC-01b: task must be named to be held, and stdio names nothing');
	// C7 / D-098 inverted this one the same way: `admin` left the default grant, so the credential-less mount no
	// longer offers `browser_close_all` unless TTK_ANON_SCOPES names admin.
	assert(!names.includes('browser_close_all'), 'C7: admin must be named to be held, and stdio names nothing');
	assert(!names.includes('browser_storage_state'), 'persistence needs TTK_DATA_DIR');
	assert(!names.includes('browser_record'), 'recording needs TTK_FFMPEG');
	assert(
		names.includes('browser_list_files') && names.includes('browser_get_file'),
		'E-33 file tools are on stdio too',
	);
	// B1.7: the event ring's third view is the only one that works here. The
	// stdio mount hosts no HTTP server, so neither the SSE route nor the
	// live-view socket exists — a tool that needed either would be absent or
	// broken, and this is where that would show.
	assert(names.includes('browser_wait_for'), 'browser_wait_for must work on a mount with no transport');
	// B1.12: a download is the browser's own transfer, so it needs no HTTP
	// mount. `browser_head` is the server's own request since SR-HEAD-REDIRECT,
	// and this child runs with the shipped-shaped `--allow-net=127.0.0.1`, so
	// the permissions API proves no outbound grant and the tool is not offered.
	assert(names.includes('browser_download'), 'browser_download is on stdio too');
	assert(!names.includes('browser_head'), 'browser_head needs a proven outbound grant (SR-HEAD-REDIRECT)');
	// B2.7 on the mount SEC-01 named as the third deny path: stdio has no credential to carry a grant, so
	// it receives DEFAULT_SCOPES and `evaluate` is not among them.
	assert(!names.includes('browser_evaluate'), 'the stdio mount holds no explicit grant');
	// B2.8 and B2.9 need no HTTP mount either: the ledger is in memory and the policy is constants.
	assert(names.includes('browser_fill_secret') && names.includes('browser_audit'), 'B2.8 works on stdio');
	assert(names.includes('browser_file_policy'), 'B2.9 works on stdio');
	// B3.2 is on stdio too: it needs no HTTP mount, only the registry.
	assert(names.includes('browser_health'), 'B3.2 works on stdio');
	// R4 (D-116): the inspection tools read the registry's own log and ring, so they need no HTTP mount either.
	assert(
		names.includes('browser_network_log') && names.includes('browser_console_log') &&
			names.includes('browser_har_export'),
		'R4 works on stdio',
	);
	// W2 (R10/R11): the three always-on browser outputs need no HTTP mount; the signed link does, and is absent.
	assert(
		names.includes('browser_pdf') && names.includes('browser_accessibility_snapshot') &&
			names.includes('browser_performance'),
		'W2 reads work on stdio',
	);
	assert(!names.includes('browser_file_link'), 'a signed link needs the HTTP route, which stdio does not have');
	// 57 in the catalog, minus six this mount cannot offer: `browser_evaluate`, since SEC-01b
	// `browser_run_task`, and since C7 `browser_close_all` (their scopes are in EXPLICIT_SCOPES and
	// TTK_ANON_SCOPES names none here, which is that mechanism seen from the credential-less mount),
	// `browser_storage_state` and `browser_record` (no data directory and no encoder in this child) and
	// `browser_head` (no provable outbound grant).
	//
	// **The six absences are asserted BY NAME and the count is kept as a second, weaker check.** This
	// tier was silently red for two revisions on exactly this number, because a count cannot say which
	// tool arrived or left and nobody ran the tier between revisions.
	assertEquals(
		[
			'browser_close_all',
			'browser_evaluate',
			'browser_head',
			// R9 (W7): MCP Apps needs the gateway's live-view socket; stdio never offers it (the catalog grows by two,
			// the count below does not).
			'browser_live_ticket',
			'browser_live_view',
			'browser_record',
			'browser_run_task',
			'browser_storage_state',
		]
			.filter((n) => names.includes(n)),
		[],
		`these must be absent on this mount: ${names.join(',')}`,
	);
	// mcp-recommendations: +3 inspection reads (W1) and +3 always-on browser outputs (W2).
	assertEquals(names.length, 47, names.join(','));

	const called = responses.get(3);
	const content = (called?.result as { content?: Array<{ text?: string }> })?.content ?? [];
	assert(content[0]?.text?.includes('sessions') === true, JSON.stringify(content));

	assertEquals(responses.get(-1), undefined, 'stdout carried a non-JSON line; the protocol owns it alone');
});

Deno.test('stdio: logs go to stderr, never stdout', async () => {
	const { responses, stderr } = await converse([
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
		},
	], [1]);

	assert(responses.has(1), 'the handshake must still succeed');
	// Anything the server says about itself belongs on stderr; a stray line on
	// stdout would corrupt the framing for every client.
	assertEquals(responses.get(-1), undefined);
	assert(!stderr.includes('"jsonrpc"'), 'protocol frames must not be duplicated to stderr');
});

/**
 * SR-HEAD-REDIRECT, the positive half in a real process: `browser_head` is
 * offered exactly when the process holds an outbound net grant for a public
 * host the allowlist names. The child here is started with such a grant — on
 * `docs.example`, a reserved name that resolves nowhere — and the test does
 * **not** call the tool: the probe consults the permissions API only, no
 * request leaves this machine, and the grant is a flag on a test child, not a
 * change to any task string, CMD or tier.
 */
Deno.test('stdio: browser_head is offered exactly when a public outbound grant is proven', async () => {
	const { responses, stderr } = await converse(
		[
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
			},
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		],
		[1, 2],
		{ allowNet: '127.0.0.1,docs.example', env: { TTK_ALLOWED_DOMAINS: 'docs.example' } },
	);
	const list = responses.get(2);
	assert(list !== undefined, `no tools/list response; stderr: ${stderr}`);
	const names = ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
	assert(names.includes('browser_head'), `browser_head should be offered under a public grant: ${names.join(',')}`);
	// The same 44 as above, plus browser_head under a public grant — and the other five
	// absences are still absent, asserted by name so this count cannot go stale alone.
	assertEquals(
		['browser_close_all', 'browser_evaluate', 'browser_record', 'browser_run_task', 'browser_storage_state']
			.filter((n) => names.includes(n)),
		[],
		`a public outbound grant must not add anything but browser_head: ${names.join(',')}`,
	);
	assertEquals(names.length, 48, names.join(','));
});

// --- mcp-recommendations W4: confirmations over the legacy shim, and no handoff on stdio (D-125, D-124) ---------

interface Io {
	send(message: unknown): Promise<void>;
	/** The next JSON-RPC message the server writes — a response, or a request of its own. */
	next(): Promise<Record<string, unknown>>;
}

/**
 * Runs one conversation that the server can take part in: unlike {@linkcode converse}, the script reads each message
 * before deciding what to send, which is what answering a server-to-client `elicitation/create` needs.
 */
async function interactive(env: Record<string, string>, script: (io: Io) => Promise<void>): Promise<void> {
	const child = new Deno.Command(Deno.execPath(), {
		args: ['run', '--allow-net=127.0.0.1', '--allow-read=.', '--allow-env', 'packages/cli/mod.ts', 'stdio'],
		cwd: ROOT,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped',
		env: { TTK_LOG_LEVEL: 'error', ...env },
	}).spawn();
	const writer = child.stdin.getWriter();
	const reader = child.stdout.getReader();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const queue: Record<string, unknown>[] = [];
	let buffer = '';
	const io: Io = {
		send: (message) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`)),
		next: async () => {
			while (queue.length === 0) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const late = new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error('the stdio server said nothing for 30 s')), 30_000);
				});
				try {
					const { value, done } = await Promise.race([reader.read(), late]);
					if (done) throw new Error('the stdio server closed stdout');
					buffer += decoder.decode(value, { stream: true });
				} finally {
					clearTimeout(timer);
				}
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) if (line.trim() !== '') queue.push(JSON.parse(line));
			}
			return queue.shift()!;
		},
	};
	try {
		await script(io);
	} finally {
		reader.releaseLock();
		await writer.close().catch(() => {});
		try {
			child.kill();
		} catch {
			// Already exited.
		}
		await child.status;
		await child.stdout.cancel().catch(() => {});
		await child.stderr.cancel().catch(() => {});
	}
}

/** `initialize` on the 2025 era with the given capabilities, then `initialized`. */
async function open(io: Io, capabilities: Record<string, unknown>): Promise<void> {
	await io.send({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'w4', version: '0' } },
	});
	assertEquals((await io.next()).id, 1);
	await io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

function closeAll(id: number): Record<string, unknown> {
	return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_close_all', arguments: {} } };
}

interface ToolResponse {
	id?: number;
	method?: string;
	result?: {
		isError?: boolean;
		content: Array<{ text: string }>;
		structuredContent?: { error?: { code: string; message: string } };
	};
}

Deno.test('stdio (D-125): a client that declared elicitation confirms browser_close_all through the shim', async () => {
	await interactive({ TTK_ANON_SCOPES: 'mcp:invoke,admin' }, async (io) => {
		await open(io, { elicitation: {} });
		const rounds: Array<[number, Record<string, unknown>, boolean]> = [
			[2, { action: 'decline' }, true],
			[3, { action: 'cancel' }, true],
			[4, { action: 'accept', content: { confirm: false } }, true],
			[5, { action: 'accept', content: { confirm: true } }, false],
		];
		for (const [id, answer, declined] of rounds) {
			await io.send(closeAll(id));
			// The 2025 shim turns the tool's `input_required` into a real server-to-client request.
			const asked = await io.next();
			assertEquals(asked.method, 'elicitation/create', JSON.stringify(asked));
			const params = asked.params as { message: string; requestedSchema: Record<string, unknown> };
			assert(params.message.startsWith('Close every browser session on this server?'), params.message);
			assertEquals(params.requestedSchema, {
				type: 'object',
				properties: { confirm: { type: 'boolean', title: 'Confirm' } },
				required: ['confirm'],
			});
			await io.send({ jsonrpc: '2.0', id: asked.id, result: answer });
			const response = (await io.next()) as ToolResponse;
			assertEquals(response.id, id);
			if (declined) {
				assertEquals(response.result?.isError, true, JSON.stringify(response));
				assert(response.result!.content[0]!.text.startsWith('Error: user-declined: '), JSON.stringify(response));
			} else {
				assertEquals(response.result?.isError, undefined, JSON.stringify(response));
				assertEquals(response.result?.content[0]?.text, 'Closed 0 sessions.');
			}
		}
	});
});

Deno.test('stdio (D-125): a client without elicitation, or with confirmations off, is never asked', async () => {
	const shapes: Array<[Record<string, string>, Record<string, unknown>]> = [
		[{ TTK_ANON_SCOPES: 'mcp:invoke,admin' }, {}],
		[{ TTK_ANON_SCOPES: 'mcp:invoke,admin', TTK_CONFIRM_DESTRUCTIVE: 'false' }, { elicitation: {} }],
	];
	for (const [env, capabilities] of shapes) {
		await interactive(env, async (io) => {
			await open(io, capabilities);
			await io.send(closeAll(2));
			const response = (await io.next()) as ToolResponse;
			assertEquals(response.method, undefined, `asked anyway: ${JSON.stringify(response)}`);
			assertEquals(response.id, 2);
			assertEquals(response.result?.content[0]?.text, 'Closed 0 sessions.');
		});
	}
});

Deno.test('stdio (D-124): the handoff is never offered on stdio, even with TTK_HUMAN_HANDOFF=true', async () => {
	await interactive({ TTK_HUMAN_HANDOFF: 'true' }, async (io) => {
		await open(io, { elicitation: { url: {} } });
		await io.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const list = (await io.next()) as { result: { tools: Array<{ name: string }> } };
		assert(!list.result.tools.some((tool) => tool.name === 'browser_request_human'), 'offered on stdio');
		await io.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'browser_request_human', arguments: { reason: 'help' } },
		});
		const refused = (await io.next()) as ToolResponse;
		assertEquals(refused.result?.isError, true);
		assertEquals(refused.result?.structuredContent?.error?.code, 'feature-unavailable');
		assert((refused.result?.structuredContent?.error?.message ?? '').includes('TTK_HUMAN_HANDOFF'));
	});
});
