import { type SandboxOperation } from './client.ts';
import { GateError } from './gate.ts';
import { LIMITS } from './limits.ts';
import { RequestError } from './request.ts';
import { ApiError } from './sandbox.ts';
import { type WorkspaceService } from './workspaces.ts';

const OPERATIONS = new Set<SandboxOperation>([
	'create',
	// R12 (design §2.19): a workspace from a git remote; refused unless the service was given git hosts or remotes.
	'clone',
	'list',
	'read',
	'write',
	'exec',
	'diff',
	'remove',
	'session_open',
	'session_input',
	'session_read',
	'session_close',
]);

async function digest(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

const encoder = new TextEncoder();

function json(status: number, data: unknown): Response {
	const text = JSON.stringify(data);
	// SB-6: nothing longer than the client accepts is sent; diffs are cut to fit before they get here
	// (fitDiff), so this only stops what no operation should produce.
	if (text.length * 3 > LIMITS.responseBytes && encoder.encode(text).length > LIMITS.responseBytes) {
		return json(500, { error: 'too_large' });
	}
	return new Response(text, {
		status,
		headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '5' } : {}) },
	});
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	if (Number(request.headers.get('content-length') ?? '0') > LIMITS.bodyBytes) {
		throw new ApiError(413, 'too_large', 'Request exceeds limit.');
	}
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > LIMITS.bodyBytes) throw new ApiError(413, 'too_large', 'Request exceeds limit.');
			chunks.push(chunk.value);
		}
	} finally {
		await reader?.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ApiError(400, 'invalid_json', 'Invalid JSON.');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new RequestError('body', 'must be an object');
	}
	return parsed as Record<string, unknown>;
}

/** Private HTTP adapter; bearer authentication precedes body parsing and principal selection. */
export async function createSandboxHandler(
	service: Pick<WorkspaceService, 'call' | 'health'>,
	token: string,
): Promise<(request: Request) => Promise<Response>> {
	if (token.length < 32 || /\s/.test(token)) throw new TypeError('Invalid sandbox service token.');
	const expected = await digest(token);
	return async (request): Promise<Response> => {
		try {
			const path = new URL(request.url).pathname;
			if (path === '/healthz' && request.method === 'GET') {
				const health = await service.health();
				return json(health.ok ? 200 : 503, health);
			}
			const operation = path.slice('/v1/'.length) as SandboxOperation;
			if (!path.startsWith('/v1/') || !OPERATIONS.has(operation)) return json(404, { error: 'not_found' });
			const presented = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
			const got = await digest(presented ?? '');
			let difference = 0;
			for (let index = 0; index < expected.length; index++) difference |= expected[index]! ^ got[index]!;
			if (!presented || difference !== 0) return json(401, { error: 'unauthorized' });
			if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
			if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
				throw new RequestError('body', 'application/json required');
			}
			const body = await readJson(request);
			if (Object.keys(body).some((field) => field !== 'principal' && field !== 'args')) {
				throw new RequestError('body', 'unknown field');
			}
			if (
				typeof body.principal !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)
			) throw new RequestError('body', 'principal and args required');
			return json(
				200,
				await service.call(body.principal, operation, body.args as Record<string, unknown>, request.signal),
			);
		} catch (error) {
			// Raw cage failures may contain host paths or caller-controlled command text.
			if (error instanceof RequestError) {
				return json(400, { error: 'invalid_request', message: 'Invalid operation arguments.' });
			}
			if (error instanceof ApiError || error instanceof GateError) return json(error.status, { error: error.code });
			if (error instanceof Deno.errors.NotFound) return json(404, { error: 'not_found' });
			if (error instanceof DOMException && error.name === 'AbortError') return json(499, { error: 'cancelled' });
			return json(500, { error: 'internal' });
		}
	};
}
