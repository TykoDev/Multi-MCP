/**
 * Writes `packages/web/dist/icons.svg`: one `<symbol>` per app icon and per Web
 * Awesome system icon, drawn from Lucide's `icon-nodes.json` (lucide-static,
 * ISC) plus the brand glyphs in `CUSTOM_ICONS`.
 *
 * Part of `deno task build:web`. An unknown Lucide name fails the build rather
 * than shipping a blank glyph. Attribute values are escaped, though every one
 * comes from the pinned package or from `icons.ts`.
 *
 * App symbols leave `stroke-width` unset so `.icon` in the stylesheet controls
 * it; system symbols (`wa-*`) set it, because they render inside Web Awesome's
 * shadow roots where the page stylesheet cannot reach.
 */
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { CUSTOM_ICONS, type IconNode, ICONS, SYSTEM_ICONS } from '../packages/web/src/icon_names.ts';

const LUCIDE = nodes as unknown as Record<string, readonly IconNode[]>;
const OUT = new URL('../packages/web/dist/icons.svg', import.meta.url);

function escape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function glyph(source: string): readonly IconNode[] {
	const found = source.startsWith('@') ? CUSTOM_ICONS[source.slice(1)] : LUCIDE[source];
	if (found === undefined) throw new Error(`icon glyph not found: ${source}`);
	return found;
}

function symbol(id: string, children: readonly IconNode[], strokeWidth?: string): string {
	const body = children.map(([tag, attrs]) => {
		if (!/^[a-z]+$/.test(tag)) throw new Error(`unexpected SVG tag in ${id}: ${tag}`);
		const attributes = Object.entries(attrs).map(([key, value]) => {
			if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error(`unexpected SVG attribute in ${id}: ${key}`);
			return ` ${key}="${escape(value)}"`;
		}).join('');
		return `<${tag}${attributes}/>`;
	}).join('');
	const stroke = strokeWidth === undefined ? '' : ` stroke-width="${strokeWidth}"`;
	return `<symbol id="${
		escape(id)
	}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"${stroke} stroke-linecap="round" stroke-linejoin="round">${body}</g></symbol>`;
}

const symbols: string[] = [];
for (const [name, source] of Object.entries(ICONS)) symbols.push(symbol(name, glyph(source)));
for (const [name, source] of Object.entries(SYSTEM_ICONS)) symbols.push(symbol(`wa-${name}`, glyph(source), '2'));

const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide (ISC) https://lucide.dev --><defs>${
	symbols.join('')
}</defs></svg>\n`;
await Deno.writeTextFile(OUT, sprite);
console.log(`icons.svg: ${symbols.length} symbols, ${Math.round(sprite.length / 1024)} KB`);

// The tab icon is no longer generated: it is the raster Multi-MCP mark in `packages/web/static/brand/`.
