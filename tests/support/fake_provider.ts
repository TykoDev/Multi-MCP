/**
 * @module
 * D-143 W2: a loopback stand-in for a model provider, speaking both wire formats the clients dial — the OpenAI
 * chat-completions shape at `/v1/chat/completions` and the Anthropic Messages shape at `/v1/messages` — from one
 * scripted list of turns. Every request is recorded with its headers and parsed body, so a test can assert what the
 * client sent (the key header, the operator headers, the version header, the tool definitions, the transcript) and
 * how many times it dialled. Nothing here is reachable off the host: `127.0.0.1`, an ephemeral port.
 *
 * D-158: `GET /v1/models` answers `{ data: [{ id }] }` from `models` (a 404 while it is `null`), recorded like a call
 * with an empty body, so a test can assert the list request's headers too.
 */

/** A tool call the fake's next turn asks for. `raw` replaces the arguments on the wire with something unparsable. */
export interface FakeCall {
	readonly id?: string;
	readonly name: string;
	readonly arguments?: Record<string, unknown>;
	/** OpenAI: the literal `function.arguments` string; Anthropic: the literal `input` value (a non-object). */
	readonly raw?: unknown;
}

/** One scripted answer. The first matching shape wins; `text` alone is a complete assistant turn. */
export type FakeTurn =
	/** An assistant turn, with or without tool calls. */
	| {
		readonly text?: string;
		readonly calls?: readonly FakeCall[];
		readonly stop?: 'end' | 'length' | 'refusal' | 'other';
		readonly usage?: { readonly input: number; readonly output: number };
	}
	/** A text turn whose text is the request's `authorization` (or `x-api-key`) header — the redaction case. */
	| {
		readonly echo: true;
		readonly calls?: readonly FakeCall[];
		readonly usage?: { readonly input: number; readonly output: number };
	}
	/** An HTTP status, with an optional body and headers (a 503, a 401 quoting the key, a 302 to somewhere). */
	| { readonly status: number; readonly body?: string; readonly headers?: Readonly<Record<string, string>> }
	/** A raw answer: any status, headers and body (a wrong content-type, an oversize body, a non-object JSON). */
	| {
		readonly raw: {
			readonly status?: number;
			readonly headers: Readonly<Record<string, string>>;
			readonly body: string | Uint8Array<ArrayBuffer>;
			/** Stream the body in 64 KiB pieces with no `content-length`, so only the incremental cap can judge it. */
			readonly chunked?: boolean;
		};
	}
	/** No answer until the client gives up: the timeout and cancel cases. */
	| { readonly stall: true };

/** One request as the fake saw it. */
export interface RecordedRequest {
	readonly path: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Record<string, unknown>;
	/** When the fake received it, `performance.now()`. */
	readonly at: number;
	/** Whether the client abandoned it (a stalled turn that was cancelled or timed out). */
	aborted: boolean;
}

export interface FakeProvider {
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	/** `${origin}/v1` — what a providers file would hold as `base_url`. */
	readonly url: string;
	readonly requests: RecordedRequest[];
	/** Turns consumed in order; once empty, every request gets `fallback`. */
	script: FakeTurn[];
	fallback: FakeTurn;
	/** D-158: what `GET /v1/models` lists; `null` answers 404 (a provider without a model list). */
	models: string[] | null;
	/** The requests seen at a path the clients must never dial (a redirect target). */
	readonly stray: string[];
	close(): Promise<void>;
}

const DEFAULT_USAGE = { input: 10, output: 5 };

function openAiAnswer(
	turn: Exclude<FakeTurn, { echo: true } | { status: number } | { raw: unknown } | { stall: true }>,
	text: string,
): Response {
	const calls = turn.calls ?? [];
	const finish = turn.stop === 'length'
		? 'length'
		: turn.stop === 'refusal'
		? 'content_filter'
		: turn.stop === 'other'
		? 'weird'
		: calls.length
		? 'tool_calls'
		: 'stop';
	const usage = turn.usage ?? DEFAULT_USAGE;
	return Response.json({
		id: 'chatcmpl-fake',
		object: 'chat.completion',
		choices: [{
			index: 0,
			message: {
				role: 'assistant',
				content: text === '' ? null : text,
				...(calls.length
					? {
						tool_calls: calls.map((call, index) => ({
							id: call.id ?? `call_${index + 1}`,
							type: 'function',
							function: {
								name: call.name,
								arguments: call.raw !== undefined ? call.raw : JSON.stringify(call.arguments ?? {}),
							},
						})),
					}
					: {}),
			},
			finish_reason: finish,
		}],
		usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
	});
}

function anthropicAnswer(
	turn: Exclude<FakeTurn, { echo: true } | { status: number } | { raw: unknown } | { stall: true }>,
	text: string,
): Response {
	const calls = turn.calls ?? [];
	const stop = turn.stop === 'length'
		? 'max_tokens'
		: turn.stop === 'refusal'
		? 'refusal'
		: turn.stop === 'other'
		? 'weird'
		: calls.length
		? 'tool_use'
		: 'end_turn';
	const usage = turn.usage ?? DEFAULT_USAGE;
	return Response.json({
		id: 'msg_fake',
		type: 'message',
		role: 'assistant',
		content: [
			...(text === '' ? [] : [{ type: 'text', text }]),
			...calls.map((call, index) => ({
				type: 'tool_use',
				id: call.id ?? `toolu_${index + 1}`,
				name: call.name,
				input: call.raw !== undefined ? call.raw : call.arguments ?? {},
			})),
		],
		stop_reason: stop,
		usage: { input_tokens: usage.input, output_tokens: usage.output },
	});
}

/** Starts the fake on an ephemeral loopback port. */
export function startFakeProvider(): FakeProvider {
	const requests: RecordedRequest[] = [];
	const stray: string[] = [];
	const stalls = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const fake: Omit<FakeProvider, 'origin' | 'url' | 'close'> = {
		requests,
		stray,
		script: [],
		fallback: { text: 'done' },
		models: [],
	};
	const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen(): void {} }, async (request) => {
		const path = new URL(request.url).pathname;
		if (request.method === 'GET' && path === '/v1/models') {
			const headers: Record<string, string> = {};
			request.headers.forEach((value, name) => headers[name] = value);
			requests.push({ path, headers, body: {}, at: performance.now(), aborted: false });
			return fake.models === null
				? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
				: Response.json({ object: 'list', data: fake.models.map((id) => ({ id, object: 'model' })) });
		}
		const format = path === '/v1/chat/completions' ? 'openai' : path === '/v1/messages' ? 'anthropic' : undefined;
		if (format === undefined) {
			stray.push(path);
			return Response.json({ stray: true });
		}
		const headers: Record<string, string> = {};
		request.headers.forEach((value, name) => headers[name] = value);
		const record: RecordedRequest = {
			path,
			headers,
			body: await request.json() as Record<string, unknown>,
			at: performance.now(),
			aborted: false,
		};
		requests.push(record);
		const turn = fake.script.shift() ?? fake.fallback;
		if ('stall' in turn) {
			// Headers now, a body that never arrives: the client's abort (a cancel, a timeout) cancels this stream,
			// which is the one disconnect signal `Deno.serve` reports promptly. `close()` ends it so shutdown never
			// waits on a stall nobody will release.
			const body = new ReadableStream<Uint8Array>({
				start(controller): void {
					stalls.add(controller);
				},
				cancel(): void {
					record.aborted = true;
				},
			});
			return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if ('raw' in turn) {
			if (turn.raw.chunked) {
				const bytes = typeof turn.raw.body === 'string' ? new TextEncoder().encode(turn.raw.body) : turn.raw.body;
				let offset = 0;
				const stream = new ReadableStream<Uint8Array>({
					pull(controller): void {
						if (offset >= bytes.length) {
							controller.close();
							return;
						}
						controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
						offset += 64 * 1024;
					},
				});
				return new Response(stream, { status: turn.raw.status ?? 200, headers: turn.raw.headers });
			}
			return new Response(turn.raw.body, { status: turn.raw.status ?? 200, headers: turn.raw.headers });
		}
		if ('status' in turn) {
			return new Response(turn.body ?? '', {
				status: turn.status,
				headers: { 'content-type': 'application/json', ...(turn.headers ?? {}) },
			});
		}
		const text = 'echo' in turn
			? headers['authorization'] ?? headers['x-api-key'] ?? '(no credential header)'
			: turn.text ?? '';
		const answer = 'echo' in turn ? { calls: turn.calls, usage: turn.usage } : turn;
		return format === 'openai' ? openAiAnswer(answer, text) : anthropicAnswer(answer, text);
	});
	const origin = `http://127.0.0.1:${server.addr.port}`;
	return Object.assign(fake, {
		origin,
		url: `${origin}/v1`,
		close: (): Promise<void> => {
			for (const controller of stalls) {
				try {
					controller.close();
				} catch { /* already cancelled by the client */ }
			}
			stalls.clear();
			return server.shutdown();
		},
	});
}
