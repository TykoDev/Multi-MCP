/**
 * The component kit: Web Awesome 3 (MIT) custom elements the shell and every
 * screen are built from, registered once before the first render (D-089).
 *
 * Components are imported one module at a time — never the library entry,
 * whose autoloader would fetch component code by URL — so the bundle carries
 * exactly what is listed here and `deno bundle` emits it as its own chunks.
 * The kit is four modules — this one (display), `kit_overlay.ts`, `kit_forms.ts`
 * and `kit_more.ts` — that `app.ts` imports dynamically and in parallel before
 * the first render, so `deno bundle` can keep every emitted file within the
 * per-file budget (D-069, D-090).
 *
 * Both icon libraries Web Awesome knows — `default` (what `<wa-icon name>`
 * means) and `system` (the chevrons, checks and close glyphs inside its own
 * components) — are pointed at the app's same-origin sprite in sprite-sheet
 * mode. In that mode `wa-icon` renders `<svg><use href>`; its other path, which
 * fetches an icon file and parses it as markup, is never taken, and nothing is
 * requested from a CDN.
 */
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import '@awesome.me/webawesome/dist/components/badge/badge.js';
import '@awesome.me/webawesome/dist/components/callout/callout.js';
import '@awesome.me/webawesome/dist/components/card/card.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import '@awesome.me/webawesome/dist/components/relative-time/relative-time.js';
import '@awesome.me/webawesome/dist/components/skeleton/skeleton.js';
import '@awesome.me/webawesome/dist/components/spinner/spinner.js';
import '@awesome.me/webawesome/dist/components/tag/tag.js';
import { SPRITE_URL } from './icons.ts';

// In sprite-sheet mode the kit renders `<svg><use>` with no viewBox, and an SVG without one is 300 px wide by
// default, which overflowed the details chevron out of its box. Every sprite symbol is on Lucide's 24-unit grid.
const square = (svg: SVGElement): void => svg.setAttribute('viewBox', '0 0 24 24');
registerIconLibrary('default', {
	resolver: (name: string) => `${SPRITE_URL}#${name}`,
	mutator: square,
	spriteSheet: true,
});
registerIconLibrary('system', {
	resolver: (name: string) => `${SPRITE_URL}#wa-${name}`,
	mutator: square,
	spriteSheet: true,
});
