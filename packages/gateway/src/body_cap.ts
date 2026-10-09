/**
 * A5 (D-100): request bodies are bounded before anything reads them.
 *
 * **Why at the front, and not as a route middleware.** The MCP adapter's app (`createMcpHonoApp`) installs a JSON
 * body parser as its *first* middleware, ahead of the bearer gate: any request with a JSON content type, on any path,
 * is cloned and parsed in full before a credential is looked at. A cap installed inside that app would run after the
 * damage. So the gateway's front — which already answers the Host and Origin allowlists — reads the body here,
 * counted as it arrives, and hands the inner app a request whose body is the bytes it already holds.
 *
 * **Which cap applies.** R1-1: the adapter's parser keys on the content type, not the path, so the cap does too. A
 * JSON-typed body ({@linkcode isJsonFamily}) is capped on *every* path and method; a body of any other type keeps the
 * per-path rules A5 started with:
 *
 * | Request | JSON-typed body | Any other body |
 * | --- | --- | --- |
 * | `/mcp` | {@linkcode MCP_BODY_BYTES} — see E-83 | the same |
 * | `POST /api/v1/auth/login` | {@linkcode LOGIN_BODY_BYTES} (D-078's own 16 KiB) | the same |
 * | `PUT /api/v1/share/file` | `TTK_MAX_BODY_KB` (a JSON upload is a JSON body) | none here: streamed, 64 MiB (D-075) |
 * | any other `/api/v1/*`, `/a2a`, `/a2a/*` | `TTK_MAX_BODY_KB` | `TTK_MAX_BODY_KB` |
 * | any other path, any method | `TTK_MAX_BODY_KB` | none (no handler there reads a body; `GET`/`HEAD` neither) |
 *
 * A route with a tighter cap of its own (the agent-task and A2UI readers, 256 KiB) still applies it behind this one.
 * The declared `Content-Length` is checked first and the stream is counted regardless, so a declared length cannot lie
 * its way past the cap. Over the cap is `413 payload-too-large`; the body is cancelled, never drained.
 */

/** D-078: what the public sign-in route reads at most before it parses anything. */
export const LOGIN_BODY_BYTES = 16 * 1024;

/**
 * ERRATUM(E-83): the `/mcp` cap.
 *
 * E-06 recorded that the 4 MiB request cap comes from `createMcpHandler`'s own default. In the published
 * `@modelcontextprotocol/server@2.0.0` no such default exists — its HTTP entry reads `request.text()` unbounded, and
 * only the stdio transport has a buffer limit — and the adapter's JSON parser runs before authentication. So `/mcp`
 * accepted a body of any size from anyone who could reach the port. The figure the project believed in is applied
 * here instead; every tool's own input schema sits far below it (the largest, `skill_put`, carries at most 2 MiB).
 */
export const MCP_BODY_BYTES = 4 * 1024 * 1024;

/**
 * R1-1: whether a `Content-Type` names a JSON body — any `application/json`, any `+json` suffix, any member of the
 * family (`application/json-seq`, `application/jsonl`), in any case and with any parameters or list of types.
 *
 * Deliberately a **superset** of the adapter's own trigger (`isJsonContentType` in `@modelcontextprotocol/server`,
 * which accepts exactly the `application/json` essence): the cap must cover every body the adapter parses, and a
 * predicate written to match it exactly would silently stop covering it the day the SDK widens its own. Matching
 * the four letters anywhere errs towards capping a body nobody parses, which costs nothing.
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
	// D-075: streamed straight to a temporary file and counted there against 64 MiB; buffering it here would hold
	// the whole upload in memory for nothing. Only while it is not JSON: a JSON-typed upload is parsed in full by the
	// adapter before the route's counter, or authentication, ever runs.
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
 * Applies the cap for `request`: the same request when no cap applies or it has no body, otherwise a copy carrying
 * the bytes already read (headers, method, URL and abort signal preserved), or `too-large`.
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
