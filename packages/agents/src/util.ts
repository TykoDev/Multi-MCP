/** Protocol failures carry public, credential-free descriptions. */
export class AgentError extends Error {
	constructor(public readonly code: number, message: string) {
		super(message);
		this.name = 'AgentError';
	}
}

/** Refusal texts the runtime and the model loop share, so the two paths cannot drift. */
export const MCP_INVOKE_SCOPE_REQUIRED = 'mcp:invoke scope required';
/** Checked at submit and before every provider call: the scope that spends the operator's key. */
export const MODEL_INVOKE_SCOPE_REQUIRED = 'model:invoke scope required';
/** A `model` without a `provider` names nothing to run it on; refused before any task exists. */
export const MODEL_REQUIRES_PROVIDER = 'model requires provider';
export const SANDBOX_EXECUTE_SCOPE_REQUIRED = 'sandbox:execute scope required';

/** Terminal invariants are shared by transports, UI and MCP extension tools. */
export function terminal(state: string): boolean {
	return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state);
}

/** Why an ended task refuses `action`, naming how it ended: the one text every binding returns. */
export function endedTaskRefusal(state: string, action: string): string {
	return `Task cannot be ${action}: it has already ended (${state.replace('TASK_STATE_', '').toLowerCase()})`;
}

/** Reject non-object protocol envelopes rather than coercing untrusted values. */
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError(-32602, 'Expected an object');
	return value as Record<string, unknown>;
}

/** A bounded string identifier, never an executable or filesystem selector. */
export function identifier(value: unknown): string {
	if (
		typeof value !== 'string' || !value.length || value.length > 256 ||
		[...value].some((char) => char.charCodeAt(0) < 32)
	) {
		throw new AgentError(-32602, 'Invalid identifier');
	}
	return value;
}

/** Reads a stream to at most `limit` bytes, calling `over` (which throws) once it would exceed it. */
export async function readCapped(
	body: ReadableStream<Uint8Array>,
	limit: number,
	over: () => never,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) over();
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

/** Read a body incrementally so the size budget applies before JSON parsing. */
export async function readJson(body: ReadableStream<Uint8Array> | null, limit = 512 * 1024): Promise<unknown> {
	if (!body) throw new AgentError(-32700, 'Invalid JSON payload');
	const bytes = await readCapped(body, limit, () => {
		throw new AgentError(-32602, 'Payload exceeds limit');
	});
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		throw new AgentError(-32700, 'Invalid JSON payload');
	}
}

/** Operator-only endpoint validation; redirects are disabled at every fetch. */
export function serviceUrl(value: string): URL {
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new AgentError(-32602, 'Invalid configured service URL');
	}
	return url;
}

/** Waits `ms`, or rejects with the signal's reason first. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}

/** A pull-driven queue disconnects slow consumers instead of retaining unbounded data. */
export class EventQueue {
	#items: Record<string, unknown>[] = [];
	#waiter?: () => void;
	#closed = false;
	#bytes = 0;
	constructor(private readonly limit = 256, private readonly byteLimit = 2 * 1024 * 1024) {}
	push(value: Record<string, unknown>): void {
		if (this.#closed) return;
		const size = new TextEncoder().encode(JSON.stringify(value)).length;
		if (this.#items.length >= this.limit || this.#bytes + size > this.byteLimit) {
			this.close();
			this.#items = [];
			this.#bytes = 0;
			return;
		}
		this.#items.push(value);
		this.#bytes += size;
		this.#waiter?.();
	}
	close(): void {
		this.#closed = true;
		this.#waiter?.();
	}
	async next(): Promise<Record<string, unknown> | undefined> {
		while (!this.#items.length && !this.#closed) await new Promise<void>((resolve) => this.#waiter = resolve);
		this.#waiter = undefined;
		const value = this.#items.shift();
		if (value) this.#bytes -= new TextEncoder().encode(JSON.stringify(value)).length;
		return value;
	}
}
