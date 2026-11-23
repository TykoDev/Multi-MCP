/** Request bodies are bounded before anything reads them. */

/** What the public sign-in route reads at most before it parses anything. */
export const LOGIN_BODY_BYTES = 16 * 1024;

/** The `/mcp` cap. */
export const MCP_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Whether a `Content-Type` names a JSON body — any `application/json`, any `+json` suffix, any member of the family
 * (`application/json-seq`, `application/jsonl`), in any case and with any parameters or list of types.
 */
export function isJsonFamily(contentType: string | null | undefined): boolean {
	return contentType !== null && contentType !== undefined && /json/i.test(contentType);
}

/**
 * The cap for one request, or `null` when this layer leaves its body alone. `contentType` is the request's
 * `Content-Type` header as sent; absent means "not JSON".
 */
export function bodyCapOf(
	method: string,
	path: string,
	maxBodyBytes: number,
	contentType: string | null = null,
): number | null {
	const verb = method.toUpperCase();
	const json = isJsonFamily(contentType);
	// A real socket never delivers a GET or HEAD body (Deno drops it), but the adapter would parse one handed to
	// `app.fetch` all the same, so only a non-JSON one is waved through.
	if (!json && (verb === 'GET' || verb === 'HEAD')) return null;
	if (path === '/mcp') return MCP_BODY_BYTES;
	if (path === '/api/v1/auth/login') return LOGIN_BODY_BYTES;
	// Streamed straight to a temporary file and counted there against 64 MiB; buffering it here would hold the whole
	// upload in memory for nothing.
	if (verb === 'PUT' && path === '/api/v1/share/file') return json ? maxBodyBytes : null;
	if (json) return maxBodyBytes;
	if (path.startsWith('/api/v1/') || path === '/a2a' || path.startsWith('/a2a/')) return maxBodyBytes;
	return null;
}

/**
 * The whole body of `request`, counted as it arrives: `'too-large'` past `max` (the stream is cancelled, never
 * drained), `null` when there is no body.
 */
export async function readCappedBody(
	request: Request,
	max: number,
): Promise<Uint8Array<ArrayBuffer> | 'too-large' | null> {
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) {
		await request.body?.cancel().catch(() => {});
		return 'too-large';
	}
	if (request.body === null) return null;
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return 'too-large';
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}

/** What the front does with one request's body. */
export type CappedRequest =
	| { readonly kind: 'pass'; readonly request: Request }
	| { readonly kind: 'too-large'; readonly cap: number };

/**
 * Applies the cap for `request`: the same request when no cap applies or it has no body, otherwise a copy carrying the
 * bytes already read (headers, method, URL and abort signal preserved), or `too-large`.
 */
export async function capRequestBody(request: Request, maxBodyBytes: number): Promise<CappedRequest> {
	const cap = bodyCapOf(
		request.method,
		new URL(request.url).pathname,
		maxBodyBytes,
		request.headers.get('content-type'),
	);
	if (cap === null || request.body === null) return { kind: 'pass', request };
	const bytes = await readCappedBody(request, cap);
	if (bytes === 'too-large') return { kind: 'too-large', cap };
	if (bytes === null) return { kind: 'pass', request };
	return { kind: 'pass', request: new Request(request, { body: bytes }) };
}
