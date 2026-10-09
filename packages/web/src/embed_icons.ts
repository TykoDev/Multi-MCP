/**
 * The glyphs the MCP Apps embeds draw (R9, D-135) — data only, no DOM, so `scripts/build_embed.ts` can import it
 * under the server's type configuration and inline exactly these symbols into each embed document.
 *
 * Every name is an app icon from `icon_names.ts`, so an embed draws the same Lucide glyph the control plane shows
 * for the same meaning; `web_test.ts` asserts each one maps.
 */
export const EMBED_ICONS = ['eye', 'stop', 'control', 'release', 'external', 'alert', 'lock', 'surface'] as const;
export type EmbedIconName = (typeof EMBED_ICONS)[number];
