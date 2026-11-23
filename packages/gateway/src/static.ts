/** Static hosting for the live-view SPA. */
import { serveDir } from '@std/http/file-server';
import { fromFileUrl, join } from '@std/path';
import type { Context, Hono } from 'hono';
import type { AppVariables } from './app.ts';
import type { Logger } from './logger.ts';

export interface StaticOptions {
	readonly app: Hono<{ Variables: AppVariables }>;
	readonly logger: Logger;
	/** Overrides asset discovery; used by tests. */
	readonly root?: string;
}

/** Locates the built SPA. */
export function resolveRoot(override?: string): { staticDir: string; distDir: string } | null {
	if (override !== undefined) return { staticDir: join(override, 'static'), distDir: join(override, 'dist') };
	try {
		const here = fromFileUrl(new URL('.', import.meta.url));
		const webRoot = join(here, '..', '..', 'web');
		const staticDir = join(webRoot, 'static');
		Deno.statSync(staticDir);
		return { staticDir, distDir: join(webRoot, 'dist') };
	} catch {
		return null;
	}
}

/** Puts the anti-framing posture actually in force. */
function applyFramingHeaders(headers: Headers): void {
	headers.set('content-security-policy', "frame-ancestors 'none'");
	headers.set('x-frame-options', 'DENY');
}

/** Makes the browser revalidate the SPA instead of reusing a cached copy. */
function applyRevalidationHeaders(headers: Headers): void {
	headers.set('cache-control', 'no-cache');
}

export function attachStatic(options: StaticOptions): void {
	const roots = resolveRoot(options.root);
	if (roots === null) {
		options.logger.warn('live-view assets not found; the SPA will not be served');
		return;
	}

	const { staticDir, distDir } = roots;

	// The bundle and the hand-written assets live in different directories, so /assets/ is resolved against both rather
	// than copying one into the other.
	options.app.get('/assets/*', async (c: Context) => {
		// Judged as `serveDir` will read it — percent-decoded — and case-folded, because the filesystem may not care
		// about case.
		let name: string;
		try {
			name = decodeURIComponent(new URL(c.req.url).pathname.slice('/assets/'.length)).toLowerCase();
		} catch {
			return c.notFound();
		}
		if (name.includes('..')) return c.notFound();
		// The MCP Apps embeds are `ui://` documents a host frames in its own sandbox origin, never pages of this
		// origin.
		if (name.startsWith('embed_') || name.startsWith('embed-src/')) return c.notFound();
		// The SPA document is served from `/` only, with its framing headers.
		if (name === '' || name.endsWith('/') || /\.x?html?$/.test(name)) return c.notFound();

		for (const [dir, prefix] of [[distDir, '/assets/'], [staticDir, '/assets/']] as const) {
			const response = await serveDir(c.req.raw, {
				fsRoot: dir,
				urlRoot: prefix.slice(1, -1),
				quiet: true,
				showIndex: false,
				showDirListing: false,
			});
			if (response.status !== 404) {
				// Belt and braces: nothing under /assets/ is meant to be framed either.
				applyFramingHeaders(response.headers);
				applyRevalidationHeaders(response.headers);
				return response;
			}
		}
		return c.notFound();
	});

	// The SPA is a single page; every non-API path renders it and the hash router decides what to show.
	options.app.get('/', async (c: Context) => {
		const response = await serveDir(c.req.raw, { fsRoot: staticDir, quiet: true });
		if (response.status === 404) {
			return c.text('The live-view bundle is missing. Run: deno task build:web', 503);
		}
		applyFramingHeaders(response.headers);
		applyRevalidationHeaders(response.headers);
		return response;
	});
}
