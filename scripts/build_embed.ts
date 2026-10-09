/**
 * Writes the two MCP Apps embed documents (R9, design §2.20, D-135): `packages/web/dist/embed_live.html` and
 * `packages/web/dist/embed_a2ui.html`.
 *
 * Part of `deno task build:web`, after the task has bundled `embed_live.ts`, `embed_a2ui.ts` and `styles/embed.css`
 * into `dist/embed-src/` (the bundler runs in the task, so this script needs no `--allow-run` — F17; it holds the
 * grants `build_icons.ts` holds). Each document is self-contained, because an MCP Apps host frames it in a sandbox
 * origin from which nothing of ours is fetchable (no CORS, ever):
 *
 * - **one inline `<script type="module">` and one inline `<style>`**, each pinned by its SHA-256 in a meta CSP —
 *   `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src blob: data:; connect-src
 *   __TTK_CONNECT_SRC__; base-uri 'none'; form-action 'none'` — so not even the host's own `'unsafe-inline'` lets a
 *   second script run inside our frame. The SPA's page CSP is unchanged; this exception is the embed's alone;
 * - **the glyphs it draws**, inlined as a hidden SVG sprite of Lucide symbols (the SPA's vocabulary, `icon_names.ts`)
 *   referenced by fragment, because the `/assets/icons.svg` sprite is unreachable;
 * - **no `src` or `href` attribute anywhere** — `web_test.ts` asserts it, with the hashes and the budget.
 *
 * `__TTK_CONNECT_SRC__` stays a placeholder: the gateway replaces it with the WebSocket origin of `TTK_PUBLIC_URL`
 * when it loads the document (`packages/gateway/src/mcp_apps.ts`). Each document must stay within
 * {@linkcode EMBED_BUDGET_BYTES} (M11); the build fails rather than ship one over it. `dist/embed-src/` is removed at
 * the end, so the 150 KB per-chunk budget of D-069 is never asked to judge an intermediate file.
 */
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { encodeBase64 } from '@std/encoding/base64';
import { CUSTOM_ICONS, type IconNode, ICONS } from '../packages/web/src/icon_names.ts';
import { EMBED_ICONS } from '../packages/web/src/embed_icons.ts';

/** M11 (design §2.21): the most one embed document may weigh. */
export const EMBED_BUDGET_BYTES = 200 * 1024;
/** The token the gateway substitutes; `packages/gateway/src/mcp_apps.ts` reads the same spelling. */
export const CONNECT_SRC_PLACEHOLDER = '__TTK_CONNECT_SRC__';

const DIST = new URL('../packages/web/dist/', import.meta.url);
const SOURCES = new URL('embed-src/', DIST);
const LUCIDE = nodes as unknown as Record<string, readonly IconNode[]>;

function escapeAttribute(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The SHA-256 CSP source of exactly the text an inline element holds. */
export async function cspHash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return `'sha256-${encodeBase64(new Uint8Array(digest))}'`;
}

/**
 * Text that can sit inside `<script>` or `<style>` without ending it early: a closing tag of the same name is
 * escaped (`<\/script`), which means the same thing inside every JavaScript string, template and regex literal the
 * minifier could have produced, and is not a CSS token at all.
 */
function inlineSafe(text: string, tag: 'script' | 'style'): string {
	return text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}

/** One `<symbol>` per glyph the embeds draw, from the same Lucide nodes `build_icons.ts` reads. */
function sprite(): string {
	const symbols = EMBED_ICONS.map((name) => {
		const source = ICONS[name];
		const children = source.startsWith('@') ? CUSTOM_ICONS[source.slice(1)] : LUCIDE[source];
		if (children === undefined) throw new Error(`embed icon glyph not found: ${name} → ${source}`);
		const body = children.map(([tag, attrs]) => {
			if (!/^[a-z]+$/.test(tag)) throw new Error(`unexpected SVG tag in ${name}: ${tag}`);
			const attributes = Object.entries(attrs).map(([key, value]) => {
				if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`unexpected SVG attribute in ${name}: ${key}`);
				return ` ${key}="${escapeAttribute(value)}"`;
			}).join('');
			return `<${tag}${attributes}/>`;
		}).join('');
		return `<symbol id="i-${name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" ` +
			`stroke-linecap="round" stroke-linejoin="round">${body}</g></symbol>`;
	});
	return `<svg class="embed-sprite" aria-hidden="true" focusable="false"><defs>${symbols.join('')}</defs></svg>`;
}

/** One embed document. Exported so `web_test.ts` can rebuild the CSP from the parts and compare. */
export async function embedDocument(title: string, script: string, style: string, glyphs: string): Promise<string> {
	const safeScript = inlineSafe(script.trim(), 'script');
	const safeStyle = inlineSafe(style.trim(), 'style');
	const csp = [
		"default-src 'none'",
		`script-src ${await cspHash(safeScript)}`,
		`style-src ${await cspHash(safeStyle)}`,
		'img-src blob: data:',
		`connect-src ${CONNECT_SRC_PLACEHOLDER}`,
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
		`<title>${escapeAttribute(title)}</title>`,
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
	const glyphs = sprite();
	for (
		const [entry, out, title] of [
			['embed_live.js', 'embed_live.html', 'TykoTech live view'],
			['embed_a2ui.js', 'embed_a2ui.html', 'TykoTech agent surface'],
		] as const
	) {
		const script = await Deno.readTextFile(new URL(entry, SOURCES));
		const html = await embedDocument(title, script, style, glyphs);
		const bytes = new TextEncoder().encode(html).length;
		if (bytes > EMBED_BUDGET_BYTES) {
			throw new Error(
				`${out} is ${Math.round(bytes / 1024)} KB, over the ${EMBED_BUDGET_BYTES / 1024} KB budget (M11)`,
			);
		}
		await Deno.writeTextFile(new URL(out, DIST), html);
		console.log(`${out}: ${Math.round(bytes / 1024)} KB (script ${Math.round(script.length / 1024)} KB)`);
	}
	// The intermediates are gone before anything reads `dist`: the gateway serves `dist` as `/assets/`, and the
	// per-chunk budget test reads it too.
	await Deno.remove(SOURCES, { recursive: true });
}
