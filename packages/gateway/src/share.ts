/**
 * The file share over HTTP (D-075): what the MCP tools cannot carry — binary and large files, streamed both ways.
 *
 * `GET /api/v1/share?path=` lists, `GET /api/v1/share/file?path=` downloads as an attachment, `PUT` on the same
 * path uploads a raw body of at most 64 MiB into a temporary file that is renamed into place, `POST
 * /api/v1/share/mkdir` and `/move` take JSON, `DELETE /api/v1/share?path=` removes. Reads take `files:read`,
 * everything else `files:write`. Every path goes through the store's one resolver, so the rules are the tools'.
 */
import type { Context, Hono } from 'hono';
import { LIBRARY_LIMITS, LibraryError, type LibraryStore } from '@tykotech/mcp';
import type { Principal } from './auth.ts';
import type { Scope } from './config.ts';
import { problemResponse } from './problem.ts';

/** A conservative download type: never something a browser would render as a document of this origin. */
function downloadType(path: string): string {
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	const safe: Record<string, string> = {
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		pdf: 'application/pdf',
		json: 'application/json',
		txt: 'text/plain; charset=utf-8',
		md: 'text/plain; charset=utf-8',
		csv: 'text/csv; charset=utf-8',
	};
	return safe[extension] ?? 'application/octet-stream';
}

function attachmentName(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1) || 'file';
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function shareProblem(c: Context, cause: unknown): Response {
	if (cause instanceof LibraryError) {
		const slug = cause.code === 'not-found'
			? 'not-found'
			: cause.code === 'exists' || cause.code === 'not-empty'
			? 'conflict'
			: cause.code === 'too-large'
			? 'payload-too-large'
			: 'invalid-request';
		return problemResponse(slug, c.get('requestId'), cause.message);
	}
	if (cause instanceof Deno.errors.NotFound) return problemResponse('not-found', c.get('requestId'), 'no such path');
	throw cause;
}

export function attachShareRoutes(
	app: Hono<{ Variables: { principal: Principal; requestId: string } }>,
	store: LibraryStore | null,
): void {
	const require = (c: Context, scope: Scope): Response | null => {
		const principal = c.get('principal') as Principal | undefined;
		if (principal === undefined) return problemResponse('unauthenticated', c.get('requestId'));
		if (!principal.scopes.has(scope)) {
			return problemResponse('forbidden-scope', c.get('requestId'), `the ${scope} scope is required`);
		}
		if (store === null) {
			return problemResponse('persistence-required', c.get('requestId'), 'the file share needs TTK_DATA_DIR');
		}
		return null;
	};
	const pathOf = (c: Context): string => c.req.query('path') ?? '';

	app.get('/api/v1/share', async (c: Context) => {
		const denied = require(c, 'files:read');
		if (denied !== null) return denied;
		try {
			return c.json(await store!.list(pathOf(c)));
		} catch (cause) {
			return shareProblem(c, cause);
		}
	});

	app.get('/api/v1/share/file', async (c: Context) => {
		const denied = require(c, 'files:read');
		if (denied !== null) return denied;
		try {
			const { path, absolute, size } = await store!.locate(pathOf(c));
			if (size > LIBRARY_LIMITS.restFileBytes) {
				return problemResponse('payload-too-large', c.get('requestId'), `${path} is larger than the download limit`);
			}
			const file = await Deno.open(absolute, { read: true });
			return new Response(file.readable, {
				headers: {
					'content-type': downloadType(path),
					'content-length': String(size),
					'content-disposition': attachmentName(path),
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
				},
			});
		} catch (cause) {
			return shareProblem(c, cause);
		}
	});

	app.put('/api/v1/share/file', async (c: Context) => {
		const denied = require(c, 'files:write');
		if (denied !== null) return denied;
		const declared = Number(c.req.header('content-length') ?? '0');
		if (declared > LIBRARY_LIMITS.restFileBytes) {
			return problemResponse('payload-too-large', c.get('requestId'), 'the upload is over 64 MiB');
		}
		let target: Awaited<ReturnType<LibraryStore['uploadTarget']>>;
		try {
			target = await store!.uploadTarget(pathOf(c));
		} catch (cause) {
			return shareProblem(c, cause);
		}
		const body = c.req.raw.body;
		const file = await Deno.open(target.temporary, { write: true, create: true, truncate: true });
		let written = 0;
		try {
			if (body !== null) {
				const reader = body.getReader();
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					written += value.length;
					if (written > LIBRARY_LIMITS.restFileBytes) {
						await reader.cancel().catch(() => {});
						throw new LibraryError('too-large', 'the upload is over 64 MiB');
					}
					let offset = 0;
					while (offset < value.length) offset += await file.write(value.subarray(offset));
				}
			}
			file.close();
			const entry = await target.commit();
			return c.json({ ...entry }, 201);
		} catch (cause) {
			try {
				file.close();
			} catch {
				// Already closed.
			}
			await Deno.remove(target.temporary).catch(() => {});
			return shareProblem(c, cause);
		}
	});

	app.delete('/api/v1/share', async (c: Context) => {
		const denied = require(c, 'files:write');
		if (denied !== null) return denied;
		try {
			await store!.remove(pathOf(c), c.req.query('recursive') === 'true');
			return c.body(null, 204);
		} catch (cause) {
			return shareProblem(c, cause);
		}
	});

	app.post('/api/v1/share/mkdir', async (c: Context) => {
		const denied = require(c, 'files:write');
		if (denied !== null) return denied;
		try {
			const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
			return c.json({ ...await store!.mkdir(body?.path) }, 201);
		} catch (cause) {
			return shareProblem(c, cause);
		}
	});

	app.post('/api/v1/share/move', async (c: Context) => {
		const denied = require(c, 'files:write');
		if (denied !== null) return denied;
		try {
			const body = await c.req.json().catch(() => null) as { from?: unknown; to?: unknown } | null;
			return c.json({ ...await store!.move(body?.from, body?.to) });
		} catch (cause) {
			return shareProblem(c, cause);
		}
	});
}
