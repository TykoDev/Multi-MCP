/** A protocol fixture, deliberately no inference: exercises actual duplex subprocess I/O. */
const writer = Deno.stdout.writable.getWriter();
const sessions = new Map<string, { servers: unknown; canceled: boolean }>();
const permissions = new Map<number, (value: unknown) => void>();
let nextPermission = 1000;
/** A12: the fixture advertises `loadSession` and image/embedded-context prompts unless told not to. */
const advertiseLoad = !Deno.args.includes('--no-load-session');
async function send(value: Record<string, unknown>): Promise<void> {
	await writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}
async function handle(value: Record<string, unknown>): Promise<void> {
	const params = value.params as Record<string, unknown> ?? {};
	if (value.method === undefined) {
		permissions.get(Number(value.id))?.(value.result);
		permissions.delete(Number(value.id));
		return;
	}
	let result: Record<string, unknown> = {};
	if (value.method === 'initialize') {
		result = {
			protocolVersion: params.protocolVersion,
			agentCapabilities: {
				mcpCapabilities: { http: true },
				...(advertiseLoad ? { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } } : {}),
			},
			authMethods: [],
		};
	}
	if (value.method === 'session/load') {
		// A12: replay the conversation as updates, then answer with ACP's `null` load response.
		const sessionId = String(params.sessionId);
		sessions.set(sessionId, { servers: params.mcpServers, canceled: false });
		await send({
			jsonrpc: '2.0',
			method: 'session/update',
			params: {
				sessionId,
				update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `replayed ${sessionId}` } },
			},
		});
		await send({ jsonrpc: '2.0', id: value.id, result: null });
		return;
	}
	if (value.method === 'session/new') {
		const sessionId = crypto.randomUUID();
		sessions.set(sessionId, { servers: params.mcpServers, canceled: false });
		result = { sessionId };
	}
	if (value.method === 'session/cancel') {
		const session = sessions.get(String(params.sessionId));
		if (session) session.canceled = true;
		return;
	}
	if (value.method === 'session/prompt') {
		const sessionId = String(params.sessionId);
		const session = sessions.get(sessionId)!;
		const prompt = params.prompt as { text: string }[];
		const text = prompt[0]?.text ?? '';
		if (text === 'malformed') {
			await writer.write(new TextEncoder().encode('broken json\n'));
			return;
		}
		if (text === 'hold') {
			while (!session.canceled) await new Promise((resolve) => setTimeout(resolve, 10));
			result = { stopReason: 'cancelled' };
		} else {
			let output = `fixture processed: ${text}`;
			if (text === 'mcp') {
				const servers = session.servers as Record<string, unknown>[];
				const observed = await Promise.all(servers.map(async (server): Promise<Record<string, unknown>> => {
					const headers = server.headers as { name: string; value: string }[];
					const digest = new Uint8Array(
						await crypto.subtle.digest('SHA-256', new TextEncoder().encode(headers[0]?.value ?? '')),
					);
					return {
						name: server.name,
						url: server.url,
						bearerHash: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
					};
				}));
				output = JSON.stringify(observed);
			}
			if (text === 'echo_credentials') output = JSON.stringify(session.servers);
			if (text.startsWith('invoke_mcp:')) {
				const server = (session.servers as { url: string; headers: { name: string; value: string }[] }[])[0];
				if (!server) output = JSON.stringify({ missingScopedMcp: true });
				else {
					const invocation = JSON.parse(text.slice('invoke_mcp:'.length));
					const response = await fetch(server.url, {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
							'mcp-protocol-version': '2025-11-25',
							...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 123,
							method: 'tools/call',
							params: { name: invocation.tool, arguments: invocation.arguments },
						}),
					});
					const body = await response.text();
					const envelope = JSON.parse(
						body.startsWith('event:') || body.startsWith('data:')
							? body.split('\n').find((line) => line.startsWith('data:'))!.slice(5)
							: body,
					);
					output = JSON.stringify({
						httpStatus: response.status,
						...(envelope.error ? { error: envelope.error } : { result: envelope.result }),
					});
				}
			}
			if (text === 'permission') {
				const id = ++nextPermission;
				const decision = new Promise((resolve) => permissions.set(id, resolve));
				await send({
					jsonrpc: '2.0',
					id,
					method: 'session/request_permission',
					params: {
						sessionId,
						toolCall: { toolCallId: 'tool-1', title: 'Fixture operation' },
						options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, {
							optionId: 'always',
							name: 'Always',
							kind: 'allow_always',
						}],
					},
				});
				output = JSON.stringify(await decision);
			}
			await send({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId,
					update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } },
				},
			});
			result = { stopReason: session.canceled ? 'cancelled' : 'end_turn' };
		}
	}
	if (value.id !== undefined) await send({ jsonrpc: '2.0', id: value.id, result });
}
let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of Deno.stdin.readable) {
	buffer += decoder.decode(chunk, { stream: true });
	let index: number;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line) void handle(JSON.parse(line));
	}
}
writer.releaseLock();
