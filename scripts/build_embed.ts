/**
 * Writes the MCP Apps embed documents `packages/web/dist/embed_{live,a2ui,terminal}.html` (part of
 * `deno task build:web`, from what the task bundled into `dist/embed-src/`).
 *
 * An MCP Apps host frames each document in a sandbox origin from which nothing of ours is fetchable (no CORS), so
 * each is self-contained: one inline script and one inline style, each pinned by SHA-256 in a meta CSP (so not even
 * the host's `'unsafe-inline'` runs a second script in our frame), the glyphs inlined as an SVG sprite, and no `src`
 * or `href` anywhere. The gateway replaces `__TTK_CONNECT_SRC__` with the WebSocket origin of `TTK_PUBLIC_URL`
 * (`packages/gateway/src/mcp_apps.ts`).
 */
import { encodeBase64 } from '@std/encoding/base64';
import { ICONS } from '../packages/web/src/icon_names.ts';
import { EMBED_ICONS } from '../packages/web/src/embed_icons.ts';
import { escape, glyph, symbol } from './build_icons.ts';

const EMBED_BUDGET_BYTES = 200 * 1024;
const DIST = new URL('../packages/web/dist/', import.meta.url);
const SOURCES = new URL('embed-src/', DIST);

async function cspHash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return `'sha256-${encodeBase64(new Uint8Array(digest))}'`;
}

/** Escapes a closing tag (`<\/script`): the same text in every JS literal the minifier emits, and no CSS token. */
function inlineSafe(text: string, tag: 'script' | 'style'): string {
	return text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

async function embedDocument(title: string, script: string, style: string, glyphs: string): Promise<string> {
	const safeScript = inlineSafe(script.trim(), 'script');
	const safeStyle = inlineSafe(style.trim(), 'style');
	const csp = [
		"default-src 'none'",
		`script-src ${await cspHash(safeScript)}`,
		`style-src ${await cspHash(safeStyle)}`,
		'img-src blob: data:',
		'connect-src __TTK_CONNECT_SRC__',
		"base-uri 'none'",
		"form-action 'none'",
	].join('; ');
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<meta http-equiv="Content-Security-Policy" content="${csp}">`,
		`<title>${escape(title)}</title>`,
		`<style>${safeStyle}</style>`,
		'</head>',
		'<body>',
		glyphs,
		'<div id="app"></div>',
		`<script type="module">${safeScript}</script>`,
		'</body>',
		'</html>',
		'',
	].join('\n');
}

if (import.meta.main) {
	const style = await Deno.readTextFile(new URL('embed.css', SOURCES));
	const glyphs = `<svg class="embed-sprite" aria-hidden="true" focusable="false"><defs>${
		EMBED_ICONS.map((name) => symbol(`i-${name}`, glyph(ICONS[name]))).join('')
	}</defs></svg>`;
	for (
		const [entry, out, title] of [
			['embed_live.js', 'embed_live.html', 'TykoTech live view'],
			['embed_a2ui.js', 'embed_a2ui.html', 'TykoTech agent surface'],
			['embed_terminal.js', 'embed_terminal.html', 'TykoTech terminal'],
		] as const
	) {
		const script = await Deno.readTextFile(new URL(entry, SOURCES));
		const html = await embedDocument(title, script, style, glyphs);
		const bytes = new TextEncoder().encode(html).length;
		if (bytes > EMBED_BUDGET_BYTES) {
			throw new Error(`${out} is ${Math.round(bytes / 1024)} KB, over the ${EMBED_BUDGET_BYTES / 1024} KB budget`);
		}
		await Deno.writeTextFile(new URL(out, DIST), html);
		console.log(`${out}: ${Math.round(bytes / 1024)} KB (script ${Math.round(script.length / 1024)} KB)`);
	}
	// Gone before anything reads `dist`: the gateway serves it as `/assets/` and the per-chunk budget test reads it.
	await Deno.remove(SOURCES, { recursive: true });
}
