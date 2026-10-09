/**
 * Review R1-2 (D-135): the MCP Apps embeds are never served as pages of this origin, however their name is spelled.
 *
 * The guard judged the path as the client sent it while `serveDir` percent-decodes it, so `/assets/%65mbed_live.html`
 * and `/assets/embed%5flive.html` passed the guard and were served as the embed — a document of this origin with no
 * framing header and an unsubstituted CSP. The front's canonical-path check (E-89) does not refuse them: neither is a
 * dot segment nor an encoded slash. A case-folded spelling reaches the same file on a case-insensitive filesystem.
 */
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { Hono } from 'hono';
import type { AppVariables } from './app.ts';
import { createLogger } from './logger.ts';
import { attachStatic } from './static.ts';

async function webRoot(): Promise<string> {
	await Deno.mkdir('tests/.scratch', { recursive: true });
	const root = await Deno.makeTempDir({ dir: 'tests/.scratch', prefix: 'static-' });
	await Deno.mkdir(join(root, 'dist', 'embed-src'), { recursive: true });
	await Deno.mkdir(join(root, 'static'));
	await Deno.writeTextFile(join(root, 'static', 'index.html'), '<!doctype html><title>spa</title>');
	await Deno.writeTextFile(join(root, 'dist', 'app.js'), 'export {};');
	await Deno.writeTextFile(join(root, 'dist', 'embed_live.html'), '<!doctype html><title>embed</title>');
	await Deno.writeTextFile(join(root, 'dist', 'embed-src', 'part.js'), 'export {};');
	return root;
}

Deno.test('R1-2: an embed is a 404 under every spelling of its name; the bundle is still served', async () => {
	const root = await webRoot();
	try {
		const app = new Hono<{ Variables: AppVariables }>();
		attachStatic({ app, logger: createLogger({ level: 'error', write: () => {} }), root });
		const status = async (path: string): Promise<number> => {
			const response = await app.request(`http://127.0.0.1:8787${path}`);
			await response.body?.cancel();
			return response.status;
		};
		assertEquals(await status('/assets/app.js'), 200, 'the fixture serves an ordinary asset');
		for (
			const path of [
				'/assets/embed_live.html',
				'/assets/%65mbed_live.html',
				'/assets/embed%5flive.html',
				'/assets/embed%5Flive.html',
				'/assets/%65%6d%62%65%64%5f%6c%69%76%65.html',
				'/assets/EMBED_live.html',
				'/assets/embed-src/part.js',
				'/assets/embed%2dsrc/part.js',
				'/assets/%45mbed-src/part.js',
				'/assets/embed_live%2ehtml',
				'/assets/%zz',
			]
		) assertEquals(await status(path), 404, path);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});
