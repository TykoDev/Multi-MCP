/**
 * Static hosting for the live-view SPA.
 *
 * Same-origin by design: no CORS headers are emitted anywhere, which is what
 * lets the page's `connect-src 'self'` hold and keeps the browser-origin
 * default-deny meaningful.
 */
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

/**
 * Locates the built SPA.
 *
 * The bundle is produced by `deno task build:web`; when it is missing the
 * gateway still serves its API and says so, rather than 404ing in a way that
 * looks like a routing bug.
 *
 * Exported for the MCP Apps embeds (R9, `mcp_apps.ts`), which are read from the same `dist` directory: one
 * resolver, so the documents a host frames and the SPA the gateway serves always come from one build.
 */
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

/**
 * Puts the anti-framing posture actually in force (F5).
 *
 * `static/index.html` has declared `frame-ancestors 'none'` in a `<meta>` CSP
 * since 0.1.0, and **browsers ignore `frame-ancestors` delivered that way** —
 * Chromium logs exactly that on every load. The directive is only enforceable
 * from a response header, so the page that holds a live credential in memory and
 * drives a logged-in browser was framable by anyone, which is the setup for a
 * clickjacked "Take control".
 *
 * Sent as a second, deliberately minimal CSP rather than by moving the whole
 * policy off the meta tag: two full copies of a policy drift, and CSP composes by
 * intersection, so a header carrying only what a meta tag cannot carry can never
 * contradict the one in the document. `X-Frame-Options` rides along for the
 * browsers that predate `frame-ancestors`.
 */
function applyFramingHeaders(headers: Headers): void {
	headers.set('content-security-policy', "frame-ancestors 'none'");
	headers.set('x-frame-options', 'DENY');
}

/**
 * Makes the browser revalidate the SPA instead of reusing a cached copy (B6.3).
 *
 * The bundle's filenames are **not** content-hashed — it is always `/assets/app.js`
 * and `/assets/app.css` — and `serveDir` sends `ETag` and `Last-Modified` but no
 * `Cache-Control`. With no explicit policy a browser applies *heuristic* caching
 * and may reuse a stored response without asking, so a viewer who used the page
 * before an upgrade keeps running the old bundle against the new server. That was
 * observed, not theorised: during B6's own container verification the browser
 * served a stylesheet cached from the previous session's image, and the fix under
 * test appeared not to work until the cache was bypassed.
 *
 * It matters most for exactly this release. A cached 0.1.0 bundle does not answer
 * the keep-alive `ping`, so the very client the F1 fix is for would keep being
 * reaped — quietly, and only until the grace window instead of never.
 *
 * `no-cache` means "revalidate", not "do not store": the `ETag` still turns an
 * unchanged asset into a 304 with no body, so this costs one conditional request
 * per asset per load, not a re-download.
 */
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

	// The bundle and the hand-written assets live in different directories, so
	// /assets/ is resolved against both rather than copying one into the other.
	options.app.get('/assets/*', async (c: Context) => {
		// Review R1-2: judged as `serveDir` will read it — percent-decoded — and case-folded, because the filesystem
		// may not care about case. The raw path let `/assets/%65mbed_live.html` past the embed check below and into a
		// file server that decoded it to the embed. A name that does not decode names no file here.
		let name: string;
		try {
			name = decodeURIComponent(new URL(c.req.url).pathname.slice('/assets/'.length)).toLowerCase();
		} catch {
			return c.notFound();
		}
		if (name.includes('..')) return c.notFound();
		// R9 (D-135): the MCP Apps embeds are `ui://` documents a host frames in its own sandbox origin, never pages of
		// this origin. Served from here they would run under our origin with an unsubstituted CSP and no framing
		// header, which buys nothing and is one more thing to reason about.
		if (name.startsWith('embed_') || name.startsWith('embed-src/')) return c.notFound();

		for (const [dir, prefix] of [[distDir, '/assets/'], [staticDir, '/assets/']] as const) {
			const response = await serveDir(c.req.raw, { fsRoot: dir, urlRoot: prefix.slice(1, -1), quiet: true });
			if (response.status !== 404) {
				applyRevalidationHeaders(response.headers);
				return response;
			}
		}
		return c.notFound();
	});

	// The SPA is a single page; every non-API path renders it and the hash
	// router decides what to show.
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
