/**
 * Writes `packages/web/dist/icons.svg` (part of `deno task build:web`): one `<symbol>` per app icon and per Web
 * Awesome system icon, from Lucide's `icon-nodes.json` (ISC) plus `CUSTOM_ICONS`. An unknown name fails the build.
 *
 * App symbols leave `stroke-width` to the stylesheet; system symbols (`wa-*`) set it, because they render inside
 * Web Awesome's shadow roots where the page stylesheet cannot reach.
 */
import nodes from 'lucide-static/icon-nodes.json' with { type: 'json' };
import { CUSTOM_ICONS, type IconNode, ICONS, SYSTEM_ICONS } from '../packages/web/src/icon_names.ts';

const LUCIDE = nodes as unknown as Record<string, readonly IconNode[]>;

/** Escapes a value for a double-quoted attribute or element text. */
export function escape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The SVG nodes of a Lucide name, or of `@name` in `CUSTOM_ICONS`. */
export function glyph(source: string): readonly IconNode[] {
	const found = source.startsWith('@') ? CUSTOM_ICONS[source.slice(1)] : LUCIDE[source];
	if (found === undefined) throw new Error(`icon glyph not found: ${source}`);
	return found;
}

/** One `<symbol>`; tag and attribute names are checked, values escaped. */
export function symbol(id: string, children: readonly IconNode[], strokeWidth?: string): string {
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

if (import.meta.main) {
	const symbols = [
		...Object.entries(ICONS).map(([name, source]) => symbol(name, glyph(source))),
		...Object.entries(SYSTEM_ICONS).map(([name, source]) => symbol(`wa-${name}`, glyph(source), '2')),
	];
	const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Lucide (ISC) https://lucide.dev --><defs>${
		symbols.join('')
	}</defs></svg>\n`;
	await Deno.writeTextFile(new URL('../packages/web/dist/icons.svg', import.meta.url), sprite);
	console.log(`icons.svg: ${symbols.length} symbols, ${Math.round(sprite.length / 1024)} KB`);
}
