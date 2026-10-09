/**
 * A protocol fixture for transport robustness regressions, deliberately no inference. Unlike `acp_fixture.ts`
 * it cancels per prompt, so a session keeps working after a cancelled or timed-out turn.
 */
const writer = Deno.stdout.writable.getWriter();
const sessions = new Map<string, { servers: { headers?: { value: string }[] }[]; cancel?: () => void }>();
const permissions = new Map<number, (value: unknown) => void>();
let nextPermission = 1000;
let stalled = false;
async function send(value: Record<string, unknown>): Promise<void> {
	await writer.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
}
function update(sessionId: string, text: string): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		method: 'session/update',
		params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
	};
}
async function prompt(sessionId: string, text: string): Promise<string | undefined> {
	const session = sessions.get(sessionId)!;
	if (text === 'hold') {
		await new Promise<void>((resolve) => session.cancel = resolve);
		return 'cancelled';
	}
	if (text === 'stderr_flood') {
		// Far beyond any lifetime diagnostics budget; a healthy client drains and discards it.
		const chunk = new TextEncoder().encode(`${'diagnostic '.repeat(1489)}\n`);
		for (let written = 0; written < 1024 * 1024; written += chunk.length) await Deno.stderr.write(chunk);
	}
	if (text === 'flood_requests') {
		// Stop reading stdin, then ask for more replies than any bound allows. Each reply echoes a 64 KiB id,
		// so the client's writes back to this process block and its outstanding replies pile up.
		stalled = true;
		setInterval(() => {}, 1_000);
		for (let index = 0; index < 100; index++) {
			await send({ jsonrpc: '2.0', id: `${index}-${'x'.repeat(64 * 1024)}`, method: 'fs/read_text_file', params: {} });
		}
		return undefined;
	}
	if (text === 'echo_escaped') {
		// The delegated bearer token leaves only as a JSON escape, so no raw-line match can see it.
		let line = JSON.stringify(update(sessionId, JSON.stringify(session.servers)));
		for (const server of session.servers) {
			for (const header of server.headers ?? []) {
				const token = header.value.slice('Bearer '.length);
				const escaped = `\\u${token.charCodeAt(0).toString(16).padStart(4, '0')}${token.slice(1)}`;
				line = line.split(token).join(escaped);
			}
		}
		await writer.write(new TextEncoder().encode(`${line}\n`));
		return 'end_turn';
	}
	let output = `fixture processed: ${text}`;
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
				options: [
					{ optionId: 'once', name: 'Allow once', kind: 'allow_once' },
					{ optionId: 'always', name: 'Always', kind: 'allow_always' },
				],
			},
		});
		output = JSON.stringify(await decision);
	}
	await send(update(sessionId, output));
	return 'end_turn';
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
			agentCapabilities: { mcpCapabilities: { http: true } },
			authMethods: [],
		};
	}
	if (value.method === 'session/new') {
		const sessionId = crypto.randomUUID();
		sessions.set(sessionId, { servers: params.mcpServers as { headers?: { value: string }[] }[] });
		result = { sessionId };
	}
	if (value.method === 'session/cancel') {
		const session = sessions.get(String(params.sessionId));
		session?.cancel?.();
		if (session) session.cancel = undefined;
		return;
	}
	if (value.method === 'session/prompt') {
		const prompt0 = (params.prompt as { text: string }[])[0]?.text ?? '';
		const stopReason = await prompt(String(params.sessionId), prompt0);
		if (stopReason === undefined) return;
		result = { stopReason };
	}
	if (value.id !== undefined) await send({ jsonrpc: '2.0', id: value.id, result });
}
const reader = Deno.stdin.readable.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (!stalled) {
	const { done, value } = await reader.read();
	if (done) break;
	buffer += decoder.decode(value, { stream: true });
	let index: number;
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line) void handle(JSON.parse(line));
	}
}
if (!stalled) writer.releaseLock();
