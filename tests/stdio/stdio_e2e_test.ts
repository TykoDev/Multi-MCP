/**
 * The stdio transport, driven as a real client would: spawn the CLI and speak JSON-RPC over its stdin/stdout. Every
 * line on stdout must parse as JSON: the protocol owns it alone.
 */
import { assert, assertEquals } from '@std/assert';
import { fromFileUrl } from '@std/path';

const ROOT = fromFileUrl(new URL('../..', import.meta.url));

type Message = Record<string, unknown>;

interface Io {
	send(message: unknown): Promise<void>;
	/** Reads until a message matches; every message read is kept in `seen`. */
	until(match: (message: Message) => boolean): Promise<Message>;
	readonly seen: Message[];
}

/** One conversation with a fresh `stdio` child under `--allow-net=<net>`. */
async function stdio(env: Record<string, string>, script: (io: Io) => Promise<void>, net = '127.0.0.1'): Promise<void> {
	const child = new Deno.Command(Deno.execPath(), {
		args: ['run', `--allow-net=${net}`, '--allow-read=.', '--allow-env', 'packages/cli/mod.ts', 'stdio'],
		cwd: ROOT,
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped',
		env: { TTK_LOG_LEVEL: 'error', ...env },
	}).spawn();
	const writer = child.stdin.getWriter();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	const queue: Message[] = [];
	let buffer = '';
	const io: Io = {
		seen: [],
		send: (message) => writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`)),
		until: async (match) => {
			for (;;) {
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
				const message = queue.shift()!;
				io.seen.push(message);
				if (match(message)) return message;
			}
		},
	};
	try {
		await script(io);
	} finally {
		reader.releaseLock();
		await writer.close().catch(() => {});
		try {
			child.kill();
		} catch { /* already exited */ }
		await child.status;
		await child.stdout.cancel().catch(() => {});
		await child.stderr.cancel().catch(() => {});
	}
}

/** `initialize` on the 2025 era with the given capabilities, then `initialized`; the initialize result. */
async function open(io: Io, capabilities: Message = {}): Promise<Message> {
	await io.send({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'test', version: '0' } },
	});
	const result = (await io.until((m) => m.id === 1)).result as Message;
	await io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
	return result;
}

async function call(io: Io, id: number, method: string, params: Message = {}): Promise<Message> {
	await io.send({ jsonrpc: '2.0', id, method, params });
	return (await io.until((m) => m.id === id)).result as Message;
}

const names = (result: Message): string[] => ((result.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);

interface ToolResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	structuredContent?: { error?: { code: string; message: string } };
}

Deno.test('stdio: initialize, grouped tools/list, a call by name, and the opened group', async () => {
	await stdio({}, async (io) => {
		const initialize = await open(io);
		assertEquals(initialize.protocolVersion, '2025-06-18');
		// A stdio process has no public URL: no website, no icon, and no live view in the instructions.
		const serverInfo = initialize.serverInfo as Message;
		assertEquals([serverInfo.name, serverInfo.title], ['tykotech-mcp', 'Multi-MCP']);
		assert(typeof serverInfo.description === 'string' && serverInfo.description !== '');
		assertEquals([serverInfo.websiteUrl, serverInfo.icons], [undefined, undefined]);
		const instructions = initialize.instructions as string;
		assert(new TextEncoder().encode(instructions).byteLength <= 2048 && !instructions.includes('live view'));

		// Tool groups are on by default: the first list holds the entry tools only, and a grouped tool answers by name.
		const grouped = names(await call(io, 2, 'tools/list'));
		assert(grouped.includes('use_browser') && grouped.every((name) => name.startsWith('use_')), grouped.join(','));
		const listed = (await call(io, 3, 'tools/call', { name: 'browser_list_sessions', arguments: {} })) as unknown;
		assert((listed as ToolResult).content[0]?.text.includes('sessions'), JSON.stringify(listed));
		const opened = (await call(io, 4, 'tools/call', { name: 'use_browser', arguments: {} })).structuredContent as {
			group?: string;
			tools?: unknown[];
		};
		assertEquals(opened.group, 'browser');
		const all = names(await call(io, 5, 'tools/list'));
		const browser = all.filter((name) => name.startsWith('browser_'));
		assertEquals(all.filter((name) => !name.startsWith('browser_')), grouped, 'the entry tools stay listed');
		assertEquals(opened.tools?.length, browser.length);
		assertEquals(io.seen.filter((m) => m.method === 'notifications/tools/list_changed').length, 1);

		// DEFAULT_SCOPES and no HTTP mount: the scoped tools (evaluate, task, admin), the tools that need a data dir, an
		// encoder, a proven outbound grant, or the live-view socket are absent; everything else is here.
		const absent = [
			'browser_close_all',
			'browser_evaluate',
			'browser_file_link',
			'browser_head',
			'browser_live_ticket',
			'browser_live_view',
			'browser_record',
			'browser_run_task',
			'browser_storage_state',
		];
		assertEquals(absent.filter((name) => browser.includes(name)), [], browser.join(','));
		for (
			const name of [
				'browser_navigate',
				'browser_wait_for',
				'browser_download',
				'browser_fill_secret',
				'browser_file_policy',
				'browser_network_log',
				'browser_har_export',
				'browser_pdf',
			]
		) {
			assert(browser.includes(name), name);
		}
		assertEquals(browser.length, 47, browser.join(','));
	});
});

Deno.test('stdio: browser_head is offered exactly when a public outbound grant is proven', async () => {
	// `docs.example` resolves nowhere, and the tool is never called: the probe consults the permissions API only.
	await stdio({ TTK_ALLOWED_DOMAINS: 'docs.example', TTK_MCP_TOOL_GROUPS: 'false' }, async (io) => {
		await open(io);
		const listed = names(await call(io, 2, 'tools/list'));
		assert(listed.includes('browser_head'), listed.join(','));
		const unchanged = ['browser_close_all', 'browser_evaluate', 'browser_record', 'browser_run_task'];
		assertEquals(unchanged.filter((name) => listed.includes(name)), []);
		assertEquals(listed.filter((name) => name.startsWith('browser_')).length, 48);
	}, '127.0.0.1,docs.example');
});

const closeAll = (io: Io, id: number) =>
	io.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_close_all', arguments: {} } });

Deno.test('stdio: a client that declared elicitation confirms browser_close_all through the 2025 shim', async () => {
	await stdio({ TTK_ANON_SCOPES: 'mcp:invoke,admin' }, async (io) => {
		await open(io, { elicitation: {} });
		const rounds: Array<[number, Message, boolean]> = [
			[2, { action: 'decline' }, true],
			[3, { action: 'cancel' }, true],
			[4, { action: 'accept', content: { confirm: false } }, true],
			[5, { action: 'accept', content: { confirm: true } }, false],
		];
		for (const [id, answer, declined] of rounds) {
			await closeAll(io, id);
			const asked = await io.until(() => true);
			assertEquals(asked.method, 'elicitation/create', JSON.stringify(asked));
			const params = asked.params as { message: string; requestedSchema: Message };
			assert(params.message.startsWith('Close every browser session on this server?'), params.message);
			assertEquals(params.requestedSchema, {
				type: 'object',
				properties: { confirm: { type: 'boolean', title: 'Confirm' } },
				required: ['confirm'],
			});
			await io.send({ jsonrpc: '2.0', id: asked.id, result: answer });
			const response = (await io.until((m) => m.id === id)).result as ToolResult;
			if (declined) assert(response.content[0]!.text.startsWith('Error: user-declined: '), JSON.stringify(response));
			else assertEquals([response.isError, response.content[0]?.text], [undefined, 'Closed 0 sessions.']);
		}
	});
});

Deno.test('stdio: a client without elicitation, or with confirmations off, is never asked', async () => {
	const shapes: Array<[Record<string, string>, Message]> = [
		[{ TTK_ANON_SCOPES: 'mcp:invoke,admin' }, {}],
		[{ TTK_ANON_SCOPES: 'mcp:invoke,admin', TTK_CONFIRM_DESTRUCTIVE: 'false' }, { elicitation: {} }],
	];
	for (const [env, capabilities] of shapes) {
		await stdio(env, async (io) => {
			await open(io, capabilities);
			await closeAll(io, 2);
			const response = await io.until(() => true);
			assertEquals(response.id, 2, `asked anyway: ${JSON.stringify(response)}`);
			assertEquals((response.result as ToolResult).content[0]?.text, 'Closed 0 sessions.');
		});
	}
});

Deno.test('stdio: the handoff is never offered on stdio, even with TTK_HUMAN_HANDOFF=true', async () => {
	// The flat list, or a grouped one would hide `browser_request_human` for the wrong reason.
	await stdio({ TTK_HUMAN_HANDOFF: 'true', TTK_MCP_TOOL_GROUPS: 'false' }, async (io) => {
		await open(io, { elicitation: { url: {} } });
		assert(!names(await call(io, 2, 'tools/list')).includes('browser_request_human'), 'offered on stdio');
		const refused = (await call(io, 3, 'tools/call', {
			name: 'browser_request_human',
			arguments: { reason: 'help' },
		})) as unknown as ToolResult;
		assertEquals(refused.structuredContent?.error?.code, 'feature-unavailable');
		assert((refused.structuredContent?.error?.message ?? '').includes('TTK_HUMAN_HANDOFF'));
	});
});

Deno.test('stdio (tool groups): a 2026-era connection lists the entry tools and hears its group open on subscriptions/listen', async () => {
	const _meta = {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientCapabilities': {},
		'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
	};
	await stdio({}, async (io) => {
		const request = (id: number, method: string, params: Message = {}) => call(io, id, method, { ...params, _meta });
		const announced = (): number => io.seen.filter((m) => m.method === 'notifications/tools/list_changed').length;
		const discovered = await request(1, 'server/discover') as {
			instructions?: string;
			capabilities?: { tykotech?: { tool_groups?: string[] } };
		};
		assertEquals(discovered.capabilities?.tykotech?.tool_groups, ['browser']);
		assert(discovered.instructions?.includes('use_browser'), discovered.instructions);
		await io.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'subscriptions/listen',
			params: { notifications: { toolsListChanged: true }, _meta },
		});
		await io.until((m) => m.method === 'notifications/subscriptions/acknowledged');
		assertEquals(names(await request(3, 'tools/list')), ['use_browser']);
		const opened = await request(4, 'tools/call', { name: 'use_browser', arguments: {} });
		assertEquals((opened.structuredContent as { group?: string }).group, 'browser');
		// The announcement rides the listen stream, so it may arrive on either side of the call's answer.
		if (announced() === 0) await io.until((m) => m.method === 'notifications/tools/list_changed');
		assert(names(await request(5, 'tools/list')).includes('browser_navigate'), 'the opened group is listed');
		assertEquals(announced(), 1, 'one announcement for the whole group');
	});
});
