/** Protocol failures carry public, credential-free descriptions. */
export class AgentError extends Error {
	constructor(public readonly code: number, message: string) {
		super(message);
		this.name = 'AgentError';
	}
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

/** Read a body incrementally so the size budget applies before JSON parsing. */
export async function readJson(body: ReadableStream<Uint8Array> | null, limit = 512 * 1024): Promise<unknown> {
	if (!body) throw new AgentError(-32700, 'Invalid JSON payload');
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new AgentError(-32602, 'Payload exceeds limit');
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		try {
			return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch {
			throw new AgentError(-32700, 'Invalid JSON payload');
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
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

/** Bounded newline transport shared by ACP framing and the private bridge. */
export async function* lines(
	stream: ReadableStream<Uint8Array>,
	max = 1024 * 1024,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const reader = stream.getReader();
	const abort = (): void => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();
	// AG-11: the partial line stays as raw bytes with a running count, and only each new chunk is scanned for
	// 0x0A, so a long line arriving in small chunks costs linear rather than quadratic time. 0x0A never occurs
	// inside a multi-byte UTF-8 sequence, so decoding each complete line strictly is the same check as before.
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	let partial: Uint8Array[] = [];
	let size = 0;
	let first = true;
	const decode = (tail: Uint8Array): string => {
		let bytes = tail;
		if (partial.length) {
			bytes = new Uint8Array(size + tail.length);
			let offset = 0;
			for (const chunk of partial) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			bytes.set(tail, offset);
		}
		partial = [];
		size = 0;
		const text = decoder.decode(bytes);
		// Only a byte order mark at the very start of the stream is dropped, as a streaming decoder would.
		const line = first && text.startsWith('\uFEFF') ? text.slice(1) : text;
		first = false;
		return line;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let offset = 0;
			let index: number;
			while ((index = value.indexOf(0x0a, offset)) >= 0) {
				if (size + index - offset > max) throw new AgentError(-32602, 'Protocol line exceeds limit');
				const line = decode(value.subarray(offset, index));
				offset = index + 1;
				if (line.trim()) yield line;
			}
			if (size + value.length - offset > max) throw new AgentError(-32602, 'Protocol line exceeds limit');
			if (offset < value.length) {
				partial.push(value.slice(offset));
				size += value.length - offset;
			}
		}
		if (size && decode(new Uint8Array()).trim()) throw new AgentError(-32700, 'Incomplete protocol line');
	} finally {
		signal?.removeEventListener('abort', abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
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
